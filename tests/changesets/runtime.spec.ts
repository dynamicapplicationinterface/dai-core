import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { test } from "../fixtures.js";
import { compileDirectory } from "../../src/compile.js";
import { decode as cborDecode } from "../../src/cbor.js";
import { TO_DOCUMENT } from "../../src/bridge.js";
import { FRAME_INTERNAL } from "../../src/frame.js";
import { SAVE_REFUSED } from "../../src/refusals.js";

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
    const insert = ops.find((op) => op[0] === "notes" && op[2] === "I" && op[3].get("body") === "hello");
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
    expect(Number(await value(app, "SELECT _dai_id FROM events WHERE what = 'opened'"))).toBeGreaterThanOrEqual(2 ** 32);
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
    await expect.poll(async () => query(await stored(pageA, uuid), "SELECT count(*) AS n FROM _cs_log WHERE _r_batch IS NULL")[0]?.["n"] ?? -1, { timeout: 60_000 }).toBe(0);
    await expect.poll(async () => query(await stored(pageA, uuid), "SELECT count(*) AS n FROM notes WHERE body = 'from A'")[0]?.["n"], { timeout: 60_000 }).toBe(1);
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

    // The conflict's own flag. Another row a conflicting save also wrote is pending as its group (M06); which
    // writes share a save is the autosave's timing, so those are checked to name the conflict, not counted.
    const own = "SELECT tbl, pk, kind FROM _cs_flag f WHERE kind = 'pending' AND EXISTS (SELECT 1 FROM json_each(f.detail) j WHERE json_extract(j.value, '$.group') IS NULL)";
    await expect
      .poll(async () => query(await stored(pageA, uuid), own), { timeout: 60_000, message: "the stored copy carries the flag" })
      .toEqual([{ tbl: "notes", pk: "[1]", kind: "pending" }]);
    const groups = query(await stored(pageA, uuid), "SELECT json_extract(j.value, '$.with') AS w FROM _cs_flag f, json_each(f.detail) j WHERE f.kind = 'pending' AND json_extract(j.value, '$.group') IS NOT NULL");
    for (const g of groups) expect(JSON.parse(String(g["w"])), "a group flag names the conflict it waits on").toEqual([["notes", "[1]"]]);

    const audit = "SELECT json_group_array(n) FROM (SELECT count(*) AS n FROM log GROUP BY note_id ORDER BY note_id)";
    expect(JSON.parse(String(await value(a, audit))).every((n: number) => n === 1), "one log row per note on A").toBe(true);
    expect(JSON.parse(String(await value(b, audit))).every((n: number) => n === 1), "one log row per note on B").toBe(true);
  });

  test("6. consequential: the kit's query views leave out a row whose consequential column is pending; every other read sees the later value", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-cs-settle-"));
    const file = await buildKitBudget(scratch);
    const pageA = await device(browser);
    const pageB = await device(browser);
    const a = await firstOpen(pageA, file);
    await expect(a.locator("#total")).toHaveText("150", { timeout: 60_000 });
    const uuid = await uuidOf(pageA);
    await expect.poll(async () => query(await stored(pageA, uuid), "SELECT count(*) AS n FROM entries")[0]?.["n"], { timeout: 60_000 }).toBe(2);
    const a1 = await saveOut(pageA, join(scratch, "a1.dai.html"));

    const b = await firstOpen(pageB, a1);
    await expect(b.locator("#total")).toHaveText("150", { timeout: 60_000 });
    await typeAmount(b, "70");
    await typeAmount(a, "60");
    const uuidB = await uuidOf(pageB);
    await expect.poll(async () => query(await stored(pageB, uuidB), "SELECT amount FROM entries WHERE label = 'food'")[0]?.["amount"], { timeout: 60_000 }).toBe(70);
    await expect.poll(async () => query(await stored(pageA, uuid), "SELECT amount FROM entries WHERE label = 'food'")[0]?.["amount"], { timeout: 60_000 }).toBe(60);
    const b1 = await saveOut(pageB, join(scratch, "b1.dai.html"));

    await pageA.setInputFiles("#file", b1);
    await expect(pageA.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
    await pageA.locator("#card-open").click();
    await expect
      .poll(async () => query(await stored(pageA, uuid), "SELECT kind FROM _cs_flag WHERE tbl = 'entries'"), { timeout: 60_000, message: "the food row is pending" })
      .toEqual([{ kind: "pending" }]);
    const raw = Number(query(await stored(pageA, uuid), "SELECT sum(amount) AS s FROM entries")[0]?.["s"]);
    expect([160, 170], "an ordinary read sees the later value").toContain(raw);
    await expect(a.locator("#total"), "the kit's view leaves the pending row out of the sum").toHaveText("100", { timeout: 60_000 });
    await expect(a.locator("#rows li"), "and out of a list of it").toHaveText(["rent"]);
    await expect(a.locator("#labels li"), "a view that names another table is unchanged").toHaveText(["bills"]);
  });

  /*
   * Q07, the catalog's fourth priority vector. A save extracts its changeset
   * and logs it, then waits for the host to sign it. An edit landing while the
   * signature is out joins the next capture epoch (R-S), never the batch in
   * flight, and is never dropped: a later save logs and seals it.
   *
   * The order that loses it is forced, as the D178 test forces its own
   * (tests/sealed-leave.spec.ts): in the shell, the host's signature is held
   * until the edit is written, and given back at once, inside the edit's own
   * debounce. From the arming on, the host is not told the frame wrote: its
   * answer would be a publish, which captures and seals whatever is there, and
   * what is checked is the save.
   */
  test("7. Q07: an edit landing while the previous batch is signed belongs to the next save, and is never dropped", async ({ page }) => {
    await page.context().addInitScript(
      ({ signed, authored }) => {
        if (window === window.top || window.parent !== window.top) return;
        const w = window as any;
        w.__giveBack = (): void => {
          const held = w.__heldSigned;
          w.__heldSigned = null;
          w.__holdSign = false;
          window.dispatchEvent(new MessageEvent("message", { data: held, source: window.parent }));
        };
        window.addEventListener("message", (event) => {
          const data = event.data as any;
          const fromHost = event.source === window.parent;
          if (w.__holdSign && fromHost && data?.type === signed && !w.__heldSigned && event.isTrusted) {
            w.__heldSigned = data;
            event.stopImmediatePropagation();
          } else if (w.__holdSign !== undefined && !fromHost && data?.type === authored) {
            event.stopImmediatePropagation();
          }
        });
      },
      { signed: TO_DOCUMENT.SIGNED, authored: FRAME_INTERNAL.AUTHORED },
    );
    const shell = () => page.mainFrame().childFrames()[0]!;
    const file = await build(mkdtempSync(join(tmpdir(), "dai-cs-inflight-")));
    const app = await firstOpen(page, file);
    const uuid = await uuidOf(page);
    const settled = async (): Promise<boolean> => {
      const saves = await page.evaluate(() => {
        const runner = (window as any).__runner;
        return { asked: Number(runner.saves ?? 0), written: Number(runner.savesWritten ?? 0) };
      });
      const open = query(await stored(page, uuid), "SELECT count(*) AS n FROM _cs_log WHERE _r_batch IS NULL")[0]?.["n"];
      return saves.asked === saves.written && open === 0;
    };
    await expect.poll(settled, { timeout: 60_000, message: "the first open's saves have landed, sealed" }).toBe(true);

    await shell().evaluate(() => {
      (window as any).__holdSign = true;
    });
    await sql(app, "INSERT INTO notes (body) VALUES ('in flight')");
    await expect
      .poll(() => shell().evaluate(() => Boolean((window as any).__heldSigned)), { timeout: 30_000, message: "the save of 'in flight' asks for its signature" })
      .toBe(true);
    await sql(app, "INSERT INTO notes (body) VALUES ('during the signature')");
    await shell().evaluate(() => (window as any).__giveBack());

    const sealedWith = async (body: string): Promise<Record<string, unknown>[]> =>
      query(await stored(page, uuid), `SELECT payload FROM _cs_log WHERE instr(payload, CAST('${body}' AS BLOB)) > 0 AND _r_batch IS NOT NULL`);
    await expect.poll(async () => (await sealedWith("in flight")).length, { timeout: 60_000, message: "the batch in flight is sealed" }).toBe(1);
    await expect
      .poll(async () => (await sealedWith("during the signature")).length, { timeout: 60_000, message: "the edit made during the signature is logged and sealed by a later save" })
      .toBe(1);
    const [inFlight] = await sealedWith("in flight");
    const bodies = (cborDecode(inFlight!["payload"] as Uint8Array) as [number, [string, unknown[], string, Map<string, unknown>][]])[1]
      .filter((op) => op[0] === "notes")
      .map((op) => op[3].get("body"));
    expect(bodies, "the batch in flight holds only what was captured before it").toEqual(["in flight"]);
  });

  /**
   * Q09 (D263). The save in flight stored bytes that already held an edit made
   * while its signature was out, before any log row carried it: a crash there
   * stored a row no log row carries. Held in that window: the in-flight save's
   * signature is given back, and the next one is held, so the stored copy is
   * the one the in-flight save wrote. Its edit made during the signature is in
   * a log row there (unsealed, for the next save to seal).
   */
  test("10. Q09: the stored copy never holds an edit no log row carries", async ({ page }) => {
    await page.context().addInitScript(
      ({ signed, authored }) => {
        if (window === window.top || window.parent !== window.top) return;
        const w = window as any;
        w.__giveBack = (): void => {
          const held = w.__heldSigned;
          w.__heldSigned = null;
          w.__holdSign = true;
          w.__holdNext = true;
          window.dispatchEvent(new MessageEvent("message", { data: held, source: window.parent }));
        };
        window.addEventListener("message", (event) => {
          const data = event.data as any;
          const fromHost = event.source === window.parent;
          if (w.__holdSign && fromHost && data?.type === signed && event.isTrusted && (!w.__heldSigned || w.__holdNext)) {
            if (w.__holdNext) w.__heldNext = data;
            else w.__heldSigned = data;
            event.stopImmediatePropagation();
          } else if (w.__holdSign !== undefined && !fromHost && data?.type === authored) {
            event.stopImmediatePropagation();
          }
        });
      },
      { signed: TO_DOCUMENT.SIGNED, authored: FRAME_INTERNAL.AUTHORED },
    );
    const shell = () => page.mainFrame().childFrames()[0]!;
    const file = await build(mkdtempSync(join(tmpdir(), "dai-cs-window-")));
    const app = await firstOpen(page, file);
    const uuid = await uuidOf(page);
    const settled = async (): Promise<boolean> => {
      const saves = await page.evaluate(() => {
        const runner = (window as any).__runner;
        return { asked: Number(runner.saves ?? 0), written: Number(runner.savesWritten ?? 0) };
      });
      const open = query(await stored(page, uuid), "SELECT count(*) AS n FROM _cs_log WHERE _r_batch IS NULL")[0]?.["n"];
      return saves.asked === saves.written && open === 0;
    };
    await expect.poll(settled, { timeout: 60_000, message: "the first open's saves have landed, sealed" }).toBe(true);
    await shell().evaluate(() => {
      (window as any).__holdSign = true;
    });
    await sql(app, "INSERT INTO notes (body) VALUES ('in flight')");
    await expect.poll(() => shell().evaluate(() => Boolean((window as any).__heldSigned)), { timeout: 30_000 }).toBe(true);
    await sql(app, "INSERT INTO notes (body) VALUES ('during the signature')");
    await shell().evaluate(() => (window as any).__giveBack());
    const inStore = async (sqlText: string): Promise<number> => Number(query(await stored(page, uuid), sqlText)[0]?.["n"] ?? 0);
    await expect
      .poll(() => inStore("SELECT count(*) AS n FROM notes WHERE body = 'during the signature'"), { timeout: 60_000, message: "the in-flight save stored the edit" })
      .toBe(1);
    expect(
      await inStore("SELECT count(*) AS n FROM _cs_log WHERE instr(payload, CAST('during the signature' AS BLOB)) > 0"),
      "and a log row carries it",
    ).toBe(1);
  });

  /**
   * 1d-H2, P3. A save that fails and cannot succeed on a retry refuses the
   * document: the host says the data interface's one sentence, the store keeps
   * the last save that succeeded, and the application's next write is held.
   * The shape is a real one: text made from a BLOB that is not UTF-8, which
   * would be carried with its bytes replaced.
   */
  test("8. P3: a save no retry cures is one sentence, the last saved work is kept, and later writes are held", async ({ page }) => {
    const file = await build(mkdtempSync(join(tmpdir(), "dai-cs-refused-")));
    const app = await firstOpen(page, file);
    const uuid = await uuidOf(page);
    await sql(app, "INSERT INTO notes (body) VALUES ('kept')");
    await expect
      .poll(async () => query(await stored(page, uuid), "SELECT count(*) AS n FROM notes WHERE body = 'kept'")[0]?.["n"], {
        timeout: 60_000,
        message: "the first edit is saved",
      })
      .toBe(1);
    await sql(app, "INSERT INTO notes (body) VALUES (CAST(x'ff41' AS TEXT))");
    await expect(page.locator("#doc-note"), "the refusal, as its own sentence").toHaveText(SAVE_REFUSED, { timeout: 60_000 });
    await expect(page.locator("#save-state")).toHaveText("Not saved");
    const held = await app.locator("#app").evaluate((_el) => {
      try {
        (window as unknown as { __db: { exec(s: string): unknown } }).__db.exec("INSERT INTO notes (body) VALUES ('after')");
        return "written";
      } catch (e) {
        return String(e);
      }
    });
    expect(held, "a later write is held").toMatch(/not authorized/);
    const kept = query(await stored(page, uuid), "SELECT body FROM notes ORDER BY id").map((r) => r["body"]);
    expect(kept, "the store holds the last save that succeeded").toEqual(["seed one", "seed two", "kept"]);
  });

  /**
   * 1d-L2. When the apply after a merge's COMMIT threw, the frame's catch
   * issued a ROLLBACK with no transaction open, and that error replaced the
   * real one. Forced in that order: the application writes text that is not
   * UTF-8 as the merge verifies its batches (the frame shares the window, so a
   * wrapped crypto.subtle.verify is its own), after the merge's own capture.
   * The save the apply begins with is refused (P3); the merge's answer is that
   * refusal, and the person reads its sentence.
   */
  test("9. 1d-L2: a merge whose apply is refused after its commit answers with the refusal, not a ROLLBACK error", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-cs-rollback-"));
    const file = await build(scratch);
    const pageA = await device(browser);
    const pageB = await device(browser);
    const a = await firstOpen(pageA, file);
    const uuid = await uuidOf(pageA);
    await expect.poll(async () => query(await stored(pageA, uuid), "SELECT count(*) AS n FROM _cs_log WHERE _r_batch IS NULL")[0]?.["n"] ?? -1, { timeout: 60_000 }).toBe(0);
    const a1 = await saveOut(pageA, join(scratch, "a1.dai.html"));
    const b = await firstOpen(pageB, a1);
    await sql(b, "INSERT INTO notes (body) VALUES ('from B')");
    const uuidB = await uuidOf(pageB);
    await expect.poll(async () => query(await stored(pageB, uuidB), "SELECT count(*) AS n FROM notes WHERE body = 'from B'")[0]?.["n"], { timeout: 60_000 }).toBe(1);
    const b1 = await saveOut(pageB, join(scratch, "b1.dai.html"));

    const shell = () => pageA.mainFrame().childFrames()[0]!;
    await shell().evaluate((type) => {
      window.addEventListener("message", (event) => {
        if ((event.data as { type?: string })?.type === type) (window as any).__mergeResult = event.data;
      });
    }, FRAME_INTERNAL.MERGE_RESULT);
    await a.locator("#app").evaluate(() => {
      const subtle = crypto.subtle as unknown as { verify: (...args: unknown[]) => Promise<boolean> };
      const verify = subtle.verify.bind(subtle);
      let armed = true;
      subtle.verify = (...args: unknown[]) => {
        if (armed) {
          armed = false;
          (window as unknown as { __db: { exec(s: string): unknown } }).__db.exec("INSERT INTO notes (body) VALUES (CAST(x'ff41' AS TEXT))");
        }
        return verify(...args);
      };
    });
    await pageA.setInputFiles("#file", b1);
    await expect(pageA.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
    await pageA.locator("#card-open").click();
    await expect
      .poll(() => shell().evaluate(() => String((window as any).__mergeResult?.refused ?? "")), { timeout: 60_000, message: "the merge's answer" })
      .toMatch(/^CHANGES_SAVE_REFUSED/);
    await expect(pageA.locator("#doc-note"), "the person reads the refusal's sentence").toHaveText(SAVE_REFUSED, { timeout: 30_000 });
  });

  test("11. R-W: the release's own CREATE IF NOT EXISTS is a no-op; every other schema statement is refused, through exec and prepare", async ({ page }) => {
    const app = await firstOpen(page, await build(mkdtempSync(join(tmpdir(), "dai-cs-release-"))));
    const attempt = (text: string, how: "exec" | "prepare"): Promise<string> =>
      app.locator("#app").evaluate(
        (_el, [t, h]) => {
          const db = (window as any).__db;
          try {
            if (h === "exec") db.exec(t);
            else {
              const s = db.prepare(t);
              try {
                s.step();
              } finally {
                s.finalize();
              }
            }
            return "ran";
          } catch (e) {
            return String((e as Error).message);
          }
        },
        [text, how] as const,
      );
    const before = await value(app, "PRAGMA schema_version");
    for (const how of ["exec", "prepare"] as const) {
      // As schema.sql declares them, a keyless table (given its hidden key at compile) and a trigger among them.
      for (const text of [
        "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
        "create table if not exists events (what text);",
        "CREATE TRIGGER IF NOT EXISTS notes_log AFTER INSERT ON notes BEGIN INSERT INTO log (note_id, what) VALUES (NEW.id, 'added'); END",
      ]) {
        expect(await attempt(text, how), `${how}: ${text}`).toBe("ran");
      }
      for (const text of [
        "ALTER TABLE notes ADD COLUMN extra TEXT",
        "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY)",
        "CREATE TABLE scratch (x)",
        "DROP TABLE events",
        "CREATE TEMP TABLE scratch (x)",
      ]) {
        expect(await attempt(text, how), `${how}: ${text}`).toBe("CHANGES_REFUSED: This change needs a new version of the app; the current version was left unchanged.");
      }
    }
    expect(await value(app, "PRAGMA schema_version"), "the schema did not move").toBe(before);
  });
});

/** A budget written with the kit, and one listener: its amount is declared consequential. */
async function buildKitBudget(scratch: string): Promise<string> {
  const src = join(scratch, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "schema.sql"),
    `CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  amount INTEGER NOT NULL -- dai:consequential amount
);
CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
`,
  );
  writeFileSync(
    join(src, "index.html"),
    `<!doctype html>
<html><head><meta charset="utf-8"><title>Budget</title></head>
<body>
<p id="app">ready</p>
<script type="application/sql">
INSERT INTO entries (label, amount) VALUES ('rent', 100);
INSERT INTO entries (label, amount) VALUES ('food', 50);
INSERT INTO groups (name) VALUES ('bills');
</script>
<p>Total: <dai-value id="total" query="SELECT sum(amount) FROM entries"></dai-value></p>
<dai-rows id="rows" query="SELECT label FROM entries ORDER BY label DESC"><template><li data-text="label"></li></template></dai-rows>
<dai-rows id="labels" query="SELECT name FROM groups"><template><li data-text="name"></li></template></dai-rows>
<dai-rows id="edit" query="SELECT id, amount FROM entries WHERE label = 'food'"><template><input class="amount" data-run="UPDATE entries SET amount = :typed WHERE id = :id"></template></dai-rows>
<script type="module" src="./dai-kit.js"></script>
<script type="module" src="app.js"></script>
</body></html>
`,
  );
  // The kit tells the application of a merge, and the application redraws (SHARED-REDRAW-ON-MERGE).
  writeFileSync(join(src, "app.js"), 'window.addEventListener("dai:kit-merged", () => window.daiKit.refresh());\n');
  const built = await compileDirectory({ sourceDir: src, root: repo, appName: "Budget" });
  const file = join(scratch, "budget.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

/** Types a new amount for food into the kit's own control, as a person would. */
async function typeAmount(app: FrameLocator, amount: string): Promise<void> {
  const input = app.locator("#edit input.amount");
  await input.fill(amount);
  await input.press("Enter");
  await input.blur();
}
