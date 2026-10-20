import { expect, test } from "@playwright/test";
import { base, exchange, item } from "./scenarios.js";
import { Copy, openBytes, person } from "./copy.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/**
 * The data-interface catalog swept row by row (`handoff-2026-10-19.md`, the
 * catalog and Build 1e's table). Each test is named by the rows it holds:
 * a shape the data interface supports, carried exactly; or one it refuses as
 * it executes, with its sentence, before any data is accepted under it (R-V).
 */

/** Both copies after a two-way exchange from snapshots, and whether they converged. */
async function both(a: Copy, b: Copy): Promise<boolean> {
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  return a.state() === b.state();
}

/** An imported copy of A: A's stored bytes with `sql` run outside any runtime, reopened as A. */
async function imported(a: Copy, sql: string): Promise<Copy> {
  const raw = await openBytes(await a.bytes());
  raw.db.exec(sql);
  const bytes = raw.sqlite3.capi.sqlite3_js_db_export(raw.db.pointer) as Uint8Array;
  raw.db.close();
  return Copy.open(a.author, bytes);
}

const refusedWith = (c: Copy, sql: string, rule: RegExp): void => expect(() => c.db.exec(sql), sql).toThrow(rule);

test("C03: a WITHOUT ROWID table keyed in another order than its columns merges by its key", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE grid (x INTEGER, y TEXT, v TEXT, PRIMARY KEY (y, x)) WITHOUT ROWID"] });
  a.db.exec("INSERT INTO grid (x, y, v) VALUES (1, 'a', 'A1'), (2, 'a', 'A2')");
  b.db.exec("INSERT INTO grid (x, y, v) VALUES (1, 'b', 'B1')");
  const before = a.db.selectValue("SELECT last_insert_rowid()");
  expect(await both(a, b), "converged").toBe(true);
  expect(b.db.selectArrays("SELECT y, x, v FROM grid ORDER BY y, x")).toEqual([["a", 1, "A1"], ["a", 2, "A2"], ["b", 1, "B1"]]);
  a.db.exec("UPDATE grid SET v = 'A1!' WHERE x = 1 AND y = 'a'");
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT v FROM grid WHERE x = 1 AND y = 'a'")).toBe("A1!");
  expect(typeof before).toBe("number");
  a.close();
  b.close();
});

test("C04: a virtual table is refused as it is made and as it is written; its shadow tables are never adopted", async () => {
  const { a, b } = await base();
  refusedWith(a, "CREATE VIRTUAL TABLE docs USING fts5(body)", /^CHANGES_REFUSED: /);
  const c = await imported(a, "CREATE VIRTUAL TABLE docs USING fts5(body); INSERT INTO docs (body) VALUES ('kept here');");
  expect(c.rows.all("SELECT tbl FROM _cs_keys WHERE tbl LIKE 'docs%'"), "no shadow table is adopted").toEqual([]);
  refusedWith(c, "INSERT INTO docs (body) VALUES ('more')", /CHANGES_REFUSED: .*virtual table/);
  expect(c.db.selectValue("SELECT count(*) FROM docs WHERE docs MATCH 'kept'"), "and it is still read").toBe(1);
  c.db.exec("INSERT INTO items (title) VALUES ('ordinary')");
  expect(c.save()?.ops, "an ordinary save logs only the ordinary row").toBe(1);
  a.close();
  b.close();
  c.close();
});

test("C05: STORED and VIRTUAL generated columns among ordinary ones merge by their base values", async () => {
  const { a, b } = await base({
    extra: ["CREATE TABLE lines (id INTEGER PRIMARY KEY, qty INTEGER, total INTEGER GENERATED ALWAYS AS (qty * price) STORED, price INTEGER, label TEXT GENERATED ALWAYS AS (qty || 'x') VIRTUAL)"],
  });
  a.db.exec("INSERT INTO lines (qty, price) VALUES (2, 5)");
  b.db.exec("INSERT INTO lines (qty, price) VALUES (3, 7)");
  expect(await both(a, b)).toBe(true);
  expect(b.db.selectArrays("SELECT qty, price, total, label FROM lines ORDER BY qty")).toEqual([[2, 5, 10, "2x"], [3, 7, 21, "3x"]]);
  a.close();
  b.close();
});

test("C06 (R-W): a table the release does not declare is refused as the application makes it, in a transaction or not; nothing is kept", async () => {
  const { a, b } = await base();
  refusedWith(a, "BEGIN; CREATE TABLE gone (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO gone (v) VALUES ('x'); ROLLBACK;", /^CHANGES_REFUSED: This change needs a new version of the app/);
  expect(a.changes.inTransaction, "the script is refused whole, its BEGIN included").toBe(false);
  refusedWith(a, "CREATE TABLE kept (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO kept (v) VALUES ('made and filled');", /^CHANGES_REFUSED: This change needs a new version of the app/);
  expect(a.db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name IN ('gone', 'kept')")).toBe(0);
  expect(a.save(), "nothing to log").toBeNull();
  a.close();
  b.close();
});

test("C12: net-zero work logs nothing; a delete and a re-insert at one key is an update", async () => {
  const { a, b } = await base();
  a.db.exec("INSERT INTO items (title) VALUES ('brief'); DELETE FROM items WHERE title = 'brief';");
  expect(a.save(), "insert then delete").toBeNull();
  const bread = item(a, "Bread");
  a.db.exec({ sql: "DELETE FROM items WHERE id = ?", bind: [bread] });
  a.db.exec({ sql: "INSERT INTO items (id, title, qty) VALUES (?, 'Bread', 9)", bind: [bread] });
  const from = Number(a.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE _r_replica = ?", [a.author.author])) + 1;
  a.save();
  expect([...(a.opsSince(from).get(`items|[${bread}]`) ?? [])], "one update").toEqual(["U"]);
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT qty FROM items WHERE title = 'Bread'")).toBe(9);
  a.close();
  b.close();
});

test("K01: a DESC key, a STRICT table, a quoted name and a comment inside the key's definition are all ranged", async () => {
  const { a, b } = await base({
    extra: [
      `CREATE TABLE k_desc (id INTEGER PRIMARY KEY DESC, v TEXT);
       CREATE TABLE k_strict (id INTEGER PRIMARY KEY, v TEXT) STRICT;
       CREATE TABLE "k quoted" ("the id" INTEGER PRIMARY KEY, v TEXT);
       CREATE TABLE k_comment (id /* the key */ INTEGER PRIMARY KEY, v TEXT);`,
    ],
  });
  for (const [t, c] of [["k_desc", "id"], ["k_strict", "id"], ["k quoted", "the id"], ["k_comment", "id"]]) {
    a.db.exec(`INSERT INTO "${t}" (v) VALUES ('x')`);
    expect(Number(a.db.selectValue(`SELECT "${c}" FROM "${t}"`)), `${t}: ranged`).toBeGreaterThanOrEqual(2 ** 32);
  }
  a.db.exec("INSERT INTO k_comment (id, v) VALUES (7, 'named')");
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT v FROM k_comment WHERE id = 7")).toBe("named");
  a.close();
  b.close();
});

test("K02: explicit 0, negative and boundary ids are kept; an omitted, NULL or DEFAULT VALUES id is ranged", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE ids (id INTEGER PRIMARY KEY, v TEXT DEFAULT 'd')"] });
  a.db.exec("INSERT INTO ids (id, v) VALUES (0, 'zero'), (-5, 'negative'), (9223372036854775807, 'max')");
  a.db.exec({ sql: "INSERT INTO ids (id, v) VALUES (?, 'bound null')", bind: [null] });
  a.db.exec("INSERT INTO ids (id, v) VALUES (NULL, 'sql null'); INSERT INTO ids DEFAULT VALUES;");
  const auto = a.db.selectValues("SELECT id FROM ids WHERE v IN ('bound null', 'sql null', 'd')") as number[];
  expect(auto.length).toBe(3);
  expect(auto.every((id) => Number(id) >= 2 ** 32 && Number(id) < 2 ** 53)).toBe(true);
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectArrays("SELECT id, v FROM ids WHERE v IN ('zero', 'negative', 'max') ORDER BY id")).toEqual([
    [-5, "negative"],
    [0, "zero"],
    [9223372036854775807n, "max"],
  ]);
  a.close();
  b.close();
});

test("K04/K05/D06: ids from INSERT…SELECT, a multi-row insert, an UPSERT and a trigger are ranged and final for RETURNING and the trigger", async () => {
  const { a, b } = await base({
    extra: [
      `CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
       CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), note TEXT);
       CREATE TRIGGER parent_child AFTER INSERT ON parent BEGIN INSERT INTO child (parent_id, note) VALUES (NEW.id, 'made by the trigger'); END;`,
    ],
  });
  const returned = a.db.selectValue("INSERT INTO parent (name) VALUES ('p1') RETURNING id");
  a.db.exec("INSERT INTO parent (name) SELECT title FROM items WHERE title IN ('Map', 'Rope'); INSERT INTO parent (name) VALUES ('m1'), ('m2');");
  a.db.exec("INSERT INTO parent (name) VALUES ('p1'), ('u1') ON CONFLICT (name) DO UPDATE SET name = excluded.name");
  const ids = a.db.selectValues("SELECT id FROM parent") as number[];
  expect(ids.every((id) => Number(id) >= 2 ** 32), "every id is ranged").toBe(true);
  expect(a.db.selectValue("SELECT id FROM parent WHERE name = 'p1'"), "RETURNING saw the final id").toBe(returned);
  expect(a.db.selectValue("SELECT count(*) FROM child c JOIN parent p ON p.id = c.parent_id"), "the trigger saw each final id").toBe(ids.length);
  expect(await both(a, b)).toBe(true);
  a.close();
  b.close();
});

test("K08: an author's range, used up, refuses the next omitted id, and an explicit one still writes", async () => {
  const { a, b } = await base();
  (a.changes as Any).counter = 2 ** 32 - 1;
  refusedWith(a, "INSERT INTO items (title) VALUES ('one too many')", /ID_RANGE_EXHAUSTED/);
  a.db.exec("INSERT INTO items (id, title) VALUES (12345, 'named')");
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT title FROM items WHERE id = 12345")).toBe("named");
  a.close();
  b.close();
});

test("K11: rowid on a ranged-key table is refused with its sentence; on a text-keyed table it is SQLite's own", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE tags (code TEXT PRIMARY KEY, label TEXT)"] });
  for (const alias of ["rowid", "_rowid_", "oid"]) refusedWith(a, `SELECT ${alias} FROM items`, /CHANGES_REFUSED: .*not rowid/);
  refusedWith(a, "UPDATE items SET qty = 2 WHERE rowid = 1", /CHANGES_REFUSED: .*not rowid/);
  a.db.exec("INSERT INTO tags (code, label) VALUES ('red', 'Red')");
  expect(typeof a.db.selectValue("SELECT rowid FROM tags")).toBe("number");
  a.db.exec("INSERT INTO items (title) VALUES ('still fine')");
  expect(a.save()).not.toBeNull();
  a.close();
  b.close();
});

test("K12: a key moved on one copy while the other edits the old key keeps both rows, the move's row flagged", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE codes (code TEXT PRIMARY KEY, v TEXT)", "INSERT INTO codes (code, v) VALUES ('old', 'base')"] });
  a.db.exec("UPDATE codes SET code = 'new' WHERE code = 'old'");
  b.db.exec("UPDATE codes SET v = 'edited' WHERE code = 'old'");
  expect(await both(a, b)).toBe(true);
  expect(a.db.selectArrays("SELECT code, v FROM codes ORDER BY code")).toEqual([["new", "base"], ["old", "edited"]]);
  expect(a.flags().filter((f) => f.tbl === "codes").map((f) => f.kind)).toEqual(["delete-conflict"]);
  a.close();
  b.close();
});

test("D01/D03/D04: UPSERT branches, a FAIL midway and OR IGNORE log what SQLite kept", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT UNIQUE, n INTEGER CHECK (n < 100))", "INSERT INTO u (id, name, n) VALUES (1, 'one', 1)"] });
  a.db.exec("INSERT INTO u (name, n) VALUES ('one', 5) ON CONFLICT (name) DO UPDATE SET n = excluded.n WHERE excluded.n > u.n");
  a.db.exec("INSERT INTO u (name, n) VALUES ('one', 2) ON CONFLICT (name) DO UPDATE SET n = excluded.n WHERE excluded.n > u.n");
  a.db.exec("INSERT INTO u (name, n) VALUES ('one', 9) ON CONFLICT DO NOTHING");
  expect(() => a.db.exec("INSERT OR FAIL INTO u (id, name, n) VALUES (10, 'ten', 10), (11, 'eleven', 500), (12, 'twelve', 12)")).toThrow(/CHECK/);
  a.db.exec("INSERT OR IGNORE INTO u (id, name, n) VALUES (13, 'one', 13), (14, 'fourteen', 14)");
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectArrays("SELECT id, name, n FROM u ORDER BY id")).toEqual(a.db.selectArrays("SELECT id, name, n FROM u ORDER BY id"));
  expect(b.db.selectArrays("SELECT name, n FROM u ORDER BY id")).toEqual([["one", 5], ["ten", 10], ["fourteen", 14]]);
  a.close();
  b.close();
});

test("D07: a RETURNING statement stepped once and reset is logged whole", async () => {
  const { a, b } = await base();
  const stmt = a.db.prepare("UPDATE items SET qty = qty + 10 RETURNING id");
  stmt.step();
  stmt.reset();
  stmt.finalize();
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValues("SELECT qty FROM items ORDER BY id")).toEqual(a.db.selectValues("SELECT qty FROM items ORDER BY id"));
  expect((b.db.selectValues("SELECT qty FROM items") as number[]).every((q) => q === 11)).toBe(true);
  a.close();
  b.close();
});

test("D08: changes() and total_changes() answer for the application's statements, across a save and a merge", async () => {
  const { a, b } = await base();
  b.db.exec("INSERT INTO items (title) VALUES ('from B')");
  const bBytes = await b.bytes();
  const total = Number(a.db.selectValue("SELECT total_changes()"));
  a.db.exec("UPDATE items SET qty = 4 WHERE title IN ('Map', 'Rope')");
  expect(a.db.selectValue("SELECT changes()"), "as SQLite answers it").toBe(2);
  a.save();
  await a.mergeFrom(bBytes);
  expect(a.db.selectValue("SELECT changes()"), "after a save and a merge, still the application's").toBe(2);
  expect(a.db.changes(), "and from the handle").toBe(2);
  expect(Number(a.db.selectValue("SELECT total_changes()")) - total, "the application's rows only").toBe(2);
  expect(Number(a.db.changes(true)) - total).toBe(2);
  a.db.exec("UPDATE items SET qty = 5 WHERE title = 'Nothing'");
  expect(a.db.selectValue("SELECT changes()"), "a statement that matched nothing").toBe(0);
  a.close();
  b.close();
});

test("D09/D10: a script with quoted semicolons, a trigger body and a recursive CTE; random() and the clock travel as stored", async () => {
  const { a, b } = await base({
    extra: [
      "CREATE TABLE stamped (id INTEGER PRIMARY KEY, r INTEGER DEFAULT (random()), at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')), n INTEGER)",
      "CREATE TRIGGER t_semi AFTER INSERT ON stamped BEGIN UPDATE items SET note = 'a; b' WHERE title = 'semi; colon'; END;",
    ],
  });
  a.db.exec(`INSERT INTO items (title) VALUES ('semi; colon'); -- a comment; with one
    WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 5) INSERT INTO stamped (n) SELECT n FROM c;
    UPDATE items SET qty = 2 WHERE title = 'Map';`);
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectArrays("SELECT n, r, at FROM stamped ORDER BY n"), "the stored values, never rerolled").toEqual(a.db.selectArrays("SELECT n, r, at FROM stamped ORDER BY n"));
  expect(b.db.selectValue("SELECT note FROM items WHERE title = 'semi; colon'")).toBe("a; b");
  a.close();
  b.close();
});

test("D11: a function under a runtime name is refused; an application function's writes are logged", async () => {
  const { a, b } = await base();
  for (const name of ["dai_projecting", "dai_id", "DAI_KEY", "last_insert_rowid", "changes", "total_changes"]) {
    expect(() => a.db.createFunction(name, () => 1), name).toThrow(/CHANGES_REFUSED: .*dai_/);
  }
  a.db.createFunction("stamp", (_c: unknown, t: unknown) => {
    a.db.exec({ sql: "UPDATE items SET note = 'stamped' WHERE title = ?", bind: [t] });
    return 1;
  });
  a.db.exec("SELECT stamp('Map')");
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT note FROM items WHERE title = 'Map'")).toBe("stamped");
  a.close();
  b.close();
});

test("T02: a view's INSTEAD OF trigger writes base tables, which travel; the view is not run again on the other copy", async () => {
  const { a, b } = await base({
    extra: [
      `CREATE TABLE ledger (id INTEGER PRIMARY KEY, what TEXT);
       CREATE VIEW entry AS SELECT title, note FROM items;
       CREATE TRIGGER entry_in INSTEAD OF INSERT ON entry BEGIN INSERT INTO items (title, note) VALUES (NEW.title, NEW.note); INSERT INTO ledger (what) VALUES (NEW.title); END;`,
    ],
  });
  a.db.exec("INSERT INTO entry (title, note) VALUES ('Kettle', 'via the view')");
  expect(await both(a, b)).toBe(true);
  expect(b.db.selectValues("SELECT what FROM ledger")).toEqual(["Kettle"]);
  a.close();
  b.close();
});

test("T03/T05: a SET NULL action and RAISE(IGNORE) and RAISE(ABORT) keep what SQLite kept, applied once", async () => {
  const { a, b } = await base({
    extra: [
      `CREATE TABLE owner (id INTEGER PRIMARY KEY, name TEXT);
       CREATE TABLE pet (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES owner(id) ON DELETE SET NULL, name TEXT);
       CREATE TABLE trail (id INTEGER PRIMARY KEY, what TEXT);
       CREATE TRIGGER guard BEFORE INSERT ON pet WHEN NEW.name = 'skip' BEGIN INSERT INTO trail (what) VALUES ('ignored'); SELECT RAISE(IGNORE); END;
       CREATE TRIGGER stop BEFORE INSERT ON pet WHEN NEW.name = 'stop' BEGIN INSERT INTO trail (what) VALUES ('aborted'); SELECT RAISE(ABORT, 'no'); END;`,
      "INSERT INTO owner (id, name) VALUES (1, 'Ann'); INSERT INTO pet (id, owner_id, name) VALUES (1, 1, 'Rex');",
    ],
  });
  a.db.exec("DELETE FROM owner WHERE id = 1");
  a.db.exec("INSERT INTO pet (name) VALUES ('skip')");
  expect(() => a.db.exec("INSERT INTO pet (name) VALUES ('stop')")).toThrow(/no/);
  expect(await both(a, b)).toBe(true);
  expect(b.db.selectArrays("SELECT id, owner_id, name FROM pet")).toEqual([[1, null, "Rex"]]);
  expect(b.db.selectValues("SELECT what FROM trail")).toEqual(["ignored"]);
  a.close();
  b.close();
});

test("T11, its views (D264): an imported runtime view with other text is put back at open, and the apply reads the runtime's", async () => {
  const { a, b } = await base();
  b.db.exec("INSERT INTO items (title) VALUES ('from B')");
  const c = await imported(a, "DROP VIEW _cs_log_current; CREATE VIEW _cs_log_current AS SELECT * FROM _cs_log WHERE 0;");
  expect(c.changes.refused, "put back at open").toContain("_cs_log_current");
  await c.mergeFrom(await b.bytes());
  expect(c.db.selectValue("SELECT count(*) FROM items WHERE title = 'from B'"), "the merge is applied").toBe(1);
  a.close();
  b.close();
  c.close();
});

test("T12: an apply that throws leaves the connection as it found it: foreign keys on, no transaction, triggers not standing down", async () => {
  const { a, b } = await base({
    extra: ["CREATE TABLE seen (what TEXT); CREATE TRIGGER seen_it AFTER INSERT ON items BEGIN INSERT INTO seen (what) VALUES (NEW.title); END;"],
  });
  b.db.exec("INSERT INTO items (title) VALUES ('from B')");
  const bBytes = await b.bytes();
  const changes = a.changes as Any;
  const project = changes.project.bind(changes);
  changes.project = () => {
    throw new Error("forced in the apply");
  };
  try {
    await expect(a.mergeFrom(bBytes)).rejects.toThrow(/forced in the apply/);
  } finally {
    changes.project = project;
  }
  expect(a.db.selectValue("PRAGMA foreign_keys")).toBe(1);
  expect(a.changes.inTransaction).toBe(false);
  expect(a.db.selectValue("SELECT dai_projecting()")).toBe(0);
  expect(a.db.selectValue("SELECT count(*) FROM items WHERE title = 'from B'"), "nothing of the failed apply").toBe(0);
  a.db.exec("INSERT INTO items (title) VALUES ('mine')");
  expect(a.db.selectValues("SELECT what FROM seen WHERE what IN ('mine', 'from B')"), "the application's trigger runs for the application, never for the failed apply").toEqual(["mine"]);
  await a.mergeFrom(bBytes);
  expect(a.db.selectValue("SELECT count(*) FROM items WHERE title = 'from B'"), "the next merge applies it").toBe(1);
  a.close();
  b.close();
});

/*
 * S03 (a rebuild reordering columns) and S04 (a UNIQUE index added on one
 * copy) are release changes under R-W: the application's schema statements
 * are refused (`release-schema.spec.ts`), and what a release may change is
 * Build 2's (D277, D278).
 */

test("S06: ATTACH is refused", async () => {
  const { a, b } = await base();
  refusedWith(a, "ATTACH ':memory:' AS side", /CHANGES_REFUSED: .*ATTACH/);
  a.close();
  b.close();
});

test("S07 (D266, R-W): a TEMP table named like an application table is refused as it is made; the apply writes main", async () => {
  const { a, b } = await base();
  b.db.exec("INSERT INTO items (title) VALUES ('from B'); UPDATE items SET qty = 3 WHERE title = 'Map';");
  const bBytes = await b.bytes();
  refusedWith(a, "CREATE TEMP TABLE items (id INTEGER PRIMARY KEY, title TEXT, qty INTEGER, note TEXT, category_id INTEGER, done INTEGER)", /^CHANGES_REFUSED: /);
  expect(a.db.selectValues("SELECT name FROM temp.sqlite_schema WHERE name NOT LIKE '\\_cs\\_%' ESCAPE '\\'"), "nothing in temp but the runtime's").toEqual([]);
  await a.mergeFrom(bBytes);
  expect(a.db.selectValue("SELECT count(*) FROM main.items WHERE title = 'from B'")).toBe(1);
  expect(a.db.selectValue("SELECT qty FROM main.items WHERE title = 'Map'")).toBe(3);
  a.close();
  b.close();
});

test("S09: a statement prepared before a P3 refusal is refused when it steps", async () => {
  const { a, b } = await base();
  const later = a.db.prepare("INSERT INTO items (title) VALUES ('prepared before')");
  a.db.exec("INSERT INTO items (title) VALUES (CAST(x'ff41' AS TEXT))");
  expect(() => a.save()).toThrow(/^CHANGES_SAVE_REFUSED/);
  expect(() => later.step(), "the held write").toThrow(/not authorized/);
  later.finalize();
  expect(a.db.selectValue("SELECT count(*) FROM items WHERE title = 'prepared before'")).toBe(0);
  a.close();
  b.close();
});

test("S10/S12: VACUUM and ANALYZE log nothing and move no key; sqlite_stat1 is never captured", async () => {
  const { a, b } = await base({ extra: ["CREATE INDEX by_title ON items (title)"] });
  a.db.exec("ANALYZE; VACUUM;");
  expect(a.save(), "nothing to log").toBeNull();
  a.db.exec("UPDATE items SET qty = 8 WHERE title = 'Tent'");
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT qty FROM items WHERE title = 'Tent'")).toBe(8);
  expect(a.written().some((w) => w.includes("sqlite_stat"))).toBe(false);
  a.close();
  b.close();
});

test("P03 (D265): the pragmas the runtime rests on are refused when set; reading them, and user_version, are not", async () => {
  const { a, b } = await base();
  for (const p of ["writable_schema = 1", "schema_version = 99", "ignore_check_constraints = 1", "legacy_alter_table = 1", "trusted_schema = 1"]) {
    refusedWith(a, `PRAGMA ${p}`, /CHANGES_REFUSED: PRAGMA/);
  }
  expect(a.db.selectValue("PRAGMA writable_schema")).toBe(0);
  a.db.exec("PRAGMA user_version = 3");
  expect(a.db.selectValue("PRAGMA user_version")).toBe(3);
  a.close();
  b.close();
});

test("Q04: a deferred foreign key failing at COMMIT leaves the transaction open and nothing logged; after a ROLLBACK, nothing", async () => {
  const { a, b } = await base();
  const logged = (): number => Number(a.db.selectValue("SELECT count(*) FROM _cs_log WHERE _r_replica = ?", [a.author.author]));
  const before = logged();
  a.db.exec("PRAGMA defer_foreign_keys = ON; BEGIN; INSERT INTO audit (item_id, what) VALUES (999999, 'orphan');");
  expect(() => a.db.exec("COMMIT")).toThrow(/FOREIGN KEY/);
  expect(a.changes.inTransaction, "still open, as SQLite says").toBe(true);
  expect(a.save(), "nothing published").toBeNull();
  a.db.exec("ROLLBACK");
  expect(a.save()).toBeNull();
  expect(logged()).toBe(before);
  a.close();
  b.close();
});

test("Q06: two saves with no edit between log nothing; one edit after logs one change", async () => {
  const { a, b } = await base();
  expect(a.save()).toBeNull();
  expect(a.save()).toBeNull();
  a.db.exec("UPDATE items SET qty = 2 WHERE title = 'Map'");
  expect(a.save()?.ops).toBe(1);
  expect(a.save()).toBeNull();
  a.close();
  b.close();
});

test("Q11: a session that cannot start over after a logged save refuses the document, its changes logged once", async () => {
  const { a, b } = await base();
  const capi = a.sqlite3.capi;
  const create = capi.sqlite3session_create;
  a.db.exec("UPDATE items SET qty = 7 WHERE title = 'Map'");
  capi.sqlite3session_create = () => 7;
  try {
    expect(() => a.save()).toThrow(/^CHANGES_SAVE_REFUSED/);
  } finally {
    capi.sqlite3session_create = create;
  }
  expect(a.save(), "no second log of the same change").toBeNull();
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT qty FROM items WHERE title = 'Map'"), "logged once, and it travels").toBe(7);
  expect(a.written().filter((w) => JSON.parse(w)[2] === "qty" && JSON.parse(w)[4] === 7)).toHaveLength(1);
  a.close();
  b.close();
});

test("M01: a copy that saw an earlier value and did not write it never undoes a later one, in either order of delivery", async () => {
  const { a, b } = await base();
  const c = await Copy.open(await person(), await a.bytes());
  a.db.exec("UPDATE items SET done = 1 WHERE title = 'Tent'");
  const first = await a.bytes();
  await b.mergeFrom(first);
  a.db.exec("UPDATE items SET done = 0 WHERE title = 'Tent'");
  b.db.exec("UPDATE items SET qty = 3 WHERE title = 'Tent'");
  expect(await both(a, b)).toBe(true);
  expect(a.db.selectObject("SELECT done, qty FROM items WHERE title = 'Tent'")).toEqual({ done: 0, qty: 3 });
  expect(a.flags(), "no conflict: B never wrote done").toEqual([]);
  // The later batch first, the earlier after: the same state.
  await c.mergeFrom(await a.bytes());
  await c.mergeFrom(first);
  expect(c.db.selectObject("SELECT done, qty FROM items WHERE title = 'Tent'")).toEqual({ done: 0, qty: 3 });
  a.close();
  b.close();
  c.close();
});

test("M03: an expression UNIQUE index refuses a merged row, held and flagged, both kept", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE emails (id INTEGER PRIMARY KEY, address TEXT)", "CREATE UNIQUE INDEX one_address ON emails (lower(address))"] });
  a.db.exec("INSERT INTO emails (address) VALUES ('Ann@X')");
  b.db.exec("INSERT INTO emails (address) VALUES ('ann@x')");
  expect(await both(a, b)).toBe(true);
  expect(a.held().map((h) => h.tbl)).toEqual(["emails"]);
  expect(a.db.selectValue("SELECT count(*) FROM emails")).toBe(1);
  a.close();
  b.close();
});

test("M04: a UNIQUE swap made through a placeholder lands on the other copy, nothing held", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE slots (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE)", "INSERT INTO slots (id, code) VALUES (1, 'a'), (2, 'b')"] });
  a.db.exec("BEGIN; UPDATE slots SET code = 'tmp' WHERE id = 1; UPDATE slots SET code = 'a' WHERE id = 2; UPDATE slots SET code = 'b' WHERE id = 1; COMMIT;");
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectArrays("SELECT id, code FROM slots ORDER BY id")).toEqual([[1, "b"], [2, "a"]]);
  expect([b.flags(), b.held()]).toEqual([[], []]);
  a.close();
  b.close();
});

test("M11: a resolution names the alternatives it saw; a third writer's, unseen, stays pending", async () => {
  const { a, b } = await base();
  const c = await Copy.open(await person(), await a.bytes());
  a.db.exec("UPDATE items SET note = 'A' WHERE title = 'Stove'");
  b.db.exec("UPDATE items SET note = 'B' WHERE title = 'Stove'");
  c.db.exec("UPDATE items SET note = 'C' WHERE title = 'Stove'");
  const cBytes = await c.bytes();
  await a.mergeFrom(await b.bytes());
  expect(a.flags().map((f) => f.kind)).toContain("pending");
  // The resolution is the explicit call (R-X §4): it names the alternatives it was shown.
  const seen = a.changes.observe("items", [a.db.selectValue("SELECT id FROM items WHERE title = 'Stove'")], ["note"]);
  a.changes.resolve(seen.token, seen.shown);
  expect(a.flags(), "resolved").toEqual([]);
  await a.mergeFrom(cBytes);
  expect(a.flags().map((f) => f.kind), "C's unseen value is still a conflict").toEqual(["pending"]);
  expect(a.everyValue().size).toBeGreaterThan(0);
  a.close();
  b.close();
  c.close();
});

test("M14: a column set to NULL travels as NULL; a column the edit left alone is not written", async () => {
  const { a, b } = await base();
  a.db.exec("UPDATE items SET note = 'n' WHERE title = 'Map'");
  await b.mergeFrom(await a.bytes());
  a.db.exec("UPDATE items SET note = NULL WHERE title = 'Map'");
  b.db.exec("UPDATE items SET qty = 4 WHERE title = 'Map'");
  expect(await both(a, b)).toBe(true);
  expect(b.db.selectObject("SELECT qty, note FROM items WHERE title = 'Map'")).toEqual({ qty: 4, note: null });
  a.close();
  b.close();
});

test("M17: two json_set calls on different paths of one column are one conflict, both kept", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE prefs (id INTEGER PRIMARY KEY, doc TEXT)", "INSERT INTO prefs (id, doc) VALUES (1, '{}')"] });
  a.db.exec("UPDATE prefs SET doc = json_set(doc, '$.a', 1) WHERE id = 1");
  b.db.exec("UPDATE prefs SET doc = json_set(doc, '$.b', 2) WHERE id = 1");
  expect(await both(a, b)).toBe(true);
  expect(a.flags().map((f) => [f.tbl, f.kind])).toEqual([["prefs", "pending"]]);
  a.close();
  b.close();
});

test("M19: the same copy merged twice changes nothing the second time", async () => {
  const o = await exchange((a, b) => {
    a.db.exec("INSERT INTO items (title) VALUES ('once')");
    b.db.exec("UPDATE items SET qty = 2 WHERE title = 'Rope'");
  });
  const before = o.a.state();
  const again = await o.a.mergeFrom(o.bBytes);
  expect(again.projected.changesets, "nothing new to apply").toBe(0);
  expect(o.a.state()).toBe(before);
  o.a.close();
  o.b.close();
});
