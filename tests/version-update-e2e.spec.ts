/// <reference path="../apps/relay/src/cloudflare.d.ts" />
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { VersionDO, announcementBytes } from "../apps/relay/src/version-do.js";
import { memoryState } from "./relay-memory.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const inside = (page: Page): FrameLocator => page.frameLocator("#cartridge").frameLocator("#dai-app");
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/**
 * An author ships a new version, and the person decides (`docs/version-ping.md`).
 *
 * The whole loop, with the real Durable Object behind a local server and the
 * real opener: a signed app is installed and used, the author publishes a
 * successor, the copy checks in on its next open, and the card says what
 * changed, that the entries are kept, and offers Update or Not now.
 *
 * What is being proved is that the two halves meet — the relay's answer
 * becomes a card, and the card's Update becomes an adoption. Succession itself
 * is proved in `succession.spec.ts`; the data carried across here is the sign
 * that this path reaches it.
 */
/** The id of the document this device holds, from its own library. */
const documentId = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const runner = (window as unknown as { __runner: { listLibrary: () => Promise<{ documentUuid: string }[]> } }).__runner;
    const items = await runner.listLibrary();
    return items[0]?.documentUuid ?? "";
  });

test.describe("a new version offered to somebody using the app", () => {
  test.slow();

  /** The version relay, as the deployed class, behind a local address. */
  async function versionRelay(): Promise<{ base: string; close: () => Promise<void> }> {
    const objects = new Map<string, VersionDO>();
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    const server: Server = createServer((request, response) => {
      if (request.method === "OPTIONS") {
        response.writeHead(204, cors);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        void (async () => {
          const url = new URL(request.url ?? "/", "http://relay.invalid");
          const document = url.pathname.split("/").filter(Boolean)[1] ?? "";
          let object = objects.get(document);
          if (!object) {
            object = new VersionDO(memoryState().state, {});
            objects.set(document, object);
          }
          const answer = await object.fetch(
            new Request(`https://relay.invalid${url.pathname}`, {
              method: request.method,
              headers: { "content-type": "application/json" },
              body: Buffer.concat(chunks).toString("utf8") || undefined,
            }),
          );
          const body = Buffer.from(await answer.arrayBuffer());
          response.writeHead(answer.status, { ...cors, "content-type": "application/json" });
          response.end(body);
        })().catch(() => {
          response.writeHead(500, cors);
          response.end();
        });
      });
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const port = (server.address() as { port: number }).port;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((closed) => {
          server.closeAllConnections();
          server.close(() => closed());
        }),
    };
  }

  /** Where the author puts the new version for people to fetch. */
  async function serveFile(html: string): Promise<{ address: string; close: () => Promise<void> }> {
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "access-control-allow-origin": "*",
      });
      response.end(html);
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const port = (server.address() as { port: number }).port;
    return {
      address: `http://127.0.0.1:${port}/logbook-v2.dai.html`,
      close: () =>
        new Promise<void>((closed) => {
          server.closeAllConnections();
          server.close(() => closed());
        }),
    };
  }

  const page1 = (extra: string): string =>
    [
      '<!doctype html><meta charset="utf-8"><title>Logbook</title>',
      extra,
      '<p>count <dai-value id="count" query="SELECT count(*) FROM entries"></dai-value></p>',
      '<dai-form run="INSERT INTO entries (what) VALUES (:what)"><input name="what" id="what" required><button id="add">Add</button></dai-form>',
      '<dai-save id="save">Save</dai-save>',
      '<script type="module" src="./dai-kit.js"></script>',
    ].join("\n");

  /** An author with one key, and the two builds they ship with it. */
  async function anAuthor(): Promise<{
    publicKey: string;
    sign: (bytes: Uint8Array) => Promise<string>;
    first: string;
    successor: () => Promise<{ html: string; version: string }>;
  }> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const source = mkdtempSync(join(tmpdir(), "dai-version-"));
    const keyFile = join(source, "key.pem");
    writeFileSync(
      keyFile,
      [
        "-----BEGIN PRIVATE KEY-----",
        pkcs8.toString("base64").replace(/(.{64})/g, "$1\n"),
        "-----END PRIVATE KEY-----",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(source, "schema.sql"), "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, what TEXT NOT NULL);\n", "utf8");
    writeFileSync(join(source, "index.html"), page1(""), "utf8");
    const one = await compileDirectory({ sourceDir: source, root: repo, appName: "Logbook", signingKey: keyFile });
    const first = join(source, "logbook.dai.html");
    writeFileSync(first, one.html, "utf8");

    return {
      publicKey: toBase64(spki),
      sign: async (bytes) =>
        toBase64(
          new Uint8Array(
            await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, bytes as unknown as ArrayBuffer),
          ),
        ),
      first,
      /*
       * The next version: a new id that names the one it replaces, signed by
       * the same key — which is what succession requires and what the card's
       * Update hands to it. `upgradeOf` reads the previous build and carries
       * its migrations forward.
       */
      successor: async () => {
        writeFileSync(join(source, "index.html"), page1("<p>Logbook, version two</p>"), "utf8");
        mkdirSync(join(source, "migrations"), { recursive: true });
        const built = await compileDirectory({
          sourceDir: source,
          root: repo,
          appName: "Logbook",
          signingKey: keyFile,
          upgradeOf: first,
        });
        return { html: built.html, version: built.manifest.signature ?? "" };
      },
    };
  }

  async function openAndWrite(page: Page, file: string, what: string[]): Promise<void> {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    for (const entry of what) {
      await inside(page).locator("#what").fill(entry);
      await inside(page).locator("#add").click();
    }
    await expect(inside(page).locator("#count")).toHaveText(String(what.length), { timeout: 30_000 });
    /*
     * Written down, read from the library rather than from the save element.
     * That element is hidden while there is nothing to save *and* after a save
     * lands, so "hidden" is true a moment after typing and means nothing — the
     * first version of this waited on it, the entries were never persisted, and
     * the update adopted an empty database while the screen had shown two
     * entries all along.
     */
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const runner = (window as unknown as { __runner: { listLibrary: () => Promise<{ wrote?: boolean }[]> } })
              .__runner;
            return (await runner.listLibrary()).some((item) => item.wrote === true);
          }),
        { timeout: 30_000, message: "the entries are on this device, not just on screen" },
      )
      .toBe(true);
  }

  /** The author publishes, signed, as their tooling would. */
  async function announce(
    relay: { base: string },
    who: { publicKey: string; sign: (bytes: Uint8Array) => Promise<string> },
    fields: { document: string; version: string; label: string; note: string; successor: string },
  ): Promise<void> {
    const response = await fetch(`${relay.base}/v/${fields.document}/announce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fields, publicKey: who.publicKey, signature: await who.sign(announcementBytes(fields)) }),
    });
    expect(response.status, "the author's announcement was accepted").toBe(200);
  }

  test("the card says what changed and that entries are kept; Update carries them across", async ({ browser }) => {
    const author = await anAuthor();
    const relay = await versionRelay();
    const device = await browser.newContext();
    const page = await device.newPage();

    // Installed and used: two entries, written down.
    await openAndWrite(page, author.first, ["squats", "rows"]);
    const uuid = await documentId(page);
    expect(uuid, "the mounted document's id").toBeTruthy();

    // The author ships the next version and puts it where the link says.
    const next = await author.successor();
    const hosted = await serveFile(next.html);
    await announce(relay, author, {
      document: uuid!,
      version: next.version,
      label: "Version two",
      note: "the exercise list has 40 more movements",
      successor: hosted.address,
    });

    /*
     * Their next open, reached through the seam rather than a reload: a reload
     * would throw away the relay address the test just injected.
     *
     * Pointed at the relay the way a deploy points at it — `DAI_RELAY_BASE`
     * carries the mailbox path, `<origin>/m`, because that is what the mailbox
     * client appends a document to. The version door is `/v` on the same
     * worker. The first build of this check took the configured value and
     * appended `/v/<document>` to it, which on a deploy is `…/m/v/<document>`:
     * one name meaning two things, and nothing here would have noticed,
     * because a test that passes a bare origin never sees it.
     */
    await page.evaluate((base) => (window as any).__runner.useRelay(`${base}/m`), relay.base);
    await page.evaluate(() => (window as any).__runner.checkForNewVersion());

    const sheet = page.locator("#update-sheet");
    await expect(sheet, "the card is offered, once the app is up").toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#update-title")).toHaveText("Version two of Logbook");
    await expect(page.locator("#update-note")).toHaveText("the exercise list has 40 more movements");
    await expect(page.locator("#update-kept")).toHaveText(
      "Your entries are kept. This changes the app, not what you have written in it.",
    );
    await expect(page.locator("#update-go")).toBeVisible();
    await expect(page.locator("#update-later")).toBeVisible();

    // Update: the successor is fetched, and succession carries the rows across.
    await page.locator("#update-go").click();
    /*
     * The successor arrives as any document does: on a card, which says what it
     * replaces before anything opens. Waited for by itself — waiting for "the
     * card or a mounted document" would be satisfied by the document already on
     * screen, which is the one being replaced.
     */
    await expect(page.locator("#card-open"), "the successor is offered, not taken").toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#card-succession"), "it says what it replaces, before it opens").toContainText(
      "Replaces Logbook",
    );
    await page.locator("#card-open").click();

    // Version two is what is running, and both entries came with it.
    await expect(inside(page).getByText("Logbook, version two"), "the new build is the one running").toBeVisible({
      timeout: 60_000,
    });
    await expect(inside(page).locator("#count"), "both entries came across").toHaveText("2", { timeout: 60_000 });

    await device.close();
    await hosted.close();
    await relay.close();
  });

  test("Not now leaves the version they have, working", async ({ browser }) => {
    const author = await anAuthor();
    const relay = await versionRelay();
    const device = await browser.newContext();
    const page = await device.newPage();
    await openAndWrite(page, author.first, ["squats"]);
    const uuid = await documentId(page);
    const next = await author.successor();
    const hosted = await serveFile(next.html);
    await announce(relay, author, {
      document: uuid!,
      version: next.version,
      label: "Version two",
      note: "the exercise list has 40 more movements",
      successor: hosted.address,
    });

    // The deploy's shape here too: the configured address carries the mailbox path.
    await page.evaluate((base) => (window as any).__runner.useRelay(base + "/m"), relay.base);
    await page.evaluate(() => (window as any).__runner.checkForNewVersion());
    await expect(page.locator("#update-sheet")).toBeVisible({ timeout: 60_000 });
    await page.locator("#update-later").click();
    await expect(page.locator("#update-sheet")).toBeHidden();

    // Their app, as it was: the entry is there and it still writes.
    await expect(inside(page).locator("#count")).toHaveText("1", { timeout: 30_000 });
    await inside(page).locator("#what").fill("press");
    await inside(page).locator("#add").click();
    await expect(inside(page).locator("#count")).toHaveText("2", { timeout: 30_000 });
    await expect(inside(page).locator("p").first(), "still version one").not.toContainText("version two");

    await device.close();
    await hosted.close();
    await relay.close();
  });

  test("with nobody to ask, there is no card, no error, and the app works", async ({ browser }) => {
    /*
     * The ordinary case, and the one the design is most careful about: a copy
     * that cannot reach a relay — offline, blocked, or pointed at nothing —
     * opens exactly as it does today. A failed check for an update that may
     * not exist is not news, and nothing about the document degrades.
     */
    const author = await anAuthor();
    const device = await browser.newContext();
    const page = await device.newPage();
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await openAndWrite(page, author.first, ["squats"]);

    // A relay address that answers nothing at all.
    await page.evaluate(() => (window as any).__runner.useRelay("http://127.0.0.1:9"));
    await page.evaluate(() => (window as any).__runner.checkForNewVersion());
    await expect(inside(page).locator("#count")).toHaveText("1", { timeout: 30_000 });
    await page.waitForTimeout(3_000);
    await expect(page.locator("#update-sheet")).toBeHidden();
    await expect(page.locator("#report")).not.toContainText("version");
    await inside(page).locator("#what").fill("press");
    await inside(page).locator("#add").click();
    await expect(inside(page).locator("#count"), "and it still writes").toHaveText("2", { timeout: 30_000 });

    await device.close();
  });
});
