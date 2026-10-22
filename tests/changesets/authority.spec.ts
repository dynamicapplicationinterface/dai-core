import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { test } from "../fixtures.js";
import { compileDirectory } from "../../src/compile.js";
import { decode as cborDecode } from "../../src/cbor.js";

/**
 * R-Y: ordinary SQL does not grant runtime authority.
 *
 * The red test filed with the ruling (backlog, "R-Y red test"): one pending
 * conflict with authentic signed history and a known observation token; an
 * application that does not cooperate replaces `TextDecoder.prototype.decode`
 * in its own realm, delegating normally, and whenever it is called tries a
 * write to the runtime's provenance (`_cs_shown`). Then a legitimate edit, and
 * a checkpoint. A control application makes the same edit without the
 * replacement, so refusing everything cannot pass.
 *
 * Trusted inspection is the host's stored copy, read in node: never a query
 * the application answers.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER_URL = "http://localhost:5175/";

const SCHEMA = `CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  qty INTEGER NOT NULL,
  unit TEXT NOT NULL,
  note TEXT
  -- dai:coupled qty unit
);
`;

const INDEX = `<!doctype html>
<html><head><meta charset="utf-8"><title>Stock</title></head>
<body>
<p id="app">ready</p>
<script type="application/sql">
INSERT INTO items (qty, unit, note) VALUES (1, 'kg', '');
</script>
<dai-rows id="edit" query="SELECT id, qty, unit, note FROM items"><template>
<input class="qty" data-run="UPDATE items SET qty = :typed WHERE id = :id">
<input class="note" data-run="UPDATE items SET note = :typed WHERE id = :id">
</template></dai-rows>
<script type="module" src="./dai-kit.js"></script>
<script type="module" src="app.js"></script>
</body></html>
`;

/*
 * The application's own code. \`arm()\` is what an application that does not
 * cooperate does: it replaces an intrinsic of its realm that the runtime's
 * native path calls, and from inside it tries to write the runtime's
 * provenance. Each attempt is counted, with what the engine said.
 */
const APP = `window.addEventListener("dai:kit-merged", () => window.daiKit.refresh());
const attempts = { calls: 0, runtime: 0, landed: 0, refused: [], where: [] };
window.__attempts = attempts;
const FORGE = "INSERT OR REPLACE INTO _cs_shown (tbl, pk, col, ver) VALUES ('items', '[1]', 'qty', 'ff:1')";
/* Through whatever this realm holds: a synchronous handle where there is one, else the worker's. */
const forge = () => {
  const db = window.daiKit && window.daiKit.db;
  if (db && typeof db.exec === "function") {
    db.exec(FORGE);
    attempts.landed += 1;
    return;
  }
  const data = window.daiKit && window.daiKit.data;
  if (data) data.run(FORGE).then(() => { attempts.landed += 1; }, (error) => { if (attempts.refused.length < 3) attempts.refused.push(String(error && error.message || error).slice(0, 160)); });
};
window.__arm = () => {
  // Outright, as the application.
  try { forge(); } catch (error) { attempts.refused.push(String(error && error.message || error).slice(0, 160)); }
  const original = TextDecoder.prototype.decode;
  let inside = false;
  TextDecoder.prototype.decode = function (...args) {
    const out = original.apply(this, args);
    attempts.calls += 1;
    // Runtime processing, as the application can see it: the runtime's own save on the stack.
    const stack = String(new Error().stack);
    if (inside || !/SessionCapture|withBases|Changes\\.|Engine\\./.test(stack)) return out;
    inside = true;
    attempts.runtime += 1;
    try {
      // From inside the runtime's call.
      forge();
      if (attempts.where.length < 3) attempts.where.push(stack.split("\\n").slice(2, 8).map((l) => l.trim()).join(" < "));
    } catch (error) {
      if (attempts.refused.length < 3) attempts.refused.push(String(error && error.message || error).slice(0, 160));
    } finally {
      inside = false;
    }
    return out;
  };
};
`;

async function build(scratch: string): Promise<string> {
  const src = join(scratch, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "index.html"), INDEX);
  writeFileSync(join(src, "schema.sql"), SCHEMA);
  writeFileSync(join(src, "app.js"), APP);
  const built = await compileDirectory({ sourceDir: src, root: repo, appName: "Stock" });
  const file = join(scratch, "stock.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

async function firstOpen(page: Page, file: string): Promise<FrameLocator> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const app = appIn(page);
  await expect(app.locator("#edit input.qty")).toHaveCount(1, { timeout: 60_000 });
  return app;
}

const uuidOf = (page: Page): Promise<string> => page.evaluate(() => (window as Any).__runner.loaded.manifest.documentUuid as string);

/** The host's stored copy: trusted inspection, never a query the application answers. */
async function stored(page: Page, uuid: string): Promise<Uint8Array> {
  const bytes = await page.evaluate(async (id) => {
    const held = await (window as Any).__runner.loadStored(id);
    return held ? [...held] : null;
  }, uuid);
  return bytes ? Uint8Array.from(bytes) : new Uint8Array();
}

function query(bytes: Uint8Array, text: string): Record<string, unknown>[] {
  if (bytes.byteLength === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), "dai-ry-db-"));
  const path = join(dir, "stored.sqlite");
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(text).all() as Record<string, unknown>[];
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function saveOut(page: Page, to: string): Promise<string> {
  await page.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.evaluate(() => (window as Any).__runner.exportContainer());
  writeFileSync(to, readFileSync(await (await downloading).path()));
  return to;
}

async function device(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ acceptDownloads: true });
  return context.newPage();
}

async function typeInto(app: FrameLocator, control: string, text: string): Promise<void> {
  const input = app.locator(`#edit input.${control}`);
  await input.fill(text);
  await input.press("Enter");
  await input.blur();
}

const SHOWN = "SELECT tbl, pk, col, ver FROM _cs_shown ORDER BY tbl, pk, col";
const PENDING = "SELECT json_group_array(json_extract(j.value, '$.col')) AS cols FROM _cs_flag f, json_each(f.detail) j WHERE f.tbl = 'items' AND f.kind = 'pending'";
const LOG = "SELECT lower(hex(_r_replica)) AS a, _r_seq AS s, _r_batch IS NOT NULL AS sealed, payload FROM _cs_log ORDER BY _r_lc, _r_seq";

/** A pending (qty, unit) conflict on A, with authentic signed history from A and B: A's page and what A's store held. */
async function pendingOnA(browser: Browser, scratch: string): Promise<{ pageA: Page; a: FrameLocator; uuid: string }> {
  const file = await build(scratch);
  const pageA = await device(browser);
  const pageB = await device(browser);
  const a = await firstOpen(pageA, file);
  const uuid = await uuidOf(pageA);
  await expect.poll(async () => query(await stored(pageA, uuid), "SELECT count(*) AS n FROM items")[0]?.["n"], { timeout: 60_000 }).toBe(1);
  const a1 = await saveOut(pageA, join(scratch, "a1.dai.html"));
  const b = await firstOpen(pageB, a1);
  await typeInto(a, "qty", "2");
  await typeInto(b, "qty", "3");
  const uuidB = await uuidOf(pageB);
  await expect.poll(async () => query(await stored(pageB, uuidB), "SELECT qty FROM items")[0]?.["qty"], { timeout: 60_000 }).toBe(3);
  await expect.poll(async () => query(await stored(pageA, uuid), "SELECT qty FROM items")[0]?.["qty"], { timeout: 60_000 }).toBe(2);
  const b1 = await saveOut(pageB, join(scratch, "b1.dai.html"));
  await pageA.setInputFiles("#file", b1);
  await expect(pageA.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
  await pageA.locator("#card-open").click();
  await expect.poll(async () => query(await stored(pageA, uuid), PENDING)[0]?.["cols"], { timeout: 60_000, message: "the tuple is pending" }).toBe('["qty","unit"]');
  await expect.poll(async () => query(await stored(pageA, uuid), "SELECT count(*) AS n FROM _cs_log WHERE _r_batch IS NULL")[0]?.["n"], { timeout: 60_000 }).toBe(0);
  await pageB.context().close();
  return { pageA, a, uuid };
}

for (const variant of ["control", "does not cooperate"] as const) {
  test(`R-Y: app code cannot re-enter runtime authority (${variant})`, async ({ browser }) => {
    test.slow();
    const scratch = mkdtempSync(join(tmpdir(), "dai-ry-"));
    const { pageA, a, uuid } = await pendingOnA(browser, scratch);
    const before = await stored(pageA, uuid);
    const shownBefore = query(before, SHOWN);
    const logBefore = query(before, LOG).map((r) => `${r["a"]}:${r["s"]}`);

    // A known observation token, over the authentic alternatives.
    const token = await a.locator("#app").evaluate(async () => {
      const data = (window as Any).daiKit.data;
      const id = await data.value("SELECT id FROM items");
      const c = await data.conflict("items", [id], ["qty", "unit"]);
      return c ? { token: c.token, alternatives: c.alternatives.map((x: Any) => x.ver) } : null;
    });
    expect(token?.alternatives.length, "a token over both alternatives").toBe(2);

    if (variant === "does not cooperate") await a.locator("#app").evaluate(() => (window as Any).__arm());

    // The legitimate edit, and the checkpoint it asks for.
    await typeInto(a, "note", "packed");
    await expect.poll(async () => query(await stored(pageA, uuid), "SELECT note FROM items")[0]?.["note"], { timeout: 60_000, message: "the edit is checkpointed" }).toBe("packed");
    await expect.poll(async () => query(await stored(pageA, uuid), "SELECT count(*) AS n FROM _cs_log WHERE _r_batch IS NULL")[0]?.["n"], { timeout: 60_000 }).toBe(0);
    const after = await stored(pageA, uuid);
    const attempts = await a.locator("#app").evaluate(() => (window as Any).__attempts);
    console.log(variant, JSON.stringify(attempts));

    // 1. Application-controlled code never ran with runtime authority: the protected write did not land.
    expect.soft(attempts.landed, "no protected write landed").toBe(0);
    expect.soft(attempts.runtime, "the application's realm is never called during the runtime's processing").toBe(0);

    // 2. Trusted inspection: the original history, receipts and alternatives intact.
    const logAfter = query(after, LOG);
    expect.soft(logAfter.slice(0, logBefore.length).map((r) => `${r["a"]}:${r["s"]}`), "the earlier history is unchanged").toEqual(logBefore);
    expect.soft(query(after, PENDING)[0]?.["cols"], "both alternatives still pending").toBe('["qty","unit"]');
    expect.soft(query(after, "SELECT ver FROM _cs_shown WHERE ver = 'ff:1'"), "no forged provenance").toEqual([]);
    const tuple = (rows: Record<string, unknown>[]) => rows.filter((r) => r["col"] === "qty" || r["col"] === "unit");
    expect.soft(tuple(query(after, SHOWN)), "the tuple's provenance is as it was").toEqual(tuple(shownBefore));

    // 3. The accepted batch carries only the legitimate effect, and nothing forged reaches its signature.
    const added = logAfter.slice(logBefore.length);
    expect.soft(added.length, "one new batch").toBe(1);
    expect.soft(added.every((r) => Number(r["sealed"]) === 1), "sealed").toBe(true);
    const payload = added[0]?.["payload"] as Uint8Array | undefined;
    if (payload) {
      const ops = (cborDecode(payload) as Any)[1] as Any[];
      expect.soft(ops.map((op) => [...(op[3] as Map<string, unknown>).keys()]), "the note alone").toEqual([["note"]]);
      expect.soft(ops[0]?.[7], "and no resolution").toBeUndefined();
      expect.soft(Buffer.from(payload).includes("ff:1"), "no forged version in the signed batch").toBe(false);
    }

    // 4. The token issued before still names the authentic alternatives, on the host's stored copy.
    expect.soft(query(after, "SELECT count(*) AS n FROM _cs_refused")[0]?.["n"], "nothing refused").toBe(0);
  });
}
