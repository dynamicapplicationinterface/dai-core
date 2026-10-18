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
 * The ordinary data interface through the real runtime: a document with no
 * session policy, compiled by the real compiler, opened in the real host,
 * written with plain SQL through the handle `window.dai.openDatabase()` gives.
 * One test per runtime rule (R-O, Build 1).
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER_URL = "http://localhost:5175/";

const SCHEMA = `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tags (code TEXT PRIMARY KEY, label TEXT);
CREATE TABLE IF NOT EXISTS events (what TEXT);
CREATE TABLE IF NOT EXISTS lists (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES lists(id), body TEXT);
CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, note_id INTEGER, what TEXT);
CREATE TRIGGER IF NOT EXISTS notes_log AFTER INSERT ON notes BEGIN INSERT INTO log (note_id, what) VALUES (NEW.id, 'added'); END;
`;

const INDEX = `<!doctype html>
<html><head><meta charset="utf-8"><title>Notes</title></head>
<body>
<p id="app" hidden>ready</p>
<script type="application/sql">
INSERT OR IGNORE INTO notes (id, body) VALUES (1, 'seed one'), (2, 'seed two');
</script>
<script type="module" src="app.js"></script>
</body></html>
`;

const APP = `const db = await window.dai.openDatabase();
window.__db = db;
document.getElementById("app").hidden = false;
`;

async function build(scratch: string): Promise<string> {
  const src = join(scratch, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "index.html"), INDEX);
  writeFileSync(join(src, "schema.sql"), SCHEMA);
  writeFileSync(join(src, "app.js"), APP);
  const built = await compileDirectory({ sourceDir: src, root: repo, appName: "Notes" });
  const file = join(scratch, "notes.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

async function firstOpen(page: Page, file: string): Promise<FrameLocator> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const app = appIn(page);
  await expect(app.locator("#app")).toBeVisible({ timeout: 60_000 });
  return app;
}

/** SQL in the frame, on the application's own handle. */
const sql = (app: FrameLocator, text: string, bind: unknown[] = []): Promise<unknown> =>
  app.locator("#app").evaluate(
    (_el, [t, b]) => (window as unknown as { __db: { exec(o: unknown): unknown } }).__db.exec({ sql: t as string, bind: (b as unknown[]).length ? b : undefined }),
    [text, bind] as const,
  );
const rows = (app: FrameLocator, text: string): Promise<Record<string, unknown>[]> =>
  app.locator("#app").evaluate((_el, t) => (window as unknown as { __db: { selectObjects(s: string): Record<string, unknown>[] } }).__db.selectObjects(t), text);
const value = async (app: FrameLocator, text: string): Promise<unknown> => {
  const r = await rows(app, text);
  return r[0] ? Object.values(r[0])[0] : undefined;
};

const uuidOf = (page: Page): Promise<string> => page.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid as string);

async function stored(page: Page, uuid: string): Promise<Uint8Array> {
  const bytes = await page.evaluate(async (id) => {
    const held = await (window as any).__runner.loadStored(id);
    return held ? [...held] : null;
  }, uuid);
  return bytes ? Uint8Array.from(bytes) : new Uint8Array();
}

/** A query over a stored database, read in node. */
function query(bytes: Uint8Array, text: string): Record<string, unknown>[] {
  if (bytes.byteLength === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), "dai-cs-db-"));
  const path = join(dir, "stored.sqlite");
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = '_cs_log'").get()) return [];
    return db.prepare(text).all() as Record<string, unknown>[];
  } catch {
    return [];
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
  await page.evaluate(() => (window as any).__runner.exportContainer());
  writeFileSync(to, readFileSync(await (await downloading).path()));
  return to;
}

async function device(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ acceptDownloads: true });
  return context.newPage();
}

test.describe("the ordinary data interface, through the real runtime", () => {
  test.slow();

  test("1. every acknowledged save carries its changeset as a sealed log row", async ({ page }) => {
    const file = await build(mkdtempSync(join(tmpdir(), "dai-cs-capture-")));
    const app = await firstOpen(page, file);
    const uuid = await uuidOf(page);
    await sql(app, "INSERT INTO notes (body) VALUES ('hello')");
    await expect
      .poll(
        async () =>
          query(await stored(page, uuid), "SELECT payload, _r_batch FROM _cs_log WHERE instr(payload, CAST('hello' AS BLOB)) > 0 AND _r_batch IS NOT NULL").length,
        { timeout: 60_000, message: "the stored copy holds the save's changeset, sealed" },
      )
      .toBe(1);
    const [row] = query(await stored(page, uuid), "SELECT payload FROM _cs_log WHERE instr(payload, CAST('hello' AS BLOB)) > 0");
    const [version, ops] = cborDecode(row!["payload"] as Uint8Array) as [number, [string, unknown[], string, Map<string, unknown>][]];
    expect(version).toBe(1);
    const insert = ops.find((op) => op[0] === "notes" && op[2] === "I");
    expect(insert?.[3].get("body")).toBe("hello");
  });

  test("2. ids: an omitted integer key is author-ranged, last_insert_rowid() answers it, a text key is a uuid, a keyless table is keyed", async ({ page }) => {
    const file = await build(mkdtempSync(join(tmpdir(), "dai-cs-ids-")));
    const app = await firstOpen(page, file);
    await sql(app, "INSERT INTO notes (body) VALUES ('ranged')");
    const id = Number(await value(app, "SELECT id FROM notes WHERE body = 'ranged'"));
    expect(id).toBeGreaterThanOrEqual(2 ** 32);
    expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    await sql(app, "INSERT INTO notes (body) VALUES ('second')");
    expect(Number(await value(app, "SELECT last_insert_rowid()"))).toBe(Number(await value(app, "SELECT id FROM notes WHERE body = 'second'")));
    await sql(app, "INSERT INTO tags (label) VALUES ('red')");
    expect(String(await value(app, "SELECT code FROM tags WHERE label = 'red'"))).toMatch(/^[0-9a-f-]{36}$/);
    await sql(app, "INSERT INTO events (what) VALUES ('opened')");
    expect(Number(await value(app, "SELECT rowid FROM events WHERE what = 'opened'"))).toBeGreaterThanOrEqual(2 ** 32);
  });

  test("3. seed blocks run once, at document creation: a deleted seed row stays deleted after a reopen", async ({ page }) => {
    const file = await build(mkdtempSync(join(tmpdir(), "dai-cs-seed-")));
    const app = await firstOpen(page, file);
    const uuid = await uuidOf(page);
    expect(await value(app, "SELECT count(*) FROM notes WHERE id IN (1, 2)")).toBe(2);
    await sql(app, "DELETE FROM notes WHERE id = 2");
    await expect
      .poll(async () => query(await stored(page, uuid), "SELECT count(*) AS n FROM notes WHERE id = 2")[0]?.["n"], { timeout: 60_000 })
      .toBe(0);
    await expect.poll(async () => query(await stored(page, uuid), "SELECT count(*) AS n FROM _cs_log WHERE _r_batch IS NULL")[0]?.["n"], { timeout: 60_000 }).toBe(0);
    await page.reload();
    const again = appIn(page);
    await expect(again.locator("#app")).toBeVisible({ timeout: 60_000 });
    expect(await value(again, "SELECT count(*) FROM notes WHERE id = 2"), "the seed row is not inserted again").toBe(0);
    expect(await value(again, "SELECT count(*) FROM notes WHERE id = 1")).toBe(1);
  });

  test("4. foreign keys are enforced from open", async ({ page }) => {
    const file = await build(mkdtempSync(join(tmpdir(), "dai-cs-fk-")));
    const app = await firstOpen(page, file);
    expect(await value(app, "PRAGMA foreign_keys")).toBe(1);
    const refused = await app
      .locator("#app")
      .evaluate(() => {
        try {
          (window as any).__db.exec("INSERT INTO entries (list_id, body) VALUES (999, 'orphan')");
          return "written";
        } catch (e) {
          return String((e as Error).message);
        }
      });
    expect(refused).toMatch(/FOREIGN KEY constraint failed/);
  });

  test("5. two copies merge through the host: both converge, the conflict is a pending flag the stored copy carries, and app triggers do not re-fire", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-cs-merge-"));
    const file = await build(scratch);
    const pageA = await device(browser);
    const pageB = await device(browser);
    const a = await firstOpen(pageA, file);
    const uuid = await uuidOf(pageA);
    await sql(a, "INSERT INTO notes (body) VALUES ('from A')");
    await expect.poll(async () => query(await stored(pageA, uuid), "SELECT count(*) AS n FROM _cs_log WHERE _r_batch IS NOT NULL")[0]?.["n"] ?? 0, { timeout: 60_000 }).toBeGreaterThan(1);
    const a1 = await saveOut(pageA, join(scratch, "a1.dai.html"));

    const b = await firstOpen(pageB, a1);
    await expect.poll(() => value(b, "SELECT count(*) FROM notes WHERE body = 'from A'"), { timeout: 60_000 }).toBe(1);
    await sql(b, "UPDATE notes SET body = 'B says' WHERE id = 1");
    await sql(b, "INSERT INTO notes (body) VALUES ('from B')");
    await sql(a, "UPDATE notes SET body = 'A says' WHERE id = 1");
    const uuidB = await uuidOf(pageB);
    await expect.poll(async () => query(await stored(pageB, uuidB), "SELECT count(*) AS n FROM notes WHERE body = 'from B'")[0]?.["n"], { timeout: 60_000 }).toBe(1);
    const b1 = await saveOut(pageB, join(scratch, "b1.dai.html"));
    await expect.poll(async () => query(await stored(pageA, uuid), "SELECT count(*) AS n FROM notes WHERE body = 'A says'")[0]?.["n"], { timeout: 60_000 }).toBe(1);
    const a2 = await saveOut(pageA, join(scratch, "a2.dai.html"));

    await pageA.setInputFiles("#file", b1);
    await expect(pageA.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
    await pageA.locator("#card-open").click();
    await expect.poll(() => value(a, "SELECT count(*) FROM notes WHERE body = 'from B'"), { timeout: 60_000 }).toBe(1);

    await pageB.setInputFiles("#file", a2);
    await expect(pageB.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
    await pageB.locator("#card-open").click();
    await expect.poll(() => value(b, "SELECT body FROM notes WHERE id = 1"), { timeout: 60_000 }).toBe(await value(a, "SELECT body FROM notes WHERE id = 1"));

    const dump = "SELECT json_group_array(json_array(id, body)) FROM (SELECT id, body FROM notes ORDER BY id)";
    expect(await value(a, dump), "both copies hold the same notes").toBe(await value(b, dump));
    expect(["A says", "B says"]).toContain(await value(a, "SELECT body FROM notes WHERE id = 1"));

    await expect
      .poll(async () => query(await stored(pageA, uuid), "SELECT tbl, pk, kind FROM _cs_flag WHERE kind = 'pending'"), { timeout: 60_000, message: "the stored copy carries the flag" })
      .toEqual([{ tbl: "notes", pk: "[1]", kind: "pending" }]);

    const audit = "SELECT json_group_array(n) FROM (SELECT count(*) AS n FROM log GROUP BY note_id ORDER BY note_id)";
    expect(JSON.parse(String(await value(a, audit))).every((n: number) => n === 1), "one log row per note on A").toBe(true);
    expect(JSON.parse(String(await value(b, audit))).every((n: number) => n === 1), "one log row per note on B").toBe(true);
  });
});
