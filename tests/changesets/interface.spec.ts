import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "../fixtures.js";
import { compileDirectory } from "../../src/compile.js";

/**
 * The application's data interface across R-Y's boundary, through the real
 * runtime: ordinary SQL, asynchronous and batched. A batch is one request and
 * all of it or none; a transaction belongs to the request sequence that opened
 * it, and nothing else runs inside it; cancellation and failure say what
 * happened; an application's own SQL functions and callbacks are refused.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER_URL = "http://localhost:5175/";

async function build(scratch: string): Promise<string> {
  const src = join(scratch, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "schema.sql"), "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n");
  writeFileSync(
    join(src, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><title>Notes</title></head><body><p id="app" hidden>ready</p><script type="module" src="app.js"></script></body></html>\n',
  );
  writeFileSync(join(src, "app.js"), 'window.__db = await window.dai.database();\ndocument.getElementById("app").hidden = false;\n');
  const built = await compileDirectory({ sourceDir: src, root: repo, appName: "Notes" });
  const file = join(scratch, "notes.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

async function open(page: Page): Promise<FrameLocator> {
  const file = await build(mkdtempSync(join(tmpdir(), "dai-interface-")));
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const app = page.frameLocator("iframe").frameLocator("iframe");
  await expect(app.locator("#app")).toBeVisible({ timeout: 60_000 });
  return app;
}

/** Runs fn in the application's frame with its handle. */
const inApp = <T,>(app: FrameLocator, fn: string): Promise<T> =>
  app.locator("#app").evaluate((_el, body) => new Function("db", `return (async () => { ${body} })();`)((window as Any).__db), fn) as Promise<T>;

const bodies = (app: FrameLocator): Promise<string[]> => inApp(app, "return (await db.query('SELECT body FROM notes ORDER BY id')).map((r) => r.body);");

test.describe("the data interface across the boundary (R-Y)", () => {
  test.slow();

  test("a batch is one request: all of it, or none", async ({ page }) => {
    const app = await open(page);
    const outcome = await inApp<string>(
      app,
      "return db.batch([{ sql: \"INSERT INTO notes (body) VALUES ('first')\" }, { sql: 'INSERT INTO notes (body) VALUES (NULL)' }]).then(() => 'resolved', (e) => 'rejected: ' + e.message);",
    );
    expect(outcome).toMatch(/^rejected: .*NOT NULL/);
    expect(await bodies(app), "the first statement did not stay").toEqual([]);
    const ran = await inApp<Any[]>(app, "return db.batch([\"INSERT INTO notes (body) VALUES ('a')\", { sql: 'INSERT INTO notes (body) VALUES (?)', bind: ['b'] }]);");
    expect(ran.map((r) => r.changes)).toEqual([1, 1]);
    expect(await bodies(app)).toEqual(["a", "b"]);
  });

  test("a transaction is its own: no other request runs inside it, and one made during it lands after", async ({ page }) => {
    const app = await open(page);
    const seen = await inApp<Any>(
      app,
      `const order = [];
       let outside;
       const held = db.transaction(async (tx) => {
         await tx.run("INSERT INTO notes (body) VALUES ('t1')");
         outside = db.value('SELECT count(*) FROM notes').then((n) => { order.push('outside saw ' + n); return n; });
         await new Promise((r) => setTimeout(r, 300));
         await tx.run("INSERT INTO notes (body) VALUES ('t2')");
         order.push('tx done');
         return 'kept';
       });
       const value = await held;
       await outside;
       return { value, order };`,
    );
    expect(seen.value).toBe("kept");
    expect(seen.order, "the outside read waited for the transaction, and saw all of it").toEqual(["tx done", "outside saw 2"]);

    const rolled = await inApp<Any>(
      app,
      `let write;
       const outcome = await db.transaction(async (tx) => {
         await tx.run("INSERT INTO notes (body) VALUES ('gone')");
         write = db.run("INSERT INTO notes (body) VALUES ('after')");
         throw new Error('changed my mind');
       }).then(() => 'committed', (e) => 'rejected: ' + e.message);
       await write;
       return outcome;`,
    );
    expect(rolled).toBe("rejected: changed my mind");
    expect(await bodies(app), "the transaction left nothing; the write made during it is its own").toEqual(["t1", "t2", "after"]);
  });

  test("a failed statement inside a transaction leaves nothing of itself, and the transaction goes on if it is caught", async ({ page }) => {
    const app = await open(page);
    const outcome = await inApp<string>(
      app,
      `return db.transaction(async (tx) => {
         await tx.run("INSERT INTO notes (body) VALUES ('kept')");
         const failed = await tx.batch(["INSERT INTO notes (body) VALUES ('half')", 'INSERT INTO notes (body) VALUES (NULL)']).then(() => 'ran', (e) => 'failed');
         await tx.run("INSERT INTO notes (body) VALUES ('also kept')");
         return failed;
       });`,
    );
    expect(outcome).toBe("failed");
    expect(await bodies(app)).toEqual(["kept", "also kept"]);
  });

  test("a transaction is not a statement of a request: BEGIN, COMMIT, ROLLBACK and SAVEPOINT are refused", async ({ page }) => {
    const app = await open(page);
    for (const sql of ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT s", "INSERT INTO notes (body) VALUES ('x'); COMMIT"]) {
      const outcome = await inApp<string>(app, `return db.run(${JSON.stringify(sql)}).then(() => 'ran', (e) => e.message);`);
      expect(outcome, sql).toMatch(/^DATA_REFUSED: A transaction is await db\.transaction/);
    }
    expect(await bodies(app)).toEqual([]);
    expect(await inApp<string>(app, "await db.run(\"INSERT INTO notes (body) VALUES ('fine')\"); return 'ok';")).toBe("ok");
  });

  test("cancelled before it runs, a request never runs; once run, it says what it did; a cancelled transaction is rolled back", async ({ page }) => {
    const app = await open(page);
    const result = await inApp<Any>(
      app,
      `const out = {};
       const early = new AbortController();
       early.abort();
       out.early = await db.batch(["INSERT INTO notes (body) VALUES ('early')"], { signal: early.signal }).then(() => 'ran', (e) => e.name);
       // Queued behind a transaction, and cancelled while it waits.
       const queued = new AbortController();
       let behind;
       await db.transaction(async (tx) => {
         behind = db.batch(["INSERT INTO notes (body) VALUES ('queued')"], { signal: queued.signal }).then(() => 'ran', (e) => e.name);
         await tx.run("INSERT INTO notes (body) VALUES ('in tx')");
         queued.abort();
         await new Promise((r) => setTimeout(r, 100));
       });
       out.queued = await behind;
       // Ran, then cancelled: the answer is what it did.
       const late = new AbortController();
       const ran = db.batch(["INSERT INTO notes (body) VALUES ('late')"], { signal: late.signal });
       const answer = await ran.then((r) => 'ran ' + r[0].changes, (e) => e.name);
       late.abort();
       out.late = answer;
       // A transaction cancelled while it is held.
       const mid = new AbortController();
       out.mid = await db.transaction(async (tx) => {
         await tx.run("INSERT INTO notes (body) VALUES ('mid')");
         mid.abort();
         await new Promise((r) => setTimeout(r, 100));
         await tx.run("INSERT INTO notes (body) VALUES ('mid 2')");
       }, { signal: mid.signal }).then(() => 'committed', (e) => e.name);
       return out;`,
    );
    expect(result).toEqual({ early: "AbortError", queued: "AbortError", late: "ran 1", mid: "AbortError" });
    expect(await bodies(app)).toEqual(["in tx", "late"]);
  });

  test("a transaction left waiting is rolled back, and the request that kept it waiting then runs", async ({ page }) => {
    const app = await open(page);
    const outcome = await inApp<Any>(
      app,
      `let inner;
       const tx = await db.transaction(async (t) => {
         await t.run("INSERT INTO notes (body) VALUES ('held')");
         inner = await db.run("INSERT INTO notes (body) VALUES ('outside')");
         await t.run("INSERT INTO notes (body) VALUES ('after the wait')");
       }).then(() => 'committed', (e) => e.message);
       return { tx, inner: inner ? inner.changes : null };`,
    );
    expect(outcome.tx).toMatch(/^DATA_REFUSED: This transaction was rolled back: nothing was asked of it for 10 seconds\.$/);
    expect(outcome.inner).toBe(1);
    expect(await bodies(app)).toEqual(["outside"]);
  });

  test("an application's own SQL functions and callbacks are refused, with the sentence", async ({ page }) => {
    const app = await open(page);
    const refused = await inApp<Any>(
      app,
      `const out = {};
       try { db.createFunction('twice', (x) => 2 * x); out.fn = 'made'; } catch (e) { out.fn = e.message; }
       out.bind = await db.query('SELECT ? AS x', [() => 1]).then(() => 'ran', (e) => e.message);
       out.callback = await db.batch([{ sql: 'SELECT 1', callback: (row) => row }]).then(() => 'ran', (e) => e.message);
       out.rowMode = await db.batch([{ sql: 'SELECT 1', rowMode: 'array' }]).then(() => 'ran', (e) => e.message);
       return out;`,
    );
    expect(refused.fn).toMatch(/^DATA_REFUSED: An application's own SQL functions and callbacks do not run inside the runtime/);
    expect(refused.bind).toMatch(/^DATA_REFUSED: An application's own SQL functions and callbacks do not run inside the runtime/);
    expect(refused.callback).toMatch(/^DATA_REFUSED: An application's own SQL functions and callbacks do not run inside the runtime/);
    expect(refused.rowMode).toMatch(/^DATA_REFUSED: A statement is its SQL/);
  });
});

