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
 * Authorship records changes and explicit decisions, not touches (R-X). A
 * save authors a unit (a column, or a coupled group whole) only where its
 * value changed from what it showed, and an edit supersedes only the version
 * it was based on; writing a shown value back is an echo, which authors
 * nothing. A conflict is resolved by the kit's explicit call (`observe`,
 * `resolve`): a signed resolution naming exactly the alternatives it was
 * shown. A changeset whose basis is missing or names a version it could not
 * have seen is refused, unapplied. The flags are rows of `_cs_flag`, which
 * the host reads from the stored document.
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

/**
 * The runtime's own tables and SQLite's, never captured and never adopted.
 * SQLite reserves sqlite_ in ASCII case only, as it compares names, so a
 * table an application named in another spelling of it (one the compiler
 * refuses, 1e-M2) is the application's, and is captured.
 */
const internalNamed = (name: string): boolean => runtimeNamed(name) || /^sqlite_/i.test(name);

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
CREATE TABLE IF NOT EXISTS _cs_shown (tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL, ver TEXT NOT NULL, PRIMARY KEY (tbl, pk, col)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_refused (ver TEXT PRIMARY KEY, reason TEXT NOT NULL) WITHOUT ROWID;
`;

/**
 * Why an admitted changeset is refused, unapplied (R-X §3): an operation
 * whose `bases` does not name, for every unit it writes, the versions it was
 * based on; or one whose `bases` or `resolves` names a version it could not
 * have seen (not a version of that cell, one no earlier than itself, or one
 * its signer had not received, 1g-M1), or that resolves a unit in part
 * (1g-L3); or an edit that changes nothing it was based on and resolves
 * nothing (`basis-unchanged`, 1g-L2).
 */
export type BasisRefusal = "basis-missing" | "basis-forged" | "basis-unchanged" | "receipt-forged";

/**
 * What a resolution is refused with (R-X §4, §5), as the application reads it:
 * `CHANGES_REFUSED: <sentence>`.
 */
export const RESOLVE_REFUSED = {
  unit: "A resolution names one whole unit: a column, or every column of its coupled group.",
  token: "This conflict is no longer the one shown: show it again, and choose from what it shows.",
  choice: "Choose one of the values the conflict showed.",
  transaction: "Resolve a conflict outside a transaction: a resolution is saved as it is made.",
} as const;

/** An observation the runtime issued (R-X §4): one unit as it showed, and the alternatives presented. Never expanded. */
interface Observation {
  table: string;
  pk: string;
  /** The unit's columns; [""] is the row's existence. */
  unit: string[];
  /** The version(s) the displayed value came from: the resolution's basis. */
  basis: string[];
  alternatives: { ver: string; values: Record<string, unknown> }[];
}

/** The flags a row can carry, as `_cs_flag.kind` holds them. */
export type FlagKind = "pending" | "delete-conflict" | "kept-referenced" | "held" | "orphan";

/** A key kind: ranged integer, uuid text, the app's own (natural), or the hidden ranged key of a table that declared none. */
type KeyKind = "ranged" | "uuid" | "natural" | "hidden";
interface Keys {
  kind: KeyKind;
  pk: string[];
}

/**
 * A captured row change, as it travels: [table, key values, op, new, old,
 * bases, seen, resolves?]. `resolves` is present only on a resolution (R-X):
 * per column, the alternatives it explicitly accepted or rejected.
 */
type Op =
  | [string, unknown[], "I" | "U" | "D", Map<string, unknown>, Map<string, unknown>, Map<string, string[]>, string[]]
  | [string, unknown[], "I" | "U" | "D", Map<string, unknown>, Map<string, unknown>, Map<string, string[]>, string[], Map<string, string[]>];

/** A version string, in the one grammar both readers read (1h-L1): lowercase hex, a colon, then ASCII digits with no leading zero. */
const VERSION = /^[0-9a-f]+:[1-9][0-9]*$/;
/**
 * A receipt entry by its one shape, in both readers and wherever a reader
 * reads one (1h-M1, 1i-L1): `[seq, digest]`, the seq a whole number of at
 * least 1, as a version's seq is by VERSION, and the digest a string. A
 * string, a float, a boolean or a whole number past 2^53 (which CBOR reads
 * here as a BigInt) is not a seq.
 */
const receiptEntry = (e: unknown): e is [number, string] =>
  Array.isArray(e) && e.length === 2 && typeof e[0] === "number" && Number.isInteger(e[0]) && e[0] >= 1 && typeof e[1] === "string";
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

/**
 * Text as a collation compares it, for a key's identity (1d-H5): NOCASE folds
 * ASCII letters only, as SQLite's own does, and RTRIM drops trailing spaces.
 * Any other collation compares the text as written.
 */
function folding(coll: string, s: string): string {
  if (coll === "NOCASE") return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  if (coll === "RTRIM") return s.replace(/ +$/, "");
  return s;
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

/**
 * What a missing declared object is refused with (R-W): the mount is damaged,
 * and the host repairs it from the release's schema at the next open. The
 * application never makes it again.
 */
export const MOUNT_DAMAGED = "Part of this copy's stored structure is missing; the copy was left unchanged, and the host repairs it when the document is next opened.";

/**
 * What the authorizer refuses with, as one sentence each (R-V): the
 * application reads it as `CHANGES_REFUSED: <sentence> (SQLite: not
 * authorized)`. These are the authoring rules the model file teaches.
 */
export const REFUSED = {
  runtimeTables: "The runtime's tables (_dai*, _cs_*) are read-only to the application.",
  // R-W: the schema is the release's. The one sentence for every schema statement the application runs.
  schema: "This change needs a new version of the app; the current version was left unchanged.",
  virtual: "Keep data in ordinary tables: a virtual table (FTS5, R-tree) is not carried between copies.",
  attach: "Keep data in the document's own database: ATTACH is refused.",
  pragma: "PRAGMA writable_schema, schema_version, ignore_check_constraints, legacy_alter_table and trusted_schema are the runtime's to set.",
  rowid: "Name a table's key column, not rowid: here an integer key is not the rowid.",
  functionName: "Name application functions without the runtime's prefix (dai_), and leave last_insert_rowid(), changes() and total_changes() as they are.",
} as const;

/** The settings whose change the authorizer refuses (P03). */
const RUNTIME_PRAGMAS = new Set(["writable_schema", "schema_version", "ignore_check_constraints", "legacy_alter_table", "trusted_schema"]);

/** What a key with a NULL in it is refused with, as it executes (1d-H3, R-V). */
export const KEY_REFUSED = "A row's key cannot be NULL: give every primary-key column a value, or leave out an integer key to have one given.";

/** The bodies of the runtime's own triggers on application tables: the last-insert slot, and the NULL-key refusal. */
const OWN_BODY = /^BEGIN SELECT (?:dai_inserted\(NEW\.rowid, NEW\.(?:"(?:[^"]|"")*"|rowid)\)|RAISE\(ABORT, 'CHANGES_REFUSED: (?:[^']|'')*'\)); END$/;

/** What a trigger that writes the runtime's tables is refused with, as it is made (1d-L1, R-V). */
export const TRIGGER_REFUSED = "A trigger cannot write the runtime's tables (_dai*, _cs_*): write the application's own tables only.";

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
    rows.all("SELECT 1 FROM pragma_table_info(?, 'main') WHERE name = '_r_replica'", [CHANGES_LOG]).length > 0
  );
}

/** The application's tables: everything that is not the runtime's own. */
export function appTablesOf(rows: Rows): string[] {
  // An ordinary table only: a virtual table's shadow tables are its module's (C04), and are never adopted or captured.
  return rows
    .all("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
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
  // Between two tokens, SQLite reads a comment as it reads a space (K01).
  const gap = "(?:\\s|/\\*[\\s\\S]*?\\*/|--[^\\n]*(?:\\n|$))+";
  if (kind === "ranged") {
    const fn = `DEFAULT (dai_id(${sqlText(table)}))`;
    const declared = `${type.trim().split(/\s+/).map(escape).join(gap)}(?=[\\s,)/-]|$)(?:${gap}NOT${gap}NULL)?`;
    const inline = new RegExp(`(${col}${gap})${declared}(${gap}PRIMARY${gap}KEY(?:${gap}(?:ASC|DESC))?)(${gap}AUTOINCREMENT)?`, "i");
    if (inline.test(sql)) return sql.replace(inline, `$1INT NOT NULL ON CONFLICT REPLACE ${fn}$2`);
    // A table-level PRIMARY KEY (id) over `id INTEGER`.
    const typed = new RegExp(`([(,](?:\\s|/\\*[\\s\\S]*?\\*/|--[^\\n]*(?:\\n|$))*${col}${gap})${declared}`, "i");
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

/* -------------------------------------------------------------- native */

/** SQLite's own codes, as its C API fixes them: the native path reads none of them from capi. */
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_UTF8 = 1;
const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_INSERT = 18;
const SQLITE_UPDATE = 23;
/** SQLITE_TRANSIENT: SQLite copies what it is handed before the call returns, so the runtime frees its own copy at once. */
const SQLITE_TRANSIENT = -1;

/**
 * The engine as the runtime calls it (1i).
 *
 * sqlite-wasm's JavaScript reads its own entry points by property at each
 * call: oo1's `step` reaches `capi.sqlite3_step`, every capi wrapper reaches
 * `wasm.scopedAllocPush`, the authorizer's adapter reaches `wasm.cstrToJs`, a
 * SQL function's adapter reaches `capi.sqlite3_result_js`, and the pointer
 * stack's methods are plain properties. The application shares the module and
 * may replace any of them, so capturing a function of sqlite-wasm's does not
 * capture what that function calls. The runtime calls none of it. It calls
 * the module's WebAssembly exports, which are frozen and run no JavaScript but
 * the callbacks the runtime itself installed, and it reads and writes the
 * module's memory itself. All of it is captured once per module, before the
 * application has a handle. What the application still shares with this path
 * is the realm's own built-ins (D285).
 */
class Native {
  /** The module's WebAssembly exports: SQLite's C API, and the pointer stack's own entry points. */
  readonly c: Any;
  /** The module's WebAssembly.Memory. */
  private readonly memory: { buffer: ArrayBuffer };
  private heapView = new Uint8Array(0);
  private dataView = new DataView(new ArrayBuffer(0));
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder("utf-8");
  private readonly rcName: (rc: number) => string | undefined;
  private readonly installFn: (fn: Any, sig: string) => number;
  private readonly uninstallFn: (ptr: number) => unknown;
  /** The destructor every SQL function the runtime makes carries: SQLite calls it as the function goes, and its slot is freed. */
  private destroy = 0;

  constructor(sqlite3: Any) {
    const wasm = sqlite3.wasm;
    this.c = wasm.exports;
    this.memory = wasm.memory;
    if (!Object.isFrozen(this.c) || !(this.memory instanceof (globalThis as Any).WebAssembly.Memory) || wasm.ptr.size !== 4 || !wasm.bigIntEnabled) {
      throw new Error("CHANGES_CAPTURE (the engine's exports cannot be captured: a 32-bit build with BigInt and frozen exports is required)");
    }
    this.rcName = sqlite3.capi.sqlite3_js_rc_str;
    this.installFn = wasm.installFunction;
    this.uninstallFn = wasm.uninstallFunction;
  }

  private heap(): Uint8Array {
    const buffer = this.memory.buffer;
    if (this.heapView.buffer !== buffer) {
      this.heapView = new Uint8Array(buffer);
      this.dataView = new DataView(buffer);
    }
    return this.heapView;
  }

  ptrAt(p: number): number {
    this.heap();
    return this.dataView.getUint32(p, true);
  }

  i32At(p: number): number {
    this.heap();
    return this.dataView.getInt32(p, true);
  }

  setPtr(p: number, v: number): void {
    this.heap();
    this.dataView.setUint32(p, v, true);
  }

  byteAt(p: number): number {
    return this.heap()[p]!;
  }

  /** `n` bytes at `p`, copied out of the module's memory. */
  bytes(p: number, n: number): Uint8Array {
    return this.heap().slice(p, p + n);
  }

  /** A text value, read as sqlite-wasm's column and value readers read one: its bytes as SQLite counts them, NULs kept; null for a null pointer. */
  utf8(p: number, n: number): string | null {
    return p ? this.decoder.decode(this.bytes(p, n)) : null;
  }

  /** A C string, read as sqlite-wasm reads one: UTF-8 to its NUL; null for a null pointer. */
  text(p: number): string | null {
    if (!p) return null;
    const heap = this.heap();
    let end = p;
    while (heap[end] !== 0) end += 1;
    return this.decoder.decode(heap.slice(p, end));
  }

  alloc(n: number): number {
    const p = this.c.sqlite3_malloc(n) >>> 0;
    if (!p) throw new Error(`CHANGES_CAPTURE (sqlite3_malloc could not allocate ${n} bytes)`);
    return p;
  }

  free(p: number): void {
    if (p) this.c.sqlite3_free(p);
  }

  /** `s` as a NUL-terminated UTF-8 string in fresh memory: its pointer and byte length. The caller frees it. */
  cstring(s: string): [number, number] {
    const b = this.encoder.encode(s);
    const p = this.alloc(b.length + 1);
    const heap = this.heap();
    heap.set(b, p);
    heap[p + b.length] = 0;
    return [p, b.length];
  }

  /** Bytes in fresh memory, at least one byte as sqlite-wasm allocates for an empty value. The caller frees it. */
  copyIn(b: Uint8Array): number {
    const p = this.alloc(b.length || 1);
    this.heap().set(b.length ? b : [0], p);
    return p;
  }

  /** Runs `f` with `count` zeroed 8-byte out-slots on the pointer stack, through its own entry points; restored after. */
  withSlots<T>(count: number, f: (...slots: number[]) => T): T {
    const at = this.c.sqlite3__wasm_pstack_ptr();
    try {
      const base = this.c.sqlite3__wasm_pstack_alloc(8 * count) >>> 0;
      if (!base) throw new Error("CHANGES_CAPTURE (the pointer stack is full)");
      this.heap().fill(0, base, base + 8 * count);
      const slots: number[] = [];
      for (let i = 0; i < count; i += 1) slots.push(base + 8 * i);
      return f(...slots);
    } finally {
      this.c.sqlite3__wasm_pstack_restore(at);
    }
  }

  /** An error as oo1 throws one for a result code: the same message, `resultCode` and name. */
  error(rc: number, message: string): Error {
    return Object.assign(new Error(`${this.rcName(rc) ?? `Unknown result code #${rc}`}: ${message}`), { resultCode: rc, name: "SQLite3Error" });
  }

  fail(db: number, rc: number): never {
    throw this.error(rc, `sqlite3 result code ${rc}: ${db ? this.text(this.c.sqlite3_errmsg(db) >>> 0) : this.text(this.c.sqlite3_errstr(rc) >>> 0)}`);
  }

  /** A column of the current row, as oo1's `Stmt.get` reads it. */
  column(stmt: number, i: number): unknown {
    const c = this.c;
    switch (c.sqlite3_column_type(stmt, i)) {
      case SQLITE_INTEGER: {
        const v = c.sqlite3_column_int64(stmt, i) as bigint;
        return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v;
      }
      case SQLITE_FLOAT:
        return c.sqlite3_column_double(stmt, i);
      case SQLITE_TEXT:
        return this.utf8(c.sqlite3_column_text(stmt, i) >>> 0, c.sqlite3_column_bytes(stmt, i));
      case SQLITE_BLOB: {
        const n = c.sqlite3_column_bytes(stmt, i);
        const p = c.sqlite3_column_blob(stmt, i) >>> 0;
        return n ? this.bytes(p, n) : new Uint8Array(0);
      }
      default:
        return null;
    }
  }

  columnNames(stmt: number): string[] {
    const out: string[] = [];
    const n = this.c.sqlite3_column_count(stmt);
    for (let i = 0; i < n; i += 1) out.push(this.text(this.c.sqlite3_column_name(stmt, i) >>> 0) as string);
    return out;
  }

  /** A `sqlite3_value`, as sqlite-wasm's `sqlite3_value_to_js` reads it. */
  value(pv: number): unknown {
    const c = this.c;
    switch (c.sqlite3_value_type(pv)) {
      case SQLITE_INTEGER: {
        const v = c.sqlite3_value_int64(pv) as bigint;
        return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v;
      }
      case SQLITE_FLOAT:
        return c.sqlite3_value_double(pv);
      case SQLITE_TEXT:
        return this.utf8(c.sqlite3_value_text(pv) >>> 0, c.sqlite3_value_bytes(pv));
      case SQLITE_BLOB: {
        const n = c.sqlite3_value_bytes(pv);
        const p = c.sqlite3_value_blob(pv) >>> 0;
        if (n && !p) throw new Error(`CHANGES_CAPTURE (sqlite3_value_blob could not read ${n} bytes)`);
        return n ? this.bytes(p, n) : null;
      }
      default:
        return null;
    }
  }

  /** Binds `bind` as oo1's one-argument `Stmt.bind` does: an array by position, an object by name, else one value at 1. */
  bind(db: number, stmt: number, bind: unknown): void {
    const count = this.c.sqlite3_bind_parameter_count(stmt);
    if (!count) throw this.error(1, "This statement has no bindable parameters.");
    const one = (i: number, v: unknown): void => {
      if (i < 1 || i > count) throw this.error(1, `Bind index ${i} is out of range.`);
      const rc = this.bindOne(stmt, i, v);
      if (rc) this.fail(db, rc);
    };
    if (Array.isArray(bind)) bind.forEach((v, i) => one(i + 1, v));
    else if (bind && typeof bind === "object" && !bindable(bind)) {
      for (const k of Object.keys(bind)) {
        const [z] = this.cstring(k);
        let i: number;
        try {
          i = this.c.sqlite3_bind_parameter_index(stmt, z);
        } finally {
          this.free(z);
        }
        if (!i) throw this.error(1, `Invalid bind() parameter name: ${k}`);
        one(i, (bind as Record<string, unknown>)[k]);
      }
    } else one(1, bind);
  }

  /** One value, bound in the storage class oo1 binds it in. */
  private bindOne(stmt: number, i: number, v: unknown): number {
    const c = this.c;
    if (v === null || v === undefined) return c.sqlite3_bind_null(stmt, i);
    switch (typeof v) {
      case "string": {
        const [z, n] = this.cstring(v);
        try {
          return c.sqlite3_bind_text(stmt, i, z, n, SQLITE_TRANSIENT);
        } finally {
          this.free(z);
        }
      }
      case "number":
        if (isInt32(v)) return c.sqlite3_bind_int(stmt, i, v);
        return Number.isInteger(v) ? c.sqlite3_bind_int64(stmt, i, BigInt(v)) : c.sqlite3_bind_double(stmt, i, v);
      case "bigint":
        if (!fits64(v)) throw this.error(1, `BigInt value is too big to store without precision loss: ${v}`);
        return c.sqlite3_bind_int64(stmt, i, v);
      case "boolean":
        return c.sqlite3_bind_int(stmt, i, v ? 1 : 0);
      default: {
        if (!bindable(v)) throw this.error(1, `Unsupported bind() argument type: ${typeof v}`);
        const b = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        const p = this.copyIn(b);
        try {
          return c.sqlite3_bind_blob(stmt, i, p, b.length, SQLITE_TRANSIENT);
        } finally {
          this.free(p);
        }
      }
    }
  }

  /** A SQL function's result, set as sqlite-wasm's `sqlite3_result_js` sets it. */
  private result(ctx: number, v: unknown): void {
    const c = this.c;
    if (v instanceof Error) return this.resultError(ctx, v);
    switch (typeof v) {
      case "undefined":
        return;
      case "boolean":
        c.sqlite3_result_int(ctx, v ? 1 : 0);
        return;
      case "bigint":
        if (v >= -2147483648n && v <= 2147483647n) c.sqlite3_result_int(ctx, Number(v));
        else if (v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER) c.sqlite3_result_double(ctx, Number(v));
        else if (fits64(v)) c.sqlite3_result_int64(ctx, v);
        else this.resultError(ctx, new Error(`BigInt value ${v} is too BigInt for int64.`));
        return;
      case "number":
        if (isInt32(v)) c.sqlite3_result_int(ctx, v);
        else if (Number.isInteger(v) && fits64(BigInt(v))) c.sqlite3_result_int64(ctx, BigInt(v));
        else c.sqlite3_result_double(ctx, v);
        return;
      case "string": {
        const [z, n] = this.cstring(v);
        try {
          c.sqlite3_result_text(ctx, z, n, SQLITE_TRANSIENT);
        } finally {
          this.free(z);
        }
        return;
      }
      default:
        if (v === null) {
          c.sqlite3_result_null(ctx);
          return;
        }
        if (bindable(v)) {
          const b = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
          const p = this.copyIn(b);
          try {
            c.sqlite3_result_blob(ctx, p, b.length, SQLITE_TRANSIENT);
          } finally {
            this.free(p);
          }
          return;
        }
        this.resultError(ctx, new Error(`A SQL function returned a value SQLite cannot hold: ${typeof v}`));
    }
  }

  private resultError(ctx: number, e: unknown): void {
    const [z] = this.cstring(String(e));
    try {
      this.c.sqlite3_result_error(ctx, z, -1);
    } finally {
      this.free(z);
    }
  }

  /** A JavaScript callback as a function pointer the engine calls directly. Installed while the runtime starts, before the application has the handle. */
  install(fn: Any, sig: string): number {
    return this.installFn(fn, sig);
  }

  uninstall(p: number): void {
    if (p) this.uninstallFn(p);
  }

  /**
   * One of the runtime's SQL functions, registered with the engine itself: its
   * arguments are read and its result set here, never by sqlite-wasm's
   * adapter, which reads capi by property at each call (1i).
   */
  createFunction(db: number, name: string, arity: number, fn: (ctx: number, ...args: unknown[]) => unknown): void {
    if (!this.destroy) this.destroy = this.install((p: number) => this.uninstall(p >>> 0), "vp");
    const xFunc = this.install((ctx: number, argc: number, argv: number): void => {
      try {
        const args: unknown[] = [];
        for (let i = 0; i < argc; i += 1) args.push(this.value(this.ptrAt((argv >>> 0) + 4 * i)));
        this.result(ctx, fn(ctx, ...args));
      } catch (e) {
        this.resultError(ctx, e);
      }
    }, "vpip");
    const [z] = this.cstring(name);
    let rc: number;
    try {
      // The function's own pointer is its user data, so the one destructor frees the right slot.
      rc = this.c.sqlite3_create_function_v2(db, z, arity, SQLITE_UTF8, xFunc, xFunc, 0, 0, this.destroy);
    } finally {
      this.free(z);
    }
    if (rc) this.fail(db, rc);
  }

  /** The authorizer, installed with the engine itself: its arguments are read here, as sqlite-wasm's adapter reads them. Returns its removal. */
  authorizer(db: number, fn: (pv: number, code: number, a1: unknown, a2: unknown, schema: unknown, trigger: unknown) => number): () => void {
    const read = (p: number): unknown => p && this.text(p >>> 0);
    const p = this.install((pv: number, code: number, s0: number, s1: number, s2: number, s3: number): number => {
      try {
        return fn(pv, code, read(s0), read(s1), read(s2), read(s3)) | 0;
      } catch (e) {
        return Number((e as Any)?.resultCode) || 1;
      }
    }, "ipipppp");
    const rc = this.c.sqlite3_set_authorizer(db, p, 0);
    if (rc) {
      this.uninstall(p);
      this.fail(db, rc);
    }
    return () => {
      this.c.sqlite3_set_authorizer(db, 0, 0);
      this.uninstall(p);
    };
  }

  /** Whether `sql` ends a statement, as SQLite's `sqlite3_complete` reads it. */
  complete(sql: string): boolean {
    const [z] = this.cstring(sql);
    try {
      return this.c.sqlite3_complete(z) !== 0;
    } finally {
      this.free(z);
    }
  }

  /** The database's bytes, as sqlite-wasm's `sqlite3_js_db_export` makes them. */
  serialize(db: number): Uint8Array {
    return this.withSlots(2, (pSize, ppOut) => {
      const rc = this.c.sqlite3__wasm_db_serialize(db, 0, ppOut, pSize, 0);
      if (rc) throw this.error(rc, `Database serialization failed with code ${this.rcName(rc)}`);
      const p = this.ptrAt(ppOut!);
      try {
        this.heap();
        const n = Number(this.dataView.getBigInt64(pSize!, true));
        return n ? this.bytes(p, n) : new Uint8Array();
      } finally {
        this.free(p);
      }
    });
  }
}

const isInt32 = (n: number): boolean => n === (n | 0);
const fits64 = (b: bigint): boolean => b >= -9223372036854775808n && b <= 9223372036854775807n;
/** What oo1 binds as a BLOB. */
const bindable = (v: unknown): v is Uint8Array | Int8Array | ArrayBuffer => v instanceof Uint8Array || v instanceof Int8Array || v instanceof ArrayBuffer;

const natives = new WeakMap<object, Native>();
/** The module's engine, captured the first time the runtime asks, which is before the application has a handle. */
function nativeOf(sqlite3: Any): Native {
  let n = natives.get(sqlite3);
  if (!n) {
    n = new Native(sqlite3);
    natives.set(sqlite3, n);
  }
  return n;
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
  /** The engine's own entry points and memory: the session is made, read and cleared through these alone (1i). */
  private readonly n: Native;
  private readonly dbPtr: number;

  constructor(
    sqlite3: Any,
    db: Any,
    /** The captured engine: the filter and the column names are read through it, never the application's handle (1h-H1). */
    private readonly engine: Engine,
    /** A table the session leaves alone for now: one made since the last save, or the target of a schema change as it runs. */
    private readonly excluded: (table: string) => boolean = () => false,
  ) {
    this.n = nativeOf(sqlite3);
    this.dbPtr = db.pointer;
    this.open();
  }

  /** A new session, attached, made the capture's; it is not the capture's until it is whole. */
  private open(): void {
    const { n } = this;
    const c = n.c;
    const [main] = n.cstring("main");
    let session = 0;
    try {
      session = n.withSlots(1, (out) => {
        const rc = c.sqlite3session_create(this.dbPtr, main, out);
        if (rc) throw new Error(`CHANGES_CAPTURE (sqlite3session_create rc=${rc})`);
        return n.ptrAt(out!);
      });
    } finally {
      n.free(main);
    }
    // A table with no primary key yet (made by the application, not yet given its hidden key) is not
    // attached: the session would remember it as keyless and ignore it once it has its key. Asked again
    // on each change until it is attached.
    this.filter ||= n.install((_ctx: number, zTab: number) => {
      const name = n.text(zTab >>> 0) as string;
      if (internalNamed(name) || this.excluded(name)) return 0;
      return this.engine.value("SELECT 1 FROM pragma_table_info(?, 'main') WHERE pk > 0", [name]) == null ? 0 : 1;
    }, "ipp");
    c.sqlite3session_table_filter(session, this.filter, 0);
    const rc = c.sqlite3session_attach(session, 0);
    if (rc) {
      c.sqlite3session_delete(session);
      throw new Error(`CHANGES_CAPTURE (sqlite3session_attach rc=${rc})`);
    }
    this.session = session;
  }

  /** Captures nothing while `f` runs: the runtime's own writes to the application's tables. */
  paused<T>(f: () => T): T {
    return this.enabled(0, f);
  }

  /** Captures what `f` writes, even inside `paused`. */
  captured<T>(f: () => T): T {
    return this.enabled(1, f);
  }

  private enabled<T>(on: number, f: () => T): T {
    const c = this.n.c;
    if (!this.session) return f();
    const was = c.sqlite3session_enable(this.session, -1);
    c.sqlite3session_enable(this.session, on);
    try {
      return f();
    } finally {
      c.sqlite3session_enable(this.session, was);
    }
  }

  changes(): { table: string; op: "INSERT" | "UPDATE" | "DELETE"; pk: Record<string, unknown>; oldPk?: Record<string, unknown>; old: Record<string, unknown>; new: Record<string, unknown> }[] {
    const { n } = this;
    if (!this.session) throw new Error("CHANGES_CAPTURE (sqlite3changeset_ has no session to read)");
    const bytes = n.withSlots(2, (pn, pp) => {
      const rc = n.c.sqlite3session_changeset(this.session, pn, pp);
      if (rc) throw new Error(`CHANGES_CAPTURE (sqlite3session_changeset rc=${rc})`);
      const size = n.i32At(pn!);
      const p = n.ptrAt(pp!);
      try {
        return size ? n.bytes(p, size) : new Uint8Array(0);
      } finally {
        n.free(p);
      }
    });
    return bytes.length ? this.decode(bytes) : [];
  }

  /** Whether anything has been captured since the last `clear`. */
  isEmpty(): boolean {
    return !this.session || Boolean(this.n.c.sqlite3session_isempty(this.session));
  }

  /**
   * Starts over: what was captured is logged. The new session is made before
   * the old one goes, so one that cannot be made leaves the capture as it
   * was, and the save that asked is retried with everything it held (1f-L3).
   */
  clear(): void {
    const old = this.session;
    this.open();
    if (old) this.n.c.sqlite3session_delete(old);
  }

  private decode(bytes: Uint8Array): ReturnType<SessionCapture["changes"]> {
    const { n } = this;
    const c = n.c;
    const ops: ReturnType<SessionCapture["changes"]> = [];
    const buf = n.copyIn(bytes);
    try {
      n.withSlots(8, (pIter, pTab, pN, pOp, pInd, pPk, pPkN, pVal) => {
        let rc = c.sqlite3changeset_start(pIter, bytes.length, buf);
        if (rc) throw new Error(`CHANGES_CAPTURE (sqlite3changeset_start rc=${rc})`);
        const it = n.ptrAt(pIter!);
        /*
         * A column's value as sqlite-wasm's sqlite3changeset_old_js/new_js read
         * it, undefined where the change carries none. Text is carried as the
         * string that reading makes, which replaces bytes that are not UTF-8
         * (text made from a BLOB by CAST). Read back to the bytes SQLite holds
         * and compared, so such text is never carried changed: the save fails,
         * and no retry cures it (P3).
         */
        const exact = (side: "old" | "new", i: number): unknown => {
          const name = `sqlite3changeset_${side}`;
          n.setPtr(pVal!, 0);
          const rcv = c[name](it, i, pVal);
          if (rcv) throw n.error(rcv, `${name}() failed with code ${rcv}`);
          const p = n.ptrAt(pVal!);
          if (!p) return undefined;
          const v = n.value(p);
          if (v instanceof Uint8Array || typeof v === "bigint") return v;
          // An empty BLOB, which sqlite-wasm reads as NULL here.
          if (v === null) return c.sqlite3_value_type(p) === SQLITE_BLOB ? new Uint8Array(0) : v;
          // A REAL sqlite-wasm reads as a JS integer (1.0), or an infinity: held as the REAL it is (M15).
          if (typeof v === "number") return c.sqlite3_value_type(p) === SQLITE_FLOAT ? typed("real", v) : v;
          if (typeof v !== "string") return v;
          const size = c.sqlite3_value_bytes(p) as number;
          const held = n.bytes(c.sqlite3_value_blob(p) >>> 0, size);
          const encoded = new TextEncoder().encode(v);
          if (encoded.length !== size || encoded.some((b, j) => b !== held[j])) {
            throw new Error("CHANGES_CAPTURE (sqlite3changeset_value: text that is not UTF-8)");
          }
          return v;
        };
        while (c.sqlite3changeset_next(it) === SQLITE_ROW) {
          c.sqlite3changeset_op(it, pTab, pN, pOp, pInd);
          const table = n.text(n.ptrAt(pTab!)) as string;
          const count = n.i32At(pN!);
          const code = n.i32At(pOp!);
          c.sqlite3changeset_pk(it, pPk, pPkN);
          const pkFlags = n.ptrAt(pPk!);
          const names = this.namesOf(table, count);
          const op = code === SQLITE_INSERT ? "INSERT" : code === SQLITE_UPDATE ? "UPDATE" : "DELETE";
          const entry = {
            table,
            op,
            pk: {} as Record<string, unknown>,
            // The key as it was before the change: an UPDATE that respells it carries both (1e-H3).
            oldPk: {} as Record<string, unknown>,
            old: {} as Record<string, unknown>,
            new: {} as Record<string, unknown>,
          } as const;
          for (let i = 0; i < count; i++) {
            const isPk = n.byteAt(pkFlags + i) !== 0;
            const name = names[i]!;
            if (op !== "INSERT") {
              const v = exact("old", i);
              if (v !== undefined) (isPk ? entry.pk : entry.old)[name] = plain(v);
              if (v !== undefined && isPk) entry.oldPk[name] = plain(v);
            }
            if (op !== "DELETE") {
              const v = exact("new", i);
              if (v !== undefined) (isPk ? entry.pk : entry.new)[name] = plain(v);
            }
          }
          ops.push(entry as Any);
        }
        rc = c.sqlite3changeset_finalize(it);
        if (rc) throw new Error(`CHANGES_CAPTURE (sqlite3changeset_finalize rc=${rc})`);
      });
    } finally {
      n.free(buf);
    }
    return ops;
  }

  /** The changeset's column names. */
  private namesOf(table: string, n: number): string[] {
    if (!this.columns.has(table)) {
      const cols = (this.engine.all(`SELECT name FROM pragma_table_info(?, 'main') ORDER BY cid`, [table]) as Any[]).map((c) => String(c.name));
      this.columns.set(table, cols);
    }
    return this.columns.get(table)!.slice(0, n);
  }

  schemaChanged(): void {
    this.columns.clear();
  }

  close(): void {
    if (this.session) this.n.c.sqlite3session_delete(this.session);
    this.session = 0;
    this.n.uninstall(this.filter);
    this.filter = 0;
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
  db.createFunction("dai_key", (_c: unknown, _t: unknown, ...k: unknown[]) => keyText(k), { arity: -1, deterministic: false });
  db.createFunction("dai_projecting", () => 0, { arity: 0, deterministic: false });
  db.createFunction("dai_inserted", () => null, { arity: 2, deterministic: false });
  db.createFunction("dai_enter", () => null, { arity: 0, deterministic: false });
  db.createFunction("dai_leave", () => null, { arity: 0, deterministic: false });
}

/* --------------------------------------------------------------- engine */

/**
 * The runtime's own hands on the database (1h-H1, 1h-M2, 1i).
 *
 * The application shares this handle, and nothing it can reach is trusted. It
 * may replace any method of the handle, any method of `Stmt.prototype`, any
 * `capi` entry point, the pointer stack's methods or the `wasm` helpers, and
 * it does so after it is given the handle; a runtime that read or wrote
 * through those would run the application's code with the authorizer off. So
 * the runtime prepares, binds, steps and reads only through the engine's own
 * entry points (`Native`), captured before the application has the handle,
 * and holds each statement as SQLite's own pointer. No function of
 * sqlite-wasm's is on a path the runtime takes.
 *
 * Trust is a statement the runtime prepared through this private path, never a
 * window of application-reachable JavaScript: `trust.on` is raised for exactly
 * the prepare and the step that drive one of the runtime's own statements,
 * which is what the authorizer reads. During those calls no JavaScript runs but
 * the callbacks the runtime installed (its authorizer, its SQL functions, its
 * session filter), because the engine's exports call nothing else.
 */
/**
 * Trust is scoped to the connection, not to an engine: every engine over one
 * handle (the runtime's own, and any `createRows` view of the same handle)
 * raises the same flag, which is the one the handle's authorizer reads.
 */
const trustByDb = new Map<number, { on: number }>();
function trustOf(dbPtr: number): { on: number } {
  let t = trustByDb.get(dbPtr);
  if (!t) {
    t = { on: 0 };
    trustByDb.set(dbPtr, t);
  }
  return t;
}

class Engine {
  private readonly dbPtr: number;
  private readonly n: Native;
  private readonly cache = new Map<string, number>();
  /** Raised for exactly the prepare and step the runtime drives: the authorizer's one measure of its own work. */
  readonly trust: { on: number };

  constructor(sqlite3: Any, db: Any) {
    this.n = nativeOf(sqlite3);
    this.dbPtr = db.pointer;
    this.trust = trustOf(this.dbPtr);
  }

  /** A reset as oo1's `reset(true)`: the bindings cleared, and a failed last step said again. */
  private resetStmt(stmt: number): void {
    this.n.c.sqlite3_clear_bindings(stmt);
    const rc = this.n.c.sqlite3_reset(stmt);
    if (rc) this.n.fail(this.dbPtr, rc);
  }

  private finalize(stmt: number): void {
    this.n.c.sqlite3_finalize(stmt);
  }

  /** One statement, prepared through the engine's own prepare: the private path that makes it the runtime's own. */
  private prep(sql: string): number {
    const n = this.n;
    const [z] = n.cstring(sql);
    try {
      return n.withSlots(1, (pp) => {
        this.trust.on += 1;
        let rc: number;
        try {
          rc = n.c.sqlite3_prepare_v3(this.dbPtr, z, -1, 0, pp, 0);
        } finally {
          this.trust.on -= 1;
        }
        if (rc) n.fail(this.dbPtr, rc);
        const p = n.ptrAt(pp!);
        if (!p) throw new Error("CHANGES_CAPTURE (the runtime prepared empty SQL)");
        return p;
      });
    } finally {
      n.free(z);
    }
  }

  /** A step of the runtime's own statement, trusted for its duration (a re-prepare at step is the runtime's too). */
  stepStmt(stmt: number): boolean {
    this.trust.on += 1;
    let rc: number;
    try {
      rc = this.n.c.sqlite3_step(stmt);
    } finally {
      this.trust.on -= 1;
    }
    if (rc === SQLITE_ROW) return true;
    if (rc === SQLITE_DONE) return false;
    return this.n.fail(this.dbPtr, rc);
  }

  private bindTo(stmt: number, bind: unknown): void {
    if (bind === undefined || bind === null) return;
    if (Array.isArray(bind) && bind.length === 0) return;
    this.n.bind(this.dbPtr, stmt, bind);
  }

  private rowOf(stmt: number, names: string[]): Record<string, unknown> {
    const o: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < names.length; i += 1) o[names[i]!] = this.n.column(stmt, i);
    return o;
  }

  /** A script cut where SQLite itself would end each statement (sqlite3_complete), trigger bodies whole. */
  private split(text: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = text.indexOf(";"); i >= 0; i = text.indexOf(";", i + 1)) {
      const piece = text.slice(start, i + 1);
      if (this.n.complete(piece)) {
        out.push(piece);
        start = i + 1;
      }
    }
    if (text.slice(start).trim()) out.push(text.slice(start));
    return out;
  }

  /** The application's exec shape, run through the engine: a string or `{sql, bind}`, one or many statements. */
  exec(arg: Any): void {
    const sql = typeof arg === "string" ? arg : String(arg.sql);
    const bind = typeof arg === "string" ? undefined : (arg as { bind?: unknown }).bind;
    let bound = false;
    for (const piece of this.split(sql)) {
      const stmt = this.prep(piece);
      try {
        if (!bound && bind !== undefined && this.n.c.sqlite3_bind_parameter_count(stmt)) {
          this.bindTo(stmt, bind);
          bound = true;
        }
        while (this.stepStmt(stmt)) {
          /* run the statement to completion */
        }
      } finally {
        this.finalize(stmt);
      }
    }
  }

  all(sql: string, bind?: unknown): Record<string, unknown>[] {
    const stmt = this.prep(sql);
    const out: Record<string, unknown>[] = [];
    try {
      this.bindTo(stmt, bind);
      const names = this.n.columnNames(stmt);
      while (this.stepStmt(stmt)) out.push(this.rowOf(stmt, names));
    } finally {
      this.finalize(stmt);
    }
    return out;
  }

  value(sql: string, bind?: unknown): unknown {
    const stmt = this.prep(sql);
    try {
      this.bindTo(stmt, bind);
      return this.stepStmt(stmt) ? this.n.column(stmt, 0) : undefined;
    } finally {
      this.finalize(stmt);
    }
  }

  values(sql: string, bind?: unknown): unknown[] {
    const stmt = this.prep(sql);
    const out: unknown[] = [];
    try {
      this.bindTo(stmt, bind);
      while (this.stepStmt(stmt)) out.push(this.n.column(stmt, 0));
    } finally {
      this.finalize(stmt);
    }
    return out;
  }

  object(sql: string, bind?: unknown): Record<string, unknown> | undefined {
    const stmt = this.prep(sql);
    try {
      this.bindTo(stmt, bind);
      if (!this.stepStmt(stmt)) return undefined;
      return this.rowOf(stmt, this.n.columnNames(stmt));
    } finally {
      this.finalize(stmt);
    }
  }

  /** A kept statement for a hot path, reset after each use (the runtime's inserts and head reads). */
  private cached(sql: string): number {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.prep(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  runCached(sql: string, bind: unknown[]): void {
    const s = this.cached(sql);
    try {
      this.bindTo(s, bind);
      while (this.stepStmt(s)) {
        /* run to completion */
      }
    } finally {
      this.resetStmt(s);
    }
  }

  /** Each row of a kept statement, as [col -> value]; for the head reads. */
  eachCached(sql: string, bind: unknown[], fn: (get: (i: number) => unknown) => void): void {
    const s = this.cached(sql);
    try {
      this.bindTo(s, bind);
      while (this.stepStmt(s)) fn((i) => this.n.column(s, i));
    } finally {
      this.resetStmt(s);
    }
  }

  /** The connection's counts and transaction state, read from the engine itself (D08, R-S). */
  changes(): number {
    return Number(this.n.c.sqlite3_changes(this.dbPtr));
  }

  totalChanges(): number {
    return Number(this.n.c.sqlite3_total_changes(this.dbPtr));
  }

  autocommit(): boolean {
    return this.n.c.sqlite3_get_autocommit(this.dbPtr) !== 0;
  }

  /** Clears the connection's progress handler, through the engine's own entry point (1h-M2). */
  clearProgress(): void {
    this.n.c.sqlite3_progress_handler(this.dbPtr, 0, 0, 0);
  }

  /** The database's bytes, as the host writes them back. */
  serialize(): Uint8Array {
    return this.n.serialize(this.dbPtr);
  }

  close(): void {
    // Legal after the handle closed too: SQLite keeps a connection closed with close_v2 until its last statement goes.
    for (const s of this.cache.values()) this.finalize(s);
    this.cache.clear();
  }
}

/**
 * A `Rows` view over a handle, reading and writing only through the captured
 * engine (1h-H1): the shape the authorship layer and the host read a document
 * through, proof against an application that has replaced the handle's methods.
 */
export function createRows(sqlite3: Any, db: Any): Rows {
  const engine = new Engine(sqlite3, db);
  return {
    all: (sql, params = []) =>
      engine.all(sql, params.length ? params.slice() : undefined).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)]))),
    run: (sql, params = []) => engine.exec({ sql, bind: params.length ? params.slice() : undefined }),
  };
}

/* ----------------------------------------------- progress handler (1h-M2) */

/** The captured progress-handler installer, and what each connection's handler is, recorded through it. */
let realProgressHandler: Any = null;
const progressByDb = new Map<number, [number, Any, number] | null>();

/**
 * Once per process, replace `capi.sqlite3_progress_handler` with a recorder
 * over the captured original (1h-M2): the application installs its handler
 * through this, so the runtime knows what to restore after it clears the
 * handler for a step of its own. A later replacement of the capi entry by the
 * application installs no C-level handler of its own, so it fires nothing.
 */
function hookProgress(capi: Any): void {
  if (realProgressHandler) return;
  realProgressHandler = capi.sqlite3_progress_handler;
  capi.sqlite3_progress_handler = (p: number, n: number, fn: Any, data: number): Any => {
    progressByDb.set(p, n && fn ? [n, fn, data] : null);
    return realProgressHandler(p, n, fn, data);
  };
}

/* --------------------------------------------------------------- changes */

export interface ChangesOptions {
  /** This copy's author id, as the host handed it. */
  author: Uint8Array;
  /** The database's exec before anything wrapped it: the runtime's own writes schedule nothing. */
  rawExec?: (sql: Any) => unknown;
  /**
   * The release's schema, as the compiler declares it and the host ran it
   * before the application had the handle (R-W). A CREATE ... IF NOT EXISTS
   * the application runs is admitted only as this text's own definition.
   */
  schema?: string;
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
  private capture!: SessionCapture;
  /** How deep the runtime's own operations nest: for counting its writes apart (D08) and clearing the progress handler once (1h-M2); not for authorization, which the engine's trust decides. */
  private depth = 0;
  private authorizer: unknown = null;
  /** Removes the runtime's authorizer, through the engine's own entry point (1h-H1, 1i). */
  private unauthorize: (() => void) | null = null;
  /** The engine's own entry points and memory, captured with the module (1i). */
  private readonly native: Native;
  /** The handle's connection, read once before the application has the handle. */
  private readonly dbPtr: number;
  /** Triggers on runtime tables an imported schema carried, dropped at open (T11). */
  readonly refused: string[] = [];
  /** Set once a save has failed in a way no retry cures (P3): the sentence the person reads. Later writes are held. */
  refusal: string | null = null;
  /** True once the constructor has adopted what the document held. */
  private started = false;
  /** The release's declared objects, `type|name`, each as its canonical text (R-W). */
  private readonly declared: Map<string, string>;
  /** While the application prepares an admitted CREATE ... IF NOT EXISTS, that statement alone: the name it may make, as the type the release declares (R-W, 1g-M3). No application code runs during a prepare, so this window carries none. */
  private admitting = new Map<string, string>();
  /** The statements the application prepared on this mount, finalized when it closes (R-W). */
  private readonly appStatements = new Set<Any>();
  /** How deep `place` is in making room for a row (M04): a ring of moves ends, its last row decided as before. */
  private roomDepth = 0;
  /** The observations issued and not yet used, by token (R-X §4). */
  private readonly observations = new Map<string, Observation>();
  /** Rows the runtime wrote on this connection, and the application's last statement's count (D08). */
  private runtimeChanges = 0;
  private runtimeWrote = false;
  private appChanges = 0;
  private appLast = 0;
  private appTotal = 0;
  private runtimeLast = 0;
  /** The reason the authorizer last refused with, which the application's error carries (`explained`). */
  private deniedBecause: string | null = null;
  /** What the authorizer reads without a statement of its own (`refreshAuthorized`). */
  private virtualSet = new Set<string>();
  /** The tables adopted so far, as the capture filter reads them (C06). */
  private adopted = new Set<string>();
  private rangedSet = new Set<string>();
  /** While the runtime prepares, never runs, the writes that would fire each trigger (`refuseRuntimeWriters`). */
  private probing = false;
  private readonly probed = new Set<string>();
  /** Each table's key collations (`keyCollations`). */
  private readonly collCache = new Map<string, string[]>();
  /** The runtime's captured hands on the database: it reads, writes and runs only through these (1h-H1, 1h-M2). */
  private readonly engine: Engine;
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
    // Captured before the application has the handle: the runtime reads, writes and runs only through these (1h-H1, 1h-M2, 1i).
    this.native = nativeOf(sqlite3);
    this.dbPtr = db.pointer;
    this.engine = new Engine(sqlite3, db);
    this.exec = (sql) => this.engine.exec(sql);
    this.declared = declarationsOf(sqlite3, options.schema ?? "");
    this.rows = {
      all: (sql, params = []) =>
        this.engine.all(sql, params.length ? params.slice() : undefined).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)]))),
      run: (sql, params = []) => this.engine.exec({ sql, bind: params.length ? params.slice() : undefined }),
    };
    const capi = sqlite3.capi;
    // The application installs a progress handler through capi; its callback fires on every step, the runtime's
    // own among them, and could clear the authorizer from under a save (1h-M2). Record what the application
    // sets, through the captured installer, so a trusted window clears it and puts it back.
    hookProgress(capi);
    // The runtime's SQL functions run inside its own statements, so they are registered with the engine itself:
    // sqlite-wasm's function adapter reads capi by property at each call (1i).
    const fn = (name: string, arity: number, f: (ctx: number, ...args: unknown[]) => unknown): void => this.native.createFunction(this.dbPtr, name, arity, f);
    fn("dai_id", 1, () => this.nextId());
    fn("dai_uuid", 0, () => crypto.randomUUID());
    // A row's identity, as the runtime's tables key it: what the kit's query views compare a row with its flags by (1d-H5).
    fn("dai_key", -1, (_c: unknown, t: unknown, ...k: unknown[]) => this.identity(String(t), k));
    // 1 while the runtime applies merged rows: the application's own triggers stand down.
    fn("dai_projecting", 0, () => (this.projecting ? 1 : 0));
    fn("dai_inserted", 2, (_c: unknown, rowid: unknown, id: unknown) => {
      this.lastInsert = { rowid: Number(rowid), id: plain(id) };
      return null;
    });
    fn("dai_enter", 0, () => {
      this.frames.push(this.lastInsert);
      return null;
    });
    fn("dai_leave", 0, () => {
      this.lastInsert = this.frames.pop() ?? this.lastInsert;
      return null;
    });
    /*
     * The key is no longer the rowid, so last_insert_rowid() answers from the
     * slot: the application's id for a row of a rewritten integer key, the
     * rowid SQLite would answer for any other (1b-H1). Never the connection's
     * own last rowid, which the runtime's writes move: a save's log row, a
     * seal, a merged row.
     */
    fn("last_insert_rowid", 0, () => this.lastInsert.id ?? 0);
    /*
     * changes() and total_changes() answer for the application's statements
     * only (D08). The runtime writes on the same connection (a save's log row,
     * a seal, a merged row), and native SQLite would count those: changes()
     * after one would be the runtime's, read as the application's last.
     */
    fn("changes", 0, () => (this.runtimeWrote ? this.appChanges : this.engine.changes()));
    fn("total_changes", 0, () => this.engine.totalChanges() - this.runtimeChanges);
    this.exec(META);
    // Before any write the runtime trusts: a trigger an imported schema hung on a runtime table is gone (T11).
    this.refuseForeignTriggers();
    this.authorize();
    this.trusted(() => {
      // Foreign keys are enforced from open: the runtime never set it before, so a declared REFERENCES was decoration.
      if (this.engine.autocommit()) this.exec("PRAGMA foreign_keys = ON");
      // A table is captured once it is adopted, its key rewritten first: the release's tables, at open (R-W).
      this.capture = new SessionCapture(sqlite3, db, this.engine, (t) => this.started && !this.adopted.has(t));
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
    // What the runtime writes is counted apart, so changes() and total_changes() answer the application's (D08).
    const outer = this.depth === 0;
    const before = outer ? this.engine.totalChanges() : 0;
    this.depth += 1;
    try {
      // The outermost runtime operation steps many of its own statements; a progress handler would run the
      // application's code between those steps, so it is cleared for the whole window and put back after (1h-M2).
      return outer ? this.withProgressCleared(f) : f();
    } finally {
      this.depth -= 1;
      if (outer) {
        const wrote = this.engine.totalChanges() - before;
        if (wrote > 0) {
          this.runtimeChanges += wrote;
          if (!this.runtimeWrote) this.appChanges = this.appLast;
          this.runtimeWrote = true;
          this.runtimeLast = this.engine.changes();
        }
      }
    }
  }

  /** Clears the application's progress handler for the duration of `f`, and puts it back (1h-M2). A no-op when none is set. */
  private withProgressCleared<T>(f: () => T): T {
    const rec = progressByDb.get(this.dbPtr);
    if (!rec || !realProgressHandler) return f();
    this.engine.clearProgress();
    try {
      return f();
    } finally {
      // Put back through the installer captured with the module, after the runtime's own statements are done.
      realProgressHandler(this.dbPtr, rec[0], rec[1], rec[2]);
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
    // Every action that makes, drops or alters a schema object; and the four a verified IF NOT EXISTS names.
    const schemaActions = new Set([
      ...named,
      capi.SQLITE_CREATE_INDEX,
      capi.SQLITE_CREATE_TEMP_INDEX,
      capi.SQLITE_DROP_INDEX,
      capi.SQLITE_DROP_TEMP_INDEX,
      capi.SQLITE_CREATE_TRIGGER,
      capi.SQLITE_CREATE_TEMP_TRIGGER,
      capi.SQLITE_DROP_TRIGGER,
      capi.SQLITE_DROP_TEMP_TRIGGER,
      capi.SQLITE_ALTER_TABLE,
      capi.SQLITE_CREATE_VTABLE,
      capi.SQLITE_DROP_VTABLE,
    ]);
    // The four a verified IF NOT EXISTS names, each as the type it makes: a name is admitted for its declared type alone (1g-M3).
    const admittable = new Map<number, string>([
      [capi.SQLITE_CREATE_TABLE, "table"],
      [capi.SQLITE_CREATE_VIEW, "view"],
      [capi.SQLITE_CREATE_INDEX, "index"],
      [capi.SQLITE_CREATE_TRIGGER, "trigger"],
    ]);
    // The action codes the authorizer compares against, captured: the application can replace a capi.SQLITE_*
    // constant, and a comparison that read it live would then misclassify an action it should refuse (1h-H1).
    const ALTER = capi.SQLITE_ALTER_TABLE;
    const ATTACH = capi.SQLITE_ATTACH;
    const DETACH = capi.SQLITE_DETACH;
    const PRAGMA = capi.SQLITE_PRAGMA;
    const READ = capi.SQLITE_READ;
    const DENY = capi.SQLITE_DENY;
    const OK = capi.SQLITE_OK;
    const trust = this.engine.trust;
    this.authorizer = (_p: unknown, code: number, a1: unknown, a2: unknown, db: unknown, trigger: unknown): number => {
      const target = writes.has(code) || named.has(code) ? a1 : onTable.has(code) ? a2 : null;
      // Trusted means the runtime itself prepared or stepped this statement, through its captured engine (1h-H1):
      // never a window of application-reachable JavaScript, which is why there is no depth counter here.
      const app = trust.on === 0;
      const deny = (why: string): number => {
        this.deniedBecause = why;
        return DENY;
      };
      // A document refused under P3 holds every later write: nothing more is accepted that no save could log.
      if (this.refusal && app && target !== null) return deny(this.refusal);
      /*
       * The schema is the release's (R-W). Every schema action the application
       * prepares is refused, in main and in TEMP, by any route: `watch` refuses
       * the statement before it is prepared, and this is the same rule where
       * SQLite itself prepares. The one admission is a CREATE ... IF NOT EXISTS
       * `watch` verified as the release's own definition of an object that
       * exists, prepared with the admission set (`allowed`). A VACUUM and an
       * admitted CREATE run through the engine, trusted, so the application
       * never reaches this branch during one (1h-M2).
       */
      if (app && schemaActions.has(code)) {
        const schema = code === ALTER ? a1 : db;
        // SQLite's own objects (ANALYZE's sqlite_stat1), by SQLite's own reserved spelling: no application statement makes one.
        const engines = typeof a1 === "string" && /^sqlite_/i.test(a1) && code !== ALTER;
        const ours = !engines && (schema == null || schema === "main" || schema === "temp");
        const admitted = schema === "main" && typeof a1 === "string" && admittable.get(code) !== undefined && this.admitting.get(folded(a1)) === admittable.get(code);
        if (ours && !admitted) return deny(REFUSED.schema);
      }
      if (app) {
        // A virtual table is not carried (C04): written where an imported document holds one.
        if (writes.has(code) && typeof a1 === "string" && db !== "temp" && this.virtualSet.has(folded(a1))) return deny(REFUSED.virtual);
        // Only the document's own database is kept (S06): every ATTACH and DETACH, whatever its argument (an
        // expression's is null), by any route. A VACUUM's own ATTACH runs trusted (1h-M2), never here.
        if (code === ATTACH || code === DETACH) return deny(REFUSED.attach);
        // The settings the runtime's assumptions rest on are the runtime's (P03): set, not read.
        if (code === PRAGMA && typeof a2 === "string" && typeof a1 === "string" && RUNTIME_PRAGMAS.has(a1.toLowerCase())) return deny(REFUSED.pragma);
        // Under a ranged key the rowid is not the key, as it was where the key was the rowid's alias (K11).
        if (code === READ && a2 === "ROWID" && typeof a1 === "string" && db !== "temp" && this.rangedSet.has(folded(a1))) {
          if (!(typeof trigger === "string" && runtimeNamed(trigger))) return deny(REFUSED.rowid);
        }
      }
      if (typeof target !== "string" || !runtimeNamed(target)) return OK;
      // The document's own schemas: VACUUM copies every table through a schema of its own, which is not one.
      if (typeof db === "string" && db !== "main" && db !== "temp") return OK;
      if (typeof trigger === "string" && trigger.length > 0) {
        // Found by preparing, never running, the writes that would fire it (1d-L1).
        if (this.probing && !own.has(trigger)) this.probed.add(trigger);
        return own.has(trigger) && !app ? OK : deny(REFUSED.runtimeTables);
      }
      return !app ? OK : deny(REFUSED.runtimeTables);
    };
    // Installed with the engine itself: sqlite-wasm's adapter reads wasm.cstrToJs by property at each call, inside
    // the runtime's own prepares (1i).
    this.unauthorize = this.native.authorizer(this.dbPtr, this.authorizer as Any);
  }

  /**
   * What the authorizer reads, which may not prepare a statement of its own
   * while SQLite prepares one: the virtual tables (C04) and the tables keyed by
   * ranged ids (K11), folded. Refreshed at every adoption.
   */
  private refreshAuthorized(): void {
    this.virtualSet = new Set(
      (this.engine.values("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'virtual'") as string[]).map(folded),
    );
    this.rangedSet = new Set((this.engine.values("SELECT tbl FROM _cs_keys WHERE kind = 'ranged'") as string[]).map(folded));
  }

  /**
   * A trigger on a runtime table that is not the runtime's own, as an
   * imported schema can carry one: dropped at open, before any write the
   * runtime trusts, so it never runs under the runtime's outbox write (T11,
   * P02). One that takes a runtime trigger's name with other text is put back
   * as the runtime writes it. The names are kept in `refused`.
   */
  private refuseForeignTriggers(): void {
    // A runtime view, as T11 holds triggers (D264): the apply reads _cs_log_current, so a view an imported
    // document carries under a runtime name is the runtime's text or it goes, put back as the runtime writes it.
    const views = runtimeObjects(this.sqlite3).views;
    for (const v of this.engine.all("SELECT name, sql FROM main.sqlite_schema WHERE type = 'view'") as Any[]) {
      if (!runtimeNamed(String(v.name))) continue;
      const want = views.get(String(v.name));
      if (want && spaced(String(v.sql)) === spaced(want)) continue;
      this.exec(`DROP VIEW main.${q(String(v.name))}`);
      if (want) this.exec(want);
      this.refused.push(String(v.name));
    }
    const expected = runtimeTriggers(this.sqlite3);
    for (const schema of ["main", "temp"]) {
      for (const t of this.engine.all(`SELECT name, tbl_name, sql FROM ${schema}.sqlite_schema WHERE type = 'trigger'`) as Any[]) {
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
   * The application's handle, watched. Every statement it runs is read before
   * SQLite prepares it: a schema statement is refused (R-W), unless it is a
   * CREATE ... IF NOT EXISTS of an object that exists as the release defines
   * it, which runs as the no-op it is (`schemaStatements`).
   */
  watch(handle: Any): void {
    /*
     * A statement the application prepares and steps itself ends a
     * transaction as exec does: an apply that waited for it runs when a step
     * leaves the connection in autocommit (1d-L3). sqlite-wasm's own exec makes
     * its statements directly, and the runtime's own reads (depth > 0) are left
     * as they are. The statement belongs to this mount, and is finalized when
     * it closes (R-W).
     */
    const prepare = handle.prepare.bind(handle);
    handle.prepare = (...args: Any[]): Any => {
      if (this.depth > 0) return prepare(...args);
      this.deniedBecause = null;
      const text = textOf(args[0]);
      if (text === null) throw new Error(`CHANGES_REFUSED: ${REFUSED.schema}`);
      // SQLite prepares the first statement, so its allowance is the statement's: the text read, never the
      // caller's object, which a getter could answer differently a second time (1g-M2).
      const first = this.pieces(text)[0];
      const vacuum = first?.vacuum === true;
      let stmt: Any;
      try {
        stmt = this.allowed(first?.admit ?? null, () => prepare(text, ...args.slice(1)));
      } catch (e) {
        throw this.explained(e);
      }
      this.appStatements.add(stmt);
      // The statement as SQLite holds it, read once here: a VACUUM is stepped by this pointer alone (1i).
      const ptr: number = vacuum ? stmt.pointer : 0;
      const finalize = stmt.finalize.bind(stmt);
      stmt.finalize = (): Any => {
        this.appStatements.delete(stmt);
        return finalize();
      };
      const step = stmt.step.bind(stmt);
      stmt.step = (): Any => {
        this.counting();
        this.deniedBecause = null;
        let row: Any;
        try {
          // A VACUUM the application steps itself attaches and rebuilds; it is stepped through the captured
          // engine (trusted, its progress handler cleared), so no replaced step, prepare or handler runs while
          // it does (1h-M2). Every other statement is the application's, stepped as it is.
          row = vacuum ? this.withProgressCleared(() => this.engine.stepStmt(ptr)) : step();
        } catch (e) {
          // A statement SQLite prepares again at its step (the schema moved) is authorized again, and a refusal
          // there reads as one at prepare does (1f-L1).
          throw this.explained(e);
        }
        this.counted();
        if (this.depth === 0 && this.deferred && !this.inTransaction) this.projectAdmitted();
        return row;
      };
      return stmt;
    };
    // The handle's own counts answer for the application's statements, as the SQL functions do (D08).
    const changes = handle.changes.bind(handle);
    handle.changes = (total = false, big = false): Any => {
      const n = total ? Number(changes(true, false)) - this.runtimeChanges : this.runtimeWrote ? this.appChanges : Number(changes(false, false));
      return big ? BigInt(n) : n;
    };
    // The runtime's own functions, and the built-ins it answers for, are not the application's to replace (D11).
    const createFunction = handle.createFunction.bind(handle);
    handle.createFunction = (...args: Any[]): Any => {
      const name = typeof args[0] === "string" ? args[0] : args[0]?.name;
      if (typeof name === "string" && (/^dai_/i.test(name) || /^(last_insert_rowid|changes|total_changes)$/i.test(name))) {
        throw new Error(`CHANGES_REFUSED: ${REFUSED.functionName}`);
      }
      return createFunction(...args);
    };
    const exec = handle.exec.bind(handle);
    handle.exec = (...args: Any[]): Any => {
      // The runtime's own writes through the handle (the frame's, inside `trusted`) go through the captured
      // engine, trusted (1h-H1): never the application's replacement of this method or of Stmt.prototype.step.
      if (this.depth > 0) {
        const sql = typeof args[0] === "string" ? { sql: args[0], ...(args[1] ?? {}) } : args[0];
        return this.engine.exec(sql);
      }
      const text = textOf(args[0]);
      if (text === null) throw new Error(`CHANGES_REFUSED: ${REFUSED.schema}`);
      const opts = (typeof args[0] === "string" ? args[1] : args[0]) as Record<string, Any> | undefined;
      // A script is read whole first: one refused statement refuses it before any of it runs (R-V).
      const pieces = this.pieces(text);
      return this.statement(handle, () => this.running(handle, exec, text, opts, pieces));
    };
  }

  /**
   * Runs the application's exec as SQLite should read it (1g-M2, 1g-M3):
   * the text the runtime read, never the caller's object. A script none of
   * whose statements earns an allowance runs as one exec. Otherwise each
   * statement that earns one (a bare VACUUM, an admitted CREATE ... IF NOT
   * EXISTS) runs alone, with the allowance on for it and no callback, bound
   * value or result row of the application's, so no application code runs
   * while it holds; the statements between run with the caller's options,
   * its bound values going to the first that takes them and its result
   * options to the first that has columns, as one exec would.
   */
  private running(handle: Any, exec: (...a: Any[]) => Any, text: string, opts: Record<string, Any> | undefined, pieces: Piece[]): Any {
    const over = (sql: string, own: Record<string, unknown>): Any => {
      const o = Object.create(opts && typeof opts === "object" ? opts : null);
      for (const [k, v] of Object.entries({ ...own, sql })) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true });
      return o;
    };
    if (!pieces.some((p) => p.vacuum || p.admit)) return exec(over(text, {}));
    const rv = opts?.["returnValue"];
    const rowMode = opts?.["rowMode"];
    const callback = opts?.["callback"];
    const rows: unknown[] | undefined = Array.isArray(opts?.["resultRows"])
      ? opts!["resultRows"]
      : rv === "resultRows" || (!callback && !rv && rowMode !== undefined)
        ? []
        : undefined;
    const saved: unknown[] | undefined = Array.isArray(opts?.["saveSql"]) ? opts!["saveSql"] : rv === "saveSql" ? [] : undefined;
    let bind = opts?.["bind"];
    let result = Boolean(callback || rows || opts?.["columnNames"]);
    const segments: { sql: string; piece: Piece | null }[] = [];
    for (const p of pieces) {
      const last = segments[segments.length - 1];
      if (p.vacuum || p.admit) segments.push({ sql: p.sql, piece: p });
      else if (last && !last.piece) last.sql += p.sql;
      else segments.push({ sql: p.sql, piece: null });
    }
    for (const { sql, piece } of segments) {
      if (piece) {
        // The allowance runs through the captured engine, trusted, with none of the caller's arrays, callbacks
        // or bound values, and (for a VACUUM) its progress handler cleared: no application code runs while it
        // does (1h-M2). Its text joins the caller's saveSql afterwards, never iterated inside the trusted run.
        const run = (): void => this.engine.exec(sql);
        if (piece.vacuum) this.withProgressCleared(run);
        else run();
        if (saved) saved.push(sql.trim());
        continue;
      }
      const names: string[] = Array.isArray(opts?.["columnNames"]) ? opts!["columnNames"] : [];
      const takes = bind !== undefined && bind !== null && parameterized(sql);
      exec(
        over(sql, {
          bind: takes ? bind : undefined,
          callback: result ? callback : undefined,
          resultRows: result ? rows : undefined,
          columnNames: result ? names : undefined,
          rowMode: result ? rowMode : undefined,
          saveSql: saved,
          returnValue: undefined,
        }),
      );
      if (takes) bind = undefined;
      if (result && names.length > 0) result = false;
    }
    return rv === "resultRows" || (rows && !callback && !rv) ? rows : rv === "saveSql" ? saved : handle;
  }

  /** Runs `run` with one statement's admission on, and only while it runs: the name it may make, as the type the release declares. A prepare runs no application code, so this window carries none (1g-M3). */
  private allowed<T>(admit: [string, string] | null, run: () => T): T {
    const was = this.admitting;
    if (admit) this.admitting = new Map([admit]);
    try {
      return run();
    } finally {
      this.admitting = was;
    }
  }

  /**
   * The application's SQL, read (R-W), as its statements and the allowance
   * each earns alone (1g-M2, 1g-M3). Every schema statement is refused but a
   * CREATE TABLE, INDEX, TRIGGER or VIEW ... IF NOT EXISTS, in main, whose
   * canonical text is the release's own definition of that name, and whose
   * object exists as that type. Then SQLite does nothing, and that statement
   * is admitted to make that name as that type. An object the release
   * declares that the mount lacks is a damaged mount, never made again here.
   * A bare VACUUM (no INTO) earns its own database. A script with neither is
   * one piece, unsplit.
   */
  private pieces(text: string): Piece[] {
    if (!/\b(?:CREATE|ALTER|DROP|ATTACH|DETACH|VACUUM)\b/i.test(text)) return [{ sql: text, vacuum: false, admit: null }];
    const out: Piece[] = [];
    for (const statement of splitStatements(this.sqlite3, text)) {
      const tokens = sqlTokens(statement);
      // Only the document's own database is kept (S06): SQLite's own temporary one, named '', included (1e-L2).
      if (["attach", "detach"].includes(tokens[0] ?? "")) throw new Error(`CHANGES_REFUSED: ${REFUSED.attach}`);
      const vacuum = tokens[0] === "vacuum" && tokens.length <= 2 && tokens[1] !== "into";
      const create = createOf(statement);
      if (create === undefined) {
        out.push({ sql: statement, vacuum, admit: null });
        continue;
      }
      if (create === null) throw new Error(`CHANGES_REFUSED: ${REFUSED.schema}`);
      const want = this.declared.get(`${create.type}|${create.name}`);
      const have = create.type === "table" ? createOf(withHiddenKeys(statement))?.canonical : create.canonical;
      if (want === undefined || have !== want) throw new Error(`CHANGES_REFUSED: ${REFUSED.schema}`);
      const stored = this.trusted(() =>
        this.engine.value("SELECT type FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE AND type = ?", [create.name, create.type]),
      );
      if (stored == null) {
        const other = this.trusted(() => this.engine.value("SELECT type FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE", [create.name]));
        throw new Error(`CHANGES_REFUSED: ${other == null ? MOUNT_DAMAGED : REFUSED.schema}`);
      }
      out.push({ sql: statement, vacuum: false, admit: [create.name, create.type] });
    }
    return out;
  }

  /**
   * An error the authorizer caused, carrying the rule it refused by, as one
   * sentence (R-V): `CHANGES_REFUSED: <sentence> (SQLite: not authorized)`.
   * Any other error is returned as it was.
   */
  private explained(e: unknown): unknown {
    const why = this.deniedBecause;
    this.deniedBecause = null;
    if (!why || !/not authorized|is prohibited|authorization denied/.test(String((e as Error)?.message ?? e))) return e;
    return new Error(`CHANGES_REFUSED: ${why} (SQLite: not authorized)`, { cause: e });
  }

  /** Before an application statement: the total it starts from (D08). */
  private counting(): void {
    this.appTotal = this.engine.totalChanges();
  }

  /**
   * After an application statement (D08). One that wrote rows, or set the
   * count anew, is the latest the application's changes() answers natively,
   * until the runtime writes again; one that wrote nothing (a SELECT) leaves
   * the answer where it was.
   */
  private counted(): void {
    const now = this.engine.changes();
    const moved = this.engine.totalChanges() > this.appTotal;
    if (!this.runtimeWrote || moved || now !== this.runtimeLast) {
      this.runtimeWrote = false;
      this.appLast = now;
    }
  }

  /** One statement, or one script, as the application ran it. */
  private statement(_handle: Any, run: () => Any): Any {
    let result: Any;
    this.deniedBecause = null;
    this.counting();
    try {
      result = run();
      this.counted();
    } catch (e) {
      throw this.explained(e);
    } finally {
      this.settleFrames();
    }
    // An apply that waited for the application's transaction runs once it ends (R-S).
    if (this.deferred && !this.inTransaction) this.projectAdmitted();
    return result;
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
    for (const { tbl, pk } of this.engine.all("SELECT tbl, pk FROM _cs_keys WHERE kind IN ('ranged', 'hidden')") as Any[]) {
      const col = q(pk);
      const m = this.engine.value(`SELECT max(${col}) FROM main.${q(tbl)} WHERE ${col} >= ? AND ${col} < ?`, [base, base + SPAN]);
      if (m != null) high = Math.max(high, Number(m) - base);
    }
    // Every id the range has held is in the cells, deleted rows included, whoever wrote it: a row another
    // copy wrote into this range with an explicit id and then deleted is a high-water mark too (K06, K07).
    const cells = this.engine.values(
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
      const info = db.selectObjects("SELECT name, type, pk, dflt_value FROM pragma_table_info(?, 'main') ORDER BY cid", [table]) as Any[];
      const pks = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      const sql = String(db.selectValue("SELECT sql FROM sqlite_schema WHERE name = ?", [table]) ?? "");
      const withoutRowid = /WITHOUT\s+ROWID\s*$/i.test(sql.trim());
      const virtual = /^\s*CREATE\s+VIRTUAL\b/i.test(sql);
      if (virtual) continue;
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
    this.collCache.clear();
    this.declaredCache.clear();
    this.settleViews();
    this.capture?.schemaChanged();
    this.adopted = new Set(this.engine.values("SELECT tbl FROM _cs_keys") as string[]);
    this.refreshAuthorized();
    this.refuseRuntimeWriters();
  }

  /**
   * An application trigger whose program writes a runtime table (1d-L1, R-V).
   * The authorizer refuses such a write when the statement that fires it is
   * prepared, whatever the trigger's WHEN, so every merged row of its table
   * would be held. Found by preparing, never running, an insert, an update of
   * every column and a delete on each table that carries a trigger, and
   * dropping each trigger whose program the authorizer refused, at open (an
   * imported document; the names go in `refused`). The application makes no
   * trigger (R-W).
   */
  private refuseRuntimeWriters(): void {
    const triggered = new Set(this.engine.values("SELECT DISTINCT tbl_name FROM sqlite_temp_schema WHERE type = 'trigger' UNION SELECT DISTINCT tbl_name FROM sqlite_schema WHERE type = 'trigger'") as string[]);
    const tables = appTablesOf(this.rows).filter((t) => triggered.has(t));
    if (tables.length === 0) return;
    this.probing = true;
    this.probed.clear();
    try {
      for (const t of tables) {
        const cols = this.engine.values("SELECT name FROM pragma_table_info(?, 'main') ORDER BY cid", [t]) as string[];
        for (const sql of [
          `INSERT INTO main.${q(t)} DEFAULT VALUES`,
          `UPDATE main.${q(t)} SET ${cols.map((c) => `${q(c)} = ${q(c)}`).join(", ")}`,
          `DELETE FROM main.${q(t)}`,
        ]) {
          let stmt: Any = null;
          try {
            stmt = this.db.prepare(sql);
          } catch {
            // Refused: the trigger that made it so is in `probed`.
          } finally {
            stmt?.finalize();
          }
        }
      }
    } finally {
      this.probing = false;
    }
    const found = [...this.probed];
    this.probed.clear();
    if (found.length === 0) return;
    for (const name of found) {
      const schema = this.engine.value("SELECT 'temp' FROM sqlite_temp_schema WHERE type = 'trigger' AND name = ?", [name]) ?? "main";
      this.paused(() => this.exec(`DROP TRIGGER IF EXISTS ${schema}.${q(name)}`));
      this.refused.push(name);
    }
  }

  /**
   * Every other table with a rowid records its inserts in the same slot, as
   * its own rowid: what SQLite answers for it (PR9-H3). A WITHOUT ROWID table
   * leaves last_insert_rowid() as it was, in SQLite and here. An insert a
   * trigger makes is restored away when the application's trigger ends
   * (guardTriggers), so the order triggers fire in does not matter (1b-L4).
   */
  private slotEveryInsert(): void {
    for (const { tbl } of this.engine.all("SELECT tbl FROM _cs_keys WHERE kind IN ('uuid', 'natural', 'hidden')") as Any[]) {
      const sql = String(this.engine.value("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", [tbl]) ?? "");
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
    for (const { tbl, pk } of this.engine.all("SELECT tbl, pk FROM _cs_keys WHERE kind = 'natural'") as Any[]) {
      const sql = String(this.engine.value("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", [tbl]) ?? "");
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
    for (const { name, tbl_name, sql } of this.engine.all(
      "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND sql IS NOT NULL",
    ) as Any[]) {
      if (!apps.has(tbl_name)) continue;
      const at = String(sql).search(/\bBEGIN\b/i);
      if (at < 0) continue;
      let head = String(sql).slice(0, at);
      let body = String(sql).slice(at);
      // The runtime's own, known by its name and its body together, never by a name alone (1d-M1).
      if (runtimeNamed(String(name)) && OWN_BODY.test(body.trim())) continue;
      // A guard only in the exact form written below; an application's own mention of dai_projecting() is not one (1d-M1).
      if (!/\bWHEN dai_projecting\(\) = 0(?: AND \(|\s*$)/.test(head)) {
        head = /\bWHEN\b/i.test(head)
          ? head.replace(/\bWHEN\b([\s\S]*)$/i, "WHEN dai_projecting() = 0 AND ($1) ")
          : `${head.trimEnd()} WHEN dai_projecting() = 0 `;
      }
      if (!/^BEGIN SELECT dai_enter\(\);/.test(body) && /\bEND\s*;?\s*$/i.test(body)) {
        body = body.replace(/^BEGIN\b/i, "BEGIN SELECT dai_enter();").replace(/\bEND\s*;?\s*$/i, "SELECT dai_leave(); END");
      }
      if (head + body === String(sql)) continue;
      this.paused(() => {
        this.exec(`DROP TRIGGER main.${q(name)}`);
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
    const sql = String(this.engine.value("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", [table]));
    let rewritten: string;
    try {
      rewritten = kind === "hidden" ? withHiddenKeys(sql) : rewriteKeySql(sql, table, column, kind, type);
    } catch {
      return false;
    }
    if (rewritten === sql) return false;
    // The ordinary columns, by name: a generated column takes no value (C05), and SELECT * would hand it one.
    const cols = (this.engine.values("SELECT name FROM pragma_table_xinfo(?, 'main') WHERE hidden = 0 ORDER BY cid", [table]) as string[]).map(q).join(", ");
    const others = this.engine.values(
      "SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
      [table],
    ) as string[];
    const old = `_cs_old_${table}`;
    const inTxn = !this.engine.autocommit();
    const fk = this.engine.value("PRAGMA foreign_keys");
    this.keepingLastInsert(() => this.paused(() => {
      if (!inTxn) exec("PRAGMA foreign_keys = OFF");
      exec("PRAGMA legacy_alter_table = ON");
      try {
        exec("SAVEPOINT cs_rebuild");
        exec(`ALTER TABLE main.${q(table)} RENAME TO ${q(old)}`);
        exec(rewritten);
        if (kind === "hidden") this.capture.captured(() => exec(`INSERT INTO main.${q(table)} (${cols}) SELECT ${cols} FROM main.${q(old)}`));
        else exec(`INSERT INTO main.${q(table)} (${cols}) SELECT ${cols} FROM main.${q(old)}`);
        exec(`DROP TABLE main.${q(old)}`);
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
      const sql = String(this.engine.value("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", [table]) ?? "");
      d = declaredIn(sql, this.engine.values("SELECT name FROM pragma_table_info(?, 'main') ORDER BY cid", [table]) as string[]);
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
        `SELECT * FROM main.${q(table)} WHERE dai_key(${sqlText(table)}, ${key}) NOT IN (SELECT f.pk FROM main._cs_flag f, json_each(f.detail) j ` +
          `WHERE f.tbl = ${sqlText(table)} AND f.kind = 'pending' AND json_extract(j.value, '$.col') IN (${cols.map(sqlText).join(", ")}))`,
      );
    }
    const have = new Map((this.engine.all("SELECT tbl, body FROM _cs_settle") as Any[]).map((r) => [String(r.tbl), String(r.body)]));
    if (want.size === have.size && [...want].every(([t, b]) => have.get(t) === b)) return;
    this.exec("DELETE FROM _cs_settle");
    for (const [tbl, body] of want) this.exec({ sql: "INSERT INTO _cs_settle (tbl, body) VALUES (?, ?)", bind: [tbl, body] });
  }

  keysOf(table: string): Keys | null {
    if (!this.keysCache.has(table)) {
      const row = this.engine.object("SELECT kind, pk FROM _cs_keys WHERE tbl = ?", [table]) as Any;
      this.keysCache.set(table, row ? { kind: row.kind, pk: row.pk ? String(row.pk).split(",") : [] } : null);
    }
    return this.keysCache.get(table)!;
  }

  /* ------------------------------------------------------------ save */

  /** Whether the application has a transaction open: a save is a committed state, so a transaction is one changeset. */
  get inTransaction(): boolean {
    return !this.engine.autocommit();
  }

  /** The document's bytes, as the host writes them back: serialized by the engine itself, never by a capi entry (1i). */
  serialize(): Uint8Array {
    return this.engine.serialize();
  }

  /**
   * Whether the application changed anything the next save would log: the
   * current capture epoch (R-S). An edit made while a save's batch is being
   * signed is here, not in the log, until the next save (Q07).
   */
  get dirty(): boolean {
    // The session counts a row an UPDATE named as touched though no value changed: an echo, which a save
    // logs nothing for (R-X). Dirty is what the next save would log.
    if (this.capture.isEmpty()) return false;
    return this.trusted(() => this.respelled(this.capture.changes()).length > 0);
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
    const was = this.refusal;
    try {
      return this.trusted(() => this.saving());
    } finally {
      if (this.refusal && !was) this.expireStatements();
    }
  }

  /**
   * Every statement the application prepared before a P3 refusal is made to
   * prepare again (S09): the authorizer acts as SQLite prepares, so a
   * statement prepared before the refusal would otherwise still write. A
   * schema change expires them all, and SQLite prepares each again at its next
   * step, under the authorizer as it now stands.
   */
  private expireStatements(): void {
    this.trusted(() => {
      try {
        this.exec("CREATE TABLE main._cs_expire (x); DROP TABLE main._cs_expire;");
      } catch {
        // Inside a transaction the application rolled back, nothing is prepared that it could still step.
      }
    });
  }

  private saving(): SavedChanges | null {
    if (this.refusal) return null;
    if (this.inTransaction) return null;
    let ops: ReturnType<SessionCapture["changes"]>;
    let logged: { payloadOps: Op[]; payload: Uint8Array; ver: string } | null = null;
    try {
      ops = this.respelled(this.capture.changes());
    } catch (e) {
      throw this.refusedBy(e);
    }
    if (ops.length > 0) {
      /*
       * The batch, its versions, and the decisions it makes over the flagged
       * or held rows it wrote commit together, and the capture starts over
       * only after (R-S, RW-11): a failure anywhere leaves nothing of the save
       * in the log or the tables, and every change it held for the next.
       * Those decisions check foreign keys after rather than during, as an
       * apply does; PRAGMA foreign_keys is a no-op inside a transaction, so it
       * is set before the savepoint opens.
       */
      const fk = Number(this.engine.value("PRAGMA foreign_keys")) === 1;
      if (fk) this.exec("PRAGMA foreign_keys = OFF");
      try {
        this.exec("SAVEPOINT cs_save");
        try {
          let payloadOps: Op[];
          let payload: Uint8Array;
          try {
            payloadOps = ops.map((op) => this.withBases(op));
            payload = cborEncode([1, payloadOps as unknown as CborValue[], this.received() as unknown as CborValue] as CborValue);
          } catch (e) {
            throw this.refusedBy(e);
          }
          const entity = crypto.getRandomValues(new Uint8Array(16));
          const row = createEntity(this.rows, CHANGES_LOG, entity, { payload });
          const ver = `${this.authorHex}:${row._r_seq}`;
          const touched = this.ingest(payloadOps, ver, Number(row._r_lc), this.authorHex);
          // What this save wrote is what the row shows, until a projection decides it again (`_cs_shown`).
          for (const [t, k, code, n] of payloadOps) {
            const pk = this.identity(t, k);
            if (code === "D") this.shownAs(t, pk, null);
            else for (const c of n.keys()) if (c !== "") this.runCached("INSERT OR REPLACE INTO _cs_shown (tbl, pk, col, ver) VALUES (?, ?, ?, ?)", [t, pk, c, ver]);
          }
          // A save over a flagged or held row may have resolved it: decide it again.
          const marked = touched.filter(
            ([t, pk]) =>
              this.engine.value("SELECT 1 FROM _cs_flag WHERE tbl = ? AND pk = ? UNION SELECT 1 FROM _cs_held WHERE tbl = ? AND pk = ?", [t, pk, t, pk]) !=
              null,
          );
          // And a held or kept-referenced row is decided again at every save, as at every projection: a save that
          // removed a kept row's last reference lets its delete stand here, as it will on every copy (1f-M3).
          const kept = this.engine.value("SELECT 1 FROM _cs_held UNION ALL SELECT 1 FROM _cs_flag WHERE kind = 'kept-referenced' LIMIT 1") != null;
          if (marked.length || kept) this.withoutCapture(() => this.project(marked));
          // The baseline advances inside the same savepoint, last: a capture that cannot start over takes the
          // batch back with it, and the save is retried with everything it held (1f-L3, P3 not reached).
          this.capture.clear();
          this.exec("RELEASE cs_save");
          logged = { payloadOps, payload, ver };
        } catch (e) {
          this.exec("ROLLBACK TO cs_save");
          this.exec("RELEASE cs_save");
          throw e;
        }
      } finally {
        if (fk) this.exec("PRAGMA foreign_keys = ON");
      }
    }
    // Net-zero work (an insert then its delete, an echo) leaves the session touched with nothing to log; it
    // starts over too. A failure here loses nothing: there was nothing to log.
    if (!logged && !this.capture.isEmpty()) this.capture.clear();
    if (!logged) return null;
    return { ver: logged.ver, ops: logged.payloadOps.length, bytes: logged.payload.length };
  }

  /**
   * A key respelled in place (1e-H3): under its collation or storage class
   * the new spelling is the same row to SQLite, and the session records the
   * UPDATE as an insert of the new spelling beside the row it finds under the
   * old: a delete of the old spelling, or (where its lookup folds the key as
   * the table does) an UPDATE of the row with what else changed. The pair is
   * taken back to one UPDATE that writes the key's columns whose spelling
   * changed and whatever else did, so the spelling travels as a value
   * change. A pair that changed nothing is nothing.
   */
  private respelled(ops: ReturnType<SessionCapture["changes"]>): ReturnType<SessionCapture["changes"]> {
    const at = new Map<string, { before?: number; ins?: number }>();
    ops.forEach((op, i) => {
      if (!this.respells(op.table)) return;
      const keys = this.keysOf(op.table);
      if (!keys?.pk.length) return;
      const id = JSON.stringify([op.table, this.identity(op.table, keys.pk.map((c) => op.pk[c]))]);
      const pair = at.get(id) ?? {};
      if (op.op === "INSERT") pair.ins = i;
      else pair.before = i;
      at.set(id, pair);
    });
    const drop = new Set<number>();
    const out = ops.slice();
    for (const { before, ins } of at.values()) {
      if (before === undefined || ins === undefined) continue;
      const b = ops[before]!;
      const n = ops[ins]!;
      const keys = this.keysOf(n.table)!;
      const now: Record<string, unknown> = {};
      const was: Record<string, unknown> = {};
      if (b.op === "DELETE") {
        for (const [c, v] of Object.entries(n.new)) {
          if (c in b.old && sameValue(b.old[c], v)) continue;
          now[c] = v;
          was[c] = b.old[c] ?? null;
        }
      } else {
        Object.assign(now, b.new);
        Object.assign(was, b.old);
      }
      const prior = b.oldPk ?? b.pk;
      for (const c of keys.pk) {
        if (keySpelling([prior[c]]) === keySpelling([n.pk[c]])) continue;
        now[c] = n.pk[c];
        was[c] = prior[c];
      }
      drop.add(before);
      if (Object.keys(now).length === 0) drop.add(ins);
      else out[ins] = { table: n.table, op: "UPDATE", pk: n.pk, old: was, new: now };
    }
    return out.filter((_, i) => !drop.has(i));
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

  private runCached(sql: string, bind: unknown[]): void {
    this.engine.runCached(sql, bind);
  }

  /** Every current version of one row, by column ("" is existence). */
  private rowHeads(table: string, pk: string): Map<string, { ver: string; val: unknown }[]> {
    const heads = new Map<string, { ver: string; val: unknown }[]>();
    this.engine.eachCached(
      "SELECT col, ver, val FROM _cs_cell c WHERE tbl = ? AND pk = ? AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = c.tbl AND s.pk = c.pk AND s.col = c.col AND s.ver = c.ver) ORDER BY col, ver",
      [table, pk],
      (get) => {
        const col = String(get(0));
        heads.set(col, [...(heads.get(col) ?? []), { ver: String(get(1)), val: get(2) }]);
      },
    );
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
    // Where a key can be spelled more than one way, its spelling is a value (1e-H3): a birth writes the
    // key's columns, as a respelling does (`respelled`), and an edit of any other column does not.
    if (code === "I" && keys?.pk.length && this.respells(op.table)) for (const c of keys.pk) n.set(c, op.pk[c]);
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
        const now = this.engine.object(
          `SELECT ${missing.map((c) => `${q(c)}, typeof(${q(c)}) AS ${q(`_cs_t_${c}`)}`).join(", ")} FROM main.${q(op.table)} WHERE ${where}`,
          k.map(compared),
        ) as Any;
        if (now) for (const c of missing) n.set(c, typed(now[`_cs_t_${c}`], now[c]));
      }
    }
    const heads = this.rowHeads(op.table, pk);
    /*
     * An edit is based on what it was made against (R-X §3): each unit's
     * basis is the version its displayed value came from, and an edit
     * supersedes that alone. The alternatives this copy also holds stay
     * pending until an explicit resolution names them, and an edit of a
     * column leaves the row's existence, and a delete that contests it, as
     * they were. A birth is based on every current version.
     *
     * A delete is an edit of the row unit (the delete ruling, 1g-H1): its
     * existence is based on the existence heads, and what it saw is the
     * version each column showed, not every version the copy holds. An
     * alternative it did not see (a pending loser, a proposal a constraint
     * set aside) stays on the row, which is kept and contested until the
     * existence call settles it; a resolution may choose the deletion.
     */
    for (const c of n.keys()) {
      if (code !== "U") b.set(c, (heads.get(c) ?? []).map((h) => h.ver));
      else {
        const v = this.shownVersion(op.table, pk, c);
        b.set(c, v ? [v] : []);
      }
    }
    if (code === "D") {
      seen = [
        ...new Set(
          [...heads.keys()]
            .filter((c) => c !== "")
            .map((c) => this.shownVersion(op.table, pk, c))
            .filter((v): v is string => v !== null),
        ),
      ].sort();
    }
    return [op.table, k, code, n, p, b, seen];
  }

  /** Records one changeset's versions. Grow-only, so the order changesets arrive in does not matter. */
  private ingest(ops: Op[], ver: string, lc: number, author: string): [string, string][] {
    const touched: [string, string][] = [];
    for (const [table, k, , n, , b, seen, r] of ops) {
      const pk = this.identity(table, k);
      // Any author's id in this author's range raises the counter, not only its own (K06, K07).
      this.counterAbove(table, k);
      // The key as this version wrote it, where its identity reads otherwise: a REAL key, a key in a collation
      // that folds (1d-H4, 1d-H5): what a log from before 1e-H3 is read back with (`spellingOf`).
      const spelled = keySpelling(k);
      if (n.get("") === 1 && spelled !== pk) {
        this.runCached("INSERT OR IGNORE INTO _cs_spell (tbl, pk, ver, k) VALUES (?, ?, ?, ?)", [table, pk, ver, spelled]);
      }
      for (const [c, val] of n) {
        const v = bound(val);
        this.runCached(`INSERT OR IGNORE INTO _cs_cell (tbl, pk, col, ver, val, lc, author) VALUES (?, ?, ?, ?, ${v.at}, ?, ?)`, [
          table,
          pk,
          c,
          ver,
          v.value,
          lc,
          author,
        ]);
      }
      for (const [c, vers] of b) for (const v of vers) this.runCached("INSERT OR IGNORE INTO _cs_sup (tbl, pk, col, ver) VALUES (?, ?, ?, ?)", [table, pk, c, v]);
      // A resolution supersedes exactly the alternatives it names, and no other (R-X §4).
      if (r) for (const [c, vers] of r) for (const v of vers) this.runCached("INSERT OR IGNORE INTO _cs_sup (tbl, pk, col, ver) VALUES (?, ?, ?, ?)", [table, pk, c, v]);
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
    const touched: [string, string][] = [];
    if (fresh.length === 0) return { changesets: 0, rows: 0 };
    const known = new Map(
      (this.engine.all(`SELECT lower(hex(_r_replica)) || ':' || _r_seq AS ver, _r_lc AS lc FROM ${q(`${CHANGES_LOG}_current`)}`) as Any[]).map((r) => [String(r.ver), Number(r.lc)]),
    );
    let applied = 0;
    this.withoutCapture(() => {
      for (const row of fresh) {
        const ver = `${row["author"]}:${row["seq"]}`;
        const decoded = cborDecode(row["payload"] as Uint8Array, { floats: true }) as unknown as [number, Op[], unknown?];
        const verdict = this.basisVerdict(decoded[1], Number(row["lc"]), known, String(row["author"]), Number(row["seq"]), decoded[2]);
        // A basis naming a version not yet here waits for it, unapplied, and is judged when it arrives.
        if (verdict === "wait") continue;
        if (verdict) {
          this.runCached("INSERT OR IGNORE INTO _cs_refused (ver, reason) VALUES (?, ?)", [ver, verdict]);
          this.runCached("INSERT OR IGNORE INTO _cs_ingested (ver) VALUES (?)", [ver]);
          continue;
        }
        touched.push(...this.ingest(decoded[1], ver, Number(row["lc"]), String(row["author"])));
        applied += 1;
      }
      this.project(touched);
    });
    return { changesets: applied, rows: new Set(touched.map((t) => t.join("|"))).size };
  }

  /**
   * Whether an admitted changeset's operations bind their causal basis
   * (R-X §3), read from the signed payload alone: never reconstructed from
   * this copy's projection, arrival order or flags. Every unit an operation
   * writes names its basis; every version its `bases` or `resolves` names is
   * a version of that cell from before it (a lower clock). One naming a
   * version this copy has not yet applied, from before it, waits for it; one
   * naming a version already judged that is not that cell's (refused, or
   * another cell's), or one from no earlier than itself, is refused. So every
   * copy decides alike, whatever order the batches came in.
   *
   * And a version named must be one the signer had received (1g-M1): its
   * own from before, or one at or below the seq its batch records it had
   * applied of that author (`received`). A clock shows only order; the
   * receipt, signed with the batch, shows possession. A delete's `seen` is
   * held to it too.
   */
  private basisVerdict(ops: Op[], lc: number, known: Map<string, number>, author: string, seq: number, received: unknown): BasisRefusal | "wait" | null {
    let wait = false;
    if (received !== undefined && !(received instanceof Map)) return "basis-forged";
    const rec = received instanceof Map ? (received as Map<string, unknown>) : undefined;
    /*
     * The receipt binds possession, not just order (1h-M1). Each entry is
     * `[seq, digest]`: the signer's highest applied seq of that author, and
     * that author's batch digest at it, which only a copy that received the
     * batch can carry. Checked against the batch the reader holds: a digest
     * that differs, or a batch whose clock is not below the signer's own
     * (it could not have been received before the signer signed), is a
     * forgery; an entry the reader does not yet hold leaves the batch
     * waiting, so a seq the signer never received never takes effect.
     */
    let recWait = false;
    if (rec) {
      for (const [, entry] of rec) {
        if (!receiptEntry(entry)) return "receipt-forged";
      }
      for (const [by, entry] of rec) {
        const [s, digest] = entry as [number, string];
        // An author's s-th batch has a clock no lower than s, and the signer could only receive it before
        // signing (below its own clock): a receipt naming a seq at or above the signer's clock is impossible,
        // refused without holding that batch (1h-M1).
        if (s >= lc) return "receipt-forged";
        const held = this.engine.object(
          `SELECT lower(hex(_r_batch)) AS d, _r_lc AS lc FROM ${q(CHANGES_LOG)} WHERE lower(hex(_r_replica)) = ? AND _r_seq = ?`,
          [by, s],
        ) as Any;
        if (held && held.d != null) {
          // The batch the reader holds at that seq must be the one named, and older than the signer's own.
          if (String(held.d) !== digest || Number(held.lc) >= lc) return "receipt-forged";
        } else {
          recWait = true;
        }
      }
      // A signer's receipt for an author cannot go backwards between its batches: the batch before this one (its
      // own, highest below this seq) could not have claimed a higher seq for anyone (1h-M1). Its entries are read
      // by the one shape rule too (1i-L1): an entry refused for its shape claims nothing, in both readers.
      const prevPayload = this.engine.value(
        `SELECT payload FROM ${q(CHANGES_LOG)} WHERE lower(hex(_r_replica)) = ? AND _r_seq < ? ORDER BY _r_seq DESC LIMIT 1`,
        [author, seq],
      );
      if (prevPayload instanceof Uint8Array) {
        try {
          const prev = (cborDecode(prevPayload, { floats: true }) as unknown as [number, Op[], unknown])[2];
          if (prev instanceof Map) {
            for (const [by, pe] of prev as Map<string, unknown>) {
              if (!receiptEntry(pe)) continue;
              const now = rec.get(by);
              if (!receiptEntry(now) || now[0] < pe[0]) return "receipt-forged";
            }
          }
        } catch {
          /* The previous batch's payload is this copy's own stored bytes; an unreadable one is not a forgery to charge here. */
        }
      }
    }
    const had = (v: string): boolean => {
      // One grammar for a version in both readers (1h-L1): lowercase hex, a colon, then ASCII digits with no
      // leading zero and no whitespace. Number() would take " 1" and isdigit() would take a Unicode digit, and
      // the two readers would then disagree; anything but this grammar is refused by both, with the same word.
      if (!VERSION.test(v)) return false;
      const at = v.lastIndexOf(":");
      const [by, n] = [v.slice(0, at), Number(v.slice(at + 1))];
      if (by === author) return n < seq;
      const entry = rec?.get(by);
      return receiptEntry(entry) && n <= entry[0];
    };
    for (const op of ops) {
      const [table, k, code, n, , b, seen] = op;
      const r = op[7];
      if (!(b instanceof Map) || !(n instanceof Map)) return "basis-missing";
      for (const c of n.keys()) if (!Array.isArray(b.get(c))) return "basis-missing";
      if (r !== undefined && !(r instanceof Map)) return "basis-forged";
      if (!Array.isArray(seen) || seen.some((v) => !had(String(v)))) return "basis-forged";
      // A resolution resolves one unit whole (R-X §5, 1g-L3): every column it writes, and no other, names the
      // same alternatives. An empty one resolves nothing, and is read as none.
      const resolving = r instanceof Map && r.size > 0;
      if (resolving) {
        const alts = (c: string): string => JSON.stringify(Array.isArray(r.get(c)) ? [...(r.get(c) as unknown[])].map(String).sort() : null);
        const first = alts([...n.keys()][0] ?? "");
        if ([...r.keys()].some((c) => !n.has(c)) || [...n.keys()].some((c) => alts(c) !== first) || first === "null") return "basis-forged";
      }
      const pk = this.identity(table, k);
      const waiting: boolean = wait;
      wait = false;
      for (const [c, vers] of [...b, ...(r ?? new Map<string, string[]>())]) {
        if (!Array.isArray(vers)) return "basis-forged";
        if (vers.some((v) => !had(String(v)))) return "basis-forged";
        for (const v of vers) {
          const at = this.engine.value("SELECT lc FROM _cs_cell WHERE tbl = ? AND pk = ? AND col = ? AND ver = ?", [table, pk, c, String(v)]);
          if (at != null) {
            if (Number(at) >= lc) return "basis-forged";
          } else if (this.engine.value("SELECT 1 FROM _cs_ingested WHERE ver = ?", [String(v)]) != null) return "basis-forged";
          else if ((known.get(String(v)) ?? -Infinity) >= lc) return "basis-forged";
          else wait = true;
        }
      }
      /*
       * An edit that changes nothing it was based on, and resolves nothing, is
       * one an honest runtime never signs (1g-L2): an echo authors nothing
       * (R-X §2), and a resolution names what it resolves. Judged once its
       * basis is here, by value and storage class.
       */
      if (code === "U" && !resolving && !wait && n.size > 0) {
        const unchanged = [...n].every(([c, val]) => {
          const vers = b.get(c) as unknown[];
          if (vers.length !== 1) return false;
          const v = bound(val);
          return (
            this.engine.value(
              `SELECT 1 FROM _cs_cell WHERE tbl = ? AND pk = ? AND col = ? AND ver = ? AND val IS ${v.at} AND typeof(val) = typeof(${v.at})`,
              [table, pk, c, String(vers[0]), v.value, v.value],
            ) != null
          );
        });
        if (unchanged) return "basis-unchanged";
      }
      wait ||= waiting;
    }
    return wait || recWait ? "wait" : null;
  }

  /**
   * What this copy had received when it signs a batch (1g-M1, 1h-M1): for each
   * other author, the highest seq of theirs it applied, and the digest of that
   * author's batch at that seq — the batch id the chain already carries
   * (`_cs_log._r_batch`). A copy applies one author's batches in order, so the
   * seq names every batch of theirs it holds, and the digest is what only a
   * copy that received that batch can carry. Both, signed in the payload's
   * third field, are `[seq, digest]` per author.
   */
  private received(): Map<string, [number, string]> {
    const out = new Map<string, [number, string]>();
    for (const r of this.engine.all(
      `SELECT m.a AS a, m.s AS s, lower(hex(l._r_batch)) AS d FROM
         (SELECT substr(ver, 1, instr(ver, ':') - 1) AS a, max(CAST(substr(ver, instr(ver, ':') + 1) AS INTEGER)) AS s
          FROM _cs_ingested i WHERE NOT EXISTS (SELECT 1 FROM _cs_refused r WHERE r.ver = i.ver) GROUP BY a) m
         JOIN ${q(CHANGES_LOG)} l ON lower(hex(l._r_replica)) = m.a AND l._r_seq = m.s
       ORDER BY a`,
    ) as Any[]) {
      if (r.a !== this.authorHex && r.d != null) out.set(String(r.a), [Number(r.s), String(r.d)]);
    }
    return out;
  }

  /** The admitted changesets refused for their basis (R-X §3), by version. */
  refusedChanges(): { ver: string; reason: BasisRefusal }[] {
    return this.engine.all("SELECT ver, reason FROM _cs_refused ORDER BY ver") as Any[];
  }

  private paused<T>(f: () => T): T {
    return this.capture ? this.capture.paused(f) : f();
  }

  /**
   * Runtime writes to the application's tables: not captured, foreign keys
   * checked after rather than during, and all or nothing. The application's
   * triggers stand down by `dai_projecting()`, written into each; the
   * application makes no TEMP trigger (R-W), so the connection the apply runs
   * on carries none of its own (R-S, T01), and the runtime's TEMP triggers
   * stand down the same way.
   */
  withoutCapture(f: () => void): void {
    this.trusted(() => this.applying(f));
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
    const heads = this.engine.all(
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
        ? (this.engine.values(`SELECT ver FROM _cs_seen WHERE tbl = ? AND pk = ? AND del IN (${dels.map(() => "?").join(",")})`, [
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
      this.engine.all("SELECT col, ver, val, typeof(val) AS t, lc, author FROM _cs_cell WHERE tbl = ? AND pk = ? AND col <> ''", [table, pk]) as Any[];
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
      const vers = versOf(state);
      const entries: Any[] = [];
      for (const [col, h] of Object.entries(state.shownBy)) {
        if (!aside.has(h.ver)) continue;
        const before = cells.filter((c) => c.col === col && !aside.has(c.ver)).sort(later)[0];
        if (!before) continue;
        values[col] = typed(before.t, before.val);
        vers[col] = String(before.ver);
        entries.push({ col, constraint: reason, values: [{ ver: h.ver, val: shown(h.val) }, { ver: before.ver, val: shown(before.val) }] });
      }
      if (entries.length === 0) continue;
      try {
        this.write(table, keys, k, values, vers);
      } catch {
        continue;
      }
      this.flag(table, pk, "pending", [...state.pending, ...entries]);
      return true;
    }
    return false;
  }

  private birthOf(table: string, pk: string): { lc: number; author: string; ver: string } | null {
    return (this.engine.object(
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
    const colls = this.keyCollations(table);
    return keyText(k, colls.some((c) => c !== "BINARY") ? (s, i) => folding(colls[i] ?? "BINARY", s) : null);
  }

  /**
   * Whether one key of this table can be held under two spellings: a key
   * column whose collation folds text (NOCASE, RTRIM), or one with no type,
   * where a REAL 1.0 and an INTEGER 1 are one key (every other affinity
   * converts one to the other as it stores). There the key's spelling is a
   * value (1e-H3): a row is written with its key columns' shown values.
   */
  private respells(table: string): boolean {
    const keys = this.keysOf(table)?.pk ?? [];
    const untyped = keys.some((c) => {
      const type = String(this.engine.value("SELECT type FROM pragma_table_info(?, 'main') WHERE name = ?", [table, c]) ?? "").toUpperCase();
      return !/INT|CHAR|CLOB|TEXT|REAL|FLOA|DOUB/.test(type) && (type === "" || type.includes("BLOB"));
    });
    return untyped || this.keyCollations(table).some((c) => c !== "BINARY");
  }

  /**
   * Each key column's collation, as SQLite reports it for the table's key
   * index (`pragma_index_xinfo`): BINARY where there is none (a rowid key).
   */
  private keyCollations(table: string): string[] {
    let colls = this.collCache.get(table);
    if (!colls) {
      const keys = this.keysOf(table)?.pk ?? [];
      const index = this.engine.value("SELECT name FROM pragma_index_list(?, 'main') WHERE origin = 'pk'", [table]) as string | undefined;
      const by = new Map<string, string>(
        index
          ? (this.engine.all("SELECT name, coll FROM pragma_index_xinfo(?, 'main') WHERE key = 1", [index]) as Any[]).map((r) => [String(r.name), String(r.coll).toUpperCase()])
          : [],
      );
      colls = keys.map((c) => by.get(c) ?? "BINARY");
      this.collCache.set(table, colls);
    }
    return colls;
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
    for (const r of this.engine.all("SELECT tbl, pk FROM _cs_held UNION SELECT tbl, pk FROM _cs_flag WHERE kind = 'kept-referenced'") as Any[]) {
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
    for (const f of this.engine.all("SELECT tbl, pk, detail FROM _cs_flag WHERE kind = 'pending'") as Any[]) {
      const entries = (f.detail ? JSON.parse(f.detail) : []) as Any[];
      const mine = entries.filter((e) => e.group === undefined);
      const at = JSON.stringify([f.tbl, f.pk]);
      own.set(at, mine);
      for (const e of mine) for (const v of e.constraint ? e.values.slice(0, 1) : e.values) contends(v.ver, at);
    }
    for (const h of this.engine.all("SELECT tbl, pk FROM _cs_held") as Any[]) {
      const at = JSON.stringify([h.tbl, h.pk]);
      for (const [col, hs] of this.rowHeads(h.tbl, h.pk)) if (col !== "") for (const v of hs) contends(v.ver, at);
    }
    const grouped = new Map<string, Any[]>();
    for (const [ver, from] of sources) {
      const wrote = this.engine.all(
        `SELECT tbl, pk, col, val FROM _cs_cell c WHERE ver = ? AND col <> ''
          AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = c.tbl AND s.pk = c.pk AND s.col = c.col AND s.ver = c.ver) ORDER BY tbl, pk, col`,
        [ver],
      ) as Any[];
      const waits = [...from].sort().map((at) => JSON.parse(at));
      for (const w of wrote) {
        const at = JSON.stringify([w.tbl, w.pk]);
        if (from.has(at) || this.engine.value("SELECT 1 FROM _cs_held WHERE tbl = ? AND pk = ?", [w.tbl, w.pk]) != null) continue;
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
  private write(table: string, keys: Keys, k: unknown[], values: Record<string, unknown>, vers: Record<string, string>): void {
    const data = Object.keys(values).filter((c) => !keys.pk.includes(c));
    const cols = [...keys.pk, ...data];
    const vals = [...k, ...data.map((c) => values[c] ?? null)].map(bound);
    const respell = this.respells(table);
    const update = [...(respell ? keys.pk : []), ...data].map((c) => `${q(c)} = excluded.${q(c)}`).join(", ");
    this.rows.run(
      `INSERT INTO main.${q(table)} (${cols.map(q).join(", ")}) VALUES (${vals.map((v) => v.at).join(", ")}) ON CONFLICT (${keys.pk.map(q).join(", ")}) DO ${update ? `UPDATE SET ${update}` : "NOTHING"}`,
      vals.map((v) => v.value),
    );
    this.shownAs(table, this.identity(table, k), vers);
  }

  /**
   * The version each value a row shows came from, as projection wrote it, or
   * a save (R-X): what an edit is based on and what an observation shows.
   * Null: the row shows nothing.
   */
  private shownAs(table: string, pk: string, vers: Record<string, string> | null): void {
    this.runCached("DELETE FROM _cs_shown WHERE tbl = ? AND pk = ?", [table, pk]);
    for (const [c, v] of Object.entries(vers ?? {})) this.runCached("INSERT INTO _cs_shown (tbl, pk, col, ver) VALUES (?, ?, ?, ?)", [table, pk, c, v]);
  }

  /** The version a shown value came from: as recorded, else (a row projected before `_cs_shown`) its column's later head. */
  private shownVersion(table: string, pk: string, col: string): string | null {
    const v = this.engine.value("SELECT ver FROM _cs_shown WHERE tbl = ? AND pk = ? AND col = ?", [table, pk, col]);
    if (v != null) return String(v);
    return (this.stateOf(table, pk)?.shownBy[col]?.ver as string | undefined) ?? null;
  }

  /**
   * The key a row is written with: its key columns' shown values, the last
   * writer's by (lc, author), where its log carries them (1e-H3); else, for a
   * log from before, the spelling its earliest-born version wrote, else its
   * identity's own.
   */
  private spellingOf(table: string, pk: string, values: Record<string, unknown> = {}): unknown[] {
    const keys = this.keysOf(table)?.pk ?? [];
    if (keys.length && keys.every((c) => c in values)) return keys.map((c) => values[c]);
    const born = this.birthOf(table, pk);
    const spelled = born ? this.engine.value("SELECT k FROM main._cs_spell WHERE tbl = ? AND pk = ? AND ver = ?", [table, pk, born.ver]) : null;
    return keyValues(typeof spelled === "string" ? spelled : pk);
  }

  private place(table: string, pk: string, force = false): void {
    const state = this.stateOf(table, pk);
    if (!state) return;
    // A table this copy does not have holds the rows, flagged, until a release makes it here (S05, R-W).
    if (this.engine.value("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ? COLLATE NOCASE", [table]) == null) {
      if (state.deleted) return;
      this.hold(table, pk, `no such table: ${table}`, state.values);
      return;
    }
    const keys = this.keysOf(table);
    if (!keys) return;
    const k = this.spellingOf(table, pk, state.values);
    const at = keyValues(pk).map(compared);
    if (state.deleted && !force) {
      this.rows.run(`DELETE FROM main.${q(table)} WHERE ${this.whereKey(table)}`, at);
      this.shownAs(table, pk, null);
      return;
    }
    if (state.contested) this.flag(table, pk, "delete-conflict", null);
    if (state.pending.length) this.flag(table, pk, "pending", state.pending);
    try {
      this.write(table, keys, k, state.values, versOf(state));
    } catch (e) {
      const message = String((e as Error).message);
      if (/UNIQUE/.test(message)) {
        const found = this.occupantOf(table, pk, state.values);
        const occupant = found?.pk;
        /*
         * The row in the slot moves out of it in this same apply (M04): its
         * merged values no longer hold the slot's value, as two rows that
         * swapped a UNIQUE value each find the other's old value. It is taken
         * out, this row is written, and it is placed again under its own merged
         * values, which now fit.
         */
        const theirs = found && this.roomDepth < 8 ? this.stateOf(table, found.pk) : null;
        const rowOf = (key: string, v: Record<string, unknown>): Record<string, unknown> => ({
          ...Object.fromEntries(keys.pk.map((c, i) => [c, keyValues(key)[i]])),
          ...v,
        });
        if (found && theirs && (theirs.deleted || !this.collides(table, found.index, rowOf(pk, state.values), rowOf(found.pk, theirs.values)))) {
          this.roomDepth += 1;
          try {
            this.rows.run(`DELETE FROM main.${q(table)} WHERE ${this.whereKey(table)}`, keyValues(found.pk).map(compared));
            let wrote = true;
            try {
              this.write(table, keys, k, state.values, versOf(state));
            } catch {
              wrote = false;
            }
            this.place(table, found.pk);
            if (wrote) return;
          } finally {
            this.roomDepth -= 1;
          }
        }
        if (occupant) {
          const mine = this.birthOf(table, pk);
          const theirs = this.birthOf(table, occupant);
          const earlier = (x: Any, y: Any): boolean => (x && y ? x.lc < y.lc || (x.lc === y.lc && x.author < y.author) : !!x);
          if (earlier(mine, theirs)) {
            this.hold(table, occupant, `UNIQUE: ${pk} holds the slot`, this.stateOf(table, occupant)?.values ?? {});
            this.rows.run(`DELETE FROM main.${q(table)} WHERE ${this.whereKey(table)}`, keyValues(occupant).map(compared));
            this.write(table, keys, k, state.values, versOf(state));
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
    this.shownAs(table, pk, null);
  }

  /** The other row holding a UNIQUE slot this row's values want. */
  /**
   * The other row holding a UNIQUE slot this row's values want (M03), for an
   * index on columns, on expressions, or with a WHERE: each of the index's
   * terms, and its WHERE, evaluated by SQLite over this row's values (a
   * one-row `mine`) and over each row of the table. `cols` are the columns
   * the terms read.
   */
  /** Whether two rows' values take one slot of a UNIQUE index: its terms, and its WHERE, as SQLite evaluates them. */
  private collides(table: string, index: { terms: string[]; where: string | null }, x: Record<string, unknown>, y: Record<string, unknown>): boolean {
    const all = (this.engine.values("SELECT name FROM pragma_table_info(?, 'main') ORDER BY cid", [table]) as string[]).filter((c) => c in x && c in y);
    const bx = all.map((c) => bound(x[c]));
    const by = all.map((c) => bound(y[c]));
    const same = index.terms.map((t) => `((SELECT ${t} FROM x) IS (SELECT ${t} FROM y))`);
    if (index.where) same.push(`(SELECT ${index.where} FROM x)`, `(SELECT ${index.where} FROM y)`);
    return (
      Number(
        this.engine.value(
          `WITH x(${all.map(q).join(", ")}) AS (VALUES (${bx.map((v) => v.at).join(", ")})), ` +
            `y(${all.map(q).join(", ")}) AS (VALUES (${by.map((v) => v.at).join(", ")})) SELECT ${same.join(" AND ")}`,
          [...bx, ...by].map((v) => v.value),
        ),
      ) === 1
    );
  }

  private occupantOf(table: string, pk: string, values: Record<string, unknown>): { pk: string; index: { terms: string[]; where: string | null } } | null {
    const keys = this.keysOf(table)!;
    const all = this.engine.values("SELECT name FROM pragma_table_info(?, 'main') ORDER BY cid", [table]) as string[];
    const row = { ...Object.fromEntries(keys.pk.map((c, i) => [c, keyValues(pk)[i]])), ...values };
    const mine = all.filter((c) => c in row);
    const bound_ = mine.map((c) => bound(row[c]));
    for (const idx of this.engine.all("SELECT name FROM pragma_index_list(?, 'main') WHERE \"unique\" = 1 AND origin <> 'pk'", [table]) as Any[]) {
      const index = uniqueIndex(
        this.engine.value("SELECT sql FROM main.sqlite_schema WHERE type = 'index' AND name = ?", [idx.name]) as string | null,
        (this.engine.values("SELECT name FROM pragma_index_info(?, 'main') ORDER BY seqno", [idx.name]) as (string | null)[]).map((c) => (c == null ? null : q(c))),
      );
      if (!index) continue;
      const cols = all.filter((c) => index.terms.some((t) => mentions(t, c)));
      if (cols.some((c) => !(c in row))) continue;
      const where = index.where ? ` AND (${index.where}) AND (SELECT ${index.where} FROM mine)` : "";
      const hit = this.engine.object(
        `WITH mine(${mine.map(q).join(", ")}) AS (VALUES (${bound_.map((v) => v.at).join(", ")})) ` +
          `SELECT ${keys.pk.map((c) => `${q(c)}, typeof(${q(c)}) AS ${q(`_cs_t_${c}`)}`).join(", ")} FROM main.${q(table)} ` +
          `WHERE ${index.terms.map((t) => `(${t}) IS (SELECT ${t} FROM mine)`).join(" AND ")}${where}`,
        bound_.map((v) => v.value),
      ) as Any;
      if (hit) {
        const other = this.identity(table, keys.pk.map((c) => typed(hit[`_cs_t_${c}`], hit[c])));
        if (other !== pk) return { pk: other, index };
      }
    }
    return null;
  }

  /** A row a live row still points at stays, flagged, until nothing refers to it (to a fixpoint). */
  private keepReferenced(): void {
    for (let round = 0; round < 16; round++) {
      const orphans = this.engine.all("SELECT * FROM pragma_foreign_key_check") as Any[];
      let revived = 0;
      for (const o of orphans) {
        const fk = this.engine.all(`SELECT "from", "to", "table" FROM pragma_foreign_key_list(?, 'main') WHERE id = ? ORDER BY seq`, [o.table, o.fkid]) as Any[];
        if (!fk.length || o.rowid == null) continue;
        const child = this.engine.object(
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
        if (this.engine.value("SELECT 1 FROM _cs_flag WHERE tbl = ? AND pk = ? AND kind = 'kept-referenced'", [o.parent, pk]) != null) continue;
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
    return this.engine.all("SELECT tbl, pk, kind, detail FROM _cs_flag ORDER BY tbl, pk, kind") as Any[];
  }

  held(): { tbl: string; pk: string; reason: string; row: string }[] {
    return this.engine.all("SELECT tbl, pk, reason, row FROM _cs_held ORDER BY tbl, pk") as Any[];
  }

  /* ------------------------------------------------------------ resolution */

  /**
   * One unit's conflict, observed (R-X §4): the value it shows, where that
   * value came from, and the alternatives presented, under an opaque token
   * the resolution names. A unit is one column, or a coupled group's every
   * column (§5); `[]` is the row's existence, contested by a delete. Null
   * when the unit has nothing to resolve. The token is never expanded: an
   * alternative that arrives after it stays unresolved.
   */
  observe(table: string, key: unknown[], unit: string[]): { token: string; unit: string[]; shown: string | null; alternatives: { ver: string; values: Record<string, unknown> }[] } | null {
    return this.trusted(() => {
      const keys = this.keysOf(table);
      if (!keys) throw new Error(`CHANGES_REFUSED: ${RESOLVE_REFUSED.unit}`);
      const pk = this.identity(table, key);
      const cols = this.unitOf(table, keys, unit);
      const state = this.stateOf(table, pk);
      if (!state || state.deleted) return null;
      let o: Observation;
      if (cols[0] === "") {
        if (!state.contested) return null;
        // The delete versions, and the versions that kept the row: data its deletes never saw.
        const exists = this.cellHeads(table, pk, [""]);
        const dels = exists.filter((h) => Number(h.val) === 0).map((h) => String(h.ver));
        const saw = new Set(
          this.engine.values(`SELECT ver FROM _cs_seen WHERE tbl = ? AND pk = ? AND del IN (${dels.map(() => "?").join(",")})`, [table, pk, ...dels]) as string[],
        );
        const kept = [...new Set(this.cellHeads(table, pk, null).map((h) => String(h.ver)).filter((v) => !saw.has(v)))].sort();
        o = {
          table,
          pk,
          unit: [""],
          basis: exists.filter((h) => Number(h.val) === 1).map((h) => String(h.ver)).sort(),
          alternatives: [...dels.sort().map((ver) => ({ ver, values: { "": 0 } })), ...kept.map((ver) => ({ ver, values: { "": 1 } }))],
        };
      } else {
        const heads = this.cellHeads(table, pk, cols);
        const vers = [...new Set(heads.map((h) => String(h.ver)))].sort();
        if (vers.length < 2) return null;
        const alternatives = vers.map((ver) => ({
          ver,
          values: Object.fromEntries(cols.map((c) => {
            const cell = this.engine.object("SELECT val, typeof(val) AS t FROM _cs_cell WHERE tbl = ? AND pk = ? AND col = ? AND ver = ?", [table, pk, c, ver]) as Any;
            return [c, cell ? typed(cell.t, cell.val) : state.values[c] ?? null];
          })),
        }));
        const basis = this.shownVersion(table, pk, cols[0]!);
        o = { table, pk, unit: cols, basis: basis ? [basis] : [], alternatives };
      }
      const token = crypto.randomUUID();
      this.observations.set(token, o);
      return {
        token,
        unit: unit.slice(),
        shown: o.basis[0] ?? null,
        alternatives: o.alternatives.map((a) => ({ ver: a.ver, values: Object.fromEntries(Object.entries(a.values).map(([c, v]) => [c, shown(v)])) })),
      };
    });
  }

  /**
   * Keeps or chooses one of an observation's alternatives (R-X §4): a signed
   * resolution, logged as it is made, though no byte changes. It binds the
   * observed basis and resolves exactly the alternatives presented. Choosing
   * a delete of a contested row deletes it; anything else writes the chosen
   * value, whole (a coupled group's every column). The application's own
   * changes are saved first, as their own batch.
   */
  resolve(token: string, choice: string): SavedChanges {
    const o = this.observations.get(token);
    if (!o) throw new Error(`CHANGES_REFUSED: ${RESOLVE_REFUSED.token}`);
    const chosen = o.alternatives.find((a) => a.ver === choice);
    if (!chosen) throw new Error(`CHANGES_REFUSED: ${RESOLVE_REFUSED.choice}`);
    if (this.refusal) throw new Error(`CHANGES_SAVE_REFUSED: ${this.refusal}`);
    if (this.inTransaction) throw new Error(`CHANGES_REFUSED: ${RESOLVE_REFUSED.transaction}`);
    this.save();
    const saved = this.trusted(() => this.resolving(o, chosen.values));
    this.observations.delete(token);
    return saved;
  }

  private resolving(o: Observation, values: Record<string, unknown>): SavedChanges {
    const k = this.spellingOf(o.table, o.pk, this.stateOf(o.table, o.pk)?.values ?? {});
    const deleting = values[""] === 0;
    const n = new Map<string, unknown>(Object.entries(values));
    const bases = new Map<string, string[]>(o.unit.map((c) => [c, o.basis.slice()]));
    const resolves = new Map<string, string[]>(o.unit.map((c) => [c, o.alternatives.filter((a) => c !== "" || a.values[""] === 0).map((a) => a.ver)]));
    // A delete chosen sees what the presented deletes saw and the versions that kept the row, and no other.
    const dels = o.alternatives.filter((a) => a.values[""] === 0).map((a) => a.ver);
    const seen = deleting
      ? [
          ...new Set([
            ...(this.engine.values(`SELECT ver FROM _cs_seen WHERE tbl = ? AND pk = ? AND del IN (${dels.map(() => "?").join(",")})`, [o.table, o.pk, ...dels]) as string[]),
            ...o.alternatives.filter((a) => a.values[""] === 1).map((a) => a.ver),
          ]),
        ].sort()
      : [];
    const op: Op = [o.table, k, deleting ? "D" : "U", n, new Map(), bases, seen, resolves];
    const payload = cborEncode([1, [op] as unknown as CborValue[], this.received() as unknown as CborValue] as CborValue);
    const fk = Number(this.engine.value("PRAGMA foreign_keys")) === 1;
    if (fk) this.exec("PRAGMA foreign_keys = OFF");
    try {
      this.exec("SAVEPOINT cs_resolve");
      try {
        const row = createEntity(this.rows, CHANGES_LOG, crypto.getRandomValues(new Uint8Array(16)), { payload });
        const ver = `${this.authorHex}:${row._r_seq}`;
        const touched = this.ingest([op], ver, Number(row._r_lc), this.authorHex);
        this.withoutCapture(() => this.project(touched));
        this.exec("RELEASE cs_resolve");
        return { ver, ops: 1, bytes: payload.length };
      } catch (e) {
        this.exec("ROLLBACK TO cs_resolve");
        this.exec("RELEASE cs_resolve");
        throw e;
      }
    } finally {
      if (fk) this.exec("PRAGMA foreign_keys = ON");
    }
  }

  /** A unit's columns, whole (R-X §5): one column, or every column of its coupled group; `[]`, the row's existence. */
  private unitOf(table: string, keys: Keys, unit: string[]): string[] {
    if (unit.length === 0) return [""];
    const columns = new Set(this.engine.values("SELECT name FROM pragma_table_info(?, 'main')", [table]) as string[]);
    const cols = [...new Set(unit)];
    const group = this.declaredOf(table).coupled.find((g) => g.includes(cols[0]!));
    const whole = group ? cols.length === group.length && group.every((c) => cols.includes(c)) : cols.length === 1;
    // A key column is a unit only where its spelling is a value (1e-H3).
    const keyed = cols.some((c) => keys.pk.includes(c)) && !this.respells(table);
    if (!whole || keyed || cols.some((c) => !columns.has(c))) throw new Error(`CHANGES_REFUSED: ${RESOLVE_REFUSED.unit}`);
    return group ? group.slice() : cols;
  }

  /** The current versions of a row's cells, for the columns named (null: every data column). */
  private cellHeads(table: string, pk: string, cols: string[] | null): { col: string; ver: string; val: unknown }[] {
    const all = this.engine.all(
      "SELECT col, ver, val FROM _cs_cell c WHERE tbl = ? AND pk = ? AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = c.tbl AND s.pk = c.pk AND s.col = c.col AND s.ver = c.ver) ORDER BY col, ver",
      [table, pk],
    ) as Any[];
    return all.filter((h) => (cols ? cols.includes(h.col) : h.col !== ""));
  }

  close(): void {
    this.engine.close();
    // A statement the application prepared is the mount's, and goes with it (R-W): none steps under another.
    for (const s of [...this.appStatements]) {
      try {
        s.finalize();
      } catch {
        /* Finalized with its database. */
      }
    }
    this.appStatements.clear();
    this.capture.close();
    if (this.unauthorize) this.unauthorize();
    this.unauthorize = null;
    this.authorizer = null;
    trustByDb.delete(this.dbPtr);
  }
}

/**
 * The SQL text the application handed exec or prepare: a string, or `{sql}`
 * holding one. Null for every other form sqlite-wasm would take (an array,
 * bytes in any typed array, an ArrayBuffer), which the handle refuses before
 * anything runs (1f-M1): SQL the runtime cannot read is SQL it cannot hold to
 * R-W.
 */
function textOf(sql: unknown): string | null {
  if (typeof sql === "string") return sql;
  if (sql && typeof sql === "object" && !Array.isArray(sql) && !ArrayBuffer.isView(sql) && !(sql instanceof ArrayBuffer) && "sql" in sql) {
    const text = (sql as { sql: unknown }).sql;
    return typeof text === "string" ? text : null;
  }
  return null;
}

/** One statement of the application's SQL, and the allowance it earns alone (1g-M2, 1g-M3). */
interface Piece {
  sql: string;
  /** A bare VACUUM, which attaches and detaches a database of its own as it runs. */
  vacuum: boolean;
  /** An admitted CREATE ... IF NOT EXISTS: the name, folded, and the type it may make. */
  admit: [string, string] | null;
}

/** Whether SQL takes a bound value: a ?, ?NNN, :name, @name or $name outside its strings and comments. */
const parameterized = (sql: string): boolean =>
  sqlTokens(sql).some((t, i, all) => t === "?" || ((t === ":" || t === "@") && /^[\p{L}\p{N}_]/u.test(all[i + 1] ?? "")) || /^\$[\p{L}\p{N}_]/u.test(t));

/** A script cut into its statements where SQLite itself would end each one (sqlite3_complete), trigger bodies whole. */
function splitStatements(sqlite3: Any, text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = text.indexOf(";"); i >= 0; i = text.indexOf(";", i + 1)) {
    const piece = text.slice(start, i + 1);
    if (nativeOf(sqlite3).complete(piece)) {
      out.push(piece);
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out;
}

/**
 * A statement's tokens as SQLite reads them, for comparing two definitions
 * (R-W): comments and whitespace gone; a name, bare or quoted ("", ``, []),
 * and a keyword, with ASCII letters folded as SQLite folds them; a string
 * literal exactly as written; anything else one character at a time.
 */
function sqlTokens(sql: string): string[] {
  const out: string[] = [];
  const fold = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const word = /[\p{L}\p{N}_$]+/uy;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) i += 1;
    else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      let text = "";
      for (;;) {
        const end = sql.indexOf(close, j);
        if (end < 0) {
          text += sql.slice(j);
          j = sql.length;
          break;
        }
        text += sql.slice(j, end);
        j = end + 1;
        if (close !== "]" && sql[j] === close) {
          text += close;
          j += 1;
          continue;
        }
        break;
      }
      out.push(ch === "'" ? `'${text.split("'").join("''")}'` : fold(text));
      i = j;
    } else {
      word.lastIndex = i;
      const m = word.exec(sql);
      out.push(m ? fold(m[0]) : ch);
      i += m ? m[0].length : 1;
    }
  }
  while (out[out.length - 1] === ";") out.pop();
  return out;
}

/**
 * A schema statement, read (R-W). Undefined: not one. Null: one never
 * admitted (ALTER, DROP, TEMP, VIRTUAL, under EXPLAIN, without IF NOT EXISTS,
 * in another schema). Otherwise a CREATE TABLE, INDEX, TRIGGER or VIEW ... IF
 * NOT EXISTS: its type, its name folded, and its canonical text, the tokens
 * without IF NOT EXISTS and a `main.` qualifier. `declared` reads a
 * release's own statement, which may leave IF NOT EXISTS out.
 */
function createOf(statement: string, declared = false): { type: string; name: string; canonical: string } | null | undefined {
  const t = sqlTokens(statement);
  const at = t[0] === "explain" ? (t[1] === "query" && t[2] === "plan" ? 3 : 1) : 0;
  if (!["create", "alter", "drop"].includes(t[at] ?? "")) return undefined;
  if (at > 0 || t[0] !== "create") return null;
  let i = 1;
  if (t[i] === "unique") i += 1;
  const type = t[i] ?? "";
  if (!["table", "index", "trigger", "view"].includes(type)) return null;
  const guarded = t[i + 1] === "if" && t[i + 2] === "not" && t[i + 3] === "exists";
  if (!guarded && !declared) return null;
  let n = guarded ? i + 4 : i + 1;
  if (t[n + 1] === ".") {
    if (t[n] !== "main") return null;
    n += 2;
  }
  const name = t[n];
  if (!name) return null;
  return { type, name: folded(name), canonical: [...t.slice(0, i + 1), ...t.slice(n)].join(" ") };
}

/** The release's declared objects, `type|name` to canonical text, from its schema as the compiler declares it (R-W). */
function declarationsOf(sqlite3: Any, schema: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const statement of splitStatements(sqlite3, schema)) {
    const c = createOf(statement, true);
    if (c) out.set(`${c.type}|${c.name}`, c.canonical);
  }
  return out;
}

/** Whether an index term reads a column: its name as a whole identifier, bare or quoted, in any case. */
function mentions(term: string, col: string): boolean {
  const name = col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w"])"?${name}"?($|[^\\w"])`, "i").test(term);
}

/**
 * A UNIQUE index's terms and WHERE (M03): from its CREATE INDEX text, each
 * term as written with its COLLATE and without ASC or DESC; for one a UNIQUE
 * constraint made (no text), its columns. Null when it cannot be read.
 */
function uniqueIndex(sql: string | null, columns: (string | null)[]): { terms: string[]; where: string | null } | null {
  if (!sql) return columns.every((c) => c !== null) ? { terms: columns as string[], where: null } : null;
  const on = sql.search(/\bON\b/i);
  const open = on < 0 ? -1 : sql.indexOf("(", on);
  if (open < 0) return null;
  const terms: string[] = [];
  let depth = 0;
  let quote = "";
  let start = open + 1;
  let close = -1;
  for (let i = open + 1; i < sql.length && close < 0; i++) {
    const ch = sql[i]!;
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "[") quote = "]";
    else if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    else if ((ch === "," || ch === ")") && depth === 0) {
      terms.push(sql.slice(start, i).trim().replace(/\s+(ASC|DESC)$/i, ""));
      start = i + 1;
      if (ch === ")") close = i;
    }
  }
  if (close < 0) return null;
  const rest = sql.slice(close + 1).trim();
  const where = /^WHERE\b/i.test(rest) ? rest.replace(/^WHERE\b/i, "").trim() : null;
  return { terms, where };
}

/** A statement's text with its whitespace runs made one space: how a stored trigger is compared with the runtime's. */
const spaced = (sql: string): string => sql.replace(/\s+/g, " ").trim();


/**
 * The triggers the runtime itself puts on its tables, by name, as SQLite
 * stores them: made once, in a scratch database, from the declaration every
 * document with no session policy carries (`rewriteReplicated`, as the
 * compiler emits it).
 */
function runtimeTriggers(sqlite3: Any): Map<string, string> {
  return runtimeObjects(sqlite3).triggers;
}

let ownObjects: { triggers: Map<string, string>; views: Map<string, string> } | null = null;

/** The runtime's own triggers and views, by name, as SQLite stores them (T11, D264). */
function runtimeObjects(sqlite3: Any): { triggers: Map<string, string>; views: Map<string, string> } {
  if (ownObjects) return ownObjects;
  const scratch = new sqlite3.oo1.DB(":memory:", "c");
  try {
    scratch.exec(rewriteReplicated(CHANGES_DECLARATION).sql);
    const of = (type: string): Map<string, string> =>
      new Map(
        (scratch.selectObjects("SELECT name, sql FROM sqlite_schema WHERE type = ? AND sql IS NOT NULL", [type]) as Any[]).map((r) => [String(r.name), String(r.sql)]),
      );
    ownObjects = { triggers: of("trigger"), views: of("view") };
  } finally {
    scratch.close();
  }
  return ownObjects;
}

/** The version each column a row's state shows came from (`_cs_shown`). */
const versOf = (state: { shownBy: Record<string, Any> }): Record<string, string> =>
  Object.fromEntries(Object.entries(state.shownBy).map(([c, h]) => [c, String(h.ver)]));

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
    // Columns by name: two copies whose tables hold the same values in another column order agree (S03).
    const cols = rows.all("SELECT name FROM pragma_table_xinfo(?, 'main') WHERE hidden <> 1 ORDER BY name", [table]).map((r) => String(r["name"]));
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
