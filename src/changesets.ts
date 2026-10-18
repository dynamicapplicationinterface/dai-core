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
 *      table with no primary key is keyed by an author-ranged rowid.
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
 *   - different rows merge; different columns of one row merge;
 *   - one column with two concurrent versions keeps both, shows the later by
 *     (lc, author), and flags the row `pending`;
 *   - a delete with a concurrent change keeps the row and flags it
 *     `delete-conflict`; a deleted row a live row still references through a
 *     declared foreign key is kept too, flagged `kept-referenced`;
 *   - a row a constraint will not admit (UNIQUE, CHECK, NOT NULL) is held,
 *     flagged `held`; for UNIQUE the earlier-born row keeps the slot.
 * A save over a flagged row supersedes every version it saw, so editing is
 * resolving: a new signed change that acknowledges both parents (R-F). The
 * flags are rows of `_cs_flag`, which the host reads from the stored document.
 *
 * Runtime rules that come with it: the application's own triggers stand down
 * while merged rows are applied (`dai_projecting()`), and `PRAGMA foreign_keys`
 * is on from open.
 */
import { decode as cborDecode, encode as cborEncode, type CborValue } from "./cbor.js";
import { createEntity, type Rows } from "./replicated-rows.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

import { CHANGES_DECLARATION, CHANGES_LOG } from "./changes-log.js";
export { CHANGES_DECLARATION, CHANGES_LOG };

/** Author-ranged integer keys: the author index in bits 32..52, a counter in bits 0..31. 2^53-1 is the largest id, exact in JavaScript. */
export const COUNTER_BITS = 32;
export const INDEX_BITS = 21;
const SPAN = 2 ** COUNTER_BITS;
const INDEX_MASK = 2 ** INDEX_BITS - 1;

/** The runtime's own tables, never captured and never adopted. */
const INTERNAL = /^(_dai|_cs_|sqlite_)/;

const META = `
CREATE TABLE IF NOT EXISTS _cs_cell (tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL, ver TEXT NOT NULL, val, lc INTEGER NOT NULL, author TEXT NOT NULL, PRIMARY KEY (tbl, pk, col, ver)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_sup (tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL, ver TEXT NOT NULL, PRIMARY KEY (tbl, pk, col, ver)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_seen (tbl TEXT NOT NULL, pk TEXT NOT NULL, del TEXT NOT NULL, ver TEXT NOT NULL, PRIMARY KEY (tbl, pk, del, ver)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_ingested (ver TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_flag (tbl TEXT NOT NULL, pk TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, PRIMARY KEY (tbl, pk, kind)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_held (tbl TEXT NOT NULL, pk TEXT NOT NULL, reason TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (tbl, pk)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _cs_keys (tbl TEXT PRIMARY KEY, kind TEXT NOT NULL, pk TEXT NOT NULL) WITHOUT ROWID;
`;

/** The flags a row can carry, as `_cs_flag.kind` holds them. */
export type FlagKind = "pending" | "delete-conflict" | "kept-referenced" | "held" | "orphan";

/** A key kind: ranged integer, uuid text, the app's own (natural), or a hidden ranged rowid. */
type KeyKind = "ranged" | "uuid" | "natural" | "rowid";
interface Keys {
  kind: KeyKind;
  pk: string[];
}

/** A captured row change, as it travels: [table, key values, op, new, old, bases, seen]. */
type Op = [string, unknown[], "I" | "U" | "D", Map<string, unknown>, Map<string, unknown>, Map<string, string[]>, string[]];

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const q = (name: string): string => `"${String(name).split('"').join('""')}"`;
const plain = (v: unknown): unknown =>
  typeof v === "bigint" && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v;
const shown = (v: unknown): unknown => (v instanceof Uint8Array ? `<${v.length} bytes>` : plain(v));

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
    .filter((n) => !INTERNAL.test(n));
}

/* --------------------------------------------------------------- key DDL */

/**
 * The application's CREATE TABLE with its key rewritten. A rowid alias cannot
 * take a DEFAULT (SQLite ignores it), so the key becomes a non-alias INT key
 * whose NOT NULL ... ON CONFLICT REPLACE takes the default for an omitted id
 * and an explicit NULL alike. AUTOINCREMENT goes: it is legal only on an
 * alias, and a per-author counter never reuses an id anyway.
 */
export function rewriteKeySql(sql: string, table: string, column: string, kind: "ranged" | "uuid"): string {
  const name = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const col = `(?:"${name}"|\`${name}\`|\\[${name}\\]|${name})`;
  if (kind === "ranged") {
    const fn = `DEFAULT (dai_id(${sqlText(table)}))`;
    const inline = new RegExp(`(${col}\\s+)INTEGER(\\s+PRIMARY\\s+KEY(?:\\s+(?:ASC|DESC))?)(\\s+AUTOINCREMENT)?`, "i");
    if (inline.test(sql)) return sql.replace(inline, `$1INT NOT NULL ON CONFLICT REPLACE ${fn}$2`);
    // A table-level PRIMARY KEY (id) over `id INTEGER`.
    const typed = new RegExp(`([(,]\\s*${col}\\s+)INTEGER\\b`, "i");
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
 * `take` hands back the changes since the last take, decoded, and starts over.
 */
class SessionCapture {
  private session = 0;
  private filter = 0;
  private readonly columns = new Map<string, string[]>();
  private readonly rowidTables = new Set<string>();

  constructor(
    private readonly sqlite3: Any,
    private readonly db: Any,
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
      // Tables with no primary key, keyed by their (ranged) rowid.
      const flag = wasm.pstack.alloc(4);
      wasm.poke32(flag, 1);
      capi.sqlite3session_object_config(this.session, capi.SQLITE_SESSION_OBJCONFIG_ROWID, flag);
    } finally {
      wasm.pstack.restore(stack);
    }
    this.filter ||= wasm.installFunction("ipp", (_ctx: number, zTab: number) => (INTERNAL.test(wasm.cstrToJs(zTab)) ? 0 : 1));
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

  take(): { table: string; op: "INSERT" | "UPDATE" | "DELETE"; pk: Record<string, unknown>; old: Record<string, unknown>; new: Record<string, unknown> }[] {
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
    capi.sqlite3session_delete(this.session);
    this.open();
    return bytes.length ? this.decode(bytes) : [];
  }

  private decode(bytes: Uint8Array): ReturnType<SessionCapture["take"]> {
    const { capi, wasm } = this.sqlite3;
    const ops: ReturnType<SessionCapture["take"]> = [];
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
            const v = capi.sqlite3changeset_old_js(it, i);
            if (v !== undefined) (isPk ? entry.pk : entry.old)[name] = plain(v);
          }
          if (op !== "DELETE") {
            const v = capi.sqlite3changeset_new_js(it, i);
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

  /** The changeset's column names: a table keyed by rowid carries it first. */
  private namesOf(table: string, n: number): string[] {
    if (!this.columns.has(table)) {
      const cols = (this.db.selectObjects(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [table]) as Any[]).map((c) => String(c.name));
      this.columns.set(table, cols);
    }
    const cols = this.columns.get(table)!;
    return n === cols.length + 1 ? ["rowid", ...cols] : cols;
  }

  schemaChanged(): void {
    this.columns.clear();
    this.rowidTables.clear();
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
  db.createFunction("dai_last_id", () => null, { arity: 0, deterministic: false });
  db.createFunction("dai_projecting", () => 0, { arity: 0, deterministic: false });
  db.createFunction("dai_inserted", () => null, { arity: 2, deterministic: false });
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
  private lastInsert: { rowid: number | null; id: unknown } = { rowid: null, id: null };
  private lastId: number | null = null;
  private readonly keysCache = new Map<string, Keys | null>();
  private readonly stmts = new Map<string, Any>();
  private readonly capture: SessionCapture;
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
    db.createFunction("dai_last_id", () => this.lastId, { arity: 0, deterministic: false });
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
    // The key is no longer the rowid, so last_insert_rowid() answers the application's id for the row it last inserted.
    db.createFunction(
      "last_insert_rowid",
      () => {
        const real = Number(capi.sqlite3_last_insert_rowid(db.pointer));
        return this.lastInsert.rowid === real ? this.lastInsert.id : real;
      },
      { arity: 0, deterministic: false },
    );
    this.exec(META);
    // Foreign keys are enforced from open: the runtime never set it before, so a declared REFERENCES was decoration.
    if (capi.sqlite3_get_autocommit(db.pointer)) this.exec("PRAGMA foreign_keys = ON");
    this.capture = new SessionCapture(sqlite3, db);
    this.adoptTables();
    this.counter = this.highestOwnCounter();
  }

  /** The application's handle, watched for schema changes: a table it creates is adopted before its first row. */
  watch(handle: Any): void {
    const exec = handle.exec.bind(handle);
    handle.exec = (...args: Any[]): Any => {
      const before = handle.selectValue("PRAGMA schema_version");
      const result = exec(...args);
      if (handle.selectValue("PRAGMA schema_version") !== before) this.adoptTables();
      return result;
    };
  }

  /* ------------------------------------------------------------ keys */

  private highestOwnCounter(): number {
    const base = this.index * SPAN;
    let high = 0;
    for (const { tbl, kind, pk } of this.db.selectObjects("SELECT tbl, kind, pk FROM _cs_keys WHERE kind IN ('ranged', 'rowid')") as Any[]) {
      const col = kind === "rowid" ? "rowid" : q(pk);
      const m = this.db.selectValue(`SELECT max(${col}) FROM ${q(tbl)} WHERE ${col} >= ? AND ${col} < ?`, [base, base + SPAN]);
      if (m != null) high = Math.max(high, Number(m) - base);
    }
    // Rows this author wrote and then deleted still hold their ids in the cells.
    const cells = this.db.selectValues(
      "SELECT DISTINCT c.pk FROM _cs_cell c JOIN _cs_keys k ON k.tbl = c.tbl AND k.kind IN ('ranged', 'rowid') WHERE c.author = ?",
      [this.authorHex],
    ) as string[];
    for (const text of cells) {
      const id = JSON.parse(text)[0];
      if (typeof id === "number" && id >= base && id < base + SPAN) high = Math.max(high, id - base);
    }
    return high;
  }

  private nextId(): number {
    this.counter += 1;
    if (this.counter >= SPAN) throw new Error("ID_RANGE_EXHAUSTED");
    this.lastId = this.index * SPAN + this.counter;
    return this.lastId;
  }

  /** Each application table, once: its key kind recorded and, for an integer, text or absent key, rewritten. */
  adoptTables(): void {
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
      let kind: KeyKind = "natural";
      const dflt = String(pks[0]?.dflt_value ?? "");
      if (pks.length === 0) kind = "rowid";
      else if (pks.length === 1 && /dai_id\(/.test(dflt)) kind = "ranged";
      else if (pks.length === 1 && /dai_uuid\(/.test(dflt)) kind = "uuid";
      else if (pks.length === 1 && String(pks[0].type).toUpperCase() === "INTEGER" && !withoutRowid) kind = "ranged";
      else if (pks.length === 1 && /TEXT|CHAR|CLOB/i.test(String(pks[0].type)) && !pks[0].dflt_value) kind = "uuid";
      if ((kind === "ranged" || kind === "uuid") && !/dai_(id|uuid)\(/.test(dflt)) {
        if (!this.rebuild(table, pks[0].name, kind)) kind = "natural";
      }
      if (kind === "ranged") {
        this.exec(
          `CREATE TRIGGER IF NOT EXISTS ${q(`_cs_id_${table}`)} AFTER INSERT ON ${q(table)} BEGIN SELECT dai_inserted(NEW.rowid, NEW.${q(pks[0].name)}); END`,
        );
      }
      if (kind === "rowid") {
        // No key of its own: its rowid is the key, drawn from this author's range on every local insert.
        this.exec(
          `CREATE TRIGGER IF NOT EXISTS ${q(`_cs_rowid_${table}`)} AFTER INSERT ON ${q(table)} WHEN dai_projecting() = 0 BEGIN ` +
            `UPDATE ${q(table)} SET rowid = dai_id(${sqlText(table)}) WHERE rowid = NEW.rowid; SELECT dai_inserted(NEW.rowid, dai_last_id()); END`,
        );
      }
      this.exec({
        sql: "INSERT OR REPLACE INTO _cs_keys (tbl, kind, pk) VALUES (?, ?, ?)",
        bind: [table, kind, kind === "rowid" ? "rowid" : pks.map((c) => c.name).join(",")],
      });
    }
    this.guardTriggers();
    this.keysCache.clear();
    this.capture?.schemaChanged();
  }

  /**
   * The application's triggers, made to stand down while the runtime applies
   * merged rows. What a trigger did on the copy that wrote is already in that
   * copy's changeset (the session records rows a trigger writes), so firing it
   * again on the receiving copy writes rows nobody captured: a divergence
   * (the spike's S8).
   */
  private guardTriggers(): void {
    const apps = new Set(appTablesOf(this.rows));
    for (const { name, tbl_name, sql } of this.db.selectObjects(
      "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND sql IS NOT NULL",
    ) as Any[]) {
      if (String(name).startsWith("_cs_") || !apps.has(tbl_name) || String(sql).includes("dai_projecting()")) continue;
      const at = String(sql).search(/\bBEGIN\b/i);
      if (at < 0) continue;
      const head = String(sql).slice(0, at);
      const guarded = /\bWHEN\b/i.test(head)
        ? head.replace(/\bWHEN\b([\s\S]*)$/i, "WHEN dai_projecting() = 0 AND ($1) ")
        : `${head.trimEnd()} WHEN dai_projecting() = 0 `;
      this.paused(() => {
        this.exec(`DROP TRIGGER ${q(name)}`);
        this.exec(guarded + String(sql).slice(at));
      });
    }
  }

  /** The table rebuilt with its key's DDL rewritten; indexes and triggers come back as they were. False when it cannot be. */
  private rebuild(table: string, column: string, kind: "ranged" | "uuid"): boolean {
    const exec = this.exec;
    const sql = String(this.db.selectValue("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", [table]));
    let rewritten: string;
    try {
      rewritten = rewriteKeySql(sql, table, column, kind);
    } catch {
      return false;
    }
    if (rewritten === sql) return false;
    const others = this.db.selectValues(
      "SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
      [table],
    ) as string[];
    const old = `_cs_old_${table}`;
    const inTxn = !this.sqlite3.capi.sqlite3_get_autocommit(this.db.pointer);
    const fk = this.db.selectValue("PRAGMA foreign_keys");
    this.paused(() => {
      if (!inTxn) exec("PRAGMA foreign_keys = OFF");
      exec("PRAGMA legacy_alter_table = ON");
      try {
        exec("SAVEPOINT cs_rebuild");
        exec(`ALTER TABLE ${q(table)} RENAME TO ${q(old)}`);
        exec(rewritten);
        exec(`INSERT INTO ${q(table)} SELECT * FROM ${q(old)}`);
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
    });
    return true;
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
   * One save: what changed since the last one, as a changeset, appended to the
   * log as one row under this author. Null when nothing changed, or when the
   * application holds a transaction open (its changes go with the next save).
   * The authorship layer's replica and seq are the caller's to settle first.
   */
  save(): SavedChanges | null {
    if (this.inTransaction) return null;
    const ops = this.capture.take();
    if (ops.length === 0) return null;
    const payloadOps = ops.map((op) => this.withBases(op));
    const payload = cborEncode([1, payloadOps as unknown as CborValue[]] as CborValue);
    const entity = crypto.getRandomValues(new Uint8Array(16));
    const row = createEntity(this.rows, CHANGES_LOG, entity, { payload });
    const ver = `${this.authorHex}:${row._r_seq}`;
    const touched = this.ingest(payloadOps, ver, Number(row._r_lc), this.authorHex);
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

  private withBases(op: ReturnType<SessionCapture["take"]>[number]): Op {
    const keys = this.keysOf(op.table);
    const keyCols = keys?.pk?.length ? keys.pk : Object.keys(op.pk);
    const k = keyCols.map((c) => op.pk[c]);
    const pk = JSON.stringify(k);
    const n = new Map<string, unknown>();
    const p = new Map<string, unknown>();
    const b = new Map<string, string[]>();
    let seen: string[] = [];
    const code = op.op === "INSERT" ? "I" : op.op === "UPDATE" ? "U" : "D";
    if (code === "I") n.set("", 1);
    if (code === "D") n.set("", 0);
    for (const [c, v] of Object.entries(op.new)) n.set(c, v);
    for (const [c, v] of Object.entries(op.old)) p.set(c, v);
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
    for (const [table, k, , n, , b, seen] of ops) {
      const pk = JSON.stringify(k);
      for (const [col, val] of n) {
        this.runCached("INSERT OR IGNORE INTO _cs_cell (tbl, pk, col, ver, val, lc, author) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          table,
          pk,
          col,
          ver,
          val ?? null,
          lc,
          author,
        ]);
      }
      for (const [col, vers] of b) for (const v of vers) this.runCached("INSERT OR IGNORE INTO _cs_sup (tbl, pk, col, ver) VALUES (?, ?, ?, ?)", [table, pk, col, v]);
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
  projectAdmitted(): { changesets: number; rows: number } {
    if (!this.inTransaction) this.save();
    const fresh = this.rows.all(
      `SELECT lower(hex(_r_replica)) AS author, _r_seq AS seq, _r_lc AS lc, payload FROM ${q(`${CHANGES_LOG}_current`)} c
        WHERE NOT EXISTS (SELECT 1 FROM _cs_ingested i WHERE i.ver = lower(hex(c._r_replica)) || ':' || c._r_seq)
        ORDER BY _r_lc, author, _r_seq`,
    );
    if (fresh.length === 0) return { changesets: 0, rows: 0 };
    const touched: [string, string][] = [];
    this.withoutCapture(() => {
      for (const row of fresh) {
        const decoded = cborDecode(row["payload"] as Uint8Array) as unknown as [number, Op[]];
        touched.push(...this.ingest(decoded[1], `${row["author"]}:${row["seq"]}`, Number(row["lc"]), String(row["author"])));
      }
      this.project(touched);
    });
    return { changesets: fresh.length, rows: new Set(touched.map((t) => t.join("|"))).size };
  }

  private paused<T>(f: () => T): T {
    return this.capture ? this.capture.paused(f) : f();
  }

  /** Runtime writes to the application's tables: not captured, foreign keys checked after rather than during, all or nothing. */
  withoutCapture(f: () => void): void {
    const exec = this.exec;
    // PRAGMA foreign_keys is a no-op inside a transaction, so it is set before the savepoint opens.
    const inTxn = this.inTransaction;
    this.paused(() => {
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
    });
  }

  private stateOf(table: string, pk: string): { deleted: boolean; contested: boolean; values: Record<string, unknown>; pending: Any[] } | null {
    const heads = this.db.selectObjects(
      "SELECT col, ver, val, lc, author FROM _cs_cell c WHERE tbl = ? AND pk = ? AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = c.tbl AND s.pk = c.pk AND s.col = c.col AND s.ver = c.ver)",
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
    const pending: Any[] = [];
    const byCol = new Map<string, Any[]>();
    for (const h of data) byCol.set(h.col, [...(byCol.get(h.col) ?? []), h]);
    for (const [col, hs] of byCol) {
      hs.sort((a, b) => Number(b.lc) - Number(a.lc) || (b.author < a.author ? -1 : b.author > a.author ? 1 : 0) || (b.ver < a.ver ? -1 : 1));
      values[col] = plain(hs[0].val);
      // Two concurrent versions are a conflict even when their values are equal: `qty = qty + 1` on both
      // sides writes the same value and means two increments (the spike's S5b).
      if (hs.length > 1) pending.push({ col, values: hs.map((h) => ({ ver: h.ver, val: shown(h.val) })) });
    }
    return { deleted, contested: !deleted && dels.length > 0, values, pending };
  }

  private birthOf(table: string, pk: string): { lc: number; author: string } | null {
    return (this.db.selectObject(
      "SELECT lc, author FROM _cs_cell WHERE tbl = ? AND pk = ? AND col = '' AND val = 1 ORDER BY lc, author LIMIT 1",
      [table, pk],
    ) ?? null) as Any;
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
    for (const [table, pk] of items) this.place(table, pk);
    this.keepReferenced();
  }

  private write(table: string, keys: Keys, k: unknown[], values: Record<string, unknown>): void {
    const data = Object.keys(values).filter((c) => !keys.pk.includes(c));
    const cols = [...keys.pk, ...data];
    const vals = [...k, ...data.map((c) => values[c] ?? null)];
    if (keys.kind === "rowid") {
      // No declared key to upsert on: update the row by its rowid, or insert it.
      if (this.db.selectValue(`SELECT 1 FROM ${q(table)} WHERE rowid IS ?`, k) != null) {
        if (data.length) this.rows.run(`UPDATE ${q(table)} SET ${data.map((c) => `${q(c)} = ?`).join(", ")} WHERE rowid IS ?`, [...data.map((c) => values[c] ?? null), ...k]);
        return;
      }
      this.rows.run(`INSERT INTO ${q(table)} (rowid${data.length ? ", " + data.map(q).join(", ") : ""}) VALUES (${vals.map(() => "?").join(", ")})`, vals);
      return;
    }
    const update = data.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ");
    this.rows.run(
      `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT (${keys.pk.map(q).join(", ")}) DO ${update ? `UPDATE SET ${update}` : "NOTHING"}`,
      vals,
    );
  }

  private place(table: string, pk: string, force = false): void {
    const keys = this.keysOf(table);
    if (!keys) return;
    const state = this.stateOf(table, pk);
    if (!state) return;
    const k = JSON.parse(pk) as unknown[];
    if (state.deleted && !force) {
      this.rows.run(`DELETE FROM ${q(table)} WHERE ${this.whereKey(table)}`, k);
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
            this.rows.run(`DELETE FROM ${q(table)} WHERE ${this.whereKey(table)}`, JSON.parse(occupant));
            this.write(table, keys, k, state.values);
            return;
          }
          this.hold(table, pk, `UNIQUE: ${occupant} holds the slot`, state.values);
          return;
        }
      }
      this.hold(table, pk, message.replace(/^.*?: /, ""), state.values);
      this.rows.run(`DELETE FROM ${q(table)} WHERE ${this.whereKey(table)}`, k);
    }
  }

  private hold(table: string, pk: string, reason: string, values: Record<string, unknown>): void {
    this.rows.run("INSERT OR REPLACE INTO _cs_held (tbl, pk, reason, row) VALUES (?, ?, ?, ?)", [
      table,
      pk,
      reason,
      JSON.stringify(values, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : typeof v === "bigint" ? v.toString() : v)),
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
        `SELECT ${keys.pk.map(q).join(", ")} FROM ${q(table)} WHERE ${cols.map((c) => `${q(c)} IS ?`).join(" AND ")}`,
        cols.map((c) => values[c]),
      ) as Any;
      if (hit) {
        const other = JSON.stringify(keys.pk.map((c) => plain(hit[c])));
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
        const child = this.db.selectObject(`SELECT ${fk.map((f) => q(f.from)).join(", ")} FROM ${q(o.table)} WHERE rowid = ?`, [o.rowid]) as Any;
        const parentKeys = this.keysOf(o.parent);
        if (!child || !parentKeys) continue;
        const to = fk.map((f) => f.to ?? parentKeys.pk[0]);
        if (to.join(",") !== parentKeys.pk.join(",")) continue;
        const pk = JSON.stringify(fk.map((f) => plain(child[f.from])));
        const state = this.stateOf(o.parent, pk);
        if (!state) {
          this.flag(o.table, JSON.stringify([plain(o.rowid)]), "orphan", { parent: o.parent, key: pk });
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
  }
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
    const order = k && k["kind"] !== "rowid" && k["pk"] ? String(k["pk"]).split(",").map(q).join(", ") : "rowid";
    const select = k?.["kind"] === "rowid" ? `SELECT rowid AS rowid, * FROM ${q(table)}` : `SELECT * FROM ${q(table)}`;
    out[table] = rows
      .all(`${select} ORDER BY ${order}`)
      .map((r) => Object.fromEntries(Object.entries(r).map(([c, v]) => [c, v instanceof Uint8Array ? `<${hex(v)}>` : typeof v === "bigint" ? v.toString() : v])));
  }
  return out;
}
