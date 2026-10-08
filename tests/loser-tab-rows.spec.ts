import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { HINT_KEY } from "../src/link.js";
import { compileDirectory } from "../src/compile.js";
import { decodeBatch } from "../src/replicated-batch.js";
import { deriveSessionMailbox, openBatch } from "../src/mailbox.js";
import { fsMailbox } from "../src/mailbox-fs.js";
import { base64 } from "../src/mailbox-http.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * The rows a tab sealed before it lost the document still reach the relay,
 * signed as that tab sealed them, sent by the tab that won (pass B's B4).
 *
 * B4 made a publish claim the sequence floor from where its mount saw it, as a
 * sign and a save do (D105). So a tab that lost the document to another tab
 * can no longer publish what it sealed before it lost: its claim is refused,
 * `FLOOR_MOVED`. The handoff of 6 October said what should happen instead, as
 * a reading it did not run: the winner, under the same author, publishes those
 * rows from its own copy. This runs it.
 *
 * Two tabs of one device on one shared game document. B opens second, so its
 * open saves and it holds the document; it starts a game and plays, and its
 * save seals the rows. B has no relay yet, so nothing of it leaves. Then A is
 * reopened and starts a game of its own: A signs and saves above B's seqs, and
 * B has lost. B is given the relay and its publish is refused. A is given the
 * relay, and what it sends to B's game's mailbox carries B's rows under the
 * header B sealed them in. Each tab speaks to the relay under its own path, so
 * the relay sees which tab sent what.
 */

let relay: Server;
let store: Server;
let relayRoot = "";
let storeBase = "";
let container = "";
const backend = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-loser-tab-relay-")) });
/** Every append, by the tab whose path it came in on. */
const posted: { tab: string; address: string; sealed: Uint8Array }[] = [];

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
    const tab = parts[0]!;
    const isHead = parts[parts.length - 1] === "head";
    const doc = isHead ? parts[parts.length - 2]! : parts[parts.length - 1]!;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      void (async () => {
        if (req.method === "POST") {
          const sealed = new Uint8Array(Buffer.concat(chunks));
          posted.push({ tab, address: doc, sealed });
          res.writeHead(200, cors);
          res.end(await backend.append(doc, sealed));
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
  relayRoot = `http://localhost:${(relay.address() as { port: number }).port}`;

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
  container = join(mkdtempSync(join(tmpdir(), "dai-loser-tab-")), "tic-tac-toe.dai.html");
  writeFileSync(container, built.html, "utf8");
});

test.afterAll(() => {
  relay?.close();
  store?.close();
});

const fromBase64Url = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const saves = (page: Page): Promise<{ asked: number; written: number }> =>
  page.evaluate(() => ({
    asked: Number((window as any).__runner.saves ?? 0),
    written: Number((window as any).__runner.savesWritten ?? 0),
  }));

/** This copy's own rows in one session: table, seq and the header each names, or null while pending. */
const ownRowsIn = (page: Page, session: string): Promise<{ table: string; seq: number; batch: string | null }[]> =>
  appIn(page)
    .locator("#app")
    .evaluate((_, wanted) => {
      const db = (window as any).daiKit.db;
      const me = db.selectObjects("SELECT id FROM _dai_replica")[0].id;
      const found: { table: string; seq: number; batch: string | null }[] = [];
      for (const { name } of db.selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")) {
        const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => c.name);
        if (!cols.includes("_r_session") || !cols.includes("_r_batch")) continue;
        for (const row of db.selectObjects(
          `SELECT _r_seq AS seq, lower(hex(_r_batch)) AS batch FROM "${name}" WHERE _r_replica = ? AND lower(hex(_r_session)) = ?`,
          [me, wanted],
        )) {
          found.push({ table: name, seq: Number(row.seq), batch: row.batch ? String(row.batch) : null });
        }
      }
      return found.sort((x, y) => x.seq - y.seq);
    }, session);

/** Starts a game against `them` and marks the first free cell. */
async function newGame(page: Page, them: string, at: number): Promise<void> {
  const ui = appIn(page);
  await ui.locator("#you").fill("Ada");
  await ui.locator("#them").fill(them);
  await ui.locator("#new-game button[type=submit]").click();
  await expect(ui.locator("#players")).toContainText(`${them} (O)`, { timeout: 30_000 });
  await ui.locator("#board .cell").nth(at).click();
  await expect(ui.locator("#board .cell").nth(at)).toHaveText("X");
}

test("a tab's sealed rows reach the relay, signed as it sealed them, when another tab wins the document", async ({ browser }) => {
  test.slow();
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(
    (cfg) => {
      (window as unknown as { __daiStore: unknown }).__daiStore = cfg;
    },
    { presignUrl: `${storeBase}/presign`, publicBase: `${storeBase}/` },
  );

  // A: the document, a game with Bo, and an invite, which gives the document
  // its key and so its mailboxes.
  let a = await context.newPage();
  await a.goto(RUNNER_URL);
  await a.setInputFiles("#file", container);
  await a.locator("#card-open").click();
  await expect(appIn(a).locator("#new-game")).toBeVisible({ timeout: 60_000 });
  await newGame(a, "Bo", 0);
  await a.evaluate((base) => (window as any).__runner.useRelay(base), `${relayRoot}/a/m`);
  await a.evaluate(() => {
    (window as any).__copied = undefined;
    navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
  });
  await appIn(a).locator("#invite").click();
  await a.click("#send-go");
  await expect.poll(() => a.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 }).not.toBeNull();
  await expect.poll(() => posted.filter((p) => p.tab === "a").length, { timeout: 45_000, message: "A published its game" }).toBeGreaterThan(0);
  const uuid = await a.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid as string);
  const root = fromBase64Url(
    await a.evaluate(async () => {
      const items = (await (window as any).__runner.listLibrary()) as { documentKey?: string }[];
      return items.map((i) => i.documentKey).find((k): k is string => typeof k === "string")!;
    }),
  );

  // B: a second tab, with no relay. Its open saves, so it holds the document.
  const b = await context.newPage();
  const bNotes: string[] = [];
  b.on("console", (message) => bNotes.push(message.text()));
  await b.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
  await expect(b.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  await expect(appIn(b).locator("#new-game")).toBeVisible({ timeout: 60_000 });
  await newGame(b, "Cy", 4);
  const cy = await appIn(b)
    .locator("#app")
    .evaluate(() => String((window as any).daiKit.db.selectObjects("SELECT lower(hex(_r_session)) AS s FROM games WHERE o_name = 'Cy'")[0].s));
  // Sealed, and every save asked written: B's rows are in the stored copy under B's headers.
  await expect
    .poll(
      async () => {
        const rows = await ownRowsIn(b, cy);
        const s = await saves(b);
        return rows.length > 0 && rows.every((r) => r.batch !== null) && s.asked === s.written && s.written > 0;
      },
      { timeout: 30_000, message: "B's game is sealed and saved" },
    )
    .toBe(true);
  const sealedByB = await ownRowsIn(b, cy);
  expect(posted.filter((p) => p.tab === "b"), "B has sent nothing").toEqual([]);

  // A reopens the document and writes: it signs and saves above B's seqs, and B has lost.
  await a.close();
  a = await context.newPage();
  await a.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
  await expect(a.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  await expect(appIn(a).locator("#new-game")).toBeVisible({ timeout: 60_000 });
  const aBefore = await saves(a);
  await newGame(a, "Di", 8);
  await expect
    .poll(async () => {
      const s = await saves(a);
      return s.written > aBefore.written && s.asked === s.written;
    }, { timeout: 30_000, message: "A's game is saved" })
    .toBe(true);

  // B is given the relay: its publish of what it sealed is refused, since it lost.
  await b.evaluate((base) => (window as any).__runner.useRelay(base), `${relayRoot}/b/m`);
  await expect
    .poll(() => bNotes.some((n) => /publish refused/.test(n)), { timeout: 30_000, message: "B's publish is refused" })
    .toBe(true);

  // A is given the relay, and sends B's rows, under the headers B sealed them in.
  const cyMailbox = await deriveSessionMailbox(root, Buffer.from(cy, "hex"));
  await a.evaluate((base) => (window as any).__runner.useRelay(base), `${relayRoot}/a/m`);
  const carried = async (tab: string): Promise<Map<number, string>> => {
    const seen = new Map<number, string>();
    for (const p of posted.filter((x) => x.tab === tab && x.address === cyMailbox.id)) {
      const batch = decodeBatch(await openBatch(p.sealed, cyMailbox.key)) as { id?: Uint8Array; entries: { row: { _r_seq: number } }[] };
      for (const { row } of batch.entries) seen.set(Number(row._r_seq), batch.id ? hex(batch.id) : "unsigned");
    }
    return seen;
  };
  await expect
    .poll(async () => {
      const seen = await carried("a");
      return sealedByB.every((r) => seen.has(r.seq));
    }, { timeout: 45_000, message: "A sent B's rows to B's game's mailbox" })
    .toBe(true);
  const seen = await carried("a");
  for (const row of sealedByB) {
    expect(seen.get(row.seq), `${row.table} at seq ${row.seq} travels under the header B sealed it in`).toBe(row.batch);
  }
  expect((await carried("b")).size, "B sent none of it").toBe(0);

  await context.close();
});
