import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { parseContainer } from "../src/container.js";
import { deriveSessionMailbox, openBatch } from "../src/mailbox.js";
import { fsMailbox } from "../src/mailbox-fs.js";
import { base64 } from "../src/mailbox-http.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * One mailbox per session, in the real host (backlog D8, T1-D30).
 *
 * The property the per-session mailbox exists for, as a test that fails loudly
 * if the wiring regresses: two games in one document travel under two different
 * relay addresses, neither of them the document's; the addresses are exactly
 * what a recipient derives from the key in its link; and a game's batches open
 * only under that game's key — not the other game's, not the document key, not
 * the old per-document key. Carrier-first: the rows are written by playing, the
 * invite is the game's own Invite button, and the relay is the one this test
 * stands up, seen only from outside.
 */

let relay: Server;
let store: Server;
let relayBase = "";
let storeBase = "";
let container = "";
const backend = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-session-mailbox-relay-")) });
/** Every relay address anything was appended to. */
const appended = new Set<string>();

test.beforeAll(async () => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS,HEAD",
    "access-control-allow-headers": "content-type,if-none-match",
    "access-control-expose-headers": "etag",
  };
  relay = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const isHead = parts[parts.length - 1] === "head";
    const doc = isHead ? parts[parts.length - 2]! : parts[parts.length - 1]!;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      void (async () => {
        if (req.method === "POST") {
          appended.add(doc);
          res.writeHead(200, cors);
          res.end(await backend.append(doc, new Uint8Array(Buffer.concat(chunks))));
        } else if (isHead) {
          res.writeHead(200, cors);
          res.end(await backend.head(doc));
        } else {
          const { cursor, batches } = await backend.since(doc, url.searchParams.get("since") ?? "");
          res.writeHead(200, { ...cors, "content-type": "application/json" });
          res.end(JSON.stringify({ cursor, batches: batches.map(base64.encode) }));
        }
      })();
    });
  });
  await new Promise<void>((r) => relay.listen(0, r));
  relayBase = `http://localhost:${(relay.address() as { port: number }).port}/m`;

  const bucket = new Map<string, Buffer>();
  store = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.method === "POST" && url.pathname === "/presign") {
        const ask = JSON.parse(body.toString()) as { hash: string; kind: string };
        const name = ask.kind === "sidecar" ? `${ask.hash}.json` : ask.kind === "icon" ? `${ask.hash}.png` : ask.hash;
        res.writeHead(200, { ...cors, "content-type": "application/json" });
        res.end(JSON.stringify({ url: `${storeBase}/__put/${name}`, method: "PUT", headers: {}, href: `${storeBase}/${name}`, token: "t.link" }));
      } else if (req.method === "PUT" && url.pathname.startsWith("/__put/")) {
        bucket.set(decodeURIComponent(url.pathname.slice("/__put/".length)), body);
        res.writeHead(200, cors);
        res.end();
      } else if (req.method === "GET" || req.method === "HEAD") {
        const held = bucket.get(decodeURIComponent(url.pathname.slice(1)));
        if (!held) {
          res.writeHead(404, cors);
          res.end();
          return;
        }
        res.writeHead(200, { ...cors, "content-length": String(held.length) });
        res.end(req.method === "HEAD" ? undefined : held);
      } else {
        res.writeHead(404, cors);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => store.listen(0, r));
  storeBase = `http://localhost:${(store.address() as { port: number }).port}`;

  const built = await compileDirectory({ sourceDir: join(repo, "examples", "tic-tac-toe"), root: repo, appName: "Tic-tac-toe" });
  container = join(mkdtempSync(join(tmpdir(), "dai-session-mailbox-")), "tic-tac-toe.dai.html");
  writeFileSync(container, built.html, "utf8");
});

test.afterAll(() => {
  relay?.close();
  store?.close();
});

async function device(browser: import("@playwright/test").Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(
    (cfg) => {
      (window as unknown as { __daiStore: unknown }).__daiStore = cfg;
    },
    { presignUrl: `${storeBase}/presign`, publicBase: `${storeBase}/` },
  );
  return { context, page: await context.newPage() };
}

async function databaseOf(page: Page): Promise<DatabaseSync> {
  await page.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.evaluate(() => (window as any).__runner.exportContainer());
  const html = readFileSync(await (await downloading).path(), "utf8");
  const path = join(mkdtempSync(join(tmpdir(), "dai-session-mailbox-db-")), "d.sqlite");
  writeFileSync(path, parseContainer(html).archive["document.sqlite"]!);
  return new DatabaseSync(path);
}

const fromBase64Url = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const fromHex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));

/** The per-document mailbox key a relay address named by the document would have used. */
async function documentMailboxKey(root: Uint8Array): Promise<Uint8Array> {
  const hk = await crypto.subtle.importKey("raw", root as unknown as ArrayBuffer, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("dai:mailbox:v1") },
    hk,
    256,
  );
  return new Uint8Array(bits);
}

const opens = (sealed: Uint8Array, key: Uint8Array): Promise<boolean> =>
  openBatch(sealed, key).then(
    () => true,
    () => false,
  );

test("two games travel in two mailboxes, and one game's key opens only its own", async ({ browser }) => {
  test.slow();
  const { context: ctxA, page: pageA } = await device(browser);
  const { context: ctxB, page: pageB } = await device(browser);
  const cell = (app: FrameLocator, n: number) => app.locator("#board .cell").nth(n);

  // A holds two games, each its own session, with a mark in each.
  await pageA.goto(RUNNER_URL);
  await pageA.setInputFiles("#file", container);
  await pageA.locator("#card-open").click();
  const appA = appIn(pageA);
  await expect(appA.locator("#new-game")).toBeVisible({ timeout: 60_000 });
  for (const [them, at] of [["Bo", 0], ["Cy", 4]] as const) {
    await appA.locator("#you").fill("Ada");
    await appA.locator("#them").fill(them);
    await appA.locator("#new-game button[type=submit]").click();
    await expect(appA.locator("#players")).toContainText(`${them} (O)`, { timeout: 30_000 });
    await cell(appA, at).click();
    await expect(cell(appA, at)).toHaveText("X");
  }

  // A invites Bo into the first game. Sharing is what gives the document a key,
  // and so a mailbox — one per session.
  await appA.locator("#game-list").selectOption({ label: "Ada v Bo" });
  await pageA.evaluate((b) => (window as any).__runner.useRelay(b), relayBase);
  await pageA.evaluate(() => {
    (window as any).__copied = undefined;
    navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
  });
  await appA.locator("#invite").click();
  await pageA.click("#send-go");
  await expect.poll(() => pageA.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 }).not.toBeNull();
  const link = await pageA.evaluate(() => (window as any).__copied as string);
  const root = fromBase64Url(new URLSearchParams(new URL(link).hash.slice(1)).get("k")!);
  expect(root.byteLength, "the link carries the document's 32-byte key").toBe(32);

  // Both games published, each to its own address.
  await expect.poll(() => appended.size, { timeout: 45_000 }).toBeGreaterThanOrEqual(2);
  const a = await databaseOf(pageA);
  const games = a.prepare("SELECT lower(hex(_r_session)) AS session, o_name FROM games").all() as { session: string; o_name: string }[];
  const bo = games.find((g) => g.o_name === "Bo")!.session;
  const cy = games.find((g) => g.o_name === "Cy")!.session;
  const boMailbox = await deriveSessionMailbox(root, fromHex(bo));
  const cyMailbox = await deriveSessionMailbox(root, fromHex(cy));

  // Two addresses, the ones a recipient derives from the link — and nothing
  // under a name the document could be recognized by.
  expect(boMailbox.id).not.toBe(cyMailbox.id);
  expect([...appended].sort()).toEqual([boMailbox.id, cyMailbox.id].sort());
  for (const address of appended) expect(address, "no mailbox is named by the document's uuid").toMatch(/^[0-9a-f]{64}$/);

  // Holding one game's key opens only that game's mailbox.
  const { batches } = await backend.since(cyMailbox.id, "");
  expect(batches.length, "the other game's mailbox has rows in it").toBeGreaterThan(0);
  const sealed = batches[0]!;
  expect(await opens(sealed, cyMailbox.key), "its own key opens it (the control)").toBe(true);
  expect(await opens(sealed, boMailbox.key), "the invited game's key must not open it").toBe(false);
  expect(await opens(sealed, root), "the document key alone must not open it").toBe(false);
  expect(await opens(sealed, await documentMailboxKey(root)), "the old per-document key must not open it").toBe(false);

  // And the invited game still plays over its own mailbox: B joins from the
  // link, answers, and A receives it.
  await pageB.goto(link);
  await pageB.locator("#card-open").click({ timeout: 60_000 });
  const appB = appIn(pageB);
  await expect(appB.locator("#status")).toContainText("Your move, Bo.", { timeout: 60_000 });
  await pageB.evaluate((b) => (window as any).__runner.useRelay(b), relayBase);
  await cell(appB, 1).click();
  await expect(cell(appB, 1)).toHaveText("O");
  await expect(async () => {
    await pageA.evaluate(() => (window as any).__runner.pullMailbox());
    await expect(cell(appA, 1)).toHaveText("O", { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  // B, who never held the other game's id, wrote nowhere new.
  expect([...appended].sort()).toEqual([boMailbox.id, cyMailbox.id].sort());

  // A move read from the mailbox is on this device to stay, even if the page is
  // gone the moment it shows. The cursor used to be written before the merged
  // rows were stored, so a page killed in between kept a cursor past the move
  // and a database without it — and no later pull could bring it back. Closed
  // straight away here, and reopened with no relay at all, so the move can only
  // come from what was stored.
  const uuid = await pageA.evaluate(
    (address) =>
      new Promise<string>((resolve) => {
        const open = indexedDB.open("dai_runner_storage");
        open.onsuccess = () => {
          const all = open.result.transaction("mailboxes", "readonly").objectStore("mailboxes").getAll();
          all.onsuccess = () =>
            resolve(String((all.result as { documentUuid: string; address?: string }[]).find((r) => r.address === address)!.documentUuid).split("/")[0]!);
        };
      }),
    boMailbox.id,
  );
  await pageA.close();
  const reopened = await ctxA.newPage();
  await reopened.goto(`${RUNNER_URL}#u=${uuid}`);
  const appAgain = appIn(reopened);
  await expect(appAgain.locator("#game-list")).toBeVisible({ timeout: 60_000 });
  await appAgain.locator("#game-list").selectOption({ label: "Ada v Bo" });
  await expect(cell(appAgain, 1), "the pulled move was stored before its cursor moved").toHaveText("O", { timeout: 30_000 });

  for (const context of [ctxA, ctxB]) await context.close();
});
