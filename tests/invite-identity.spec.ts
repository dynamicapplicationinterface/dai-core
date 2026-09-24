import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};

/**
 * Who a copy is, after an invite that carried the game with it.
 *
 * A replica id is per copy, and everything about seats rests on it: the chess
 * fixture decides "am I the creator" by asking whether any seat row was
 * authored by its own replica. So a copy running under the sender's id *is*
 * the sender, to the application — same seat, no name asked, the creator's
 * side of a game the recipient never started.
 *
 * On iOS the arrival is followed by a relaunch at the document's address, and
 * the load after it opens the copy out of the library. That load used to call
 * itself this device's own copy and keep whatever `_dai_replica` the file
 * carried — which, for an invite sent with data, is the sender's. The phone
 * sitting on 7653c44 read it as the recipient being handed the creator's seat.
 *
 * Desktop never relaunches, so it never had the bug: it is here to hold that
 * the fix did not move it.
 */
const webkitOnly = (): void =>
  test.skip(({ browserName }) => browserName !== "webkit", "the iOS relaunch is an iPhone's: WebKit only");

let store: Server;
let storeBase = "";

test.beforeAll(async () => {
  const bucket = new Map<string, Buffer>();
  store = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.method === "POST" && url.pathname === "/presign") {
        const ask = JSON.parse(body.toString()) as { hash: string; kind: string };
        const name = ask.kind === "sidecar" ? `${ask.hash}.json` : ask.kind === "icon" ? `${ask.hash}.png` : ask.hash;
        response.writeHead(200, { ...cors, "content-type": "application/json" });
        response.end(
          JSON.stringify({
            url: `${storeBase}/__put/${name}`,
            method: "PUT",
            headers: {},
            href: `${storeBase}/${name}`,
            token: "t.link",
          }),
        );
      } else if (request.method === "PUT" && url.pathname.startsWith("/__put/")) {
        bucket.set(decodeURIComponent(url.pathname.slice("/__put/".length)), body);
        response.writeHead(200, cors);
        response.end();
      } else if (request.method === "GET" || request.method === "HEAD") {
        const held = bucket.get(decodeURIComponent(url.pathname.slice(1)));
        if (!held) {
          response.writeHead(404, cors);
          response.end();
          return;
        }
        response.writeHead(200, { ...cors, "content-length": String(held.length) });
        response.end(request.method === "HEAD" ? undefined : held);
      } else {
        response.writeHead(404, cors);
        response.end();
      }
    });
  });
  await new Promise<void>((listening) => store.listen(0, listening));
  storeBase = `http://localhost:${(store.address() as { port: number }).port}`;
});

test.afterAll(() => store?.close());

const appIn = (page: Page): FrameLocator => page.frameLocator("#cartridge").frameLocator("#dai-app");

const replicaOf = (page: Page): Promise<string | null> =>
  page.evaluate(() =>
    (window as unknown as { __runner: { replicaId(): Promise<string | null> } }).__runner.replicaId(),
  );

/** A device, pointed at the test store, with the clipboard captured. */
async function device(browser: Browser, options: { iphone?: boolean } = {}): Promise<Page> {
  const context = await browser.newContext(
    options.iphone ? { userAgent: IPHONE, viewport: { width: 390, height: 844 } } : {},
  );
  const page = await context.newPage();
  await page.addInitScript((config) => {
    (window as unknown as { __daiStore: unknown }).__daiStore = config;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => void ((window as unknown as { __copied?: string }).__copied = text),
      },
    });
  }, { presignUrl: `${storeBase}/presign`, publicBase: `${storeBase}/` });
  if (options.iphone) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "iPhone", configurable: true });
    });
  }
  return page;
}

async function openHere(page: Page): Promise<void> {
  await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
  if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
}

/**
 * The host's person key, as the author id it fingerprints to (docs/identity.md).
 * Read from the host, never from the document: that is the whole point.
 */
const hostAuthorOf = (page: Page): Promise<string | null> =>
  page.evaluate(async () => {
    const runner = (window as unknown as { __runner: { authorId?: () => Promise<string | null> } }).__runner;
    return typeof runner.authorId === "function" ? await runner.authorId() : null;
  });

/** An author id as shown: 16 bytes, base64url. */
const AUTHOR_ID = /^[A-Za-z0-9_-]{22}$/;

/** A creator starts a game and shares it with the data in it; a guest opens the link. */
async function inviteWithData(browser: Browser, iphone: boolean) {
  const built = await compileDirectory({
    sourceDir: join(repo, "tests", "fixture", "chess"),
    root: repo,
    appName: "Velvet Chess",
  });
  const file = join(mkdtempSync(join(tmpdir(), "dai-invite-identity-")), "chess.dai.html");
  writeFileSync(file, built.html, "utf8");

  // The creator starts a game, and shares it with the data in it.
  const creator = await device(browser);
  await creator.goto(RUNNER_URL);
  await creator.setInputFiles("#file", file);
  await openHere(creator);
  const app = appIn(creator);
  await app.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
  await app.locator("#setup-you").fill("Ada");
  await app.locator("#setup-them").fill("");
  await app.locator('input[name="color"][value="w"]').check();
  await app.locator("#new-game-form button[type=submit]").click();
  await creator.waitForTimeout(2_000);
  await app.locator("#share").click();
  await expect(creator.locator("#send-sheet")).toBeVisible({ timeout: 30_000 });
  await creator.locator("#send-with-data").check();
  await creator.locator("#send-go").click();
  await expect
    .poll(() => creator.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? null), {
      timeout: 60_000,
    })
    .not.toBeNull();
  const link = (await creator.evaluate(() => (window as unknown as { __copied: string }).__copied)) as string;
  // The recipient opens it on a device that has never seen the document.
  const guest = await device(browser, { iphone });
  await guest.goto(link);
  await openHere(guest);
  if (iphone) {
    // The load after the relaunch is the one a person is looking at.
    await expect(guest.locator("#sheet-arrival")).toContainText("iOS reload: taken on the load before this one", {
      timeout: 60_000,
    });
    await expect(guest.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  }
  return { creator, guest };
}

test.describe("an invite that carries the game", () => {
  webkitOnly();
  test.slow();

  for (const iphone of [true, false]) {
    test(`the recipient is not the sender, on ${iphone ? "an iPhone" : "a desktop"}`, async ({ browser }) => {
      const { creator, guest } = await inviteWithData(browser, iphone);
      const sender = await replicaOf(creator);
      expect(sender, "the sender writes under an id of its own").toMatch(AUTHOR_ID);
      await expect
        .poll(() => replicaOf(guest), { timeout: 30_000 })
        .toMatch(AUTHOR_ID);

      expect(await replicaOf(guest), "a copy of somebody else's game is not that person").not.toBe(sender);
      await expect(
        appIn(guest).locator("#name-dialog[open]"),
        "so the app asks who this is, rather than seating them as the creator",
      ).toHaveCount(1, { timeout: 30_000 });

      await creator.context().close();
      await guest.context().close();
    });
  }
});

/**
 * Who a copy is comes from the key this device holds (docs/identity.md, tests 1
 * and 6 of the sitting).
 *
 * The test above holds that the recipient is not the sender. These hold why: the
 * id a copy writes under is the fingerprint of the host's person key, so a copy
 * on another device cannot be the sender whatever rows arrived with it. The
 * frame's id is read through `__runner.replicaId()`, the host's through
 * `__runner.authorId()`; they are asked separately so neither can vouch for the
 * other.
 */
test.describe("an arrived copy writes under this device's key", () => {
  test.slow();

  async function holds(browser: Browser, iphone: boolean): Promise<void> {
    const { creator, guest } = await inviteWithData(browser, iphone);
    const creatorKey = await hostAuthorOf(creator);
    expect(creatorKey, "the creator's host holds a person key").toMatch(AUTHOR_ID);
    expect(await replicaOf(creator), "and the creator's copy writes under it").toBe(creatorKey);

    const guestKey = await hostAuthorOf(guest);
    expect(guestKey, "the guest's device made a key of its own").toMatch(AUTHOR_ID);
    expect(guestKey, "a different device holds a different key").not.toBe(creatorKey);
    await expect.poll(() => replicaOf(guest), { timeout: 30_000 }).toBe(guestKey);
    await expect(appIn(guest).locator("#name-dialog[open]"), "a new author is asked who they are").toHaveCount(1, {
      timeout: 30_000,
    });

    await creator.context().close();
    await guest.context().close();
  }

  test("test 1: on an iPhone, through the relaunch, the recipient is the key its device holds", async ({ browser, browserName }) => {
    test.skip(browserName !== "webkit", "the iOS relaunch is an iPhone's: WebKit only");
    await holds(browser, true);
  });

  test("test 6: a new device is a new author", async ({ browser }) => {
    await holds(browser, false);
  });
});
