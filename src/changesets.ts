/**
 * The ordinary data interface (R-O): ordinary tables, signed changesets.
 *
 * The application owns ordinary SQLite tables: its own keys, UPDATE, DELETE,
 * foreign keys, joins, transactions. This layer, which the application never
 * calls, is the changeset spike's literal policy (`handoff-2026-10-18.md`,
 * "Changeset spike") moved into the runtime:
 *
 *   1. Each application table is adopted once. An INTEGER PRIMARY KEY becomes
 *      an author-ranged integer, a text key takes a uuid by default, and a
 *      table with no primary key is given an explicit author-ranged key
 *      column, `_dai_id` (by the compiler, or here for a table made later).
 *   2. What each save changed is captured with SQLite's session extension:
 *      row-level old and new values, keyed by primary key.
 *   3. Each save's changeset is one row of `_cs_log`, an ordinary replicated
 *      table the compiler declares for every document with no session policy.
 *      So the changeset is the payload of an ordinary signed batch: per-author
 *      seq, floors, equivocation and signatures are the authorship layer's,
 *      unchanged (src/replicated-batch.ts verifies as before).
 *   4. After the authorship merge admits another copy's log, every admitted
 *      changeset not yet seen here is projected onto the application's tables
 *      by one fixed policy, below. Nothing is discarded: every value ever
 *      written stays in `_cs_cell`, and a row a constraint will not admit is
 *      held in `_cs_held` with a flag.
 *
 * Policy. Each cell (table, key, column) is a register of versions; a version
 * is the save that wrote it, `<author hex>:<seq>`, and names the versions it
 * saw (they are superseded). Row existence is the register of column "" (1
 * alive, 0 deleted), and a delete records every data version it saw. From
 * these grow-only sets alone, so any order of arrival converges:
 *   - different rows merge; different columns of one row merge, unless the
 *     app declared them coupled (`-- dai:coupled a b`): a change to one
 *     writes the group, so concurrent changes to it are one conflict;
 *   - one column with two concurrent versions keeps both, shows the later by
 *     (lc, author), and flags the row `pending`; for a column the app
 *     declared consequential (`-- dai:consequential c`) the kit's query
 *     views leave the row out until it is resolved (`_cs_settle`);
 *   - a delete with a concurrent change keeps the row and flags it
 *     `delete-conflict`; a deleted row a live row still references through a
 *     declared foreign key is kept too, flagged `kept-referenced`;
 *   - a row whose merged values a CHECK or NOT NULL refuses, each save valid
 *     alone, is a constraint conflict (R-T): it shows the latest candidate the
 *     table admits, the newest versions set aside first, and is `pending`;
 *   - a row a constraint will not admit otherwise is held, flagged `held`;
 *     for UNIQUE the earlier-born row keeps the slot.
 *   - a save is one effect group: where a row it wrote is pending or held,
 *     every other row where its change is still current is pending too.
 * A save over a flagged row supersedes every version it saw, so editing is
 * resolving: a new signed change that acknowledges both parents (R-F). The
 * flags are rows of `_cs_flag`, which the host reads from the stored document.
 *
 * Runtime rules that come with it: the application's own triggers stand down
 * while merged rows are applied (`dai_projecting()`), and `PRAGMA foreign_keys`
 * is on from open.
 */
import { CborError, decode as cborDecode, encode as cborEncode, Float64, type CborValue } from "./cbor.js";
import { createEntity, type Rows } from "./replicated-rows.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

import { CHANGES_DECLARATION, CHANGES_LOG, HIDDEN_KEY, withHiddenKeys } from "./changes-log.js";
import { declaredIn, type Declared } from "./declarations.js";
import { rewriteReplicated } from "./replicated.js";
import { SAVE_REFUSED } from "./refusals.js";
export { CHANGES_DECLARATION, CHANGES_LOG };

/** Author-ranged integer keys: the author index in bits 32..52, a counter in bits 0..31. 2^53-1 is the largest id, exact in JavaScript. */
export const COUNTER_BITS = 32;
export const INDEX_BITS = 21;
const SPAN = 2 ** COUNTER_BITS;
const INDEX_MASK = 2 ** INDEX_BITS - 1;

/**
 * A name as it is compared with the runtime's (1d-H1): Unicode compatibility
 * forms and case folded. SQLite matches names without regard to ASCII case and
 * hands the authorizer, and stores in `tbl_name`, the spelling as written, so
 * `_CS_LOG` is `_cs_log` to the engine; and a name a reader or a host folds to
 * a runtime name is never the application's either.
 */
const folded = (name: string): string => name.normalize("NFKC").toLowerCase();

/** The runtime's own objects: the application reads them, and never writes them or hangs code on them (T11, P01). */
const runtimeNamed = (name: string): boolean => /^(_dai|_cs_)/.test(folded(name));

/** The runtime's own tables and SQLite's, never captured and never adopted. */
const internalNamed = (name: string): boolean => runtimeNamed(name) || folded(name).startsWith("sqlite_");

const META = `
CREATE TABLE IF NOT EXISTS _cs_cell (tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL, ver TEXT NOT NULL, val, lc INTEGER NOT NULL, author TEXT NOT NULL, PRIMARY KEY (tbl, pk, col, ver)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS _cs_cell_by_ver ON _cs_cell (ver);
CREATE TABLE IF NOT EXISTS _cs_sup (tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL, ver TEXT NOT NULL, PRIMARY KEY (tbl, pk, col, ver)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_seen (tbl TEXT NOT NULL, pk TEXT NOT NULL, del TEXT NOT NULL, ver TEXT NOT NULL, PRIMARY KEY (tbl, pk, del, ver)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_ingested (ver TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_flag (tbl TEXT NOT NULL, pk TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, PRIMARY KEY (tbl, pk, kind)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_held (tbl TEXT NOT NULL, pk TEXT NOT NULL, reason TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (tbl, pk)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_keys (tbl TEXT PRIMARY KEY, kind TEXT NOT NULL, pk TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_settle (tbl TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_spell (tbl TEXT NOT NULL, pk TEXT NOT NULL, ver TEXT NOT NULL, k TEXT NOT NULL, PRIMARY KEY (tbl, pk, ver)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_shape (kind TEXT NOT NULL, tbl TEXT NOT NULL, col TEXT NOT NULL, now TEXT, PRIMARY KEY (kind, tbl, col)) WITHOUT ROWID;
`;

/** The flags a row can carry, as `_cs_flag.kind` holds them. */
export type FlagKind = "pending" | "delete-conflict" | "kept-referenced" | "held" | "orphan";

/** A key kind: ranged integer, uuid text, the app's own (natural), or the hidden ranged key of a table that declared none. */
type KeyKind = "ranged" | "uuid" | "natural" | "hidden";
interface Keys {
  kind: KeyKind;
  pk: string[];
}

/** A captured row change, as it travels: [table, key values, op, new, old, bases, seen]. */
type Op = [string, unknown[], "I" | "U" | "D", Map<string, unknown>, Map<string, unknown>, Map<string, string[]>, string[]];

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const q = (name: string): string => `"${String(name).split('"').join('""')}"`;
const plain = (v: unknown): unknown =>
  typeof v === "bigint" && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v;
const shown = (v: unknown): unknown => {
  const p = plain(v);
  if (p instanceof Float64) return Number.isFinite(p.value) ? p.value : String(p.value);
  if (typeof p === "number" && !Number.isFinite(p)) return String(p);
  return p instanceof Uint8Array ? `<${p.length} bytes>` : typeof p === "bigint" ? p.toString() : p;
};

/**
 * A key as the runtime's tables hold it (`_cs_cell.pk` and every table keyed
 * like it): a JSON array, exact for every storage class (K10, M15), and equal
 * for two keys exactly when SQLite takes them for one row. An integer past
 * 2^53 is `{"$int": "<digits>"}` and a BLOB `{"$blob": "<hex>"}`, so no key is
 * rounded or turned into an object it was not. A REAL with no fraction is the
 * integer it equals, as SQLite compares them; an infinity or a REAL past 2^53
 * is `{"$real": "<value>"}`. Integers and text read as plain JSON, as they
 * always have. `fold` gives each text part as its column's collation compares
 * it (1d-H5).
 */
export function keyText(k: unknown[], fold: ((s: string, i: number) => string) | null = null): string {
  return JSON.stringify(k.map((v, i) => keyPart(v, false, fold ? (s) => fold(s, i) : null)));
}

/** A key exactly as written, storage class and spelling both (`_cs_spell`): what a row is written back with. */
export function keySpelling(k: unknown[]): string {
  return JSON.stringify(k.map((v) => keyPart(v, true, null)));
}

function keyPart(v: unknown, exact: boolean, fold: ((s: string) => string) | null): unknown {
  const p = plain(v);
  if (typeof p === "bigint") return { $int: p.toString() };
  if (p instanceof Uint8Array) return { $blob: hex(p) };
  if (p instanceof Float64) {
    return !exact && Number.isSafeInteger(p.value) ? p.value : { $real: String(p.value) };
  }
  if (typeof p === "number" && !Number.isFinite(p)) return { $real: String(p) };
  if (typeof p === "string" && fold) return fold(p);
  return p;
}

/** The key values `keyText` or `keySpelling` wrote, each in its own storage class. */
export function keyValues(text: string): unknown[] {
  return JSON.parse(text, (_k, v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    if ("$int" in v) return BigInt(v.$int);
    if ("$blob" in v) return unhex(String(v.$blob));
    if ("$real" in v) return new Float64(Number(v.$real));
    return v;
  }) as unknown[];
}

/**
 * A value read from SQLite with the storage class it had. sqlite-wasm reads a
 * REAL with no fraction as a JS integer, and binds one as an INTEGER, so such
 * a REAL (and an infinity) is held as a Float64 from capture to apply (M15).
 */
const typed = (type: unknown, v: unknown): unknown =>
  type === "real" && typeof v === "number" && (Number.isInteger(v) || !Number.isFinite(v)) ? new Float64(v) : plain(v);

/**
 * A value as SQLite binds it, stored in the class it had: a Float64 through
 * CAST(? AS REAL). sqlite-wasm binds a whole JS number as an integer, and one
 * past 2^53 wrongly (1e300 was bound as 0), so such a REAL goes as its text;
 * an infinity is no whole number, and binds as the double it is.
 */
const bound = (v: unknown): { at: string; value: unknown } => {
  if (!(v instanceof Float64)) return { at: "?", value: v ?? null };
  if (!Number.isFinite(v.value)) return { at: "?", value: v.value };
  return { at: "CAST(? AS REAL)", value: Number.isSafeInteger(v.value) ? v.value : String(v.value) };
};

/** A value to compare with in SQL, where SQLite's own comparison decides (a REAL 1.0 IS 1). */
const compared = (v: unknown): unknown => (v instanceof Float64 ? v.value : v);

/** Two values SQLite would store alike: the same storage class and the same value. */
function sameValue(a: unknown, b: unknown): boolean {
  const x = plain(a);
  const y = plain(b);
  if (x instanceof Uint8Array || y instanceof Uint8Array) {
    return x instanceof Uint8Array && y instanceof Uint8Array && x.length === y.length && x.every((v, i) => v === y[i]);
  }
  if (x instanceof Float64 || y instanceof Float64) return x instanceof Float64 && y instanceof Float64 && x.value === y.value;
  return x === y || (x == null && y == null);
}

/** What a schema change the data interface cannot follow is refused with (R-V), by case. */
export const SCHEMA_REFUSED = {
  alone: "A schema change runs as a statement of its own, with no values bound to it.",
  declared: "A column a -- dai: declaration names keeps its name and stays in its table.",
  renamedOnto: "A table can take the name of a table dropped since the last save only if it was made since then too.",
} as const;

/** What a key with a NULL in it is refused with, as it executes (1d-H3, R-V). */
export const KEY_REFUSED = "A row's key cannot be NULL: give every primary-key column a value, or leave out an integer key to have one given.";

/** The SQLite result codes of a capture failure a retry can cure: busy, locked, out of memory, interrupted, I/O, full. */
const RETRYABLE_RC = new Set([5, 6, 7, 9, 10, 13]);

/**
 * The author index a key range is drawn from: 21 bits of the author id, never
 * 0 (index 0 is the range of ids written before adoption: seeds with fixed
 * ids). The author id is a fingerprint, so its bits are already uniform.
 * **Assumption until R-E's enrollment exists:** two authors of one document
 * share a range with probability about n²/2^22. A shared range is not a lost
 * write: the same id from two authors is one row, column-merged and flagged.
 */
export function authorIndexOf(author: Uint8Array): number {
  const n = (((author[0] ?? 0) << 13) | ((author[1] ?? 0) << 5) | ((author[2] ?? 0) >> 3)) & INDEX_MASK;
  return n === 0 ? 1 : n;
}

/** Whether a database carries the changeset log: a document with no session policy. */
export function declaresChanges(rows: Rows): boolean {
  return (
    rows.all("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [CHANGES_LOG]).length > 0 &&
    rows.all("SELECT 1 FROM pragma_table_info(?) WHERE name = '_r_replica'", [CHANGES_LOG]).length > 0
  );
}

/** The application's tables: everything that is not the runtime's own. */
export function appTablesOf(rows: Rows): string[] {
  return rows
    .all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
    .map((r) => String(r["name"]))
    .filter((n) => !internalNamed(n));
}

/* --------------------------------------------------------------- key DDL */

/**
 * The application's CREATE TABLE with its key rewritten. A rowid alias cannot
 * take a DEFAULT (SQLite ignores it), so the key becomes a non-alias INT key
 * whose NOT NULL ... ON CONFLICT REPLACE takes the default for an omitted id
 * and an explicit NULL alike. AUTOINCREMENT goes: it is legal only on an
 * alias, and a per-author counter never reuses an id anyway. `type` is the
 * key's declared type as SQLite reports it (any of integer affinity: INT,
 * BIGINT, INT8, UNSIGNED BIG INT; 1d-H3); a NOT NULL beside it goes, since
 * the rewritten key carries its own.
 */
export function rewriteKeySql(sql: string, table: string, column: string, kind: "ranged" | "uuid", type = "INTEGER"): string {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = escape(column);
  const col = `(?:"${name}"|\`${name}\`|\\[${name}\\]|${name})`;
  if (kind === "ranged") {
    const fn = `DEFAULT (dai_id(${sqlText(table)}))`;
    const declared = `${type.trim().split(/\s+/).map(escape).join("\\s+")}(?=[\\s,)]|$)(?:\\s+NOT\\s+NULL)?`;
    const inline = new RegExp(`(${col}\\s+)${declared}(\\s+PRIMARY\\s+KEY(?:\\s+(?:ASC|DESC))?)(\\s+AUTOINCREMENT)?`, "i");
    if (inline.test(sql)) return sql.replace(inline, `$1INT NOT NULL ON CONFLICT REPLACE ${fn}$2`);
    // A table-level PRIMARY KEY (id) over `id INTEGER`.
    const typed = new RegExp(`([(,]\\s*${col}\\s+)${declared}`, "i");
    if (typed.test(sql)) return sql.replace(typed, `$1INT NOT NULL ON CONFLICT REPLACE ${fn}`);
    throw new Error(`CHANGES_KEY_UNREWRITABLE (${table})`);
  }
  const inline = new RegExp(`(${col}\\s+[A-Z ()0-9]*?(?:TEXT|CHAR|CLOB)[A-Z ()0-9]*?)(\\s+PRIMARY\\s+KEY)`, "i");
  if (inline.test(sql) && !/\bDEFAULT\b/i.test(sql.match(inline)![1]!)) {
    return sql.replace(inline, `$1 NOT NULL ON CONFLICT REPLACE DEFAULT (dai_uuid())$2`);
  }
  // A text key with a default of its own, or one a default cannot be placed
  // on: the application always names it, and it is a natural key.
  return sql;
}

/* ------------------------------------------------------------- capture */

/**
 * The session extension, attached to every table but the runtime's own.
 * `changes` hands back what changed since the last `clear`, decoded, and
 * keeps it: it is cleared only once a save has logged it (1b-H2).
 */
class SessionCapture {
  private session = 0;
  private filter = 0;
  private readonly columns = new Map<string, string[]>();

  constructor(
    private readonly sqlite3: Any,
    private readonly db: Any,
    /** A table the session leaves alone for now: one made since the last save, or the target of a schema change as it runs. */
    private readonly excluded: (table: string) => boolean = () => false,
  ) {
    this.open();
  }

  private open(): void {
    const { capi, wasm } = this.sqlite3;
    const stack = wasm.pstack.pointer;
    try {
      const out = wasm.pstack.allocPtr();
      const rc = capi.sqlite3session_create(this.db.pointer, "main", out);
      if (rc) throw new Error(`CHANGES_CAPTURE (sqlite3session_create rc=${rc})`);
      this.session = wasm.peekPtr(out);
    } finally {
      wasm.pstack.restore(stack);
    }
    // A table with no primary key yet (made by the application, not yet given its hidden key) is not
    // attached: the session would remember it as keyless and ignore it once it has its key. Asked again
    // on each change until it is attached.
    this.filter ||= wasm.installFunction("ipp", (_ctx: number, zTab: number) => {
      const name = wasm.cstrToJs(zTab) as string;
      if (internalNamed(name) || this.excluded(name)) return 0;
      return this.db.selectValue("SELECT 1 FROM pragma_table_info(?) WHERE pk > 0", [name]) == null ? 0 : 1;
    });
    capi.sqlite3session_table_filter(this.session, this.filter, 0);
    const rc = capi.sqlite3session_attach(this.session, null);
    if (rc) throw new Error(`CHANGES_CAPTURE (sqlite3session_attach rc=${rc})`);
  }

  /** Captures nothing while `f` runs: the runtime's own writes to the application's tables. */
  paused<T>(f: () => T): T {
    const capi = this.sqlite3.capi;
    const was = capi.sqlite3session_enable(this.session, -1);
    capi.sqlite3session_enable(this.session, 0);
    try {
      return f();
    } finally {
      capi.sqlite3session_enable(this.session, was);
    }
  }

  /** Captures what `f` writes, even inside `paused`. */
  captured<T>(f: () => T): T {
    const capi = this.sqlite3.capi;
    const was = capi.sqlite3session_enable(this.session, -1);
    capi.sqlite3session_enable(this.session, 1);
    try {
      return f();
    } finally {
      capi.sqlite3session_enable(this.session, was);
    }
  }

  changes(): { table: string; op: "INSERT" | "UPDATE" | "DELETE"; pk: Record<string, unknown>; old: Record<string, unknown>; new: Record<string, unknown> }[] {
    const { capi, wasm } = this.sqlite3;
    const stack = wasm.pstack.pointer;
    let bytes: Uint8Array;
    try {
      const pn = wasm.pstack.allocPtr();
      const pp = wasm.pstack.allocPtr();
      const rc = capi.sqlite3session_changeset(this.session, pn, pp);
      if (rc) throw new Error(`CHANGES_CAPTURE (sqlite3session_changeset rc=${rc})`);
      const n = wasm.peek32(pn);
      const p = wasm.peekPtr(pp);
      bytes = n ? wasm.heap8u().slice(Number(p), Number(p) + n) : new Uint8Array(0);
      if (p) capi.sqlite3_free(p);
    } finally {
      wasm.pstack.restore(stack);
    }
    return bytes.length ? this.decode(bytes) : [];
  }

  /** Whether anything has been captured since the last `clear`. */
  isEmpty(): boolean {
    return Boolean(this.sqlite3.capi.sqlite3session_isempty(this.session));
  }

  /** Starts over: what was captured is logged. */
  clear(): void {
    this.sqlite3.capi.sqlite3session_delete(this.session);
    this.open();
  }

  private decode(bytes: Uint8Array): ReturnType<SessionCapture["changes"]> {
    const { capi, wasm } = this.sqlite3;
    const ops: ReturnType<SessionCapture["changes"]> = [];
    const buf = wasm.allocFromTypedArray(bytes);
    const stack = wasm.pstack.pointer;
    try {
      const pIter = wasm.pstack.allocPtr();
      let rc = capi.sqlite3changeset_start(pIter, bytes.length, buf);
      if (rc) throw new Error(`CHANGES_CAPTURE (sqlite3changeset_start rc=${rc})`);
      const it = wasm.peekPtr(pIter);
      const pTab = wasm.pstack.allocPtr();
      const pN = wasm.pstack.allocPtr();
      const pOp = wasm.pstack.allocPtr();
      const pInd = wasm.pstack.allocPtr();
      const pPk = wasm.pstack.allocPtr();
      const pPkN = wasm.pstack.allocPtr();
      const pVal = wasm.pstack.allocPtr();
      /*
       * Text is carried as the string sqlite-wasm reads, which replaces bytes
       * that are not UTF-8 (text made from a BLOB by CAST). Read back to the
       * bytes SQLite holds and compared, so such text is never carried changed:
       * the save fails, and no retry cures it (P3).
       */
      const exact = (read: (it: number, i: number, out: number) => number, i: number, v: unknown): unknown => {
        if (v === undefined || v instanceof Uint8Array || typeof v === "bigint") return v;
        if (read(it, i, pVal)) return v;
        const p = wasm.peekPtr(pVal);
        // An empty BLOB, which sqlite-wasm reads as NULL here.
        if (v === null) return p && capi.sqlite3_value_type(p) === capi.SQLITE_BLOB ? new Uint8Array(0) : v;
        // A REAL sqlite-wasm reads as a JS integer (1.0), or an infinity: held as the REAL it is (M15).
        if (typeof v === "number") return capi.sqlite3_value_type(p) === capi.SQLITE_FLOAT ? typed("real", v) : v;
        if (typeof v !== "string") return v;
        const n = capi.sqlite3_value_bytes(p) as number;
        const at = Number(capi.sqlite3_value_blob(p));
        const held = wasm.heap8u().subarray(at, at + n);
        const encoded = new TextEncoder().encode(v);
        if (encoded.length !== n || encoded.some((b, j) => b !== held[j])) {
          throw new Error("CHANGES_CAPTURE (sqlite3changeset_value: text that is not UTF-8)");
        }
        return v;
      };
      while (capi.sqlite3changeset_next(it) === capi.SQLITE_ROW) {
        capi.sqlite3changeset_op(it, pTab, pN, pOp, pInd);
        const table = wasm.cstrToJs(wasm.peekPtr(pTab)) as string;
        const n = wasm.peek32(pN) as number;
        const code = wasm.peek32(pOp) as number;
        capi.sqlite3changeset_pk(it, pPk, pPkN);
        const pkFlags = wasm.peekPtr(pPk);
        const names = this.namesOf(table, n);
        const op = code === capi.SQLITE_INSERT ? "INSERT" : code === capi.SQLITE_UPDATE ? "UPDATE" : "DELETE";
        const entry = { table, op, pk: {} as Record<string, unknown>, old: {} as Record<string, unknown>, new: {} as Record<string, unknown> } as const;
        for (let i = 0; i < n; i++) {
          const isPk = wasm.peek8(Number(pkFlags) + i) !== 0;
          const name = names[i]!;
          if (op !== "INSERT") {
            const v = exact(capi.sqlite3changeset_old, i, capi.sqlite3changeset_old_js(it, i));
            if (v !== undefined) (isPk ? entry.pk : entry.old)[name] = plain(v);
          }
          if (op !== "DELETE") {
            const v = exact(capi.sqlite3changeset_new, i, capi.sqlite3changeset_new_js(it, i));
            if (v !== undefined) (isPk ? entry.pk : entry.new)[name] = plain(v);
          }
        }
        ops.push(entry as Any);
      }
      rc = capi.sqlite3changeset_finalize(it);
      if (rc) throw new Error(`CHANGES_CAPTURE (sqlite3changeset_finalize rc=${rc})`);
    } finally {
      wasm.pstack.restore(stack);
      wasm.dealloc(buf);
    }
    return ops;
  }

  /** The changeset's column names. */
  private namesOf(table: string, n: number): string[] {
    if (!this.columns.has(table)) {
      const cols = (this.db.selectObjects(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [table]) as Any[]).map((c) => String(c.name));
      this.columns.set(table, cols);
    }
    return this.columns.get(table)!.slice(0, n);
  }

  schemaChanged(): void {
    this.columns.clear();
  }

  close(): void {
    if (this.session) this.sqlite3.capi.sqlite3session_delete(this.session);
    this.session = 0;
  }
}

/**
 * The runtime's SQL functions, before the schema block runs. A stored
 * document's keys carry `DEFAULT (dai_id(...))` and its triggers name
 * `dai_projecting()`, and SQLite resolves both when it prepares a statement,
 * not when it runs one: an `INSERT … WHERE NOT EXISTS` in the schema block
 * failed on reopen with "unknown function: dai_id()" though it inserted
 * nothing. `Changes` replaces these with the real ones when it starts.
 */
export function stageChangeFunctions(db: Any): void {
  db.createFunction(
    "dai_id",
    () => {
      throw new Error("CHANGES_CAPTURE (an id was asked for before the document's changes were started)");
    },
    { arity: 1, deterministic: false },
  );
  db.createFunction("dai_uuid", () => crypto.randomUUID(), { arity: 0, deterministic: false });
  db.createFunction("dai_projecting", () => 0, { arity: 0, deterministic: false });
  db.createFunction("dai_inserted", () => null, { arity: 2, deterministic: false });
  db.createFunction("dai_enter", () => null, { arity: 0, deterministic: false });
  db.createFunction("dai_leave", () => null, { arity: 0, deterministic: false });
}

/* --------------------------------------------------------------- changes */

export interface ChangesOptions {
  /** This copy's author id, as the host handed it. */
  author: Uint8Array;
  /** The database's exec before anything wrapped it: the runtime's own writes schedule nothing. */
  rawExec?: (sql: Any) => unknown;
}

/** What a save wrote to the log. */
export interface SavedChanges {
  ver: string;
  ops: number;
  bytes: number;
}

export class Changes {
  readonly author: Uint8Array;
  readonly authorHex: string;
  readonly index: number;
  private counter = 0;
  private projecting = false;
  /** An apply asked for while the application held a transaction: run when it ends (R-S). */
  private deferred = false;
  private lastInsert: { rowid: number | null; id: unknown } = { rowid: null, id: null };
  /** The slot as each running application trigger found it (dai_enter), restored when it ends (dai_leave). */
  private frames: { rowid: number | null; id: unknown }[] = [];
  private readonly keysCache = new Map<string, Keys | null>();
  private readonly declaredCache = new Map<string, Declared>();
  private readonly stmts = new Map<string, Any>();
  private capture!: SessionCapture;
  /** How deep the runtime's own calls are: a write to a runtime table is admitted only inside one (T11, P01). */
  private depth = 0;
  private authorizer: unknown = null;
  /** Triggers on runtime tables an imported schema carried, dropped at open (T11). */
  readonly refused: string[] = [];
  /** Set once a save has failed in a way no retry cures (P3): the sentence the person reads. Later writes are held. */
  refusal: string | null = null;
  /** True once the constructor has adopted what the document held: a table made after that is the application's. */
  private started = false;
  /** While an application's schema change runs (R-S): the tables it alters or drops, which the session leaves alone. */
  private schemaChanging = false;
  private readonly schemaTargets = new Set<string>();
  /**
   * Tables made since the last save, which the session does not capture; and
   * every name whose table was made, dropped or renamed onto since then. At
   * the next save each such name is logged by the difference between what its
   * table holds and what its history shows (`unsettledChanges`).
   */
  private readonly uncaptured = new Set<string>();
  private readonly unsettled = new Set<string>();
  /** Tables whose flagged and held rows are decided again at the next apply: a rename here may place them now. */
  private readonly redecide = new Set<string>();
  /** The renames this copy made, as `here` reads them. */
  private readonly shapeCache = new Map<string, string>();
  private readonly exec: (sql: Any) => unknown;
  /** The Rows view the authorship layer writes the log through. */
  readonly rows: Rows;

  constructor(
    private readonly sqlite3: Any,
    readonly db: Any,
    options: ChangesOptions,
  ) {
    this.author = options.author;
    this.authorHex = hex(options.author);
    this.index = authorIndexOf(options.author);
    this.exec = options.rawExec ?? db.exec.bind(db);
    this.rows = {
      all: (sql, params = []) =>
        (db.selectObjects(sql, params.length ? params.slice() : undefined) as Record<string, unknown>[]).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])),
        ),
      run: (sql, params = []) => void this.exec({ sql, bind: params.length ? params.slice() : undefined }),
    };
    const capi = sqlite3.capi;
    db.createFunction("dai_id", () => this.nextId(), { arity: 1, deterministic: false });
    db.createFunction("dai_uuid", () => crypto.randomUUID(), { arity: 0, deterministic: false });
    // 1 while the runtime applies merged rows: the application's own triggers stand down.
    db.createFunction("dai_projecting", () => (this.projecting ? 1 : 0), { arity: 0, deterministic: false });
    db.createFunction(
      "dai_inserted",
      (_c: unknown, rowid: unknown, id: unknown) => {
        this.lastInsert = { rowid: Number(rowid), id: plain(id) };
        return null;
      },
      { arity: 2, deterministic: false },
    );
    db.createFunction(
      "dai_enter",
      () => {
        this.frames.push(this.lastInsert);
        return null;
      },
      { arity: 0, deterministic: false },
    );
    db.createFunction(
      "dai_leave",
      () => {
        this.lastInsert = this.frames.pop() ?? this.lastInsert;
        return null;
      },
      { arity: 0, deterministic: false },
    );
    /*
     * The key is no longer the rowid, so last_insert_rowid() answers from the
     * slot: the application's id for a row of a rewritten integer key, the
     * rowid SQLite would answer for any other (1b-H1). Never the connection's
     * own last rowid, which the runtime's writes move: a save's log row, a
     * seal, a merged row.
     */
    db.createFunction("last_insert_rowid", () => this.lastInsert.id ?? 0, { arity: 0, deterministic: false });
    this.exec(META);
    // Before any write the runtime trusts: a trigger an imported schema hung on a runtime table is gone (T11).
    this.refuseForeignTriggers();
    this.authorize();
    this.trusted(() => {
      // Foreign keys are enforced from open: the runtime never set it before, so a declared REFERENCES was decoration.
      if (capi.sqlite3_get_autocommit(db.pointer)) this.exec("PRAGMA foreign_keys = ON");
      this.capture = new SessionCapture(sqlite3, db, (t) => this.uncaptured.has(t) || this.schemaTargets.has(t));
      this.adoptTables();
      this.counter = this.highestOwnCounter();
    });
    this.started = true;
  }

  /**
   * Runs `f` as the runtime: a write to the runtime's own tables is admitted
   * only inside it (T11, P01). The frame's own writes, the log's seal and the
   * merge's admission among them, go through it too.
   */
  trusted<T>(f: () => T): T {
    this.depth += 1;
    try {
      return f();
    } finally {
      this.depth -= 1;
    }
  }

  /**
   * The runtime's objects are the runtime's (T11, P01, P02), held at
   * execution by SQLite's authorizer, not by the lint. The application may
   * read `_dai*` and `_cs_*`; it may not write them, hang a trigger or an
   * index on them, or make, drop or alter a table or view under those names,
   * by any route: direct SQL, quoted or schema-qualified names, a prepared
   * statement, a TEMP trigger, a view's INSTEAD OF trigger, or a trigger on its
   * own table. A write to a runtime table from inside any trigger but the
   * runtime's own is refused even while the runtime writes, so nothing the
   * application wrote runs under the runtime's authority. The authorizer acts
   * as a statement is prepared; a trigger's body is prepared with the
   * statement that fires it, so a trigger whose body writes a runtime table is
   * refused when it would run.
   */
  private authorize(): void {
    const capi = this.sqlite3.capi;
    const own = new Set(runtimeTriggers(this.sqlite3).keys());
    const writes = new Set([capi.SQLITE_INSERT, capi.SQLITE_UPDATE, capi.SQLITE_DELETE]);
    // The action's second argument names the table.
    const onTable = new Set([
      capi.SQLITE_CREATE_TRIGGER,
      capi.SQLITE_CREATE_TEMP_TRIGGER,
      capi.SQLITE_DROP_TRIGGER,
      capi.SQLITE_DROP_TEMP_TRIGGER,
      capi.SQLITE_CREATE_INDEX,
      capi.SQLITE_CREATE_TEMP_INDEX,
      capi.SQLITE_DROP_INDEX,
      capi.SQLITE_DROP_TEMP_INDEX,
      capi.SQLITE_ALTER_TABLE,
    ]);
    // The first argument names the table or view.
    const named = new Set([
      capi.SQLITE_CREATE_TABLE,
      capi.SQLITE_CREATE_TEMP_TABLE,
      capi.SQLITE_DROP_TABLE,
      capi.SQLITE_DROP_TEMP_TABLE,
      capi.SQLITE_CREATE_VIEW,
      capi.SQLITE_CREATE_TEMP_VIEW,
      capi.SQLITE_DROP_VIEW,
      capi.SQLITE_DROP_TEMP_VIEW,
    ]);
    this.authorizer = (_p: unknown, code: number, a1: unknown, a2: unknown, db: unknown, trigger: unknown): number => {
      const target = writes.has(code) || named.has(code) ? a1 : onTable.has(code) ? a2 : null;
      // A document refused under P3 holds every later write: nothing more is accepted that no save could log.
      if (this.refusal && this.depth === 0 && target !== null) return capi.SQLITE_DENY;
      /*
       * A schema change to an application table runs only as `watch` runs it,
       * between two capture epochs (R-S), which records the table it touches.
       * One prepared any other way, or spelled so `watch` does not see it, is
       * refused before it runs: it would break the capture under the save.
       */
      if ((code === capi.SQLITE_DROP_TABLE || code === capi.SQLITE_ALTER_TABLE) && this.depth === 0) {
        const table = code === capi.SQLITE_DROP_TABLE ? a1 : a2;
        const schema = code === capi.SQLITE_DROP_TABLE ? db : a1;
        if (typeof table === "string" && !runtimeNamed(table) && schema !== "temp") {
          if (!this.schemaChanging) return capi.SQLITE_DENY;
          this.schemaTargets.add(table);
        }
      }
      if (typeof target !== "string" || !runtimeNamed(target)) return capi.SQLITE_OK;
      if (typeof trigger === "string" && trigger.length > 0) return own.has(trigger) && this.depth > 0 ? capi.SQLITE_OK : capi.SQLITE_DENY;
      return this.depth > 0 ? capi.SQLITE_OK : capi.SQLITE_DENY;
    };
    capi.sqlite3_set_authorizer(this.db.pointer, this.authorizer, 0);
  }

  /**
   * A trigger on a runtime table that is not the runtime's own, as an
   * imported schema can carry one: dropped at open, before any write the
   * runtime trusts, so it never runs under the runtime's outbox write (T11,
   * P02). One that takes a runtime trigger's name with other text is put back
   * as the runtime writes it. The names are kept in `refused`.
   */
  private refuseForeignTriggers(): void {
    const expected = runtimeTriggers(this.sqlite3);
    for (const schema of ["main", "temp"]) {
      for (const t of this.db.selectObjects(`SELECT name, tbl_name, sql FROM ${schema}.sqlite_schema WHERE type = 'trigger'`) as Any[]) {
        if (!runtimeNamed(String(t.tbl_name))) continue;
        const want = schema === "main" ? expected.get(String(t.name)) : undefined;
        if (want && spaced(String(t.sql)) === spaced(want)) continue;
        this.exec(`DROP TRIGGER ${schema}.${q(String(t.name))}`);
        if (want) this.exec(want);
        this.refused.push(String(t.name));
      }
    }
  }

  /**
   * The application's handle, watched for schema changes: a table it creates
   * is adopted before its first row, and a script holding an ALTER TABLE or a
   * DROP TABLE runs one statement at a time, so each such statement runs
   * between two capture epochs (R-S, `schemaChange`).
   */
  watch(handle: Any): void {
    const exec = handle.exec.bind(handle);
    handle.exec = (...args: Any[]): Any => {
      // The runtime's own calls (its reads go through exec too) run as they are.
      if (this.depth > 0) return exec(...args);
      const sql = sqlOf(args);
      if (!sql ||!/\b(ALTER|DROP)\b/i.test(sql.text)) return this.statement(handle, () => exec(...args));
      const statements = splitStatements(this.sqlite3, sql.text);
      if (!sql.plain) {
        if (statements.filter(changesSchema).length === 0) return this.statement(handle, () => exec(...args));
        if (statements.length > 1) throw new Error(`CHANGES_REFUSED: ${SCHEMA_REFUSED.alone}`);
        return this.schemaChange(() => exec(...args));
      }
      for (const s of statements) {
        if (changesSchema(s)) this.schemaChange(() => exec(s));
        else this.statement(handle, () => exec(s));
      }
      return handle;
    };
  }

  /** One statement, or one script with no schema change in it, as the application ran it. */
  private statement(handle: Any, run: () => Any): Any {
    const before = handle.selectValue("PRAGMA schema_version");
    let result: Any;
    try {
      result = run();
    } finally {
      this.settleFrames();
    }
    if (handle.selectValue("PRAGMA schema_version") !== before) this.adoptTables();
    // An apply that waited for the application's transaction runs once it ends (R-S).
    if ((this.deferred || this.redecide.size > 0) && !this.inTransaction) this.projectAdmitted();
    return result;
  }

  /**
   * An ALTER TABLE or a DROP TABLE, between two capture epochs (R-S: DDL
   * closes the epoch). The epoch is logged first, so no change the session
   * holds is read back under the new schema; inside the application's
   * transaction its log row is written in that transaction, and commits or
   * rolls back with it. The statement runs with the table it alters or drops
   * left out of the session, so what it does to that table's rows is the
   * change's, while a cascade it causes elsewhere is captured. Then what it
   * wrote is logged, and a new epoch begins with the new schema. A change the
   * runtime cannot follow is undone and refused (`followSchema`).
   */
  private schemaChange(run: () => Any): Any {
    const before = this.trusted(() => {
      const shape = this.shapeOf();
      this.closeEpoch();
      this.exec("SAVEPOINT cs_schema");
      return shape;
    });
    // The statement itself runs as the application's, under every check the authorizer makes of one.
    this.schemaChanging = true;
    let result: Any;
    try {
      result = run();
      this.schemaChanging = false;
      this.trusted(() => this.followSchema(before, this.shapeOf()));
    } catch (e) {
      this.schemaChanging = false;
      this.schemaTargets.clear();
      this.trusted(() => {
        try {
          this.exec("ROLLBACK TO cs_schema");
          this.exec("RELEASE cs_schema");
        } catch {
          // A failure that rolled the whole transaction back took the savepoint with it.
        }
      });
      this.settleFrames();
      throw e;
    }
    this.trusted(() => {
      this.exec("RELEASE cs_schema");
      this.schemaTargets.clear();
      this.settleFrames();
      this.closeEpoch();
    });
    this.adoptTables();
    if ((this.deferred || this.redecide.size > 0) && !this.inTransaction) this.projectAdmitted();
    return result;
  }

  /** The application's tables and their columns, in order: what a schema change is read from. */
  private shapeOf(): Map<string, string[]> {
    return new Map(
      appTablesOf(this.rows).map((t) => [t, this.db.selectValues("SELECT name FROM pragma_table_info(?) ORDER BY cid", [t]) as string[]]),
    );
  }

  /**
   * The runtime's records follow a schema change (R-S). A table or column
   * renamed takes its history with it, and the rename is recorded, so a
   * change made before it, arriving later, lands under the new name; a held
   * row naming the new one is decided again (1d-M2). A table dropped, made,
   * or made since the last save and renamed, is left to the next save, which
   * logs it by difference (`unsettledChanges`). A dropped column is recorded,
   * so a merged value for it is kept in the cells and not written. Refused
   * before anything is changed: a declared column renamed or dropped, and a
   * captured table renamed onto a name dropped since the last save.
   */
  private followSchema(before: Map<string, string[]>, after: Map<string, string[]>): void {
    const gone = [...before.keys()].filter((t) => !after.has(t));
    const made = [...after.keys()].filter((t) => !before.has(t));
    const columnChanges: { table: string; from: string; to: string | null }[] = [];
    for (const [table, was] of before) {
      const now = after.get(table);
      if (!now || now.join("\u0000") === was.join("\u0000")) continue;
      if (now.length === was.length) {
        const at = was.findIndex((c, i) => c !== now[i]);
        if (at >= 0 && was.every((c, i) => i === at || c === now[i])) columnChanges.push({ table, from: was[at]!, to: now[at]! });
      } else if (now.length < was.length) {
        for (const c of was.filter((c) => !now.includes(c))) columnChanges.push({ table, from: c, to: null });
      }
    }
    const renamed = gone.length === 1 && made.length === 1 ? { from: gone[0]!, to: made[0]! } : null;
    for (const change of columnChanges) {
      if (this.uncaptured.has(change.table)) continue;
      const d = this.declaredOf(change.table);
      if ([...d.coupled.flat(), ...d.consequential].includes(change.from)) throw new Error(`CHANGES_REFUSED: ${SCHEMA_REFUSED.declared}`);
    }
    if (renamed && !this.uncaptured.has(renamed.from) && this.unsettled.has(renamed.to)) {
      throw new Error(`CHANGES_REFUSED: ${SCHEMA_REFUSED.renamedOnto}`);
    }

    const meta = ["_cs_cell", "_cs_sup", "_cs_seen", "_cs_flag", "_cs_held", "_cs_spell"];
    if (renamed && this.uncaptured.has(renamed.from)) {
      // Made since the last save: nothing of it is in the history, and both names are settled at the save.
      this.uncaptured.delete(renamed.from);
      this.uncaptured.add(renamed.to);
      this.unsettled.add(renamed.from).add(renamed.to);
      this.moveKeys(renamed.from, renamed.to);
    } else if (renamed) {
      for (const t of meta) {
        const cols = (this.db.selectValues(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [t]) as string[]).map(q);
        const moved = cols.map((c) => (c === '"tbl"' ? "?" : c)).join(", ");
        this.exec({ sql: `INSERT OR IGNORE INTO main.${t} (${cols.join(", ")}) SELECT ${moved} FROM main.${t} WHERE tbl = ?`, bind: [renamed.to, renamed.from] });
        this.exec({ sql: `DELETE FROM main.${t} WHERE tbl = ?`, bind: [renamed.from] });
      }
      this.moveKeys(renamed.from, renamed.to);
      this.exec({ sql: "INSERT OR REPLACE INTO main._cs_shape (kind, tbl, col, now) VALUES ('table', ?, '', ?)", bind: [renamed.from, renamed.to] });
      this.exec({ sql: "UPDATE OR REPLACE main._cs_shape SET tbl = ? WHERE tbl = ? AND kind <> 'table'", bind: [renamed.to, renamed.from] });
      this.exec({ sql: "DELETE FROM main._cs_shape WHERE kind = 'dropped' AND tbl = ? AND col = ''", bind: [renamed.to] });
      this.redecide.add(renamed.to);
    } else {
      for (const t of gone) this.unsettled.add(t);
    }
    for (const change of columnChanges) {
      if (this.uncaptured.has(change.table)) continue;
      if (change.to === null) {
        this.exec({ sql: "INSERT OR REPLACE INTO main._cs_shape (kind, tbl, col, now) VALUES ('dropped', ?, ?, NULL)", bind: [change.table, change.from] });
        continue;
      }
      for (const t of ["_cs_cell", "_cs_sup"]) {
        const cols = (this.db.selectValues(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [t]) as string[]).map(q);
        const moved = cols.map((c) => (c === '"col"' ? "?" : c)).join(", ");
        this.exec({
          sql: `INSERT OR IGNORE INTO main.${t} (${cols.join(", ")}) SELECT ${moved} FROM main.${t} WHERE tbl = ? AND col = ?`,
          bind: [change.to, change.table, change.from],
        });
        this.exec({ sql: `DELETE FROM main.${t} WHERE tbl = ? AND col = ?`, bind: [change.table, change.from] });
      }
      this.exec({ sql: "UPDATE main._cs_shape SET now = ? WHERE kind = 'column' AND tbl = ? AND now = ?", bind: [change.to, change.table, change.from] });
      this.exec({ sql: "INSERT OR REPLACE INTO main._cs_shape (kind, tbl, col, now) VALUES ('column', ?, ?, ?)", bind: [change.table, change.from, change.to] });
      this.exec({ sql: "DELETE FROM main._cs_shape WHERE kind = 'dropped' AND tbl = ? AND col = ?", bind: [change.table, change.to] });
      this.redecide.add(change.table);
    }
    this.shapeCache.clear();
    this.keysCache.clear();
    this.declaredCache.clear();
    this.capture.schemaChanged();
  }

  /** A table's key record under its new name. */
  private moveKeys(from: string, to: string): void {
    this.exec({ sql: "INSERT OR REPLACE INTO main._cs_keys (tbl, kind, pk) SELECT ?, kind, pk FROM main._cs_keys WHERE tbl = ?", bind: [to, from] });
    this.exec({ sql: "DELETE FROM main._cs_keys WHERE tbl = ?", bind: [from] });
  }

  /** What a name in another copy's changeset is called here, after the renames this copy made (1d-M2). */
  private here(table: string, col?: string): string {
    const key = col === undefined ? `t|${table}` : `c|${table}|${col}`;
    let found = this.shapeCache.get(key);
    if (found === undefined) {
      if (col === undefined) {
        found = table;
        for (let i = 0; i < 32; i++) {
          const next: unknown = this.db.selectValue("SELECT now FROM main._cs_shape WHERE kind = 'table' AND tbl = ? AND col = ''", [found]);
          if (next == null || next === found) break;
          found = String(next);
        }
      } else {
        found = String(this.db.selectValue("SELECT now FROM main._cs_shape WHERE kind = 'column' AND tbl = ? AND col = ?", [table, col]) ?? col);
      }
      this.shapeCache.set(key, found);
    }
    return found;
  }

  /** Whether this copy dropped the table, or the column of it. */
  private droppedHere(table: string, col = ""): boolean {
    const key = `d|${table}|${col}`;
    let found = this.shapeCache.get(key);
    if (found === undefined) {
      found = this.db.selectValue("SELECT 1 FROM main._cs_shape WHERE kind = 'dropped' AND tbl = ? AND col = ?", [table, col]) != null ? "1" : "";
      this.shapeCache.set(key, found);
    }
    return found === "1";
  }

  /**
   * Logs the capture epoch as it stands and starts the next (R-S), at a
   * schema change. Inside the application's transaction the log row is
   * written in it. The names left to the next save are not settled here: a
   * table made in a rebuild is settled only once the rebuild is done.
   */
  private closeEpoch(): void {
    this.trusted(() => this.saving({ epoch: true }));
    this.capture.clear();
  }

  /**
   * After a statement: a trigger that ended without reaching dai_leave (an
   * error, a RAISE) left its frame open. SQLite restores the last rowid to
   * what it was when the outermost trigger began, and so does this.
   */
  private settleFrames(): void {
    if (this.frames.length === 0) return;
    this.lastInsert = this.frames[0]!;
    this.frames = [];
  }

  /** Runtime writes to the application's tables leave the application's last insert as it was. */
  private keepingLastInsert<T>(f: () => T): T {
    const kept = this.lastInsert;
    try {
      return f();
    } finally {
      this.lastInsert = kept;
    }
  }

  /* ------------------------------------------------------------ keys */

  private highestOwnCounter(): number {
    const base = this.index * SPAN;
    let high = 0;
    for (const { tbl, pk } of this.db.selectObjects("SELECT tbl, pk FROM _cs_keys WHERE kind IN ('ranged', 'hidden')") as Any[]) {
      const col = q(pk);
      const m = this.db.selectValue(`SELECT max(${col}) FROM ${q(tbl)} WHERE ${col} >= ? AND ${col} < ?`, [base, base + SPAN]);
      if (m != null) high = Math.max(high, Number(m) - base);
    }
    // Every id the range has held is in the cells, deleted rows included, whoever wrote it: a row another
    // copy wrote into this range with an explicit id and then deleted is a high-water mark too (K06, K07).
    const cells = this.db.selectValues(
      "SELECT DISTINCT c.pk FROM _cs_cell c JOIN _cs_keys k ON k.tbl = c.tbl AND k.kind IN ('ranged', 'hidden')",
    ) as string[];
    for (const text of cells) {
      const id = keyValues(text)[0];
      if (typeof id === "number" && id >= base && id < base + SPAN) high = Math.max(high, id - base);
    }
    return high;
  }

  /**
   * The counter, raised past an id in this author's range that any changeset
   * carries (PR9-H4; K06, K07). The constructor reads the tables and cells as
   * they are, and a copy rebuilt from an arrival has neither until its log is
   * projected, so the counter started at 0 and the author's next inserts
   * failed on their own earlier rows, or silently reused a deleted row's id.
   * Every changeset passes through `ingest`, its inserts of deleted rows
   * included, and another author's explicit id in this range counts as this
   * author's own would: the range's high-water mark is the log's.
   */
  private counterAbove(table: string, k: unknown[]): void {
    const kind = this.keysOf(table)?.kind;
    if (kind !== "ranged" && kind !== "hidden") return;
    const id = k[0];
    const base = this.index * SPAN;
    if (typeof id === "number" && id >= base && id < base + SPAN) this.counter = Math.max(this.counter, id - base);
  }

  private nextId(): number {
    this.counter += 1;
    if (this.counter >= SPAN) throw new Error("ID_RANGE_EXHAUSTED");
    return this.index * SPAN + this.counter;
  }

  /** Each application table, once: its key kind recorded and, for an integer, text or absent key, rewritten. */
  adoptTables(): void {
    this.trusted(() => this.adopting());
  }

  private adopting(): void {
    const db = this.db;
    const known = new Set(db.selectValues("SELECT tbl FROM _cs_keys") as string[]);
    for (const table of appTablesOf(this.rows)) {
      if (known.has(table)) continue;
      const info = db.selectObjects("SELECT name, type, pk, dflt_value FROM pragma_table_info(?) ORDER BY cid", [table]) as Any[];
      const pks = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      const sql = String(db.selectValue("SELECT sql FROM sqlite_schema WHERE name = ?", [table]) ?? "");
      const withoutRowid = /WITHOUT\s+ROWID\s*$/i.test(sql.trim());
      const virtual = /^\s*CREATE\s+VIRTUAL\b/i.test(sql);
      if (virtual) continue;
      // Made by the application: logged at the next save by what it holds, not captured row by row, so a
      // table a rebuild copies into is the rebuild's and not an edit (R-S).
      if (this.started) {
        this.uncaptured.add(table);
        this.unsettled.add(table);
      }
      let kind: KeyKind = "natural";
      const dflt = String(pks[0]?.dflt_value ?? "");
      if (pks.length === 0) {
        // A table the compiler did not see (made later by the application): given its hidden key now.
        if (!this.rebuild(table, HIDDEN_KEY, "hidden")) continue;
        kind = "hidden";
        pks.push({ name: HIDDEN_KEY });
      } else if (pks.length === 1 && pks[0].name === HIDDEN_KEY && /dai_id\(/.test(dflt)) kind = "hidden";
      else if (pks.length === 1 && /dai_id\(/.test(dflt)) kind = "ranged";
      else if (pks.length === 1 && /dai_uuid\(/.test(dflt)) kind = "uuid";
      // Integer affinity, by SQLite's own rule over the type it reports (a type naming INT): INTEGER, INT, BIGINT, INT8 (1d-H3).
      else if (pks.length === 1 && /INT/i.test(String(pks[0].type)) && !withoutRowid) kind = "ranged";
      else if (pks.length === 1 && /TEXT|CHAR|CLOB/i.test(String(pks[0].type)) && !pks[0].dflt_value) kind = "uuid";
      if ((kind === "ranged" || kind === "uuid") && !/dai_(id|uuid)\(/.test(dflt)) {
        if (!this.rebuild(table, pks[0].name, kind, String(pks[0].type))) kind = "natural";
      }
      if (kind === "ranged") {
        this.exec(
          `CREATE TRIGGER IF NOT EXISTS ${q(`_cs_id_${table}`)} AFTER INSERT ON ${q(table)} BEGIN SELECT dai_inserted(NEW.rowid, NEW.${q(pks[0].name)}); END`,
        );
      }
      this.exec({
        sql: "INSERT OR REPLACE INTO _cs_keys (tbl, kind, pk) VALUES (?, ?, ?)",
        bind: [table, kind, pks.map((c) => c.name).join(",")],
      });
    }
    this.slotEveryInsert();
    this.refuseNullKeys();
    this.guardTriggers();
    this.keysCache.clear();
    this.declaredCache.clear();
    this.settleViews();
    this.capture?.schemaChanged();
  }

  /**
   * Every other table with a rowid records its inserts in the same slot, as
   * its own rowid: what SQLite answers for it (PR9-H3). A WITHOUT ROWID table
   * leaves last_insert_rowid() as it was, in SQLite and here. An insert a
   * trigger makes is restored away when the application's trigger ends
   * (guardTriggers), so the order triggers fire in does not matter (1b-L4).
   */
  private slotEveryInsert(): void {
    for (const { tbl } of this.db.selectObjects("SELECT tbl FROM _cs_keys WHERE kind IN ('uuid', 'natural', 'hidden')") as Any[]) {
      const sql = String(this.db.selectValue("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", [tbl]) ?? "");
      if (!sql || /WITHOUT\s+ROWID\s*$/i.test(sql.trim())) continue;
      this.exec(`CREATE TRIGGER IF NOT EXISTS ${q(`_cs_id_${tbl}`)} AFTER INSERT ON ${q(tbl)} BEGIN SELECT dai_inserted(NEW.rowid, NEW.rowid); END`);
    }
  }

  /**
   * A NULL in a key, refused as it executes (1d-H3, C02; R-V). The session
   * does not capture a row with a NULL in its primary key, and SQLite allows
   * one in a rowid table's key that is not the rowid alias, so such a row was
   * kept here, logged nowhere, and reported as nothing to save. A ranged,
   * uuid or hidden key is never NULL (NOT NULL ... ON CONFLICT REPLACE takes
   * its default), and a WITHOUT ROWID table's never is; every other key gets
   * a runtime trigger, before insert and before an update of its columns.
   */
  private refuseNullKeys(): void {
    for (const { tbl, pk } of this.db.selectObjects("SELECT tbl, pk FROM _cs_keys WHERE kind = 'natural'") as Any[]) {
      const sql = String(this.db.selectValue("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", [tbl]) ?? "");
      const cols = String(pk).split(",").filter(Boolean);
      if (!sql || !cols.length || /WITHOUT\s+ROWID\s*$/i.test(sql.trim())) continue;
      const when = cols.map((c) => `NEW.${q(c)} IS NULL`).join(" OR ");
      const raise = `SELECT RAISE(ABORT, ${sqlText(`CHANGES_REFUSED: ${KEY_REFUSED}`)})`;
      this.exec(`CREATE TRIGGER IF NOT EXISTS ${q(`_cs_key_${tbl}`)} BEFORE INSERT ON ${q(tbl)} WHEN ${when} BEGIN ${raise}; END`);
      this.exec(
        `CREATE TRIGGER IF NOT EXISTS ${q(`_cs_rekey_${tbl}`)} BEFORE UPDATE OF ${cols.map(q).join(", ")} ON ${q(tbl)} WHEN ${when} BEGIN ${raise}; END`,
      );
    }
  }

  /**
   * The application's triggers, made to stand down while the runtime applies
   * merged rows. What a trigger did on the copy that wrote is already in that
   * copy's changeset (the session records rows a trigger writes), so firing it
   * again on the receiving copy writes rows nobody captured: a divergence
   * (the spike's S8).
   *
   * Each body is also framed by `dai_enter()` and `dai_leave()`, which save
   * and restore the last-insert slot, as SQLite saves and restores the last
   * rowid around every trigger program (1b-H1): an insert a trigger makes,
   * fired by an INSERT, UPDATE or DELETE, is never the statement's.
   */
  private guardTriggers(): void {
    const apps = new Set(appTablesOf(this.rows));
    for (const { name, tbl_name, sql } of this.db.selectObjects(
      "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND sql IS NOT NULL",
    ) as Any[]) {
      if (String(name).startsWith("_cs_") || !apps.has(tbl_name)) continue;
      const at = String(sql).search(/\bBEGIN\b/i);
      if (at < 0) continue;
      let head = String(sql).slice(0, at);
      let body = String(sql).slice(at);
      if (!head.includes("dai_projecting()")) {
        head = /\bWHEN\b/i.test(head)
          ? head.replace(/\bWHEN\b([\s\S]*)$/i, "WHEN dai_projecting() = 0 AND ($1) ")
          : `${head.trimEnd()} WHEN dai_projecting() = 0 `;
      }
      if (!body.includes("dai_enter()") && /\bEND\s*;?\s*$/i.test(body)) {
        body = body.replace(/^BEGIN\b/i, "BEGIN SELECT dai_enter();").replace(/\bEND\s*;?\s*$/i, "SELECT dai_leave(); END");
      }
      if (head + body === String(sql)) continue;
      this.paused(() => {
        this.exec(`DROP TRIGGER ${q(name)}`);
        this.exec(head + body);
      });
    }
  }

  /**
   * The table rebuilt with its key's DDL rewritten; indexes and triggers come
   * back as they were. False when it cannot be. A table given its hidden key
   * gets one for each row it already holds, and those rows are captured as
   * inserts: the application wrote them, under no key the log could carry.
   */
  private rebuild(table: string, column: string, kind: "ranged" | "uuid" | "hidden", type?: string): boolean {
    const exec = this.exec;
    const sql = String(this.db.selectValue("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", [table]));
    let rewritten: string;
    try {
      rewritten = kind === "hidden" ? withHiddenKeys(sql) : rewriteKeySql(sql, table, column, kind, type);
    } catch {
      return false;
    }
    if (rewritten === sql) return false;
    // The ordinary columns, by name: a generated column takes no value (C05), and SELECT * would hand it one.
    const cols = (this.db.selectValues("SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid", [table]) as string[]).map(q).join(", ");
    const others = this.db.selectValues(
      "SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
      [table],
    ) as string[];
    const old = `_cs_old_${table}`;
    const inTxn = !this.sqlite3.capi.sqlite3_get_autocommit(this.db.pointer);
    const fk = this.db.selectValue("PRAGMA foreign_keys");
    this.keepingLastInsert(() => this.paused(() => {
      if (!inTxn) exec("PRAGMA foreign_keys = OFF");
      exec("PRAGMA legacy_alter_table = ON");
      try {
        exec("SAVEPOINT cs_rebuild");
        exec(`ALTER TABLE ${q(table)} RENAME TO ${q(old)}`);
        exec(rewritten);
        if (kind === "hidden") this.capture.captured(() => exec(`INSERT INTO ${q(table)} (${cols}) SELECT ${cols} FROM ${q(old)}`));
        else exec(`INSERT INTO ${q(table)} (${cols}) SELECT ${cols} FROM ${q(old)}`);
        exec(`DROP TABLE ${q(old)}`);
        for (const s of others) exec(s);
        exec("RELEASE cs_rebuild");
      } catch (e) {
        exec("ROLLBACK TO cs_rebuild");
        exec("RELEASE cs_rebuild");
        throw e;
      } finally {
        exec("PRAGMA legacy_alter_table = OFF");
        if (fk && !inTxn) exec("PRAGMA foreign_keys = ON");
      }
    }));
    return true;
  }

  declaredOf(table: string): Declared {
    let d = this.declaredCache.get(table);
    if (!d) {
      // Read strictly, against the columns SQLite reports: a line that does not read exactly is ignored (1b-H2).
      const sql = String(this.db.selectValue("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", [table]) ?? "");
      d = declaredIn(sql, this.db.selectValues("SELECT name FROM pragma_table_info(?) ORDER BY cid", [table]) as string[]);
      this.declaredCache.set(table, d);
    }
    return d;
  }

  /**
   * For each table with a consequential column, the rows the kit's query views
   * read: every row but one whose value in such a column is pending (R-F
   * amended). Kept in `_cs_settle` as the body of a common table expression
   * the kit puts in front of a view's query under the table's own name, so the
   * view's SQL is the application's, unchanged. Every other read sees the
   * row, holding the later value.
   */
  private settleViews(): void {
    const want = new Map<string, string>();
    for (const table of appTablesOf(this.rows)) {
      const cols = this.declaredOf(table).consequential;
      const keys = this.keysOf(table);
      if (!cols.length || !keys) continue;
      const key = keys.pk.map(q).join(", ");
      want.set(
        table,
        `SELECT * FROM main.${q(table)} WHERE json_array(${key}) NOT IN (SELECT f.pk FROM main._cs_flag f, json_each(f.detail) j ` +
          `WHERE f.tbl = ${sqlText(table)} AND f.kind = 'pending' AND json_extract(j.value, '$.col') IN (${cols.map(sqlText).join(", ")}))`,
      );
    }
    const have = new Map((this.db.selectObjects("SELECT tbl, body FROM _cs_settle") as Any[]).map((r) => [String(r.tbl), String(r.body)]));
    if (want.size === have.size && [...want].every(([t, b]) => have.get(t) === b)) return;
    this.exec("DELETE FROM _cs_settle");
    for (const [tbl, body] of want) this.exec({ sql: "INSERT INTO _cs_settle (tbl, body) VALUES (?, ?)", bind: [tbl, body] });
  }

  keysOf(table: string): Keys | null {
    if (!this.keysCache.has(table)) {
      const row = this.db.selectObject("SELECT kind, pk FROM _cs_keys WHERE tbl = ?", [table]) as Any;
      this.keysCache.set(table, row ? { kind: row.kind, pk: row.pk ? String(row.pk).split(",") : [] } : null);
    }
    return this.keysCache.get(table)!;
  }

  /* ------------------------------------------------------------ save */

  /** Whether the application has a transaction open: a save is a committed state, so a transaction is one changeset. */
  get inTransaction(): boolean {
    return !this.sqlite3.capi.sqlite3_get_autocommit(this.db.pointer);
  }

  /**
   * Whether the application changed anything the next save would log: the
   * current capture epoch (R-S). An edit made while a save's batch is being
   * signed is here, not in the log, until the next save (Q07).
   */
  get dirty(): boolean {
    return !this.capture.isEmpty() || this.unsettled.size > 0;
  }

  /**
   * One save: what changed since the last one, as a changeset, appended to the
   * log as one row under this author. Null when nothing changed, or when the
   * application holds a transaction open (its changes go with the next save).
   * The authorship layer's replica and seq are the caller's to settle first.
   *
   * The capture is cleared only once the batch is logged (1b-H2). The payload
   * is built and logged inside a savepoint, so a save that throws anywhere,
   * from building one row's bases to the log write itself, leaves nothing of
   * itself in the log and every change it held for the next save.
   */
  save(): SavedChanges | null {
    return this.trusted(() => this.saving());
  }

  /**
   * `epoch`: a schema change closing the capture epoch, inside the
   * application's transaction or not; it logs what the session holds and
   * nothing else. Otherwise a save, which also settles every name a schema
   * change left to it.
   */
  private saving(opts: { epoch?: boolean } = {}): SavedChanges | null {
    if (this.refusal) return null;
    if (this.inTransaction && !opts.epoch) return null;
    let ops: ReturnType<SessionCapture["changes"]>;
    let settling: { ops: ReturnType<SessionCapture["changes"]>; dropped: string[] } = { ops: [], dropped: [] };
    let logged: { payloadOps: Op[]; payload: Uint8Array; ver: string; touched: [string, string][] } | null = null;
    try {
      ops = this.capture.changes();
      if (!opts.epoch) settling = this.unsettledChanges();
    } catch (e) {
      throw this.refusedBy(e);
    }
    const all = [...ops, ...settling.ops];
    if (all.length > 0) {
      this.exec("SAVEPOINT cs_save");
      try {
        let payloadOps: Op[];
        let payload: Uint8Array;
        try {
          payloadOps = all.map((op) => this.withBases(op));
          payload = cborEncode([1, payloadOps as unknown as CborValue[]] as CborValue);
        } catch (e) {
          throw this.refusedBy(e);
        }
        const entity = crypto.getRandomValues(new Uint8Array(16));
        const row = createEntity(this.rows, CHANGES_LOG, entity, { payload });
        const ver = `${this.authorHex}:${row._r_seq}`;
        const touched = this.ingest(payloadOps, ver, Number(row._r_lc), this.authorHex);
        this.exec("RELEASE cs_save");
        logged = { payloadOps, payload, ver, touched };
      } catch (e) {
        this.exec("ROLLBACK TO cs_save");
        this.exec("RELEASE cs_save");
        throw e;
      }
    }
    // Net-zero work (an insert then its delete) leaves the session touched with nothing to log; it starts
    // over too, so `dirty` says exactly whether a save has something to log.
    if (logged || !this.capture.isEmpty()) this.capture.clear();
    if (!opts.epoch) {
      for (const t of settling.dropped) {
        this.exec({ sql: "INSERT OR REPLACE INTO main._cs_shape (kind, tbl, col, now) VALUES ('dropped', ?, '', NULL)", bind: [t] });
      }
      if (settling.dropped.length) this.shapeCache.clear();
      this.uncaptured.clear();
      this.unsettled.clear();
    }
    if (!logged) return null;
    const { payloadOps, payload, ver, touched } = logged;
    // A save over a flagged or held row may have resolved it: decide it again.
    const marked = touched.filter(
      ([t, pk]) =>
        this.db.selectValue(
          "SELECT 1 FROM _cs_flag WHERE tbl = ? AND pk = ? UNION SELECT 1 FROM _cs_held WHERE tbl = ? AND pk = ?",
          [t, pk, t, pk],
        ) != null,
    );
    if (marked.length) this.withoutCapture(() => this.project(marked));
    return { ver, ops: payloadOps.length, bytes: payload.length };
  }

  /**
   * A save's failure, classified (P3). One a retry can cure (a busy or full
   * database, a write that failed) is returned as it was, and the save is
   * retried with everything it held. One no retry cures (the session cannot
   * read back what it holds, or a value cannot be encoded) refuses the
   * document: the sentence is kept in `refusal`, later writes are held, and
   * no later save or merge runs, so nothing more is accepted that no save
   * could log.
   */
  private refusedBy(e: unknown): Error {
    const message = e instanceof Error ? e.message : String(e);
    const rc = /CHANGES_CAPTURE \(sqlite3session_changeset rc=(\d+)\)/.exec(message);
    const permanent =
      e instanceof CborError || e instanceof TypeError || /CHANGES_CAPTURE \(sqlite3changeset_/.test(message) || (rc !== null && !RETRYABLE_RC.has(Number(rc[1])));
    if (!permanent) return e instanceof Error ? e : new Error(message);
    this.refusal = SAVE_REFUSED;
    return new Error(`CHANGES_SAVE_REFUSED: ${SAVE_REFUSED}`, { cause: e });
  }

  /**
   * Each name a schema change left to this save, logged by difference (R-S):
   * what the table under that name holds now against what the history shows
   * under it. A table made since the last save is all inserts, so its rows
   * are logged as the application wrote them; a rebuild (a table made, filled,
   * and renamed onto the name of the one it replaces) logs only what it
   * changed, and a row it copied unchanged is no edit; a name with no table
   * now logs a delete of each row its history shows, so a dropped table's
   * rows go on every copy. A column the history has no value for in a row
   * (one added since) is the schema change's, and is not compared. A held row
   * is left as it is.
   */
  private unsettledChanges(): { ops: ReturnType<SessionCapture["changes"]>; dropped: string[] } {
    const ops: ReturnType<SessionCapture["changes"]> = [];
    const dropped: string[] = [];
    const exists = new Set(appTablesOf(this.rows));
    for (const table of [...this.unsettled].sort()) {
      const keys = this.keysOf(table);
      if (!keys || keys.pk.length === 0) continue;
      const history = new Map<string, Record<string, unknown>>();
      for (const pk of this.db.selectValues("SELECT DISTINCT pk FROM main._cs_cell WHERE tbl = ? ORDER BY pk", [table]) as string[]) {
        if (this.db.selectValue("SELECT 1 FROM main._cs_held WHERE tbl = ? AND pk = ?", [table, pk]) != null) continue;
        const state = this.stateOf(table, pk);
        if (state && !state.deleted) history.set(pk, state.values);
      }
      const keyOf = (pk: string): Record<string, unknown> => Object.fromEntries(keyValues(pk).map((v, i) => [keys.pk[i]!, v]));
      if (!exists.has(table)) {
        for (const [pk, values] of history) ops.push({ table, op: "DELETE", pk: keyOf(pk), old: values, new: {} });
        dropped.push(table);
        continue;
      }
      const cols = (this.db.selectValues("SELECT name FROM pragma_table_info(?) ORDER BY cid", [table]) as string[]).filter((c) => !keys.pk.includes(c));
      const current = new Map<string, Record<string, unknown>>();
      const all = [...keys.pk, ...cols];
      // Each text value with the bytes SQLite holds for it, so text that is not UTF-8 is refused here as at capture.
      const raw = all.flatMap((c, i) => [
        `CASE WHEN typeof(${q(c)}) = 'text' THEN CAST(${q(c)} AS BLOB) END AS "_cs_raw_${i}"`,
        `typeof(${q(c)}) AS "_cs_t_${i}"`,
      ]);
      for (const r of this.db.selectObjects(`SELECT ${[...all.map(q), ...raw].join(", ")} FROM main.${q(table)}`) as Any[]) {
        all.forEach((c, i) => {
          const held = r[`_cs_raw_${i}`] as Uint8Array | null;
          const encoded = typeof r[c] === "string" ? new TextEncoder().encode(r[c]) : null;
          if (held && encoded && (encoded.length !== held.length || encoded.some((b, j) => b !== held[j]))) {
            throw new Error("CHANGES_CAPTURE (sqlite3changeset_value: text that is not UTF-8)");
          }
        });
        const row = Object.fromEntries(all.map((c, i) => [c, typed(r[`_cs_t_${i}`], r[c])]));
        current.set(this.identity(table, keys.pk.map((c) => row[c])), row);
      }
      for (const [pk, row] of [...current].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        const pkCols = Object.fromEntries(keys.pk.map((c) => [c, row[c]]));
        const was = history.get(pk);
        if (!was) {
          ops.push({ table, op: "INSERT", pk: pkCols, old: {}, new: Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) });
          continue;
        }
        const changed = cols.filter((c) => c in was && !sameValue(was[c], row[c]));
        if (changed.length) {
          ops.push({
            table,
            op: "UPDATE",
            pk: pkCols,
            old: Object.fromEntries(changed.map((c) => [c, was[c]])),
            new: Object.fromEntries(changed.map((c) => [c, row[c] ?? null])),
          });
        }
      }
      for (const [pk, values] of history) if (!current.has(pk)) ops.push({ table, op: "DELETE", pk: keyOf(pk), old: values, new: {} });
    }
    return { ops, dropped };
  }

  private stmt(sql: string): Any {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private runCached(sql: string, bind: unknown[]): void {
    const s = this.stmt(sql);
    try {
      s.bind(bind).step();
    } finally {
      s.reset(true);
    }
  }

  /** Every current version of one row, by column ("" is existence). */
  private rowHeads(table: string, pk: string): Map<string, { ver: string; val: unknown }[]> {
    const s = this.stmt(
      "SELECT col, ver, val FROM _cs_cell c WHERE tbl = ? AND pk = ? AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = c.tbl AND s.pk = c.pk AND s.col = c.col AND s.ver = c.ver) ORDER BY col, ver",
    );
    const heads = new Map<string, { ver: string; val: unknown }[]>();
    try {
      s.bind([table, pk]);
      while (s.step()) {
        const col = String(s.get(0));
        heads.set(col, [...(heads.get(col) ?? []), { ver: String(s.get(1)), val: s.get(2) }]);
      }
    } finally {
      s.reset(true);
    }
    return heads;
  }

  private withBases(op: ReturnType<SessionCapture["changes"]>[number]): Op {
    const keys = this.keysOf(op.table);
    const keyCols = keys?.pk?.length ? keys.pk : Object.keys(op.pk);
    const k = keyCols.map((c) => op.pk[c]);
    const pk = this.identity(op.table, k);
    const n = new Map<string, unknown>();
    const p = new Map<string, unknown>();
    const b = new Map<string, string[]>();
    let seen: string[] = [];
    const code = op.op === "INSERT" ? "I" : op.op === "UPDATE" ? "U" : "D";
    if (code === "I") n.set("", 1);
    if (code === "D") n.set("", 0);
    for (const [c, v] of Object.entries(op.new)) n.set(c, v);
    for (const [c, v] of Object.entries(op.old)) p.set(c, v);
    // A change to any column of a coupled group writes the whole group as it stands, so the group's
    // columns share their versions: two concurrent changes to it conflict on every column of it, and
    // the later by (lc, author) shows on all of them together (R-F amended).
    if (code === "U" && keys) {
      const groups = this.declaredOf(op.table).coupled.filter((g) => g.some((c) => n.has(c)));
      const missing = [...new Set(groups.flat())].filter((c) => !n.has(c));
      if (missing.length) {
        const where = this.whereKey(op.table);
        const now = this.db.selectObject(
          `SELECT ${missing.map((c) => `${q(c)}, typeof(${q(c)}) AS ${q(`_cs_t_${c}`)}`).join(", ")} FROM main.${q(op.table)} WHERE ${where}`,
          k.map(compared),
        ) as Any;
        if (now) for (const c of missing) n.set(c, typed(now[`_cs_t_${c}`], now[c]));
      }
    }
    const heads = this.rowHeads(op.table, pk);
    // A change to a row a delete contested also re-asserts it: editing it is keeping it.
    if (code === "U" && (heads.get("") ?? []).some((h) => Number(h.val) === 0)) n.set("", 1);
    for (const c of n.keys()) b.set(c, (heads.get(c) ?? []).map((h) => h.ver));
    if (code === "D") {
      seen = [...heads]
        .filter(([c]) => c !== "")
        .flatMap(([, hs]) => hs.map((h) => h.ver))
        .sort();
    }
    return [op.table, k, code, n, p, b, seen];
  }

  /** Records one changeset's versions. Grow-only, so the order changesets arrive in does not matter. */
  private ingest(ops: Op[], ver: string, lc: number, author: string): [string, string][] {
    const touched: [string, string][] = [];
    for (const [named, k, , n, , b, seen] of ops) {
      // Under the names this copy uses: a table or column it renamed since the change was made (1d-M2).
      const table = this.here(named);
      const col = (c: string): string => (c === "" ? c : this.here(table, c));
      const pk = this.identity(table, k);
      // Any author's id in this author's range raises the counter, not only its own (K06, K07).
      this.counterAbove(table, k);
      // The key as this version wrote it, where its identity reads otherwise: a REAL key, a key in a collation
      // that folds (1d-H4, 1d-H5). A row is written back with the spelling it was born with.
      const spelled = keySpelling(k);
      if (n.get("") === 1 && spelled !== pk) {
        this.runCached("INSERT OR IGNORE INTO _cs_spell (tbl, pk, ver, k) VALUES (?, ?, ?, ?)", [table, pk, ver, spelled]);
      }
      for (const [c, val] of n) {
        const v = bound(val);
        this.runCached(`INSERT OR IGNORE INTO _cs_cell (tbl, pk, col, ver, val, lc, author) VALUES (?, ?, ?, ?, ${v.at}, ?, ?)`, [
          table,
          pk,
          col(c),
          ver,
          v.value,
          lc,
          author,
        ]);
      }
      for (const [c, vers] of b) for (const v of vers) this.runCached("INSERT OR IGNORE INTO _cs_sup (tbl, pk, col, ver) VALUES (?, ?, ?, ?)", [table, pk, col(c), v]);
      for (const v of seen) this.runCached("INSERT OR IGNORE INTO _cs_seen (tbl, pk, del, ver) VALUES (?, ?, ?, ?)", [table, pk, ver, v]);
      touched.push([table, pk]);
    }
    this.runCached("INSERT OR IGNORE INTO _cs_ingested (ver) VALUES (?)", [ver]);
    return touched;
  }

  /* ------------------------------------------------------------ projection */

  /**
   * Every admitted changeset not yet ingested here, in (lc, author, seq) order,
   * projected onto the application's tables. Run after the authorship merge
   * admits rows, and at open (a copy that arrived, or one rebuilt from a log).
   *
   * What the application changed since the last save is captured first, here
   * and not by the caller (PR9-H1). The frame captures before it awaits the
   * batches' verification, and a write landing inside that await was captured
   * by nobody: projection would overwrite it, and the next save would sign
   * the remote value as the person's own. Captured now, its bases name only
   * what this copy had seen, so it stands as the person's change or as one
   * side of a pending conflict.
   */
  projectAdmitted(): { changesets: number; rows: number; deferred?: boolean; refused?: boolean } {
    return this.trusted(() => this.projectingAdmitted());
  }

  private projectingAdmitted(): { changesets: number; rows: number; deferred?: boolean; refused?: boolean } {
    // A document refused under P3 applies nothing: its own epoch can no longer be logged first (R-S).
    if (this.refusal) return { changesets: 0, rows: 0, refused: true };
    /*
     * The capture-epoch boundary (R-S, C07/Q08). The session records a row's
     * values as they are when it is extracted, so a merged value written into
     * a row it has already touched joins the local changeset, paused or not,
     * and would be signed as the person's. So the local epoch is logged and
     * the session rotated before anything is applied, and that can only happen
     * at a committed boundary: while the application holds a transaction
     * (sqlite3_get_autocommit), the apply waits, and runs when it ends
     * (`watch`).
     */
    if (this.inTransaction) {
      this.deferred = true;
      return { changesets: 0, rows: 0, deferred: true };
    }
    this.deferred = false;
    this.save();
    const fresh = this.rows.all(
      `SELECT lower(hex(_r_replica)) AS author, _r_seq AS seq, _r_lc AS lc, payload FROM ${q(`${CHANGES_LOG}_current`)} c
        WHERE NOT EXISTS (SELECT 1 FROM _cs_ingested i WHERE i.ver = lower(hex(c._r_replica)) || ':' || c._r_seq)
        ORDER BY _r_lc, author, _r_seq`,
    );
    // The flagged and held rows of a table this copy renamed, decided again: the rename may place them.
    const again = [...this.redecide];
    this.redecide.clear();
    const touched: [string, string][] = again.flatMap(
      (t) => this.db.selectObjects("SELECT tbl, pk FROM main._cs_flag WHERE tbl = ? UNION SELECT tbl, pk FROM main._cs_held WHERE tbl = ?", [t, t]) as Any[],
    ).map((r: Any) => [String(r.tbl), String(r.pk)] as [string, string]);
    if (fresh.length === 0 && again.length === 0) return { changesets: 0, rows: 0 };
    this.withoutCapture(() => {
      for (const row of fresh) {
        const decoded = cborDecode(row["payload"] as Uint8Array, { floats: true }) as unknown as [number, Op[]];
        touched.push(...this.ingest(decoded[1], `${row["author"]}:${row["seq"]}`, Number(row["lc"]), String(row["author"])));
      }
      this.project(touched);
    });
    return { changesets: fresh.length, rows: new Set(touched.map((t) => t.join("|"))).size };
  }

  private paused<T>(f: () => T): T {
    return this.capture ? this.capture.paused(f) : f();
  }

  /**
   * Runtime writes to the application's tables: not captured, foreign keys
   * checked after rather than during, all or nothing, and on a connection
   * carrying no application TEMP trigger (R-S, T01). The application's main
   * triggers stand down by `dai_projecting()`, written into each; a TEMP
   * trigger is not the document's, is not rewritten, and is not turned off by
   * SQLITE_DBCONFIG_ENABLE_TRIGGER, so each is lifted off for the apply and put
   * back as it was written. A trigger that cannot be put back fails the call.
   */
  withoutCapture(f: () => void): void {
    this.trusted(() => this.withoutTemps(f));
  }

  private withoutTemps(f: () => void): void {
    const temps = this.db.selectObjects("SELECT name, sql FROM temp.sqlite_schema WHERE type = 'trigger' AND sql IS NOT NULL") as { name: string; sql: string }[];
    for (const t of temps) this.exec(`DROP TRIGGER temp.${q(t.name)}`);
    try {
      this.applying(f);
    } finally {
      // SQLite keeps a TEMP trigger's text without its TEMP: run as stored, it would make a main trigger.
      for (const t of temps) this.exec(t.sql.replace(/^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\s+/i, "CREATE TEMP TRIGGER "));
      const back = this.db.selectValues("SELECT name FROM temp.sqlite_schema WHERE type = 'trigger'") as string[];
      const lost = temps.filter((t) => !back.includes(t.name));
      if (lost.length) throw new Error(`CHANGES_APPLY (TEMP triggers not put back: ${lost.map((t) => t.name).join(", ")})`);
    }
  }

  private applying(f: () => void): void {
    const exec = this.exec;
    // PRAGMA foreign_keys is a no-op inside a transaction, so it is set before the savepoint opens.
    const inTxn = this.inTransaction;
    this.keepingLastInsert(() => this.paused(() => {
      if (!inTxn) exec("PRAGMA foreign_keys = OFF");
      exec("SAVEPOINT cs_project");
      this.projecting = true;
      try {
        f();
        exec("RELEASE cs_project");
      } catch (e) {
        exec("ROLLBACK TO cs_project");
        exec("RELEASE cs_project");
        throw e;
      } finally {
        this.projecting = false;
        if (!inTxn) exec("PRAGMA foreign_keys = ON");
      }
    }));
  }

  private stateOf(
    table: string,
    pk: string,
  ): { deleted: boolean; contested: boolean; values: Record<string, unknown>; pending: Any[]; shownBy: Record<string, Any>; cells: Any[] } | null {
    const heads = this.db.selectObjects(
      "SELECT col, ver, val, typeof(val) AS t, lc, author FROM _cs_cell c WHERE tbl = ? AND pk = ? AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = c.tbl AND s.pk = c.pk AND s.col = c.col AND s.ver = c.ver)",
      [table, pk],
    ) as Any[];
    if (heads.length === 0) return null;
    const exists = heads.filter((h) => h.col === "");
    const dels = exists.filter((h) => Number(h.val) === 0).map((h) => h.ver);
    const alive = exists.filter((h) => Number(h.val) === 1);
    const data = heads.filter((h) => h.col !== "");
    const seen = new Set(
      dels.length
        ? (this.db.selectValues(`SELECT ver FROM _cs_seen WHERE tbl = ? AND pk = ? AND del IN (${dels.map(() => "?").join(",")})`, [
            table,
            pk,
            ...dels,
          ]) as string[])
        : [],
    );
    const deleted = alive.length === 0 && data.every((h) => seen.has(h.ver));
    const values: Record<string, unknown> = {};
    const shownBy: Record<string, Any> = {};
    const pending: Any[] = [];
    const byCol = new Map<string, Any[]>();
    for (const h of data) byCol.set(h.col, [...(byCol.get(h.col) ?? []), h]);
    for (const [col, hs] of byCol) {
      hs.sort(later);
      values[col] = typed(hs[0].t, hs[0].val);
      shownBy[col] = hs[0];
      // Two concurrent versions are a conflict even when their values are equal: `qty = qty + 1` on both
      // sides writes the same value and means two increments (the spike's S5b).
      if (hs.length > 1) pending.push({ col, values: hs.map((h) => ({ ver: h.ver, val: shown(h.val) })) });
    }
    const cells = () =>
      this.db.selectObjects("SELECT col, ver, val, typeof(val) AS t, lc, author FROM _cs_cell WHERE tbl = ? AND pk = ? AND col <> ''", [table, pk]) as Any[];
    return { deleted, contested: !deleted && dels.length > 0, values, pending, shownBy, get cells() { return cells(); } };
  }

  /**
   * A row whose merged values a CHECK or NOT NULL refuses, though each save
   * that wrote them was valid where it was made (R-T, M02). The combined
   * candidate is not settled: the row shows the latest candidate the table
   * admits, found by setting aside the newest versions first, each column such
   * a version shows going back to the latest value before it. The row is
   * flagged pending, naming for each column set aside what was proposed and
   * what is shown, and the constraint. So the earlier edit stands and the
   * later waits, as the earlier-born row keeps a UNIQUE slot; every value
   * stays in the cells, and writing the row again resolves it. False when no
   * candidate is admitted: the row is then held, as before.
   */
  private withinConstraints(table: string, pk: string, keys: Keys, k: unknown[], state: NonNullable<ReturnType<Changes["stateOf"]>>, reason: string): boolean {
    const cells = state.cells;
    const versions = [...new Map(Object.values(state.shownBy).map((h: Any) => [h.ver, h])).values()].sort(later);
    for (let n = 1; n <= versions.length; n++) {
      const aside = new Set(versions.slice(0, n).map((h: Any) => h.ver));
      const values = { ...state.values };
      const entries: Any[] = [];
      for (const [col, h] of Object.entries(state.shownBy)) {
        if (!aside.has(h.ver)) continue;
        const before = cells.filter((c) => c.col === col && !aside.has(c.ver)).sort(later)[0];
        if (!before) continue;
        values[col] = typed(before.t, before.val);
        entries.push({ col, constraint: reason, values: [{ ver: h.ver, val: shown(h.val) }, { ver: before.ver, val: shown(before.val) }] });
      }
      if (entries.length === 0) continue;
      try {
        this.write(table, keys, k, values);
      } catch {
        continue;
      }
      this.flag(table, pk, "pending", [...state.pending, ...entries]);
      return true;
    }
    return false;
  }

  private birthOf(table: string, pk: string): { lc: number; author: string; ver: string } | null {
    return (this.db.selectObject(
      "SELECT lc, author, ver FROM _cs_cell WHERE tbl = ? AND pk = ? AND col = '' AND val = 1 ORDER BY lc, author, ver LIMIT 1",
      [table, pk],
    ) ?? null) as Any;
  }

  /**
   * A row's identity in this table: its key as `keyText` reads it, each text
   * part as its column's collation compares it (1d-H5). Two keys SQLite takes
   * for one row have one identity, and every copy reads it the same.
   */
  private identity(table: string, k: unknown[]): string {
    return keyText(k);
  }

  /** Whether a key column of the table compares text in a collation that folds it (NOCASE, RTRIM). */
  private folds(_table: string): boolean {
    return false;
  }

  private flag(table: string, pk: string, kind: FlagKind, detail: unknown): void {
    this.rows.run("INSERT OR REPLACE INTO _cs_flag (tbl, pk, kind, detail) VALUES (?, ?, ?, ?)", [
      table,
      pk,
      kind,
      detail == null ? null : JSON.stringify(detail),
    ]);
  }

  private whereKey(table: string): string {
    const { pk } = this.keysOf(table)!;
    return pk.map((c) => `${q(c)} IS ?`).join(" AND ");
  }

  /** Writes rows' projected states onto the application's tables, then keeps what live rows still reference. */
  private project(touched: [string, string][]): void {
    const set = new Map(touched.map(([t, pk]) => [`${t}|${pk}`, [t, pk] as [string, string]]));
    // A held row, or one kept because something referred to it, is decided again every time.
    for (const r of this.db.selectObjects("SELECT tbl, pk FROM _cs_held UNION SELECT tbl, pk FROM _cs_flag WHERE kind = 'kept-referenced'") as Any[]) {
      set.set(`${r.tbl}|${r.pk}`, [r.tbl, r.pk]);
    }
    const items = [...set.values()].sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
    for (const [table, pk] of items) {
      this.rows.run("DELETE FROM _cs_flag WHERE tbl = ? AND pk = ?", [table, pk]);
      this.rows.run("DELETE FROM _cs_held WHERE tbl = ? AND pk = ?", [table, pk]);
    }
    // Deletes first, then every other row (D02): an INSERT OR REPLACE deletes the row holding a UNIQUE value
    // and inserts a new one, and in key order the new row could come first, find the slot still taken by
    // the row its own save deleted, and be held.
    const gone = (t: string, pk: string): boolean => this.stateOf(t, pk)?.deleted === true;
    for (const [table, pk] of items) if (gone(table, pk)) this.place(table, pk);
    for (const [table, pk] of items) if (!gone(table, pk)) this.place(table, pk);
    this.keepReferenced();
    this.keepGroups();
  }

  /**
   * The effect group stays together (R-T, M06). A save is one group: the
   * changeset does not record the transactions inside a capture epoch, so the
   * whole save is the conservative one. A save contends where a row it wrote
   * is pending (every version a same-column conflict names; the proposal set
   * aside in a constraint conflict) or held. Every other row where such a
   * save's change is still current is flagged pending too, each column it
   * wrote there named with the save (`group`) and the rows it waits on
   * (`with`), so no half of a transaction is materialized as settled alone.
   * Recomputed whole after every projection: a resolution clears its group.
   */
  private keepGroups(): void {
    const own = new Map<string, Any[]>();
    const sources = new Map<string, Set<string>>();
    const contends = (ver: string, at: string): void => {
      sources.set(ver, (sources.get(ver) ?? new Set()).add(at));
    };
    for (const f of this.db.selectObjects("SELECT tbl, pk, detail FROM _cs_flag WHERE kind = 'pending'") as Any[]) {
      const entries = (f.detail ? JSON.parse(f.detail) : []) as Any[];
      const mine = entries.filter((e) => e.group === undefined);
      const at = JSON.stringify([f.tbl, f.pk]);
      own.set(at, mine);
      for (const e of mine) for (const v of e.constraint ? e.values.slice(0, 1) : e.values) contends(v.ver, at);
    }
    for (const h of this.db.selectObjects("SELECT tbl, pk FROM _cs_held") as Any[]) {
      const at = JSON.stringify([h.tbl, h.pk]);
      for (const [col, hs] of this.rowHeads(h.tbl, h.pk)) if (col !== "") for (const v of hs) contends(v.ver, at);
    }
    const grouped = new Map<string, Any[]>();
    for (const [ver, from] of sources) {
      const wrote = this.db.selectObjects(
        `SELECT tbl, pk, col, val FROM _cs_cell c WHERE ver = ? AND col <> ''
          AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = c.tbl AND s.pk = c.pk AND s.col = c.col AND s.ver = c.ver) ORDER BY tbl, pk, col`,
        [ver],
      ) as Any[];
      const waits = [...from].sort().map((at) => JSON.parse(at));
      for (const w of wrote) {
        const at = JSON.stringify([w.tbl, w.pk]);
        if (from.has(at) || this.db.selectValue("SELECT 1 FROM _cs_held WHERE tbl = ? AND pk = ?", [w.tbl, w.pk]) != null) continue;
        grouped.set(at, [...(grouped.get(at) ?? []), { col: w.col, group: ver, with: waits, values: [{ ver, val: shown(w.val) }] }]);
      }
    }
    for (const at of new Set([...own.keys(), ...grouped.keys()])) {
      const [tbl, pk] = JSON.parse(at) as [string, string];
      const entries = [...(own.get(at) ?? []), ...(grouped.get(at) ?? [])];
      if (entries.length) this.flag(tbl, pk, "pending", entries);
      else this.rows.run("DELETE FROM _cs_flag WHERE tbl = ? AND pk = ? AND kind = 'pending'", [tbl, pk]);
    }
  }

  /**
   * One row written as merged: its key as it was born (`spellingOf`) and each
   * value in its own storage class (M15). Where that spelling is not the one
   * the identity reads (a REAL key, a key in a folding collation), the key is
   * rewritten too, so a row another copy wrote first under another spelling
   * shows the same on every copy (1d-H5).
   */
  private write(table: string, keys: Keys, k: unknown[], values: Record<string, unknown>): void {
    // A column this copy dropped keeps its merged values in the cells, and is not written (R-S).
    const data = Object.keys(values).filter((c) => !keys.pk.includes(c) && !this.droppedHere(table, c));
    const cols = [...keys.pk, ...data];
    const vals = [...k, ...data.map((c) => values[c] ?? null)].map(bound);
    const respell = keySpelling(k) !== keyText(k) || this.folds(table);
    const update = [...(respell ? keys.pk : []), ...data].map((c) => `${q(c)} = excluded.${q(c)}`).join(", ");
    this.rows.run(
      `INSERT INTO main.${q(table)} (${cols.map(q).join(", ")}) VALUES (${vals.map((v) => v.at).join(", ")}) ON CONFLICT (${keys.pk.map(q).join(", ")}) DO ${update ? `UPDATE SET ${update}` : "NOTHING"}`,
      vals.map((v) => v.value),
    );
  }

  /** The key a row was born with: the spelling its earliest-born version wrote, else its identity's own. */
  private spellingOf(table: string, pk: string): unknown[] {
    const born = this.birthOf(table, pk);
    const spelled = born ? this.db.selectValue("SELECT k FROM main._cs_spell WHERE tbl = ? AND pk = ? AND ver = ?", [table, pk, born.ver]) : null;
    return keyValues(typeof spelled === "string" ? spelled : pk);
  }

  private place(table: string, pk: string, force = false): void {
    const state = this.stateOf(table, pk);
    if (!state) return;
    // A table this copy does not have: one it dropped keeps the rows in the cells; any other holds them,
    // flagged, until it is made here (a copy behind on a schema change, S05).
    if (this.db.selectValue("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ? COLLATE NOCASE", [table]) == null) {
      if (this.droppedHere(table) || state.deleted) return;
      this.hold(table, pk, `no such table: ${table}`, state.values);
      return;
    }
    const keys = this.keysOf(table);
    if (!keys) return;
    const k = this.spellingOf(table, pk);
    const at = keyValues(pk).map(compared);
    if (state.deleted && !force) {
      this.rows.run(`DELETE FROM main.${q(table)} WHERE ${this.whereKey(table)}`, at);
      return;
    }
    if (state.contested) this.flag(table, pk, "delete-conflict", null);
    if (state.pending.length) this.flag(table, pk, "pending", state.pending);
    try {
      this.write(table, keys, k, state.values);
    } catch (e) {
      const message = String((e as Error).message);
      if (/UNIQUE/.test(message)) {
        const occupant = this.occupantOf(table, pk, state.values);
        if (occupant) {
          const mine = this.birthOf(table, pk);
          const theirs = this.birthOf(table, occupant);
          const earlier = (x: Any, y: Any): boolean => (x && y ? x.lc < y.lc || (x.lc === y.lc && x.author < y.author) : !!x);
          if (earlier(mine, theirs)) {
            this.hold(table, occupant, `UNIQUE: lost the slot to ${pk}`, this.stateOf(table, occupant)?.values ?? {});
            this.rows.run(`DELETE FROM main.${q(table)} WHERE ${this.whereKey(table)}`, keyValues(occupant).map(compared));
            this.write(table, keys, k, state.values);
            return;
          }
          this.hold(table, pk, `UNIQUE: ${occupant} holds the slot`, state.values);
          return;
        }
      }
      if (/(CHECK|NOT NULL) constraint failed/.test(message) && this.withinConstraints(table, pk, keys, k, state, message.replace(/^.*?: /, ""))) return;
      this.hold(table, pk, message.replace(/^.*?: /, ""), state.values);
      this.rows.run(`DELETE FROM main.${q(table)} WHERE ${this.whereKey(table)}`, at);
    }
  }

  private hold(table: string, pk: string, reason: string, values: Record<string, unknown>): void {
    this.rows.run("INSERT OR REPLACE INTO _cs_held (tbl, pk, reason, row) VALUES (?, ?, ?, ?)", [
      table,
      pk,
      reason,
      JSON.stringify(values, (_k, v) => (v instanceof Uint8Array || v instanceof Float64 || typeof v === "bigint" ? shown(v) : v)),
    ]);
    this.flag(table, pk, "held", reason);
  }

  /** The other row holding a UNIQUE slot this row's values want. */
  private occupantOf(table: string, pk: string, values: Record<string, unknown>): string | null {
    const keys = this.keysOf(table)!;
    for (const idx of this.db.selectObjects("SELECT name FROM pragma_index_list(?) WHERE \"unique\" = 1 AND origin <> 'pk'", [table]) as Any[]) {
      const cols = this.db.selectValues("SELECT name FROM pragma_index_info(?) ORDER BY seqno", [idx.name]) as string[];
      if (cols.some((c) => !(c in values))) continue;
      const hit = this.db.selectObject(
        `SELECT ${keys.pk.map((c) => `${q(c)}, typeof(${q(c)}) AS ${q(`_cs_t_${c}`)}`).join(", ")} FROM main.${q(table)} WHERE ${cols.map((c) => `${q(c)} IS ?`).join(" AND ")}`,
        cols.map((c) => compared(values[c])),
      ) as Any;
      if (hit) {
        const other = this.identity(table, keys.pk.map((c) => typed(hit[`_cs_t_${c}`], hit[c])));
        if (other !== pk) return other;
      }
    }
    return null;
  }

  /** A row a live row still points at stays, flagged, until nothing refers to it (to a fixpoint). */
  private keepReferenced(): void {
    for (let round = 0; round < 16; round++) {
      const orphans = this.db.selectObjects("SELECT * FROM pragma_foreign_key_check") as Any[];
      let revived = 0;
      for (const o of orphans) {
        const fk = this.db.selectObjects('SELECT "from", "to", "table" FROM pragma_foreign_key_list(?) WHERE id = ? ORDER BY seq', [o.table, o.fkid]) as Any[];
        if (!fk.length || o.rowid == null) continue;
        const child = this.db.selectObject(
          `SELECT ${fk.map((f) => `${q(f.from)}, typeof(${q(f.from)}) AS ${q(`_cs_t_${f.from}`)}`).join(", ")} FROM main.${q(o.table)} WHERE rowid = ?`,
          [o.rowid],
        ) as Any;
        const parentKeys = this.keysOf(o.parent);
        if (!child || !parentKeys) continue;
        const to = fk.map((f) => f.to ?? parentKeys.pk[0]);
        if (to.join(",") !== parentKeys.pk.join(",")) continue;
        const pk = this.identity(o.parent, fk.map((f) => typed(child[`_cs_t_${f.from}`], child[f.from])));
        const state = this.stateOf(o.parent, pk);
        if (!state) {
          this.flag(o.table, keyText([o.rowid]), "orphan", { parent: o.parent, key: pk });
          continue;
        }
        if (this.db.selectValue("SELECT 1 FROM _cs_flag WHERE tbl = ? AND pk = ? AND kind = 'kept-referenced'", [o.parent, pk]) != null) continue;
        this.flag(o.parent, pk, "kept-referenced", { by: o.table });
        this.place(o.parent, pk, true);
        revived += 1;
      }
      if (!revived) return;
    }
  }

  /* ------------------------------------------------------------ reading */

  /** The flags, as the host reads them from `_cs_flag`. */
  flags(): { tbl: string; pk: string; kind: FlagKind; detail: string | null }[] {
    return this.db.selectObjects("SELECT tbl, pk, kind, detail FROM _cs_flag ORDER BY tbl, pk, kind") as Any[];
  }

  held(): { tbl: string; pk: string; reason: string; row: string }[] {
    return this.db.selectObjects("SELECT tbl, pk, reason, row FROM _cs_held ORDER BY tbl, pk") as Any[];
  }

  close(): void {
    for (const s of this.stmts.values()) {
      try {
        s.finalize();
      } catch {
        /* Finalized with its database. */
      }
    }
    this.stmts.clear();
    this.capture.close();
    if (this.authorizer) this.sqlite3.capi.sqlite3_set_authorizer(this.db.pointer, 0, 0);
    this.authorizer = null;
  }
}

/** The SQL an exec call carries, and whether it carries nothing else (no values bound, no callback, no rows asked for). */
function sqlOf(args: Any[]): { text: string; plain: boolean } | null {
  const [first, second] = args;
  const bare = (o: unknown): boolean => o === undefined || (typeof o === "object" && o !== null && Object.keys(o).length === 0);
  if (typeof first === "string") return { text: first, plain: bare(second) };
  if (first && typeof first === "object" && typeof first.sql === "string") {
    return { text: first.sql, plain: second === undefined && Object.keys(first).every((k) => k === "sql") };
  }
  return null;
}

/** A script cut into its statements where SQLite itself would end each one (sqlite3_complete), trigger bodies whole. */
function splitStatements(sqlite3: Any, text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = text.indexOf(";"); i >= 0; i = text.indexOf(";", i + 1)) {
    const piece = text.slice(start, i + 1);
    if (sqlite3.capi.sqlite3_complete(piece)) {
      out.push(piece);
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out;
}

/** Whether a statement is an ALTER TABLE or a DROP TABLE, read past the comments in front of it. */
function changesSchema(statement: string): boolean {
  const head = statement.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
  return /^(?:ALTER|DROP)\s+TABLE\b/i.test(head);
}

/** A statement's text with its whitespace runs made one space: how a stored trigger is compared with the runtime's. */
const spaced = (sql: string): string => sql.replace(/\s+/g, " ").trim();

let ownTriggers: Map<string, string> | null = null;

/**
 * The triggers the runtime itself puts on its tables, by name, as SQLite
 * stores them: made once, in a scratch database, from the declaration every
 * document with no session policy carries (`rewriteReplicated`, as the
 * compiler emits it).
 */
function runtimeTriggers(sqlite3: Any): Map<string, string> {
  if (ownTriggers) return ownTriggers;
  const scratch = new sqlite3.oo1.DB(":memory:", "c");
  try {
    scratch.exec(rewriteReplicated(CHANGES_DECLARATION).sql);
    ownTriggers = new Map(
      (scratch.selectObjects("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND sql IS NOT NULL") as Any[]).map((r) => [String(r.name), String(r.sql)]),
    );
  } finally {
    scratch.close();
  }
  return ownTriggers;
}

/** The later version first, by (lc, author, ver): the order a column's shown value is chosen in. */
function later(a: Any, b: Any): number {
  return Number(b.lc) - Number(a.lc) || (b.author < a.author ? -1 : b.author > a.author ? 1 : 0) || (b.ver < a.ver ? -1 : 1);
}

function sqlText(s: string): string {
  return `'${s.split("'").join("''")}'`;
}

/**
 * The application's tables, every row in key order: what two converged copies
 * must agree on. Reads only: a test, a reader or a host can call it on any
 * database carrying the log.
 */
export function changesDump(rows: Rows): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  const keys = new Map(rows.all("SELECT tbl, kind, pk FROM _cs_keys").map((r) => [String(r["tbl"]), r]));
  for (const table of appTablesOf(rows)) {
    const k = keys.get(table);
    const order = k?.["pk"] ? String(k["pk"]).split(",").map(q).join(", ") : "rowid";
    // Each value with its storage class where JSON would lose it: a BLOB as <hex>, an integer past 2^53 as its
    // digits, and a REAL with no fraction or an infinity as <real ...>, which an INTEGER never reads as (M15).
    const cols = rows.all("SELECT name FROM pragma_table_xinfo(?) WHERE hidden <> 1 ORDER BY cid", [table]).map((r) => String(r["name"]));
    const types = cols.map((c, i) => `typeof(${q(c)}) AS "_cs_t_${i}"`).join(", ");
    out[table] = rows.all(`SELECT *${types ? `, ${types}` : ""} FROM ${q(table)} ORDER BY ${order}`).map((r) =>
      Object.fromEntries(
        cols.map((c, i) => {
          const v = r[c];
          if (v instanceof Uint8Array) return [c, `<${hex(v)}>`];
          if (typeof v === "bigint") return [c, v.toString()];
          if (r[`_cs_t_${i}`] === "real" && typeof v === "number" && (Number.isInteger(v) || !Number.isFinite(v))) return [c, `<real ${String(v)}>`];
          return [c, v];
        }),
      ),
    );
  }
  return out;
}
