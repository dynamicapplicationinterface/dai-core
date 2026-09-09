/**
 * The frame's half of a merge (docs/replicated-tables.md §6, T1-D20).
 *
 * The host hands over a sibling's data section and never parses it. The frame
 * opens it, merges by union, and answers with counts. Container bytes, the
 * manifest and the host's storage are all on the other side of that line:
 * whatever arrives is hostile until proven otherwise, and it is opened inside
 * the sandbox that already exists for exactly this reason.
 *
 * The merge itself is `mergeFrom` in `replicated-rows.ts`, over the same `Rows`
 * interface the tests and the conformance fixtures use. What lives here is the
 * part that cannot be shared: turning a SQLite-wasm connection into that
 * interface, and deciding what to refuse before any of it runs.
 */
import { canonicalDump, mergeFrom, type MergeResult, type Rows } from "./replicated-rows.js";

/** What the host sends. */
export interface MergeRequest {
  /** The sibling's data section, as SQLite bytes. */
  databaseBytes: Uint8Array;
  /** The sibling's replica id, for the host's own record. Not trusted here. */
  replicaId?: Uint8Array;
  /** 1 at Track 1. A level this frame does not implement is refused. */
  level?: number;
}

/** What goes back, per T1-D20. */
export interface MergeReport extends MergeResult {
  /** Entities that now have more than one head — the one number a person sees. */
  conflicts: number;
  /** Present only when the merge did not run at all. */
  refused?: string;
}

/**
 * The smallest SQLite handle this needs, so a caller can pass wasm, node, or a
 * test double without this module knowing which.
 */
export interface Connection {
  exec(sql: string, options?: unknown): unknown;
  selectObjects?(sql: string, bind?: unknown): Record<string, unknown>[];
  close?(): void;
}

/**
 * A sqlite-wasm `oo1.DB` behind the `Rows` interface.
 *
 * `selectObjects` and `exec` are the two calls the write rules make. Bound
 * parameters go through as an array, which is what both engines take.
 */
export function rowsOf(db: Connection): Rows {
  return {
    all: (sql, params = []) =>
      db.selectObjects
        ? db.selectObjects(sql, [...params])
        : (db.exec(sql, { bind: [...params], rowMode: "object", returnValue: "resultRows" }) as Record<
            string,
            unknown
          >[]),
    run: (sql, params = []) => {
      db.exec(sql, { bind: [...params] });
    },
  };
}

/** The replicated tables a connection carries, by their shape (T1-D18). */
export function replicatedTablesOf(rows: Rows): string[] {
  return rows
    .all(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_dai\\_%' ESCAPE '\\'",
    )
    .map((row) => String(row["name"]))
    .filter((name) => {
      const columns = rows.all("SELECT name FROM pragma_table_info(?)", [name]).map((c) => String(c["name"]));
      return columns.includes("_r_replica") && columns.includes("_r_seq");
    })
    .sort();
}

/**
 * The schema digests of two copies, compared as T1-D14 requires.
 *
 * Compared over the replicated tables' own definitions rather than the whole
 * schema: a local table the sibling does not have is not a reason to refuse a
 * merge, because local tables never travel and never merge.
 */
function replicatedSchema(rows: Rows, tables: readonly string[]): string {
  return tables
    .map((name) => {
      const sql = rows.all("SELECT sql FROM sqlite_schema WHERE name = ?", [name])[0]?.["sql"];
      return `${name}:${String(sql ?? "")}`;
    })
    .join("\n");
}

/**
 * Merges a sibling into this copy, and says what happened.
 *
 * Refuses before touching anything when the two copies do not describe the same
 * tables the same way. At Level 1 that is the whole of the compatibility check
 * (T1-D14): refuse loudly rather than merge under invented migration semantics,
 * because the migration chain later turns refusals into merges and never the
 * other way.
 */
export function mergeSibling(local: Rows, sibling: Rows, level = 1): MergeReport {
  const empty: MergeResult = { applied: 0, duplicate: 0, rejected: [], newReplicas: 0 };

  if (level !== 1) {
    // A sibling asking for a level this frame does not implement is refused
    // rather than merged as though it were Level 1 — signatures it expected to
    // be checked would not have been.
    return { ...empty, conflicts: 0, refused: "UNSUPPORTED_LEVEL" };
  }

  const tables = replicatedTablesOf(local);
  const theirs = replicatedTablesOf(sibling);
  if (
    tables.length !== theirs.length ||
    tables.some((name, index) => name !== theirs[index]) ||
    replicatedSchema(local, tables) !== replicatedSchema(sibling, theirs)
  ) {
    return { ...empty, conflicts: 0, refused: "SCHEMA_MISMATCH" };
  }

  const result = mergeFrom(local, sibling, tables);
  return { ...result, conflicts: conflictsIn(local, tables) };
}

/** Entities with more than one head, across every replicated table. */
export function conflictsIn(rows: Rows, tables: readonly string[]): number {
  let total = 0;
  for (const table of tables) {
    const count = rows.all(`SELECT count(*) AS n FROM "${table}_conflicts"`)[0]?.["n"];
    total += Number(count ?? 0);
  }
  return total;
}

/** The canonical dump, re-exported so a host can show what a merge produced. */
export { canonicalDump };
