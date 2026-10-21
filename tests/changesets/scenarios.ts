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

/** R-X's table (`docs/backlog.md`, "R-X red test"), named stock beside the base's items. */
const STOCK = `CREATE TABLE stock (
    id INTEGER PRIMARY KEY,
    qty INTEGER NOT NULL,
    unit TEXT NOT NULL,
    note TEXT
    -- dai:coupled qty unit
)`;

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

/**
 * One save of `c` whose operations `change` alters after the runtime built
 * them and before they are logged and signed: a copy that signs what it
 * likes (R-X §3). The signature is good; the basis is what a reader judges.
 */
export function forging(c: Copy, change: (op: Any[]) => void): void {
  const changes = c.changes as Any;
  const built = changes.withBases;
  changes.withBases = (op: Any): Any => {
    const out = built.call(changes, op);
    change(out);
    return out;
  };
  try {
    c.save();
  } finally {
    changes.withBases = built;
  }
}

/**
 * One save of `c` whose basis and whose receipt are both altered before it is
 * logged and signed (R-X §3, 1h-M1): a copy that signs a receipt it did not
 * earn. `bases` alters each op as `forging` does; `receipt` is handed the map
 * the runtime built and returns the one to sign.
 */
export function forgingFull(c: Copy, opts: { bases?: (op: Any[]) => void; receipt?: (r: Map<string, Any>) => Map<string, Any> | void }): void {
  const changes = c.changes as Any;
  const builtBases = changes.withBases;
  const builtReceived = changes.received;
  if (opts.bases) {
    changes.withBases = (op: Any): Any => {
      const out = builtBases.call(changes, op);
      opts.bases!(out);
      return out;
    };
  }
  if (opts.receipt) {
    changes.received = (): Map<string, Any> => {
      const r = builtReceived.call(changes) as Map<string, Any>;
      return opts.receipt!(r) ?? r;
    };
  }
  try {
    c.save();
  } finally {
    changes.withBases = builtBases;
    changes.received = builtReceived;
  }
}

/**
 * 1g-M1's arrangement: F opens from the base and saves four notes, so its
 * clock is past A's next; A retitles Tent; F, which never received A's batch,
 * retitles it too, and `forge` writes A's version into its title op. B
 * carries F's file on. Without `forge`, the honest control.
 */
export async function unreceived(
  a: Copy,
  b: Copy,
  forge?: (op: Any[], aVer: string) => void,
  act = "UPDATE items SET title = 'Tent (F)' WHERE title = 'Tent'",
  receipt?: (r: Map<string, Any>, aVer: string) => void,
): Promise<void> {
  const f = await Copy.open(await person(), await a.bytes(), a.schema);
  for (const note of ["f1", "f2", "f3", "f4"]) {
    f.db.exec({ sql: "UPDATE items SET note = ? WHERE title = 'Rope'", bind: [note] });
    f.save();
  }
  a.db.exec("UPDATE items SET title = 'Tent (A)' WHERE title = 'Tent'");
  a.save();
  const aVer = `${a.changes.authorHex}:${a.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE _r_replica = ?", [a.author.author])}`;
  f.db.exec(act);
  if (forge || receipt) {
    forgingFull(f, {
      bases: forge ? (op) => void (op[0] === "items" && (op[3].has("title") || op[2] === "D") && forge(op, aVer)) : undefined,
      receipt: receipt ? (r) => void receipt(r, aVer) : undefined,
    });
  } else {
    f.save();
  }
  await b.mergeFrom(await f.bytes());
  f.close();
}

/**
 * 1g-L2, 1g-L3: A and B each write `table`'s row 7 (`column` to 2 and 3);
 * F, opened from the base, merges both, so the row is pending there, and
 * writes `edit`; `forge` then alters F's op, given the value F showed. B
 * carries F's file on.
 */
export async function overPending(
  a: Copy,
  b: Copy,
  table: string,
  column: string,
  edit: string,
  forge: (op: Any[], shown: unknown, alternatives: string[]) => void,
): Promise<void> {
  const f = await Copy.open(await person(), await a.bytes(), a.schema);
  a.db.exec(`UPDATE ${table} SET ${column} = 2 WHERE id = 7`);
  b.db.exec(`UPDATE ${table} SET ${column} = 3 WHERE id = 7`);
  await f.mergeFrom(await a.bytes());
  await f.mergeFrom(await b.bytes());
  const shown = f.db.selectValue(`SELECT ${column} FROM ${table} WHERE id = 7`);
  const alternatives = f.rows
    .all(
      "SELECT ver FROM _cs_cell c WHERE tbl = ? AND pk = '[7]' AND col = ? AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = c.tbl AND s.pk = c.pk AND s.col = c.col AND s.ver = c.ver) ORDER BY ver",
      [table, column],
    )
    .map((r) => String(r["ver"]));
  f.db.exec(edit);
  forging(f, (op) => op[0] === table && forge(op, shown, alternatives));
  await b.mergeFrom(await f.bytes());
  f.close();
}

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
  // D267 under R-X: T08's total pending on A, and a third workout there, whose trigger raises the total A shows.
  "D267 counter over a pending total": {
    extra: [
      `CREATE TABLE workouts (id INTEGER PRIMARY KEY, what TEXT NOT NULL);
       CREATE TABLE summary (id INTEGER PRIMARY KEY, count INTEGER NOT NULL);
       CREATE TRIGGER workouts_count AFTER INSERT ON workouts BEGIN UPDATE summary SET count = count + 1 WHERE id = 1; END;`,
      "INSERT INTO summary (id, count) VALUES (1, 0)",
    ],
    write: async (a, b) => {
      a.db.exec("INSERT INTO workouts (what) VALUES ('workout A')");
      b.db.exec("INSERT INTO workouts (what) VALUES ('workout B')");
      await a.mergeFrom(await b.bytes());
      a.db.exec("INSERT INTO workouts (what) VALUES ('workout A2')");
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
  // The catalog's K12: a text key moved on one copy while the other edits the row under the old key.
  "K12 key moved": {
    extra: ["CREATE TABLE codes (code TEXT PRIMARY KEY, v TEXT)", "INSERT INTO codes (code, v) VALUES ('old', 'base')"],
    write: (a, b) => {
      a.db.exec("UPDATE codes SET code = 'new' WHERE code = 'old'");
      b.db.exec("UPDATE codes SET v = 'edited' WHERE code = 'old'");
    },
  },
  // The catalog's D07: a RETURNING statement stepped once and reset; SQLite has run it whole.
  "D07 returning": {
    write: (a, b) => {
      const stmt = a.db.prepare("UPDATE items SET qty = qty + 10 RETURNING id");
      stmt.step();
      stmt.reset();
      stmt.finalize();
      b.db.exec("UPDATE items SET note = 'from B' WHERE title = 'Map'");
    },
  },
  // RW-12's outcome, by R-X's call: A saw B's title and kept the one it showed, no byte changed; B edited another column.
  "RW-12 resolution": {
    write: async (a, b) => {
      a.db.exec("UPDATE items SET title = 'Tent (2p)' WHERE title = 'Tent'");
      b.db.exec("UPDATE items SET title = 'Tent (4p)' WHERE title = 'Tent'");
      await a.mergeFrom(await b.bytes());
      const seen = a.changes.observe("items", [a.db.selectValue("SELECT id FROM items WHERE title LIKE 'Tent%'")], ["title"]);
      a.changes.resolve(seen.token, seen.shown);
      b.db.exec("UPDATE items SET qty = 2 WHERE title LIKE 'Tent%'");
    },
  },
  // R-X's first assertion: a coupled tuple pending between A's and B's, and a form save on A writing it back whole with a new note.
  "R-X form echo": {
    extra: [STOCK, "INSERT INTO stock (id, qty, unit, note) VALUES (7, 1, 'kg', '')"],
    write: async (a, b) => {
      a.db.exec("UPDATE stock SET qty = 2 WHERE id = 7");
      b.db.exec("UPDATE stock SET qty = 3 WHERE id = 7");
      await a.mergeFrom(await b.bytes());
      const shown = a.db.selectObject("SELECT qty, unit FROM stock WHERE id = 7") as Any;
      a.db.exec({ sql: "UPDATE stock SET qty = ?, unit = ?, note = 'packed' WHERE id = 7", bind: [shown.qty, shown.unit] });
    },
  },
  // R-X's second assertion: A keeps the shown tuple by the call; C's (4, "kg"), from the start, travels in B's file.
  "R-X explicit keep": {
    extra: [STOCK, "INSERT INTO stock (id, qty, unit, note) VALUES (7, 1, 'kg', '')"],
    write: async (a, b) => {
      const c = await Copy.open(await person(), await a.bytes(), a.schema);
      a.db.exec("UPDATE stock SET qty = 2 WHERE id = 7");
      b.db.exec("UPDATE stock SET qty = 3 WHERE id = 7");
      c.db.exec("UPDATE stock SET qty = 4 WHERE id = 7");
      await a.mergeFrom(await b.bytes());
      const seen = a.changes.observe("stock", [7], ["qty", "unit"]);
      a.changes.resolve(seen.token, seen.shown);
      await b.mergeFrom(await c.bytes());
      c.close();
    },
  },
  // 1f-H1 (a): a form save over a row pending on its title, writing B's qty and note back with done.
  "1f-H1 form save": {
    write: async (a, b) => {
      b.db.exec("UPDATE items SET qty = 9, note = 'B packed it', title = 'Tent (4p)' WHERE title = 'Tent'");
      a.db.exec("UPDATE items SET title = 'Tent (2p)' WHERE title = 'Tent'");
      await a.mergeFrom(await b.bytes());
      const row = a.db.selectObject("SELECT id, category_id, title, qty, note FROM items WHERE title LIKE 'Tent%'") as Any;
      a.db.exec({ sql: "UPDATE items SET category_id = ?, title = ?, qty = ?, note = ?, done = 1 WHERE id = ?", bind: [row.category_id, row.title, row.qty, row.note, row.id] });
    },
  },
  // 1f-H1 (b): SET qty = qty on a row pending on its title, beside a third copy's qty, which travels in B's file.
  "1f-H1 echo": {
    write: async (a, b) => {
      const c = await Copy.open(await person(), await a.bytes(), a.schema);
      c.db.exec("UPDATE items SET qty = 5 WHERE title = 'Tent'");
      a.db.exec("UPDATE items SET title = 'Tent (2p)' WHERE title = 'Tent'");
      b.db.exec("UPDATE items SET title = 'Tent (4p)' WHERE title = 'Tent'");
      await a.mergeFrom(await b.bytes());
      a.db.exec("UPDATE items SET qty = qty WHERE title LIKE 'Tent%'");
      await b.mergeFrom(await c.bytes());
      c.close();
    },
  },
  // M05 (1f-M3): Food kept for Jam on both, then B moves Jam out of it; Food's delete stands on both.
  "M05 kept, then released": {
    write: async (a, b) => {
      a.db.exec("INSERT INTO items (category_id, title) SELECT id, 'Jam' FROM categories WHERE name = 'Food'");
      b.db.exec("UPDATE items SET category_id = NULL WHERE title = 'Bread'");
      b.db.exec("DELETE FROM categories WHERE name = 'Food'");
      const [ab, bb] = [await a.bytes(), await b.bytes()];
      await a.mergeFrom(bb);
      await b.mergeFrom(ab);
      b.db.exec("UPDATE items SET category_id = (SELECT id FROM categories WHERE name = 'Gear') WHERE title = 'Jam'");
    },
  },
  // R-X §3: a third copy signs an edit whose basis names A's concurrent title, which it never saw; B carries it on.
  "R-X forged basis": {
    write: async (a, b) => {
      const f = await Copy.open(await person(), await a.bytes(), a.schema);
      a.db.exec("UPDATE items SET title = 'Tent (2p)' WHERE title = 'Tent'");
      a.save();
      const seen = `${a.changes.authorHex}:${a.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE _r_replica = ?", [a.author.author])}`;
      f.db.exec("UPDATE items SET title = 'Tent (9p)' WHERE title = 'Tent'");
      forging(f, (op) => op[5].set("title", [seen]));
      await b.mergeFrom(await f.bytes());
      b.db.exec("UPDATE items SET note = 'from B' WHERE title = 'Map'");
      f.close();
    },
  },
  // R-X §3: a third copy signs an edit that names no basis for the column it writes; B carries it on.
  "R-X missing basis": {
    write: async (a, b) => {
      const f = await Copy.open(await person(), await a.bytes(), a.schema);
      f.db.exec("UPDATE items SET qty = 9 WHERE title = 'Rope'");
      forging(f, (op) => op[5].delete("qty"));
      await b.mergeFrom(await f.bytes());
      a.db.exec("UPDATE items SET note = 'from A' WHERE title = 'Map'");
      f.close();
    },
  },
  // 1g-H1: B's and C's titles pending on A, which shows one and deletes the row; C's batch travels in B's file.
  "1g-H1 delete over a pending loser": {
    write: async (a, b) => {
      const c = await Copy.open(await person(), await a.bytes(), a.schema);
      b.db.exec("UPDATE items SET title = 'Tent (B)' WHERE title = 'Tent'");
      c.db.exec("UPDATE items SET title = 'Tent (C)' WHERE title = 'Tent'");
      const cBytes = await c.bytes();
      await a.mergeFrom(await b.bytes());
      await a.mergeFrom(cBytes);
      a.db.exec("DELETE FROM items WHERE title LIKE 'Tent%'");
      await b.mergeFrom(cBytes);
      c.close();
    },
  },
  // 1g-H1: B's finish, set aside on A by the CHECK (B's clock is ahead), and A deletes the row it showed.
  "1g-H1 delete over a set-aside proposal": {
    extra: [
      "CREATE TABLE spans (id INTEGER PRIMARY KEY, start INTEGER NOT NULL, finish INTEGER NOT NULL, CHECK (start <= finish))",
      "INSERT INTO spans (id, start, finish) VALUES (1, 0, 10)",
    ],
    write: async (a, b) => {
      for (const note of ["b1", "b2", "b3"]) {
        b.db.exec({ sql: "UPDATE items SET note = ? WHERE title = 'Map'", bind: [note] });
        b.save();
      }
      a.db.exec("UPDATE spans SET start = 8 WHERE id = 1");
      b.db.exec("UPDATE spans SET finish = 5 WHERE id = 1");
      await a.mergeFrom(await b.bytes());
      a.db.exec("DELETE FROM spans WHERE id = 1");
    },
  },
  // 1g-M1: F, its clock moved past A's by four saves, names in its title basis A's title version, which it never
  // received; B carries F's batch on.
  "1g-M1 unreceived basis": { write: (a, b) => unreceived(a, b, (op, v) => op[5].set("title", [...op[5].get("title"), v])) },
  // 1g-M1: the same, with A's version named in what F's ordinary edit resolves.
  "1g-M1 unreceived resolves": { write: (a, b) => unreceived(a, b, (op, v) => (op[7] = new Map([["title", [v]]]))) },
  // 1g-M1: F deletes Tent, and its delete names A's title version, never received, among what it saw.
  "1g-M1 unreceived seen": { write: (a, b) => unreceived(a, b, (op, v) => op[6].push(v), "DELETE FROM items WHERE title = 'Tent'") },
  // 1h-M1: F names A's title version in its basis and raises its receipt to that seq with a forged digest; the
  // reader holds A's batch at that seq, and the digests differ.
  "1h-M1 receipt digest": {
    write: (a, b) =>
      unreceived(a, b, (op, v) => op[5].set("title", [...op[5].get("title"), v]), undefined, (r, v) => {
        const at = v.lastIndexOf(":");
        r.set(v.slice(0, at), [Number(v.slice(at + 1)), "00000000000000000000000000000000"]);
      }),
  },
  // 1h-M1: the same, but the receipt names a seq at or above F's own clock, which no batch it could have received reaches.
  "1h-M1 receipt clock": {
    write: (a, b) =>
      unreceived(a, b, (op, v) => op[5].set("title", [...op[5].get("title"), v]), undefined, (r, v) => {
        r.set(v.slice(0, v.lastIndexOf(":")), [999, "00000000000000000000000000000000"]);
      }),
  },
  // 1g-L2 (F2a): F's op writes back the qty it showed, based on that version, and names nothing it resolves.
  "1g-L2 resolution without resolves": {
    extra: ["CREATE TABLE gear (id INTEGER PRIMARY KEY, qty INTEGER NOT NULL)", "INSERT INTO gear (id, qty) VALUES (7, 1)"],
    write: (a, b) => overPending(a, b, "gear", "qty", "UPDATE gear SET qty = 9 WHERE id = 7", (op, shown) => op[3].set("qty", shown)),
  },
  // 1g-L2 (F2b): the same, with an empty resolves.
  "1g-L2 resolution with empty resolves": {
    extra: ["CREATE TABLE gear (id INTEGER PRIMARY KEY, qty INTEGER NOT NULL)", "INSERT INTO gear (id, qty) VALUES (7, 1)"],
    write: (a, b) =>
      overPending(a, b, "gear", "qty", "UPDATE gear SET qty = 9 WHERE id = 7", (op, shown) => {
        op[3].set("qty", shown);
        op[7] = new Map();
      }),
  },
  // 1g-L3 (F2c): F's tuple edit of R-X's coupled (qty, unit) resolves qty's alternatives and not unit's.
  "1g-L3 partial coupled resolution": {
    extra: [STOCK, "INSERT INTO stock (id, qty, unit, note) VALUES (7, 1, 'kg', '')"],
    write: (a, b) => overPending(a, b, "stock", "qty", "UPDATE stock SET qty = 9 WHERE id = 7", (op, _shown, alts) => (op[7] = new Map([["qty", alts]]))),
  },
  // 1e-H3: a key respelled under its collation on one copy while the other edits another column of the row.
  "1e-H3 respelled key": {
    extra: ["CREATE TABLE people (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT)", "INSERT INTO people (email, name) VALUES ('bob@x.com', 'Bob')"],
    write: (a, b) => {
      a.db.exec("UPDATE people SET email = 'Bob@X.com' WHERE email = 'bob@x.com'");
      b.db.exec("UPDATE people SET name = 'Robert' WHERE email = 'bob@x.com'");
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
