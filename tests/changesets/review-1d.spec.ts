import { expect, test } from "@playwright/test";
import { base, item } from "./scenarios.js";
import { Copy, openBytes } from "./copy.js";

/**
 * The review of Builds 1c and 1d (`handoff-2026-10-19.md`, "Code review —
 * PR #9, Builds 1c–1d"), each finding from the review's own run, named by
 * its id. The rulings they hold the runtime to are R-S (with its DDL
 * boundary), R-V (refuse before accepting) and P3 in docs/backlog.md.
 */

/**
 * 1d-H1. SQLite resolves names without regard to ASCII case, and hands the
 * authorizer, and stores in `tbl_name`, the name as written. So every check
 * of a runtime name folds it first: ASCII case, as SQLite does, and Unicode
 * compatibility and case, so a name a reader or host folds the same way is
 * never the application's either.
 */
test("1d-H1: a runtime name in any case or Unicode spelling is the runtime's, at the authorizer, the trigger drop and the capture", async () => {
  const { a, b } = await base();

  // An imported schema hangs a trigger on the log under a case-variant name.
  const raw = await openBytes(await a.bytes());
  raw.db.exec(`CREATE TRIGGER evil_case AFTER INSERT ON "_CS_LOG" BEGIN UPDATE items SET note = 'pwned-case'; END;
    CREATE TABLE "_CS_Imported" (id INTEGER PRIMARY KEY, v TEXT);`);
  const imported = raw.sqlite3.capi.sqlite3_js_db_export(raw.db.pointer) as Uint8Array;
  raw.db.close();
  const c = await Copy.open(a.author, imported);
  expect.soft(c.changes.refused, "the case-variant trigger is dropped at open").toEqual(["evil_case"]);
  c.db.exec("INSERT INTO items (title) VALUES ('after the import')");
  expect(c.save()).not.toBeNull();
  await c.seal();
  expect.soft(c.db.selectValues("SELECT note FROM items WHERE note IS NOT NULL"), "nothing the imported trigger wrote").toEqual([]);
  expect.soft(c.db.selectValue("SELECT count(*) FROM _cs_keys WHERE tbl = '_CS_Imported'"), "a case-variant runtime table is never adopted").toBe(0);
  expect.soft(() => c.db.exec(`INSERT INTO "_CS_Imported" (v) VALUES ('x')`), "nor written by the application").toThrow(/not authorized/);
  c.close();

  // Made by the application at runtime, in any spelling SQLite or a reader folds to a runtime name.
  for (const sql of [
    `CREATE TEMP TABLE "_CS_LOG_X" (x)`,
    `CREATE TEMP VIEW "_CS_LOG_CURRENT" AS SELECT 1`,
    `CREATE TEMP TABLE "_Cs_Ingested" (ver TEXT)`,
    `CREATE TABLE main."_CS_NEW" (x)`,
    `CREATE TEMP TABLE "_CS_LOG" AS SELECT * FROM main._cs_log WHERE 0`,
    `CREATE TABLE "_ｃｓ_wide" (x)`,
    `CREATE TABLE "_DAI_meta2" (x)`,
    `CREATE INDEX on_flag ON "_CS_FLAG" (tbl)`,
  ]) {
    expect.soft(() => a.db.exec(sql), sql).toThrow(/not authorized/);
  }

  // So the runtime's own tables take its writes: A's save is in main's log, and B gets it.
  a.db.exec({ sql: "UPDATE items SET qty = 42 WHERE id = ?", bind: [item(a, "Bread")] });
  expect(a.save()).not.toBeNull();
  expect(a.db.selectValues("SELECT name FROM temp.sqlite_schema"), "nothing was made in temp").toEqual([]);
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT qty FROM items WHERE title = 'Bread'")).toBe(42);
  a.close();
  b.close();
});
