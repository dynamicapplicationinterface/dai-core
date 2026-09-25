import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { serveRelay, type ServedRelay } from "./relay-memory.js";

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
// A copy that opened an invite asks for the open seat and is seated by the
// creator's copy, over the mailbox; the name is asked once it is seated.
let relay: ServedRelay;

test.beforeAll(async () => {
  relay = await serveRelay();
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

test.afterAll(async () => {
  store?.close();
  await relay?.close();
});

/** That the setup took: this page's copy is running a mailbox session against the relay. */
const mailboxRuns = (page: Page): Promise<void> =>
  expect
    .poll(() => page.evaluate(() => (window as any).__runner.mailboxPolls !== undefined), {
      timeout: 30_000,
      message: "the copy runs a mailbox session",
    })
    .toBe(true);

/**
 * What the guest's copy says about itself: its author id as the kit has it,
 * how many sessions it did not create it asked a seat in (its own practice
 * board seats itself, and is not an invite), and in how many of those it is
 * waiting and seated.
 */
const seatingOf = (page: Page): Promise<{ me: string; asked: number; waiting: number; seated: number }> =>
  appIn(page)
    .locator("body")
    .evaluate(() => {
      const kit = (window as any).daiKit;
      const me = kit.author();
      const asked = kit.db
        .selectObjects("SELECT DISTINCT lower(hex(_r_session)) s FROM _dai_binding WHERE lower(hex(_r_replica)) = ?", [me])
        .map((r: { s: string }) => r.s)
        .filter((s: string) => !kit.amCreator(s));
      return {
        me,
        asked: asked.length,
        waiting: asked.filter((s: string) => kit.pendingSeat(s) !== null).length,
        seated: asked.filter((s: string) => kit.mySeat(s) !== null).length,
      };
    });

/**
 * The guest waits to be let in, then is seated, then is asked its name.
 *
 * A joiner is seated by the creator's copy, not by opening the link, and a name
 * written while waiting would wait on the same confirmation, so the name is
 * asked only once seated (ruled 24 Sept). Asserted in that order: waiting and
 * not asked, the creator's copy pulls the ask and confirms it, the guest pulls
 * the confirmation, and then the name dialog.
 */
async function waitsThenIsAsked(creator: Page, guest: Page): Promise<void> {
  await expect
    .poll(() => seatingOf(guest), { timeout: 30_000, message: "the guest asked for the open seat and waits on it" })
    .toMatchObject({ asked: 1, waiting: 1, seated: 0 });
  expect((await seatingOf(guest)).me, "the kit's author id").toMatch(/^[0-9a-f]{32}$/);
  await expect(appIn(guest).locator("#name-dialog[open]"), "no name is asked while waiting").toHaveCount(0);
  await expect(async () => {
    await creator.evaluate(() => (window as any).__runner.pullMailbox());
    await guest.evaluate(() => (window as any).__runner.pullMailbox());
    const seen = await seatingOf(guest);
    // What it looked at, before what it found: an ask, by a known author.
    expect(seen.me, "the guest's author id").toMatch(/^[0-9a-f]{32}$/);
    expect(seen.asked, "the guest asked for a seat").toBe(1);
    expect(seen.waiting, "the guest is still waiting to be seated").toBe(0);
    expect(seen.seated, "the guest is seated").toBe(1);
  }).toPass({ timeout: 30_000 });
  await expect(appIn(guest).locator("#name-dialog[open]"), "a new author, once seated, is asked who they are").toHaveCount(1, {
    timeout: 30_000,
  });
}

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
  /*
   * The relay, the way a deploy gives it: the page's `dai-relay` meta, on every
   * load. Not `__runner.useRelay` after the fact, because on an iPhone the load
   * that opens the link relaunches before a test can call it, and that load is
   * where a fresh device files the game's key. Filled in once parsing is done
   * and before the runner's module reads it.
   */
  await page.addInitScript((base) => {
    document.addEventListener("readystatechange", () => {
      if (document.readyState !== "interactive") return;
      document.querySelector('meta[name="dai-relay"]')?.setAttribute("content", base);
    });
  }, relay.base);
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
  // Sharing gave the creator's copy a key, and with it a mailbox.
  await mailboxRuns(creator);
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
  // On the load a person is looking at, so the guest's ask can reach the creator.
  await mailboxRuns(guest);
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
      // So it waits to be let in, and is then asked who it is, rather than
      // being seated as the creator.
      await waitsThenIsAsked(creator, guest);

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
    await waitsThenIsAsked(creator, guest);

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
