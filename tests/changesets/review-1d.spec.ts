import { expect, test } from "@playwright/test";
import { base, item } from "./scenarios.js";
import { Copy, openBytes } from "./copy.js";

/**
 * The review of Builds 1c and 1d (`handoff-2026-10-19.md`, "Code review —
 * PR #9, Builds 1c–1d"), each finding from the review's own run, named by
 * its id. The rulings they hold the runtime to are R-S, R-V (refuse before
 * accepting), R-W (the schema is the release's) and P3 in docs/backlog.md.
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

  // Made by the application at runtime, in any spelling SQLite or a reader folds to a runtime name: refused, as any schema statement is (R-W).
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
    expect.soft(() => a.db.exec(sql), sql).toThrow(/^CHANGES_REFUSED: /);
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

/*
 * 1d-H2, the schema half (DROP TABLE, a rebuild, DROP COLUMN, RENAME TABLE
 * closing the capture epoch) and 1d-M2 (a renamed column's history) are
 * retired with R-W: the application changes no schema, and each of those
 * forms is refused before any effect (`release-schema.spec.ts`, RW-03).
 */

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

/**
 * 1d-H4 (catalog M15). SQLite's five storage classes, as values in a column
 * with no type (which keeps each class as written) and as keys of a table
 * keyed by such a column, through capture, the signed log and the apply, in
 * both directions: on the other copy each value has the same class and the
 * same bytes. A BLOB key used to be logged as a JSON object and stop every
 * merge on the copy that received it; a REAL 1.0 came back an INTEGER.
 */
test("1d-H4: NULL, INTEGER, REAL, TEXT and BLOB travel exactly, as values and as keys", async () => {
  const VALUES = [
    "NULL",
    "0",
    "1",
    "-9223372036854775808",
    "9007199254740993",
    "1.0",
    "2.5",
    "0.1",
    "-0.0",
    "1e300",
    "9e999",
    "''",
    "'1'",
    "'a' || char(0) || 'b'",
    "'é ✓'",
    "x''",
    "x'31'",
    "x'00ff'",
  ];
  const KEYS = ["1", "9007199254740993", "2.5", "'1'", "'one'", "x'31'", "x''", "9e999"];
  const { a, b } = await base({ extra: ["CREATE TABLE vals (id INTEGER PRIMARY KEY, v); CREATE TABLE keyed (k PRIMARY KEY, v)"] });
  VALUES.forEach((v, i) => a.db.exec(`INSERT INTO vals (id, v) VALUES (${i + 1}, ${v})`));
  KEYS.forEach((k, i) => a.db.exec(`INSERT INTO keyed (k, v) VALUES (${k}, ${i})`));
  const exact = (c: Copy, table: string, by: string): unknown =>
    c.db.selectArrays(`SELECT typeof(${by}), hex(${by}), typeof(v), hex(v) FROM ${table} ORDER BY typeof(${by}), hex(${by})`);
  expect(a.save(), "the save").not.toBeNull();
  await b.mergeFrom(await a.bytes());
  expect(exact(b, "vals", "id"), "values, A to B").toEqual(exact(a, "vals", "id"));
  expect(exact(b, "keyed", "k"), "keys, A to B").toEqual(exact(a, "keyed", "k"));
  expect([b.flags(), b.held()]).toEqual([[], []]);

  // Edited on B, every row, and back to A.
  b.db.exec("UPDATE vals SET v = CASE typeof(v) WHEN 'real' THEN 3.0 WHEN 'blob' THEN x'' WHEN 'null' THEN 2.0 ELSE v END");
  b.db.exec("UPDATE keyed SET v = v * 1.0");
  await a.mergeFrom(await b.bytes());
  expect(exact(a, "vals", "id"), "values, B to A").toEqual(exact(b, "vals", "id"));
  expect(exact(a, "keyed", "k"), "keys, B to A").toEqual(exact(b, "keyed", "k"));
  expect(a.db.selectValue("SELECT typeof(v) FROM keyed WHERE k = 'one'"), "a whole REAL stays a REAL").toBe("real");
  expect([a.flags(), a.held()]).toEqual([[], []]);
  expect(a.state()).toBe(b.state());
  a.close();
  b.close();
});

/**
 * 1d-H5 (catalog M16). Two keys SQLite takes for one row are one row on
 * every copy: under the key column's collation (NOCASE, RTRIM), and across
 * storage classes (a REAL 1.0 is the INTEGER 1). Each copy wrote its own
 * spelling concurrently; after the exchange both show one row, under the
 * spelling the earlier-born version wrote, with the two values of the other
 * column a pending conflict, never each copy showing the other's.
 */
test("1d-H5: keys equal under the key's collation are one row, under one spelling, on every copy", async () => {
  const { a, b } = await base({
    extra: [
      `CREATE TABLE people (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT);
       CREATE TABLE tags (code TEXT PRIMARY KEY COLLATE RTRIM, label TEXT);
       CREATE TABLE pairs (x TEXT COLLATE NOCASE, y INTEGER, v TEXT, PRIMARY KEY (x, y));
       CREATE TABLE nums (k PRIMARY KEY, v TEXT);`,
    ],
  });
  a.db.exec("INSERT INTO people (email, name) VALUES ('Bob@x', 'from A'); INSERT INTO tags (code, label) VALUES ('red', 'A');");
  a.db.exec("INSERT INTO pairs (x, y, v) VALUES ('Key', 1, 'A'); INSERT INTO nums (k, v) VALUES (1, 'A');");
  b.db.exec("INSERT INTO people (email, name) VALUES ('bob@x', 'from B'); INSERT INTO tags (code, label) VALUES ('red  ', 'B');");
  b.db.exec("INSERT INTO pairs (x, y, v) VALUES ('KEY', 1, 'B'); INSERT INTO nums (k, v) VALUES (1.0, 'B');");
  const aBytes = await a.bytes();
  const bBytes = await b.bytes();
  await a.mergeFrom(bBytes);
  await b.mergeFrom(aBytes);
  for (const [table, key] of [["people", "email"], ["tags", "code"], ["pairs", "x"], ["nums", "k"]] as const) {
    const rows = (c: Copy): unknown => c.db.selectArrays(`SELECT hex(${key}), typeof(${key}) FROM ${table}`);
    expect((rows(a) as unknown[]).length, `${table}: one row on A`).toBe(1);
    expect(rows(b), `${table}: the same row, the same spelling, on B`).toEqual(rows(a));
    expect(a.flags().filter((f) => f.tbl === table).map((f) => f.kind), `${table}: the two values are a pending conflict`).toEqual(["pending"]);
  }
  expect(a.state(), "the copies converge").toBe(b.state());
  a.close();
  b.close();

  // Which spelling is born first follows the authors' order, which is random. Each case is run until it
  // has been seen: the INTEGER born first, a copy holding the REAL, and the other way round.
  const seen = new Set<string>();
  for (let run = 0; run < 24 && seen.size < 2; run++) {
    const { a, b } = await base({ extra: ["CREATE TABLE nums (k PRIMARY KEY, v TEXT)"] });
    a.db.exec("INSERT INTO nums (k, v) VALUES (1, 'A')");
    b.db.exec("INSERT INTO nums (k, v) VALUES (1.0, 'B')");
    const [ab, bb] = [await a.bytes(), await b.bytes()];
    await a.mergeFrom(bb);
    await b.mergeFrom(ab);
    const born = a.db.selectValue("SELECT author FROM _cs_cell WHERE tbl = 'nums' AND col = '' AND val = 1 ORDER BY lc, author, ver LIMIT 1");
    const want = born === a.changes.authorHex ? "integer" : "real";
    seen.add(want);
    expect([a.db.selectValue("SELECT typeof(k) FROM nums"), b.db.selectValue("SELECT typeof(k) FROM nums")], `born ${want}: both copies`).toEqual([want, want]);
    a.close();
    b.close();
  }
  expect([...seen].sort(), "both birth orders were run").toEqual(["integer", "real"]);
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
  const c = (await base({ extra: ["CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)"] })).a;
  c.save();
  c.db.exec("INSERT INTO notes (body) VALUES (CAST(x'ff41' AS TEXT))");
  expect(() => c.save(), "text that is not UTF-8").toThrow(/^CHANGES_SAVE_REFUSED: /);
  expect(() => c.db.exec("INSERT INTO notes (body) VALUES ('later')")).toThrow(/not authorized/);
  c.close();
});

/** An imported copy of A: A's stored bytes with `sql` run on them outside any runtime, reopened as A. */
async function imported(a: Copy, sql: string): Promise<Copy> {
  const raw = await openBytes(await a.bytes());
  raw.db.exec(sql);
  const bytes = raw.sqlite3.capi.sqlite3_js_db_export(raw.db.pointer) as Uint8Array;
  raw.db.close();
  return Copy.open(a.author, bytes);
}

/**
 * 1d-M1. The application's triggers stand down while merged rows are
 * applied (dai_projecting()), and are framed for the last-insert slot. Two
 * kinds were left as written: one named like the runtime's (`_cs_*`), and one
 * whose text already named dai_projecting(). Now the runtime's own triggers
 * are known by their bodies, not their names, so any other is guarded; a
 * guard is recognized only in the exact form the runtime writes; and a
 * trigger under a runtime name is refused as the application makes it.
 */
test("1d-M1: a trigger named like the runtime's, or naming dai_projecting(), stands down on merged rows like any other", async () => {
  // The release declares the trigger naming dai_projecting(); one under a runtime name the application makes is refused (R-W).
  const { a, b } = await base({
    extra: ["CREATE TRIGGER replay_only AFTER INSERT ON items WHEN dai_projecting() = 1 BEGIN INSERT INTO audit (item_id, what) VALUES (NEW.id, 'replay'); END"],
  });
  expect(() => a.db.exec("CREATE TRIGGER _cs_dup AFTER INSERT ON items BEGIN INSERT INTO audit (item_id, what) VALUES (NEW.id, 'dup'); END"), "made now").toThrow(
    /^CHANGES_REFUSED: /,
  );
  const c = await imported(a, "CREATE TRIGGER _cs_dup AFTER INSERT ON items BEGIN INSERT INTO audit (item_id, what) VALUES (NEW.id, 'dup'); END");
  b.db.exec("INSERT INTO items (title) VALUES ('Soap')");
  const bBytes = await b.bytes();
  await a.mergeFrom(bBytes);
  await c.mergeFrom(bBytes);
  expect(a.db.selectValues("SELECT what FROM audit WHERE what = 'replay'"), "the trigger naming dai_projecting() does not fire on the merged row").toEqual([]);
  expect(c.db.selectValues("SELECT what FROM audit WHERE what = 'dup'"), "the imported _cs_* trigger does not fire on the merged row").toEqual([]);
  c.db.exec("INSERT INTO items (title) VALUES ('Lamp')");
  expect(c.db.selectValues("SELECT what FROM audit WHERE what = 'dup'"), "and still fires on the application's own write").toEqual(["dup"]);
  await b.mergeFrom(await a.bytes());
  expect(a.state(), "converged").toBe(b.state());
  a.close();
  b.close();
  c.close();
});

/**
 * 1d-L1. A trigger whose body writes a runtime table is refused by the
 * authorizer when it would run, and a merged row's write fires it: every
 * merged row of its table was held. Now it is found when it is made, by
 * preparing (never running) the writes that would fire it: refused as the
 * application makes it, and dropped at open from an imported document, so
 * merged rows land.
 */
test("1d-L1: a trigger that writes a runtime table is refused when made and dropped at open, and merged rows land", async () => {
  const { a, b } = await base();
  expect(() => a.db.exec("CREATE TRIGGER items_forge AFTER INSERT ON items BEGIN DELETE FROM _cs_cell; END"), "made now").toThrow(/^CHANGES_REFUSED: /);
  expect(a.db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name = 'items_forge'"), "and not kept").toBe(0);
  const c = await imported(a, "CREATE TRIGGER items_forge AFTER UPDATE OF qty ON items BEGIN INSERT INTO _cs_flag (tbl, pk, kind) VALUES ('items', '[0]', 'held'); END");
  expect(c.changes.refused, "dropped at open").toContain("items_forge");
  b.db.exec("INSERT INTO items (title) VALUES ('Soap'); UPDATE items SET qty = 4 WHERE title = 'Bread';");
  await c.mergeFrom(await b.bytes());
  expect(c.held(), "no merged row is held").toEqual([]);
  expect(c.db.selectValue("SELECT qty FROM items WHERE title = 'Bread'")).toBe(4);
  a.close();
  b.close();
  c.close();
});

/**
 * 1d-L3. An apply that waited for the application's transaction ran only
 * from exec: a COMMIT through prepare().step() left the merged values
 * unapplied until the next exec. A prepared statement's step now ends the
 * wait as exec does.
 */
test("1d-L3: an apply waiting on a transaction runs when a prepared COMMIT ends it", async () => {
  const { a, b } = await base();
  b.db.exec("UPDATE items SET note = 'B-note' WHERE title = 'Bread'");
  const bBytes = await b.bytes();
  a.db.exec("BEGIN");
  a.db.exec("UPDATE items SET qty = 7 WHERE title = 'Bread'");
  await a.mergeFrom(bBytes);
  const commit = a.db.prepare("COMMIT");
  commit.step();
  commit.finalize();
  expect(a.db.selectObject("SELECT qty, note FROM items WHERE title = 'Bread'"), "applied as the transaction ends").toEqual({ qty: 7, note: "B-note" });
  a.close();
  b.close();
});
