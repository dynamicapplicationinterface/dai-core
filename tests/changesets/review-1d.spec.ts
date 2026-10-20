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

/** Every value A's own log carries, as [table, column, value]: what A was recorded as writing. */
const wrote = (c: Copy): [string, string, unknown][] =>
  c.written().map((w) => {
    const [t, , col, , val] = JSON.parse(w) as [string, string, string, string, unknown];
    return [t, col, val];
  });

/**
 * 1d-H2, the schema half. Each of the review's runs: an edit, then a schema
 * change, then an unrelated insert. The save after it used to fail with
 * SQLITE_SCHEMA (rc=17) from the session, every later save and merge with
 * it. A schema change now closes the capture epoch (R-S): the epoch is
 * logged, the change runs, and a new epoch begins with the new schema. So
 * each run's saves succeed and every edit is in the log.
 */
test("1d-H2: DROP TABLE, a table rebuild, DROP COLUMN and RENAME TABLE close the epoch; every edit is logged and the next save succeeds", async () => {
  // DROP TABLE: the edit before it is logged, and the table's rows go with it on every copy.
  {
    const { a, b } = await base();
    a.db.exec("UPDATE audit SET what = 'checked'");
    a.db.exec("DROP TABLE audit");
    a.db.exec("INSERT INTO items (title) VALUES ('after the drop')");
    expect(a.save(), "DROP TABLE: the save").not.toBeNull();
    expect(wrote(a), "DROP TABLE: the edit before it").toContainEqual(["audit", "what", "checked"]);
    await b.mergeFrom(await a.bytes());
    expect(b.db.selectValues("SELECT title FROM items WHERE title = 'after the drop'")).toEqual(["after the drop"]);
    expect(b.db.selectValue("SELECT count(*) FROM audit"), "DROP TABLE: its rows are deleted on the other copy").toBe(0);
    a.db.exec("INSERT INTO items (title) VALUES ('later')");
    await b.mergeFrom(await a.bytes());
    expect(b.db.selectValues("SELECT title FROM items WHERE title = 'later'"), "DROP TABLE: a later save").toEqual(["later"]);
    expect([b.flags(), b.held()]).toEqual([[], []]);
    a.close();
    b.close();
  }

  // SQLite's own procedure for changing a table, in one transaction. The copy is the rebuild's, not an edit;
  // only what the rebuild changed (Map becomes Atlas) is logged, and the next edit lands.
  {
    const { a, b } = await base();
    a.db.exec("UPDATE audit SET what = 'checked'");
    a.db.exec(`PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE items_new (id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES categories(id), title TEXT NOT NULL CHECK (length(title) > 0),
        qty INTEGER NOT NULL DEFAULT 1, note TEXT, done INTEGER NOT NULL DEFAULT 0);
      INSERT INTO items_new (id, category_id, title, qty, note, done)
        SELECT id, category_id, CASE title WHEN 'Map' THEN 'Atlas' ELSE title END, qty, note, done FROM items;
      DROP TABLE items;
      ALTER TABLE items_new RENAME TO items;
      COMMIT;
      PRAGMA foreign_keys = ON;`);
    a.db.exec("INSERT INTO items (title) VALUES ('after the rebuild')");
    const from = Number(a.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE _r_replica = ?", [a.author.author])) + 1;
    expect(a.save(), "rebuild: the save").not.toBeNull();
    expect(wrote(a), "rebuild: the edit before it").toContainEqual(["audit", "what", "checked"]);
    const ops = [...a.opsSince(from - 1)].filter(([k]) => k.startsWith("items")).map(([k, s]) => [k.split("|")[0], [...s].join("")]);
    expect(ops.sort(), "rebuild: one change (Map), one insert, and no copied row").toEqual([
      ["items", "I"],
      ["items", "U"],
    ]);
    await b.mergeFrom(await a.bytes());
    expect(b.db.selectValues("SELECT title FROM items ORDER BY title")).toEqual(["Atlas", "Bread", "Rope", "Stove", "Tent", "after the rebuild"]);
    expect(b.db.selectValue("SELECT what FROM audit")).toBe("checked");
    a.db.exec("UPDATE items SET qty = 3 WHERE title = 'Bread'");
    await b.mergeFrom(await a.bytes());
    expect(b.db.selectValue("SELECT qty FROM items WHERE title = 'Bread'"), "rebuild: a later edit").toBe(3);
    expect([b.flags(), b.held()], "rebuild: nothing flagged or held").toEqual([[], []]);
    await a.mergeFrom(await b.bytes());
    expect(a.state(), "rebuild: the copies converge").toBe(b.state());
    a.close();
    b.close();
  }

  // DROP COLUMN: the edit before it reaches a copy that still has the column, and a merged change to that
  // copy's column is kept in the cells here, not held.
  {
    const { a, b } = await base();
    a.db.exec("UPDATE items SET note = 'n5' WHERE title = 'Bread'");
    a.db.exec("ALTER TABLE items DROP COLUMN note");
    a.db.exec("INSERT INTO items (title) VALUES ('after drop column')");
    expect(a.save(), "DROP COLUMN: the save").not.toBeNull();
    expect(wrote(a)).toContainEqual(["items", "note", "n5"]);
    await b.mergeFrom(await a.bytes());
    expect(b.db.selectObject("SELECT qty, note FROM items WHERE title = 'Bread'")).toEqual({ qty: 1, note: "n5" });
    expect(b.db.selectValues("SELECT title FROM items WHERE title = 'after drop column'")).toEqual(["after drop column"]);
    b.db.exec("UPDATE items SET qty = 2, note = 'from B' WHERE title = 'Bread'");
    await a.mergeFrom(await b.bytes());
    expect(a.db.selectValue("SELECT qty FROM items WHERE title = 'Bread'"), "DROP COLUMN: B's change lands").toBe(2);
    expect([a.flags(), a.held()], "DROP COLUMN: nothing held for the column A dropped").toEqual([[], []]);
    a.close();
    b.close();
  }

  // RENAME TABLE: the history goes with the table; a copy that has not renamed holds the row, flagged, until it does.
  {
    const { a, b } = await base();
    a.db.exec("UPDATE audit SET what = 'checked'");
    a.db.exec("ALTER TABLE audit RENAME TO audit2");
    a.db.exec("UPDATE audit2 SET what = 'after'");
    expect(a.save(), "RENAME TABLE: the save").not.toBeNull();
    expect(wrote(a)).toContainEqual(["audit", "what", "checked"]);
    expect(wrote(a)).toContainEqual(["audit2", "what", "after"]);
    await b.mergeFrom(await a.bytes());
    expect(b.db.selectValue("SELECT what FROM audit"), "RENAME TABLE: the edit before it").toBe("checked");
    expect(b.held().map((h) => h.tbl), "RENAME TABLE: held where the table is not, flagged").toEqual(["audit2"]);
    b.db.exec("ALTER TABLE audit RENAME TO audit2");
    expect(b.db.selectValue("SELECT what FROM audit2"), "RENAME TABLE: once this copy renames too").toBe("after");
    expect([b.flags(), b.held()]).toEqual([[], []]);
    await a.mergeFrom(await b.bytes());
    expect(a.state(), "RENAME TABLE: the copies converge").toBe(b.state());
    a.close();
    b.close();
  }
});

/**
 * 1d-H3 (catalog C02, K01). The session skips a row with a NULL in its
 * primary key, and SQLite allows one in any rowid table's key that is not
 * the rowid alias. So a key of integer affinity in any spelling (INT, BIGINT,
 * INT8, a table-level key, with NOT NULL beside it) takes an author-ranged id
 * when the application leaves it out, decided from the type SQLite reports;
 * and a NULL key in any other captured table is refused as it executes, with
 * one sentence, before a save could report nothing to log.
 */
test("1d-H3: integer-affinity keys take ranged ids; a NULL key is refused as it executes", async () => {
  const { a, b } = await base({
    extra: [
      `CREATE TABLE k_int (id INT PRIMARY KEY, v TEXT);
       CREATE TABLE k_big (id BIGINT PRIMARY KEY, v TEXT);
       CREATE TABLE k_int8 ("Id" int8 NOT NULL PRIMARY KEY, v TEXT);
       CREATE TABLE k_level (id UNSIGNED BIG INT, v TEXT, PRIMARY KEY (id));
       CREATE TABLE k_text (code TEXT DEFAULT 'none' PRIMARY KEY, v TEXT);
       CREATE TABLE k_pair (x TEXT, y TEXT, v TEXT, PRIMARY KEY (x, y));`,
    ],
  });
  const range = (id: unknown): boolean => Number(id) >= 2 ** 32 && Number(id) <= Number.MAX_SAFE_INTEGER;
  for (const [table, col] of [["k_int", "id"], ["k_big", "id"], ["k_int8", "Id"], ["k_level", "id"]] as const) {
    a.db.exec(`INSERT INTO ${table} (v) VALUES ('one'), ('two')`);
    const ids = a.db.selectValues(`SELECT "${col}" FROM ${table} ORDER BY "${col}"`);
    expect(ids.every(range), `${table}: an omitted id is ranged`).toBe(true);
    expect(new Set(ids).size, `${table}: two rows, two ids`).toBe(2);
    expect(a.db.selectValue("SELECT last_insert_rowid()"), `${table}: last_insert_rowid() answers the ranged id`).toBe(ids[1]);
  }
  const refused = (sql: string): void => expect(() => a.db.exec(sql), sql).toThrow(/CHANGES_REFUSED: .*key/);
  refused("INSERT INTO k_text (code, v) VALUES (NULL, 'null code')");
  refused("INSERT INTO k_pair (x, y, v) VALUES ('k', NULL, 'half')");
  a.db.exec("INSERT INTO k_text (code, v) VALUES ('c1', 'one'); INSERT INTO k_pair (x, y, v) VALUES ('k', 'y', 'whole');");
  refused("UPDATE k_text SET code = NULL WHERE code = 'c1'");
  refused("UPDATE k_pair SET y = NULL WHERE x = 'k'");
  expect(a.db.selectValue("SELECT count(*) FROM k_text WHERE code IS NULL") + a.db.selectValue("SELECT count(*) FROM k_pair WHERE y IS NULL")).toBe(0);

  await b.mergeFrom(await a.bytes());
  for (const table of ["k_int", "k_big", "k_int8", "k_level", "k_text", "k_pair"]) {
    expect(b.dump()[table], `${table}: every row reaches the other copy`).toEqual(a.dump()[table]);
  }
  expect(b.dump()["k_int"]).toHaveLength(2);
  a.close();
  b.close();
});

/** 1d-H2, the key half (catalog K10). A key above 2^53 is carried exactly, as a save, a merge and a later edit. */
test("1d-H2: an integer key above 2^53 is saved, merged and edited exactly", async () => {
  const { a, b } = await base();
  const big = 9007199254740993n;
  a.db.exec({ sql: "INSERT INTO items (id, title) VALUES (?, 'big')", bind: [big] });
  expect(a.save(), "the save").not.toBeNull();
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT id FROM items WHERE title = 'big'"), "exact on the other copy").toBe(big);
  expect(b.db.selectValue("SELECT count(*) FROM items WHERE id = 9007199254740992"), "not its neighbor").toBe(0);
  a.db.exec({ sql: "UPDATE items SET qty = 7 WHERE id = ?", bind: [big] });
  a.db.exec("INSERT INTO items (title) VALUES ('after')");
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectObject("SELECT qty FROM items WHERE id = 9007199254740993"), "a later edit").toEqual({ qty: 7 });
  expect(b.db.selectValue("SELECT count(*) FROM items WHERE title = 'after'")).toBe(1);
  await a.mergeFrom(await b.bytes());
  expect(a.state()).toBe(b.state());
  a.close();
  b.close();
});

/**
 * 1d-H2, the save half (P3). A save that fails and cannot succeed on a retry
 * (here the session's own SQLITE_SCHEMA, put in at the engine's boundary) is
 * a document-level refusal: one sentence, nothing half-logged, later writes
 * held, and no later save or merge throws. The work saved before it stands.
 */
test("1d-H2: a save that cannot succeed refuses the document once, holds later writes, and wedges nothing", async () => {
  const { a, b } = await base();
  const capi = a.sqlite3.capi;
  const extract = capi.sqlite3session_changeset;
  const logged = (): number => Number(a.db.selectValue("SELECT count(*) FROM _cs_log WHERE _r_replica = ?", [a.author.author]));
  a.db.exec("UPDATE items SET qty = 5 WHERE title = 'Bread'");
  a.save();
  const before = logged();
  a.db.exec("UPDATE items SET qty = 9 WHERE title = 'Bread'");
  capi.sqlite3session_changeset = () => 17;
  let thrown: unknown;
  try {
    a.save();
  } catch (e) {
    thrown = e;
  } finally {
    capi.sqlite3session_changeset = extract;
  }
  expect(String(thrown), "the refusal, by its code and its sentence").toMatch(/^Error: CHANGES_SAVE_REFUSED: .+/);
  expect(a.changes.refusal, "one sentence").toMatch(/^[^.]+\.$/);
  expect(logged(), "nothing half-logged").toBe(before);
  expect(() => a.db.exec("UPDATE items SET qty = 10 WHERE title = 'Bread'"), "a later write is held").toThrow(/not authorized/);
  expect(() => a.db.exec("INSERT INTO items (title) VALUES ('held')")).toThrow(/not authorized/);
  expect(a.db.selectValue("SELECT qty FROM items WHERE title = 'Bread'"), "reads go on").toBe(9);
  expect(a.save(), "a later save throws nothing and logs nothing").toBeNull();
  expect(a.changes.projectAdmitted(), "nor does a merge apply anything").toMatchObject({ changesets: 0, refused: true });
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT qty FROM items WHERE title = 'Bread'"), "the saved work stands; the refused edit is not signed").toBe(5);
  a.close();
  b.close();

  // The same refusal from a real shape: text that is not UTF-8 (made from a BLOB) would be carried with its
  // bytes replaced, so its save is refused rather than signed changed.
  const c = await Copy.open((await base()).a.author);
  c.db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  c.save();
  c.db.exec("INSERT INTO notes (body) VALUES (CAST(x'ff41' AS TEXT))");
  expect(() => c.save(), "text that is not UTF-8").toThrow(/^CHANGES_SAVE_REFUSED: /);
  expect(() => c.db.exec("INSERT INTO notes (body) VALUES ('later')")).toThrow(/not authorized/);
  c.close();
  // And from a table made since the last save, which the save logs by what it holds.
  const d = await Copy.open((await base()).a.author);
  d.db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES (CAST(x'c3' AS TEXT));");
  expect(() => d.save(), "text that is not UTF-8, in a new table").toThrow(/^CHANGES_SAVE_REFUSED: /);
  d.close();
});
