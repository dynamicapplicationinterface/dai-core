/**
 * One copy of a document with no session policy, in node, on the runtime's
 * own SQLite (sqlite-wasm, the engine every container embeds) and the
 * runtime's own modules from src/: the authorship layer (replicated-batch,
 * replicated-rows) and the data interface (`Changes`, reached through
 * replicated-frame, the module the frame imports).
 *
 * What the frame does around a save and a merge, and no more: settle the
 * replica, save (capture into the log), seal under the author's key, export;
 * and on a merge, verify, admit through `mergeVerified`, project. The merge
 * scenarios run here; the frame's own wiring is tested through the real
 * runtime in the browser specs beside this file.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import * as merge from "../../src/replicated-frame.js";
import { rewriteReplicated } from "../../src/replicated.js";
import { decode as cborDecode } from "../../src/cbor.js";
import { person, type Person } from "../signed-people.js";
import type { Rows } from "../../src/replicated-rows.js";

export const DOC = "7d3e2c1b-4a59-4e6f-9a0b-c1d2e3f40516";
export { person, type Person };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const m = merge as Any;

let booted: Promise<Any> | null = null;
export const boot = (): Promise<Any> => (booted ??= sqlite3InitModule({ print: () => {}, printErr: () => {} } as Any));

const norm = (v: unknown): unknown =>
  typeof v === "bigint" && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v;

/** The Rows interface over an oo1.DB. */
export function rowsOf(db: Any): Rows {
  return {
    all: (sql, params = []) =>
      (db.selectObjects(sql, params.length ? params.slice() : undefined) as Record<string, unknown>[]).map((r) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, norm(v)])),
      ),
    run: (sql, params = []) => void db.exec({ sql, bind: params.length ? params.slice() : undefined }),
  };
}

export function deserialize(sqlite3: Any, db: Any, bytes: Uint8Array): void {
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer,
    "main",
    pointer,
    bytes.byteLength,
    bytes.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc !== 0) throw new Error(`sqlite3_deserialize rc=${rc}`);
  db.exec("SELECT count(*) FROM sqlite_schema");
}

export async function openBytes(bytes: Uint8Array): Promise<{ sqlite3: Any; db: Any; rows: Rows }> {
  const sqlite3 = await boot();
  const db = new sqlite3.oo1.DB(":memory:", "c");
  deserialize(sqlite3, db, bytes);
  return { sqlite3, db, rows: rowsOf(db) };
}

export class Copy {
  readonly rows: Rows;
  readonly changes: Any;

  private constructor(
    readonly sqlite3: Any,
    readonly db: Any,
    readonly author: Person,
  ) {
    this.rows = rowsOf(db);
    // The host's id wins over the file's, as the frame settles it at mount.
    m.adoptReplica(this.rows, author.author);
    this.changes = new m.Changes(sqlite3, db, { author: author.author });
    this.changes.watch(db);
    this.changes.projectAdmitted();
  }

  /** A new document (no bytes), or a copy of one opened in this context (bytes). */
  static async open(author: Person, bytes?: Uint8Array): Promise<Copy> {
    const sqlite3 = await boot();
    const db = new sqlite3.oo1.DB(":memory:", "c");
    if (bytes) deserialize(sqlite3, db, bytes);
    else db.exec(rewriteReplicated(String(m.CHANGES_DECLARATION)).sql);
    return new Copy(sqlite3, db, author);
  }

  /** One save: what changed since the last, into the log. */
  save(): Any {
    return this.changes.save();
  }

  async seal(): Promise<void> {
    for (const batch of m.pendingBatches(this.rows, this.author.author, m.mergeTablesOf(this.rows))) {
      m.recordSeal(this.rows, await m.signBatch(batch, { document: DOC, keys: this.author.keys }));
    }
  }

  /** The document as it would be stored or sent: saved, sealed, serialized. */
  async bytes(): Promise<Uint8Array> {
    this.save();
    await this.seal();
    return this.sqlite3.capi.sqlite3_js_db_export(this.db.pointer);
  }

  /** Another copy merged in: admitted by the authorship layer, then projected. */
  async mergeFrom(bytes: Uint8Array): Promise<Any> {
    this.save();
    const sib = await openBytes(bytes);
    const verdicts = await m.verifyBatches(sib.rows, m.mergeTablesOf(sib.rows), DOC);
    const report = m.mergeVerified(this.rows, sib.rows, { document: DOC, author: this.author.author, verdicts });
    sib.db.close();
    const projected = this.changes.projectAdmitted();
    return { report, projected };
  }

  flags(): Any[] {
    return this.changes.flags();
  }

  held(): Any[] {
    return this.changes.held();
  }

  dump(): Any {
    return m.changesDump(this.rows);
  }

  /** Every (table, key, column, version, value) this copy's cells hold. */
  everyValue(): Set<string> {
    return new Set(
      this.rows
        .all("SELECT tbl, pk, col, ver, val FROM _cs_cell ORDER BY tbl, pk, col, ver")
        .map((r) => JSON.stringify([r["tbl"], r["pk"], r["col"], r["ver"], r["val"] instanceof Uint8Array ? "<blob>" : r["val"]])),
    );
  }

  /** Every value this copy's own log carries: what its author wrote. */
  written(): string[] {
    const all: string[] = [];
    for (const r of this.rows.all(`SELECT lower(hex(_r_replica)) AS a, _r_seq AS s, payload FROM _cs_log WHERE _r_replica = ?`, [this.author.author])) {
      for (const [t, k, , n] of (cborDecode(r["payload"] as Uint8Array) as Any)[1]) {
        for (const [c, v] of n) all.push(JSON.stringify([t, JSON.stringify(k), c, `${r["a"]}:${r["s"]}`, v instanceof Uint8Array ? "<blob>" : (v ?? null)]));
      }
    }
    return all;
  }

  /** This author's ops at seq >= `from`, by row: table|key -> I/U/D. */
  opsSince(from: number): Map<string, Set<string>> {
    const ops = new Map<string, Set<string>>();
    for (const r of this.rows.all("SELECT payload FROM _cs_log WHERE _r_replica = ? AND _r_seq >= ?", [this.author.author, from])) {
      for (const [t, k, code] of (cborDecode(r["payload"] as Uint8Array) as Any)[1]) {
        const key = `${t}|${JSON.stringify(k)}`;
        ops.set(key, (ops.get(key) ?? new Set()).add(code));
      }
    }
    return ops;
  }

  /** Every row this copy shows, as table|key. */
  shown(): string[] {
    const keys: string[] = [];
    const kinds = new Map(this.rows.all("SELECT tbl, kind, pk FROM _cs_keys").map((r) => [String(r["tbl"]), r]));
    for (const [t, rows] of Object.entries(this.dump()) as [string, Any[]][]) {
      const k = kinds.get(t);
      const pk = k && k["kind"] !== "rowid" ? String(k["pk"]).split(",") : ["rowid"];
      for (const r of rows) keys.push(`${t}|${JSON.stringify(pk.map((c) => r[c]))}`);
    }
    return keys;
  }

  state(): string {
    return JSON.stringify({ tables: this.dump(), flags: this.flags(), held: this.held() });
  }

  close(): void {
    this.changes.close();
    this.db.close();
  }
}
