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
import { SESSION_SYSTEM_TABLES } from "./replicated.js";

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
 * The roster tables a session document carries, when it is one (T1-D29).
 *
 * `replicatedTablesOf` excludes every `_dai_%` table, because the two document
 * tables are merged specially and must not be row-merged. The roster tables are
 * the exception: they *are* replicated and must union like any author table, so
 * they are named explicitly rather than by shape.
 */
export function rosterTablesOf(rows: Rows): string[] {
  const present = new Set(
    rows.all("SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => String(r["name"])),
  );
  return SESSION_SYSTEM_TABLES.filter((name) => present.has(name));
}

/** Every table a merge unions: the author tables and the roster tables, in one order. */
export function mergeTablesOf(rows: Rows): string[] {
  return [...replicatedTablesOf(rows), ...rosterTablesOf(rows)].sort();
}

/**
 * Every replicated table by shape, whatever its name — the ground truth
 * `mergeTablesOf` must cover.
 *
 * Unlike `replicatedTablesOf`, this does not exclude `_dai_%`: it finds every
 * table that carries the replication columns, so a system table that is
 * replicated but unlisted shows up here and can be caught.
 */
function everyReplicatedTable(rows: Rows): string[] {
  return rows
    .all("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .map((row) => String(row["name"]))
    .filter((name) => {
      const columns = rows.all("SELECT name FROM pragma_table_info(?)", [name]).map((c) => String(c["name"]));
      return columns.includes("_r_replica") && columns.includes("_r_seq");
    });
}

/**
 * Asserts that `mergeTablesOf` covers every replicated table, exactly once.
 *
 * `mergeTablesOf` decides what converges, so a replicated table it omits is a
 * table that silently never merges — two copies that agree everywhere else and
 * diverge on it, with no error to point at. That is the invisible failure this
 * project keeps finding, so it is a check rather than a comment: every table
 * with the replication columns is in the author list or the roster list, and a
 * table in neither — a new system table added without extending
 * `SESSION_SYSTEM_TABLES`, the way `_dai_close` will be in Step 5 — is a build
 * error, not a divergence discovered in the field.
 *
 * Called at the top of a merge so a mis-wired schema cannot merge at all rather
 * than merge incompletely.
 */
export function assertMergeCoverage(rows: Rows): void {
  const covered = new Set(mergeTablesOf(rows));
  const uncovered = everyReplicatedTable(rows).filter((name) => !covered.has(name));
  if (uncovered.length > 0) {
    throw new Error(
      `MERGE_COVERAGE: these replicated tables are in neither the author nor the roster set, so ` +
        `they would never converge: ${uncovered.join(", ")}. A replicated table must be an author ` +
        `table or a named system table (SESSION_SYSTEM_TABLES).`,
    );
  }
}

/**
 * The replicated schema of a copy, canonicalised (T1-D21).
 *
 * Over the **author's** columns, recovered from the table itself, and not over
 * the `CREATE TABLE` text SQLite stores. That text is the compiler's output —
 * the replication columns, the key, and whatever whitespace and ordering that
 * compiler chose — and two compilers could emit it differently while both
 * being right. Comparing it would refuse a merge between two copies of the
 * same document built by different tools: a disagreement about *mergeability*
 * rather than about a merge, which is the worse of the two, because the rows
 * never get far enough to disagree.
 *
 * One line per author column, tab-separated, tables in name order and columns
 * in declared order. The `_r_*` columns are excluded: every conforming compiler
 * emits exactly the same ones, so they carry no information and only invite a
 * formatting difference.
 *
 * Local tables are absent by construction. A private table on one side is not a
 * reason to refuse — local tables never travel and never merge, so a difference
 * in them says nothing about whether two copies can exchange rows.
 */
export function replicatedSchemaOf(rows: Rows, tables?: readonly string[]): string {
  const names = tables ?? replicatedTablesOf(rows);
  const lines: string[] = [];
  for (const table of [...names].sort()) {
    const columns = rows.all('SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?)', [
      table,
    ]);
    for (const column of columns) {
      const name = String(column["name"]);
      if (name.startsWith("_r_")) continue;
      lines.push(
        [
          table,
          name,
          // The declared type, case-folded with its whitespace collapsed.
          // SQLite keeps the author's spelling and treats `text` and `TEXT`
          // alike, and `VARCHAR( 20 )` and `VARCHAR(20)` alike; two tools will
          // spell both ways, and neither difference is a difference of schema.
          String(column["type"] ?? "").trim().replace(/\s+/g, " ").toUpperCase(),
          Number(column["notnull"] ?? 0) === 1 ? "NOT NULL" : "",
          // Verbatim. A default is a literal, and normalising a literal is how
          // two readers begin disagreeing about what a default means.
          column["dflt_value"] === null || column["dflt_value"] === undefined
            ? ""
            : String(column["dflt_value"]),
        ].join("\t"),
      );
    }
  }
  return `${lines.join("\n")}\n`;
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

  // Refuse to merge a schema whose replicated tables are not all accounted for,
  // rather than merge some of them and diverge on the rest (T1-D29).
  assertMergeCoverage(local);

  // The merge unions author tables and the roster tables together, so seats and
  // bindings converge like moves (T1-D29). Conflicts, below, are reported over
  // the author tables only — a contested seat is not the app's conflict to show.
  const tables = mergeTablesOf(local);
  const theirs = mergeTablesOf(sibling);

  /*
   * Neither copy has a replicated table, so there is nothing a merge could do.
   *
   * Without this the two empty table lists compare as equal, the union runs
   * over nothing, and the answer is `applied: 0` — a merge that reports
   * success and changed nothing, which reads to a person as "it worked" and to
   * a log as a merge that happened. A document with no replicated tables is
   * not a document two copies of which can be merged; it is a document that is
   * replaced whole, by `savedAt` succession, and saying so is the difference
   * between an answer and a silence.
   */
  if (tables.length === 0 && theirs.length === 0) {
    return { ...empty, conflicts: 0, refused: "NOT_REPLICATED" };
  }

  if (
    tables.length !== theirs.length ||
    tables.some((name, index) => name !== theirs[index]) ||
    replicatedSchemaOf(local, tables) !== replicatedSchemaOf(sibling, theirs)
  ) {
    return { ...empty, conflicts: 0, refused: "SCHEMA_MISMATCH" };
  }

  const result = mergeFrom(local, sibling, tables);
  return { ...result, conflicts: conflictsIn(local, replicatedTablesOf(local)) };
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

/*
 * The whole surface, from one module.
 *
 * This is the file the frame imports and the fixtures import, so everything a
 * merge needs has to leave by this door — otherwise the frame would need two
 * modules and the question of whether they were built together would be live.
 */
export {
  adoptReplica,
  applyRow,
  authorColumnsOf,
  canonicalDump,
  changeEntity,
  createEntity,
  deleteEntity,
  encodeValue,
  ensureReplica,
  headsOf,
  mergeFrom,
  parentsOf,
  rowId,
  RowRejected,
} from "./replicated-rows.js";

export {
  authoredSince,
  authoredHead,
  authoredBatchAbove,
  encodeBatch,
  decodeBatch,
  stageBatch,
  type Batch,
  type BatchEntry,
  type Watermark,
} from "./replicated-batch.js";
