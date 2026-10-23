import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { test } from "../fixtures.js";
import { compileDirectory } from "../../src/compile.js";

/**
 * No bytes are taken while the application holds a transaction (2a-H1). The
 * runtime's save waits for the transaction to end and runs after its commit or
 * its rollback, so a row the application rolled back never reaches the stored
 * copy, where it would come back on reopen with no log row to carry it to any
 * other copy. A page going away with a transaction open rolls it back first,
 * then saves.
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

const appIn = (page: Page): FrameLocator => page.frameLocator("#cartridge").frameLocator("#dai-app");

async function open(page: Page, file: string): Promise<FrameLocator> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const app = appIn(page);
  await expect(app.locator("#app")).toBeVisible({ timeout: 60_000 });
  return app;
}

/** Runs fn in the application's frame with its handle. */
const inApp = <T,>(app: FrameLocator, fn: string): Promise<T> =>
  app.locator("#app").evaluate((_el, body) => new Function("db", `return (async () => { ${body} })();`)((window as Any).__db), fn) as Promise<T>;
const bodies = (app: FrameLocator): Promise<string[]> => inApp(app, "return (await db.query('SELECT body FROM notes ORDER BY id')).map((r) => r.body);");

/** The host's stored copy, read in node: its rows, and the log ops that name the rolled-back row. */
async function stored(page: Page, uuid: string): Promise<{ bodies: string; unsealed: number; ghostOps: number }> {
  const held = await page.evaluate(async (id) => {
    const bytes = await (window as Any).__runner.loadStored(id);
    return bytes ? [...bytes] : null;
  }, uuid);
  if (!held) return { bodies: "", unsealed: -1, ghostOps: -1 };
  const dir = mkdtempSync(join(tmpdir(), "dai-held-db-"));
  const path = join(dir, "stored.sqlite");
  writeFileSync(path, Uint8Array.from(held));
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT (SELECT group_concat(body, ',') FROM (SELECT body FROM notes ORDER BY id)) AS bodies,
                (SELECT count(*) FROM _cs_log WHERE _r_batch IS NULL) AS unsealed,
                (SELECT count(*) FROM _cs_log WHERE instr(payload, CAST('ghost' AS BLOB)) > 0) AS ghostOps`,
      )
      .get() as Any;
    return { bodies: String(row.bodies ?? ""), unsealed: Number(row.unsealed), ghostOps: Number(row.ghostOps) };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const uuidOf = (page: Page): Promise<string> => page.evaluate(() => (window as Any).__runner.loaded.manifest.documentUuid as string);

/** base, written, saved and sealed: the stored copy every case starts from. */
async function based(page: Page, app: FrameLocator, uuid: string): Promise<void> {
  await inApp(app, "await db.run(\"INSERT INTO notes (body) VALUES ('base')\");");
  await expect.poll(async () => JSON.stringify(await stored(page, uuid)), { timeout: 60_000 }).toBe(JSON.stringify({ bodies: "base", unsealed: 0, ghostOps: 0 }));
}

/** This copy's file, as Save a copy writes it. */
async function fileOf(page: Page, scratch: string): Promise<string> {
  await page.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.evaluate(() => (window as Any).__runner.exportContainer());
  const out = join(scratch, "a.dai.html");
  writeFileSync(out, readFileSync(await (await downloading).path()));
  return out;
}

async function openElsewhere(browser: Browser, file: string): Promise<{ bodies: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ acceptDownloads: true });
  const app = await open(await context.newPage(), file);
  return { bodies: await bodies(app), close: () => context.close() };
}

test.describe("no bytes while an application transaction is open (2a-H1)", () => {
  test.slow();

  test("a transaction held past a save and rolled back: the stored copy never holds its row, a reopen shows what committed, and another copy matches", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-held-"));
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    let app = await open(page, await build(scratch));
    const uuid = await uuidOf(page);
    await based(page, app, uuid);

    // Held past the save's interval (800 ms) and the seal, then thrown: the application rolls it back.
    const held = inApp<string>(
      app,
      `return db.transaction(async (tx) => {
         await tx.run("INSERT INTO notes (body) VALUES ('ghost')");
         await new Promise((r) => setTimeout(r, 3000));
         throw new Error('never mind');
       }).then(() => 'committed', (e) => 'rolled back: ' + e.message);`,
    );
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(500);
      seen.push((await stored(page, uuid)).bodies);
    }
    expect(await held).toBe("rolled back: never mind");
    await page.waitForTimeout(2000);
    seen.push((await stored(page, uuid)).bodies);
    expect(seen, "the stored copy, while held and after the rollback").toEqual(seen.map(() => "base"));
    expect((await stored(page, uuid)).ghostOps, "no log op names the rolled-back row").toBe(0);
    expect(await bodies(app)).toEqual(["base"]);

    // Reopened, as a person does: the page reloads and the opener reopens the document from its store.
    await page.reload();
    app = appIn(page);
    await expect(app.locator("#app")).toBeVisible({ timeout: 60_000 });
    expect(await bodies(app), "reopened").toEqual(["base"]);

    // A later edit, saved and sealed; then the file opened as another copy holds what this one holds.
    await inApp(app, "await db.run(\"INSERT INTO notes (body) VALUES ('later')\");");
    await expect.poll(async () => JSON.stringify(await stored(page, uuid)), { timeout: 60_000 }).toBe(JSON.stringify({ bodies: "base,later", unsealed: 0, ghostOps: 0 }));
    const other = await openElsewhere(browser, await fileOf(page, scratch));
    expect(other.bodies, "the copy opened from the file").toEqual(await bodies(app));
    expect(other.bodies).toEqual(["base", "later"]);
    await other.close();
    await context.close();
  });

  test("the page goes away while a transaction is open: it is rolled back first, then what committed is saved", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-held-leave-"));
    let app = await open(page, await build(scratch));
    const uuid = await uuidOf(page);
    await based(page, app, uuid);

    // A committed write whose save is still to come, then a transaction opened over it and kept open: it asks
    // every second, so its idle limit never ends it and only the page leaving can. The write is saved before the
    // transaction opens (2a-r1-M1); the transaction's own row never is.
    await inApp(
      app,
      `await db.run("INSERT INTO notes (body) VALUES ('pending')");
       let opened;
       const ready = new Promise((r) => (opened = r));
       window.__held = db.transaction(async (tx) => {
         await tx.run("INSERT INTO notes (body) VALUES ('ghost')");
         opened();
         for (let i = 0; i < 120; i++) {
           await new Promise((r) => setTimeout(r, 1000));
           await tx.value('SELECT count(*) FROM notes');
         }
       }).then(() => 'committed', (e) => e.message);
       await ready;`,
    );
    await page.waitForTimeout(2000);
    expect(await stored(page, uuid), "nothing of the open transaction is taken").toEqual({ bodies: "base,pending", unsealed: 0, ghostOps: 0 });

    // The shell's page is going away: what a close or a hide fires.
    await page.frameLocator("#cartridge").locator("body").evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect
      .poll(async () => JSON.stringify(await stored(page, uuid)), { timeout: 30_000, message: "rolled back, then saved" })
      .toBe(JSON.stringify({ bodies: "base,pending", unsealed: 0, ghostOps: 0 }));
    expect(await bodies(app), "the open transaction was rolled back").toEqual(["base", "pending"]);
    expect(await inApp<string>(app, "return window.__held;"), "and the application is told why").toBe("This transaction was rolled back: the page was left while it was open.");

    await page.reload();
    app = appIn(page);
    await expect(app.locator("#app")).toBeVisible({ timeout: 60_000 });
    expect(await bodies(app), "reopened").toEqual(["base", "pending"]);
  });

  test("a committed write is saved before a transaction opens over it, Saved is never said of what is not stored, and a real leave keeps it (2a-r1-M1)", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-held-before-"));
    let app = await open(page, await build(scratch));
    const uuid = await uuidOf(page);
    await based(page, app, uuid);

    // The status arrives on the port the answer comes back on, before it: what the application reads as soon as
    // its write resolves is what the runtime said of that write.
    const said = await inApp<string>(
      app,
      `await db.run("INSERT INTO notes (body) VALUES ('pending')");
       const said = window.dai.saveStatus;
       let opened;
       const ready = new Promise((r) => (opened = r));
       window.__held = db.transaction(async (tx) => {
         await tx.run("INSERT INTO notes (body) VALUES ('ghost')");
         opened();
         for (let i = 0; i < 120; i++) {
           await new Promise((r) => setTimeout(r, 1000));
           await tx.value('SELECT count(*) FROM notes');
         }
       }).then(() => 'committed', (e) => e.message);
       await ready;
       return said;`,
    );
    expect.soft(said, "a write still to be saved is not said to be saved").not.toBe("saved");

    // Held past the save's interval; the transaction keeps asking, so nothing but the page leaving ends it.
    await page.waitForTimeout(2500);
    expect(await stored(page, uuid), "the committed write was saved before the transaction opened").toEqual({ bodies: "base,pending", unsealed: 0, ghostOps: 0 });

    // A real leave: away and back, as a person goes.
    await page.goto("about:blank");
    await page.goBack();
    await page.reload();
    app = appIn(page);
    await expect(app.locator("#app")).toBeVisible({ timeout: 60_000 });
    expect(await bodies(app), "reopened").toEqual(["base", "pending"]);
    expect(await stored(page, uuid), "the stored copy").toEqual({ bodies: "base,pending", unsealed: 0, ghostOps: 0 });
  });

  test("Save a copy while a transaction is held says it waits on the app, not that a signature or a save failed (2a-r1-L1)", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-held-copy-"));
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const app = await open(page, await build(scratch));
    await based(page, app, await uuidOf(page));
    await page.evaluate(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    let files = 0;
    page.on("download", () => void (files += 1));
    // Kept open by asking every second, so nothing but the test's end closes it.
    await inApp(
      app,
      `let opened;
       const ready = new Promise((r) => (opened = r));
       db.transaction(async (tx) => {
         await tx.run("INSERT INTO notes (body) VALUES ('ghost')");
         opened();
         for (let i = 0; i < 120; i++) {
           await new Promise((r) => setTimeout(r, 1000));
           await tx.value('SELECT 1');
         }
       }).catch(() => undefined);
       await ready;`,
    );
    await page.click("#more");
    await page.click("#export");
    await expect(page.locator("#doc-note"), "what Save a copy says").toContainText("waiting on the app", { timeout: 30_000 });
    await expect(page.locator("#doc-note")).not.toContainText("could not be signed");
    expect(files, "no file is made of a document in the middle of a change").toBe(0);
    await context.close();
  });
});
