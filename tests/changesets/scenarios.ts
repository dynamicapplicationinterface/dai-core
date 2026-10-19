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
import { Copy, person, openBytes, DOC } from "./copy.js";
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

export async function base(opts: { trigger?: boolean; extra?: string[] } = {}): Promise<{ a: Copy; b: Copy }> {
  const a = await Copy.open(await person());
  a.db.exec(SCHEMA);
  if (opts.trigger) a.db.exec(TRIGGER);
  a.db.exec(`
    INSERT INTO categories (name) VALUES ('Food'), ('Gear');
    INSERT INTO items (category_id, title) SELECT id, 'Bread' FROM categories WHERE name = 'Food';
    INSERT INTO items (category_id, title) SELECT id, 'Tent' FROM categories WHERE name = 'Gear';
    INSERT INTO items (title) VALUES ('Map'), ('Rope'), ('Stove');
    INSERT INTO audit (item_id, what) SELECT id, 'packed' FROM items WHERE title = 'Rope';`);
  // A scenario's own tables and rows, each statement group in its own exec: a table is adopted (its key
  // rewritten) when the exec that made it returns.
  for (const sql of opts.extra ?? []) a.db.exec(sql);
  const b = await Copy.open(await person(), await a.bytes());
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
};
