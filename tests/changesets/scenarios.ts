/**
 * The changeset spike's merge scenarios (`handoff-2026-10-18.md`, "Changeset
 * spike", §3), against src/.
 *
 * Every scenario starts from the same base: author A wrote two categories,
 * five items and one audit row; B opened A's file. Both write concurrently
 * with ordinary SQL, the copies exchange both ways from snapshots, and each
 * scenario is judged three ways:
 *   converged — app tables, flags and held rows equal on both copies;
 *   kept      — every value either author's log carries is in both copies'
 *               cells, and every row either copy showed is shown or held,
 *               unless one side deleted it and the other wrote nothing to it
 *               (read from the signed payloads, not the policy's own state);
 *   flagged   — the scenario's conflict carries its flag.
 */
import { Copy, person, openBytes, DOC, boot, statementsOf, isSchema } from "./copy.js";
import * as merge from "../../src/replicated-frame.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id),
  title TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  what TEXT NOT NULL
);
`;

const TRIGGER = "CREATE TRIGGER IF NOT EXISTS items_audit AFTER INSERT ON items BEGIN INSERT INTO audit (item_id, what) VALUES (NEW.id, 'created'); END;";

/**
 * The release's schema for a scenario: the base tables, its trigger, and the
 * schema statements of its `extra` (R-W: a schema is the release's, run by the
 * host before the application has the handle). The rest of `extra` is data.
 */
export async function releaseOf(opts: { trigger?: boolean; extra?: string[] } = {}): Promise<{ schema: string; data: string[] }> {
  const sqlite3 = await boot();
  const parts = (opts.extra ?? []).flatMap((sql) => statementsOf(sqlite3, sql));
  // The host runs the schema at every open, so each statement in it makes its object only if it is missing.
  const idempotent = (s: string): string =>
    s.replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+)(?!IF\s)/i, "$1IF NOT EXISTS ").trim().replace(/;?$/, ";");
  const schema = [SCHEMA, opts.trigger ? TRIGGER : "", ...parts.filter(isSchema).map(idempotent)].join("\n");
  return { schema, data: parts.filter((s) => !isSchema(s)) };
}

export async function base(opts: { trigger?: boolean; extra?: string[] } = {}): Promise<{ a: Copy; b: Copy }> {
  const release = await releaseOf(opts);
  const a = await Copy.open(await person(), undefined, release.schema);
  a.db.exec(`
    INSERT INTO categories (name) VALUES ('Food'), ('Gear');
    INSERT INTO items (category_id, title) SELECT id, 'Bread' FROM categories WHERE name = 'Food';
    INSERT INTO items (category_id, title) SELECT id, 'Tent' FROM categories WHERE name = 'Gear';
    INSERT INTO items (title) VALUES ('Map'), ('Rope'), ('Stove');
    INSERT INTO audit (item_id, what) SELECT id, 'packed' FROM items WHERE title = 'Rope';`);
  // A scenario's own rows; its tables are in the release's schema.
  for (const sql of release.data) a.db.exec(sql);
  const b = await Copy.open(await person(), await a.bytes(), release.schema);
  return { a, b };
}

export const item = (c: Copy, title: string): number => c.db.selectValue("SELECT id FROM items WHERE title = ?", [title]);

export interface Outcome {
  a: Copy;
  b: Copy;
  aBytes: Uint8Array;
  bBytes: Uint8Array;
  ab: Any;
  ba: Any;
  converged: boolean;
  missing: string[];
  vanished: string[];
  kinds: string[];
  local: unknown;
}

/** Writes on both sides, exchanges both ways from snapshots, and judges. */
export async function exchange(
  write: (a: Copy, b: Copy) => Promise<unknown> | unknown,
  opts: { trigger?: boolean; extra?: string[]; tamper?: (bytes: Uint8Array) => Promise<Uint8Array> } = {},
): Promise<Outcome> {
  const { a, b } = await base(opts);
  const local = await write(a, b);
  a.save();
  b.save();
  const beforeA = a.shown();
  const beforeB = b.shown();
  const wroteA = a.written();
  const wroteB = b.written();
  const aBytes = await a.bytes();
  let bBytes = await b.bytes();
  if (opts.tamper) bBytes = await opts.tamper(bBytes);
  const ab = await a.mergeFrom(bBytes);
  const ba = await b.mergeFrom(aBytes);
  const converged = a.state() === b.state();
  const cellsA = a.everyValue();
  const cellsB = b.everyValue();
  const missing = [...wroteA, ...(opts.tamper ? [] : wroteB)].filter((w) => !cellsA.has(w) || !cellsB.has(w));
  const after = new Set([...a.shown(), ...a.held().map((h) => `${h.tbl}|${h.pk}`)]);
  // A's round starts after its base saves; B's at its first seq.
  const opsA = a.opsSince(2);
  const opsB = opts.tamper ? new Map<string, Set<string>>() : b.opsSince(1);
  const unopposed = (key: string): boolean =>
    Boolean(
      (opsA.get(key)?.has("D") && !(opsB.get(key)?.has("U") || opsB.get(key)?.has("I"))) ||
        (opsB.get(key)?.has("D") && !(opsA.get(key)?.has("U") || opsA.get(key)?.has("I"))),
    );
  const vanished = [...new Set([...beforeA, ...(opts.tamper ? [] : beforeB)])].filter((k) => !after.has(k) && !unopposed(k));
  const kinds = [...new Set(a.flags().map((f) => f.kind))].sort();
  return { a, b, aBytes, bBytes, ab, ba, converged, missing, vanished, kinds, local };
}

/** The verdicts a copy's headers get, as the reader is handed them. */
export async function verdictsOf(bytes: Uint8Array): Promise<Record<string, string>> {
  const { rows, db } = await openBytes(bytes);
  const found: Record<string, string> = {};
  const m = merge as Any;
  for (const [id, v] of await m.verifyBatches(rows, m.mergeTablesOf(rows), DOC)) found[id] = v.ok ? (v.complete ? "ok" : "incomplete") : v.reason;
  db.close();
  return found;
}

/** Each scenario's two writes, by name, for the merge spec and the Python reader's. */
export const SCENARIOS: Record<string, { write: (a: Copy, b: Copy) => unknown; trigger?: boolean; extra?: string[] }> = {
  "S1 inserts": {
    write: (a, b) => {
      a.db.exec("INSERT INTO items (title) VALUES ('Lamp')");
      b.db.exec("INSERT INTO items (title) VALUES ('Soap')");
    },
  },
  "S1b UNIQUE": {
    write: (a, b) => {
      a.db.exec("INSERT INTO categories (name) VALUES ('Tools'); INSERT INTO items (category_id, title) VALUES (last_insert_rowid(), 'Saw')");
      b.db.exec("INSERT INTO categories (name) VALUES ('Tools'); INSERT INTO items (category_id, title) VALUES (last_insert_rowid(), 'Drill')");
    },
  },
  "S2 columns": {
    write: (a, b) => {
      a.db.exec({ sql: "UPDATE items SET qty = 3 WHERE id = ?", bind: [item(a, "Bread")] });
      b.db.exec({ sql: "UPDATE items SET note = 'whole wheat' WHERE id = ?", bind: [item(b, "Bread")] });
    },
  },
  "S3 same column": {
    write: (a, b) => {
      a.db.exec({ sql: "UPDATE items SET title = 'Tent (2p)' WHERE id = ?", bind: [item(a, "Tent")] });
      b.db.exec({ sql: "UPDATE items SET title = 'Tent (4p)' WHERE id = ?", bind: [item(b, "Tent")] });
    },
  },
  "S4 delete/update": {
    write: (a, b) => {
      a.db.exec({ sql: "DELETE FROM items WHERE id = ?", bind: [item(a, "Map")] });
      b.db.exec({ sql: "UPDATE items SET qty = 2 WHERE id = ?", bind: [item(b, "Map")] });
    },
  },
  "S4b delete/child": {
    write: (a, b) => {
      a.db.exec({ sql: "DELETE FROM items WHERE id = ?", bind: [item(a, "Rope")] });
      b.db.exec({ sql: "INSERT INTO audit (item_id, what) VALUES (?, 'checked')", bind: [item(b, "Rope")] });
    },
  },
  "S4c delete/delete": {
    write: (a, b) => {
      a.db.exec("DELETE FROM items WHERE title = 'Stove'");
      b.db.exec("DELETE FROM items WHERE title = 'Stove'");
    },
  },
  "S5 transaction": {
    write: (a, b) => {
      a.db.exec(`BEGIN;
        INSERT INTO categories (name) VALUES ('Kitchen');
        INSERT INTO items (category_id, title) VALUES (last_insert_rowid(), 'Pan');
        INSERT INTO audit (item_id, what) VALUES (last_insert_rowid(), 'bought');
        UPDATE items SET done = 1 WHERE title = 'Stove';
        COMMIT;`);
      const saved = a.save();
      b.db.exec("UPDATE items SET note = 'gas' WHERE title = 'Stove'");
      return saved;
    },
  },
  "S5b relative, same": {
    write: (a, b) => {
      a.db.exec("UPDATE items SET qty = qty + 1 WHERE title = 'Bread'");
      b.db.exec("UPDATE items SET qty = qty + 1 WHERE title = 'Bread'");
    },
  },
  "S5c relative, different": {
    write: (a, b) => {
      a.db.exec("UPDATE items SET qty = qty + 1 WHERE title = 'Bread'");
      b.db.exec("UPDATE items SET qty = qty + 2 WHERE title = 'Bread'");
    },
  },
  "S8 app trigger": {
    trigger: true,
    write: (a, b) => {
      a.db.exec("INSERT INTO items (title) VALUES ('Lamp')");
      b.db.exec("INSERT INTO items (title) VALUES ('Soap')");
    },
  },
  // The catalog's T08: a total a trigger keeps, and two independent inserts that each capture it as 1.
  "T08 derived total": {
    extra: [
      `CREATE TABLE workouts (id INTEGER PRIMARY KEY, what TEXT NOT NULL);
       CREATE TABLE summary (id INTEGER PRIMARY KEY, count INTEGER NOT NULL);
       CREATE TRIGGER workouts_count AFTER INSERT ON workouts BEGIN UPDATE summary SET count = count + 1 WHERE id = 1; END;`,
      "INSERT INTO summary (id, count) VALUES (1, 0)",
    ],
    write: (a, b) => {
      a.db.exec("INSERT INTO workouts (what) VALUES ('workout A')");
      b.db.exec("INSERT INTO workouts (what) VALUES ('workout B')");
    },
  },
  // The catalog's M02: two edits to different columns, each valid, whose combination a CHECK refuses.
  "M02 check across columns": {
    extra: [
      "CREATE TABLE spans (id INTEGER PRIMARY KEY, start INTEGER NOT NULL, finish INTEGER NOT NULL, CHECK (start <= finish))",
      "INSERT INTO spans (id, start, finish) VALUES (1, 0, 10)",
    ],
    write: (a, b) => {
      a.db.exec("UPDATE spans SET start = 8 WHERE id = 1");
      b.db.exec("UPDATE spans SET finish = 5 WHERE id = 1");
    },
  },
  // The catalog's M15 (1d-H4): SQLite's five storage classes, as values in a column with no type and as keys.
  "M15 storage classes": {
    extra: ["CREATE TABLE vals (id INTEGER PRIMARY KEY, v); CREATE TABLE keyed (k PRIMARY KEY, v)", "INSERT INTO vals (id, v) VALUES (1, 1), (2, 'x')"],
    write: (a, b) => {
      a.db.exec(`INSERT INTO vals (id, v) VALUES (101, 1.0), (102, x''), (103, 'a' || char(0) || 'b'), (104, 9007199254740993), (105, 9e999), (106, 0.1), (107, NULL);
        INSERT INTO keyed (k, v) VALUES (x'31', 'blob'), (2.5, 'real'), (9007199254740993, 'big'), ('1', 'text'), (1, 'int'), (x'', 'empty');`);
      b.db.exec("UPDATE vals SET v = 2.0 WHERE id = 1; INSERT INTO keyed (k, v) VALUES (x'00', 'b-blob'), (1e300, 'b-real'), (1.5e-7, 'b-small');");
    },
  },
  // The catalog's M16 (1d-H5): keys equal under their collation, or across storage classes, are one row.
  "M16 key collations": {
    extra: [
      `CREATE TABLE people (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT);
       CREATE TABLE tags (code TEXT PRIMARY KEY COLLATE RTRIM, label TEXT);
       CREATE TABLE nums (k PRIMARY KEY, v TEXT);`,
    ],
    write: (a, b) => {
      a.db.exec("INSERT INTO people (email, name) VALUES ('Bob@x', 'from A'), ('Ann@x', 'A only'); INSERT INTO tags (code, label) VALUES ('red', 'A'); INSERT INTO nums (k, v) VALUES (1, 'A');");
      b.db.exec("INSERT INTO people (email, name) VALUES ('bob@x', 'from B'); INSERT INTO tags (code, label) VALUES ('red  ', 'B'); INSERT INTO nums (k, v) VALUES (1.0, 'B');");
    },
  },
  // The catalog's M03: an expression UNIQUE index two concurrent rows collide under.
  "M03 expression unique": {
    extra: ["CREATE TABLE emails (id INTEGER PRIMARY KEY, address TEXT)", "CREATE UNIQUE INDEX one_address ON emails (lower(address))"],
    write: (a, b) => {
      a.db.exec("INSERT INTO emails (address) VALUES ('Ann@X')");
      b.db.exec("INSERT INTO emails (address) VALUES ('ann@x')");
    },
  },
  // The catalog's M04: two rows swap a UNIQUE value through a placeholder.
  "M04 unique swap": {
    extra: ["CREATE TABLE slots (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE)", "INSERT INTO slots (id, code) VALUES (1, 'a'), (2, 'b')"],
    write: (a, b) => {
      a.db.exec("BEGIN; UPDATE slots SET code = 'tmp' WHERE id = 1; UPDATE slots SET code = 'a' WHERE id = 2; UPDATE slots SET code = 'b' WHERE id = 1; COMMIT;");
      b.db.exec("INSERT INTO items (title) VALUES ('unrelated')");
    },
  },
  // The catalog's M06: one transaction over two rows, one of which becomes pending.
  "M06 effect group": {
    extra: [
      "CREATE TABLE accounts (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, balance INTEGER NOT NULL)",
      "INSERT INTO accounts (id, owner, balance) VALUES (1, 'one', 100), (2, 'two', 0)",
    ],
    write: (a, b) => {
      a.db.exec("BEGIN; UPDATE accounts SET balance = balance - 10 WHERE id = 1; UPDATE accounts SET balance = balance + 10 WHERE id = 2; COMMIT;");
      b.db.exec("UPDATE accounts SET balance = 50 WHERE id = 1");
    },
  },
};
