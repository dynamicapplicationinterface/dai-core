import { expect, test } from "@playwright/test";
import { Copy } from "./copy.js";
import { base } from "./scenarios.js";

/**
 * R-W: the schema belongs to the release. Declared in schema.sql, run by the
 * host before the application has the handle, and changed only through a
 * release. The application's DDL is refused at prepare, through every entry
 * point, before any effect. The one admission is a CREATE ... IF NOT EXISTS
 * whose object exists with the release's own definition: a verified no-op.
 *
 * External review 2026-10-20, RW-01 to RW-03; the review of Build 1e
 * (`handoff-2026-10-19.md`), whose DDL forms are each refused here.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const DDL = "This change needs a new version of the app; the current version was left unchanged.";
const DAMAGED = "Part of this copy's stored structure is missing; the copy was left unchanged, and the host repairs it when the document is next opened.";

/** The release's own index, view and trigger, beside the base tables. */
const RELEASE = [
  "CREATE INDEX IF NOT EXISTS items_by_title ON items (title)",
  "CREATE VIEW IF NOT EXISTS open_items AS SELECT id, title FROM items WHERE done = 0",
  "CREATE TRIGGER IF NOT EXISTS audit_note AFTER UPDATE OF note ON items BEGIN INSERT INTO audit (item_id, what) VALUES (NEW.id, 'noted'); END",
];

async function fresh(): Promise<Copy> {
  const { a, b } = await base({ extra: RELEASE });
  b.close();
  expect(a.save()).toBeNull();
  return a;
}

/**
 * Everything a schema statement could move: the schema, its version, the data,
 * the log and the frontier. The capture is read by `nothingCaptured`: the
 * session keeps a record of a row written in a transaction that rolled back,
 * so `dirty` reads true there with nothing to log.
 */
function snapshot(c: Copy): string {
  const db = c.db;
  return JSON.stringify({
    schema: db.selectObjects("SELECT 'main' AS s, type, name, sql FROM main.sqlite_schema UNION ALL SELECT 'temp', type, name, sql FROM temp.sqlite_schema ORDER BY 1, 2, 3"),
    databases: db.selectValues("SELECT name FROM pragma_database_list ORDER BY name"),
    version: db.selectValue("PRAGMA schema_version"),
    foreignKeys: db.selectValue("PRAGMA foreign_keys"),
    data: c.dump(),
    log: db.selectValue("SELECT count(*) FROM _cs_log"),
    ingested: db.selectValue("SELECT count(*) FROM _cs_ingested"),
    flags: c.flags(),
  });
}

/** Each way the application can run one statement: exec as text, exec as an object, prepare and step, a select helper. */
const ROUTES: Record<string, (db: Any, sql: string) => void> = {
  "exec text": (db, sql) => void db.exec(sql),
  "exec object": (db, sql) => void db.exec({ sql }),
  "prepare, step": (db, sql) => {
    const s = db.prepare(sql);
    try {
      s.step();
    } finally {
      s.finalize();
    }
  },
  selectValue: (db, sql) => void db.selectValue(sql),
};

const refused = (run: () => void, sentence: string): void => {
  let error: unknown = null;
  try {
    run();
  } catch (e) {
    error = e;
  }
  expect(error, "refused").not.toBeNull();
  expect(String((error as Error).message)).toContain(`CHANGES_REFUSED: ${sentence}`);
};

test("RW-01: a matching IF NOT EXISTS moves nothing, through every route, in a transaction or not", async () => {
  const a = await fresh();
  // The release's own definitions, spelled otherwise: case, whitespace, comments, quoting, a main. qualifier.
  const same = [
    `create table if not exists "items" ( id integer primary key, category_id integer references categories(id),
       title text not null, qty integer not null default 1, note text, done integer not null default 0 );`,
    "CREATE TABLE IF NOT EXISTS main.categories (id INTEGER PRIMARY KEY, /* the same */ name TEXT NOT NULL UNIQUE)",
    "CREATE INDEX IF NOT EXISTS [items_by_title] ON items(title) -- the release's",
    "CREATE VIEW IF NOT EXISTS open_items AS SELECT id, title FROM items WHERE done = 0;",
    "create trigger if not exists audit_note after update of note on items begin insert into audit (item_id, what) values (new.id, 'noted'); end",
  ];
  const before = snapshot(a);
  for (const sql of same) {
    for (const [route, run] of Object.entries(ROUTES)) {
      run(a.db, sql);
      expect(snapshot(a), `${route}: ${sql.slice(0, 40)}`).toBe(before);
      a.db.exec("BEGIN");
      run(a.db, sql);
      a.db.exec("COMMIT");
      expect(snapshot(a), `${route}, in a transaction: ${sql.slice(0, 40)}`).toBe(before);
    }
  }
  expect(a.changes.dirty, "nothing captured").toBe(false);
  expect(a.save()).toBeNull();
  a.close();
});

test("RW-02: a different definition, a different type, or an object the release does not declare is refused", async () => {
  const a = await fresh();
  const wrong = [
    // A column short.
    "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT NOT NULL)",
    // A table's name, as a view.
    "CREATE VIEW IF NOT EXISTS items AS SELECT 1",
    // The release's index name over another column: SQLite would call it done.
    "CREATE INDEX IF NOT EXISTS items_by_title ON items (note)",
    // The release's trigger name with another body.
    "CREATE TRIGGER IF NOT EXISTS audit_note AFTER UPDATE OF note ON items BEGIN DELETE FROM audit; END",
    // A view by another query.
    "CREATE VIEW IF NOT EXISTS open_items AS SELECT id FROM items",
    // Not declared at all.
    "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)",
    "CREATE INDEX IF NOT EXISTS items_by_note ON items (note)",
    // The release's own text, in TEMP.
    "CREATE TEMP TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)",
    "CREATE TABLE IF NOT EXISTS temp.categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)",
  ];
  const before = snapshot(a);
  for (const sql of wrong) {
    for (const [route, run] of Object.entries(ROUTES)) {
      refused(() => run(a.db, sql), DDL);
      expect(snapshot(a), `${route}: ${sql}`).toBe(before);
      a.db.exec("BEGIN");
      refused(() => run(a.db, sql), DDL);
      expect(a.changes.inTransaction, `${route}, the transaction kept: ${sql}`).toBe(true);
      a.db.exec("ROLLBACK");
      expect(snapshot(a), `${route}, in a transaction: ${sql}`).toBe(before);
    }
  }
  expect(a.save(), "nothing captured").toBeNull();
  a.close();
});

test("RW-03: a missing declared object is a damaged mount, never made again by the application; the host repairs it", async () => {
  const a = await fresh();
  // Damage the mount from outside the application: the index the release declares is gone.
  a.changes.trusted(() => a.db.exec("DROP INDEX items_by_title"));
  const before = snapshot(a);
  for (const [route, run] of Object.entries(ROUTES)) {
    refused(() => run(a.db, "CREATE INDEX IF NOT EXISTS items_by_title ON items (title)"), DAMAGED);
    expect(snapshot(a), route).toBe(before);
  }
  expect(a.db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name = 'items_by_title'")).toBe(0);
  // The host runs the release's schema at the next open: the index is back, and the data is as it was.
  const again = await Copy.reopen(a.author, await a.bytes(), a);
  expect(again.db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name = 'items_by_title'")).toBe(1);
  expect(again.dump()).toEqual(a.dump());
  again.close();
  a.close();
});

test("RW-03: every DDL form the Build 1e review ran is refused before any effect, in a transaction or not", async () => {
  const forms = [
    "ALTER TABLE items ADD COLUMN extra TEXT",
    "ALTER TABLE items RENAME COLUMN note TO memo",
    "ALTER TABLE items RENAME TO things",
    "ALTER TABLE items DROP COLUMN note",
    'ALTER TABLE audit RENAME TO "_CS_audit"',
    "ALTER TABLE audit RENAME TO _dai_audit",
    "ALTER TABLE audit RENAME TO ſqlite_audit",
    "DROP TABLE audit",
    "DROP TABLE IF EXISTS nothing_here",
    "DROP INDEX items_by_title",
    "DROP VIEW open_items",
    "DROP TRIGGER audit_note",
    'DROP TRIGGER "_cs_id_items"',
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
    "CREATE TABLE ſqlite_notes (x)",
    "CREATE TABLE ＳＱＬＩＴＥ_notes (x)",
    "CREATE TABLE copies AS SELECT * FROM items",
    "CREATE INDEX items_by_note ON items (note)",
    "CREATE UNIQUE INDEX one_title ON items (title)",
    "CREATE TRIGGER items_dup AFTER INSERT ON items BEGIN INSERT INTO audit (item_id, what) VALUES (NEW.id, 'dup'); END",
    "CREATE VIEW titles AS SELECT title FROM items",
    "CREATE VIRTUAL TABLE found USING fts5(body)",
    "CREATE TEMP TABLE scratch (x)",
    "CREATE TABLE temp.scratch (x)",
    "CREATE TEMP VIEW scratch AS SELECT 1",
    "CREATE TEMP TRIGGER scratch AFTER INSERT ON items BEGIN SELECT 1; END",
    "EXPLAIN CREATE TABLE notes (x)",
  ];
  const a = await fresh();
  const before = snapshot(a);
  for (const sql of forms) {
    for (const [route, run] of Object.entries(ROUTES)) {
      refused(() => run(a.db, sql), DDL);
      expect(snapshot(a), `${route}: ${sql}`).toBe(before);
      a.db.exec("BEGIN");
      a.db.exec("UPDATE items SET qty = 7 WHERE title = 'Map'");
      refused(() => run(a.db, sql), DDL);
      expect(a.changes.inTransaction, `${route}, the transaction kept: ${sql}`).toBe(true);
      expect(a.db.selectValue("SELECT qty FROM items WHERE title = 'Map'"), `${route}, the write before kept: ${sql}`).toBe(7);
      a.db.exec("ROLLBACK");
      expect(snapshot(a), `${route}, in a transaction: ${sql}`).toBe(before);
    }
  }
  // A script is refused whole: nothing in front of its DDL runs, a pragma and a BEGIN included.
  const scripts = [
    "INSERT INTO items (title) VALUES ('early'); ALTER TABLE items ADD COLUMN extra TEXT;",
    `PRAGMA foreign_keys = OFF; BEGIN;
     CREATE TABLE items_new (id INTEGER PRIMARY KEY, category_id INTEGER, title TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, done INTEGER NOT NULL DEFAULT 0);
     INSERT INTO items_new (id, category_id, title, qty, done) SELECT id, category_id, title, qty, done FROM items;
     DROP TABLE items; ALTER TABLE items_new RENAME TO items; COMMIT; PRAGMA foreign_keys = ON;`,
  ];
  for (const sql of scripts) {
    refused(() => a.db.exec(sql), DDL);
    expect(a.changes.inTransaction, sql).toBe(false);
    expect(snapshot(a), sql).toBe(before);
  }
  expect(a.save()).toBeNull();
  a.close();
});

test("R-W: a statement the application prepared is bound to its mount", async () => {
  const a = await fresh();
  const s = a.db.prepare("SELECT count(*) FROM items");
  expect(s.step()).toBe(true);
  s.reset();
  a.changes.close();
  let error: unknown = null;
  try {
    s.step();
  } catch (e) {
    error = e;
  }
  expect(error, "a statement from a closed mount does not step").not.toBeNull();
  a.db.close();
});
