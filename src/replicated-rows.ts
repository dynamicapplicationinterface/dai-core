/**
 * Write rules and supersession (docs/replicated-tables.md §5, T1-D2).
 *
 * Everything that puts a row into a replicated table comes through here: a
 * local create, change or delete, and every row arriving in a merge. They share
 * one primitive, `applyRow`, because the properties that matter — idempotence,
 * and the flag converging regardless of arrival order — have to hold for both
 * or they hold for neither.
 *
 * The engine is injected rather than imported. The runtime has SQLite compiled
 * to wasm, the tests have `node:sqlite`, and the Python reader implements this
 * text again from the other side; a module that reached for one of them would
 * be untestable in the other two.
 */

/** The little that is needed of a SQLite connection. */
export interface Rows {
  all(sql: string, params?: readonly unknown[]): Record<string, unknown>[];
  run(sql: string, params?: readonly unknown[]): void;
}

export class RowRejected extends Error {
  readonly code = "ROW_REJECTED";
  constructor(message: string) {
    super(message);
    this.name = "RowRejected";
  }
}

export class SessionExportIncomplete extends Error {
  readonly code = "SESSION_EXPORT_INCOMPLETE";
  constructor(message: string) {
    super(message);
    this.name = "SessionExportIncomplete";
  }
}

/** The `_r_` columns as they travel. `_r_superseded` is not among them (T1-D11). */
export interface ReplicatedRow {
  _r_replica: Uint8Array;
  _r_seq: number;
  _r_lc: number;
  _r_entity: Uint8Array;
  _r_parents: string;
  _r_deleted: number;
  _r_sig?: Uint8Array | null;
  /**
   * The session this row belongs to (T1-D26). Present only in a document that
   * declares the session profile — where the table carries `_r_session` — and
   * absent everywhere else, so a plain replicated row is exactly what it was.
   */
  _r_session?: Uint8Array;
  /** The author's own columns. */
  columns: Record<string, unknown>;
}

/**
 * The `_r_` columns a row carries as it travels — the one list every encoder,
 * decoder and stager derives from, so none of them can drift.
 *
 * `_r_session` slipped out of the mailbox format precisely because each of those
 * kept its own hand-written copy of this list and one copy was short a field: a
 * bug that surfaced as an empty merge, not an error, because `INSERT OR IGNORE`
 * swallowed the `NOT NULL` it violated. This is the same class as `mergeTablesOf`
 * before its coverage guard — a list a caller can get wrong with no complaint —
 * and gets the same treatment: named once, consumed everywhere, and a round-trip
 * test that fails the moment a field added here is not carried through.
 *
 * `_r_superseded` is absent by design (T1-D11): it is derived local state, not
 * part of the row, and merge recomputes it. `_r_session` is `optional` — present
 * only in a session document — and rides the wire as an explicit null when a
 * plain row has none, so decode never has to guess. `key` is the compact CBOR
 * label the batch uses; `kind` is how the value is read from a stored row.
 */
export interface CarriedRField {
  /** The column name in the table and on `ReplicatedRow`. */
  col: keyof ReplicatedRow;
  /** The compact key the CBOR batch encodes it under. */
  key: string;
  /** How to read it from a stored row. */
  kind: "bytes" | "number" | "string" | "bytesOrNull";
  /** True for a field only a session document carries; absent → sent as null. */
  optional?: boolean;
}

export const CARRIED_R_FIELDS: readonly CarriedRField[] = [
  { col: "_r_replica", key: "r", kind: "bytes" },
  { col: "_r_seq", key: "s", kind: "number" },
  { col: "_r_lc", key: "lc", kind: "number" },
  { col: "_r_entity", key: "e", kind: "bytes" },
  { col: "_r_parents", key: "p", kind: "string" },
  { col: "_r_deleted", key: "d", kind: "number" },
  { col: "_r_sig", key: "sig", kind: "bytesOrNull" },
  { col: "_r_session", key: "ss", kind: "bytes", optional: true },
];

/**
 * The `_r_` columns the rewrite emits that deliberately do NOT travel, each with
 * the reason it is held back — so a new column can be excluded only on purpose,
 * with a reason, and never by omission.
 *
 * This is the completeness half of `CARRIED_R_FIELDS`. That list says what a row
 * carries; a column the schema grows that is in neither is the bug the four
 * hand-lists made possible — a field that silently does not travel. A test
 * enumerates every `_r_` column off a rewritten table and asserts each is carried
 * or named here, so the descriptor can no longer fall behind the schema.
 */
export const UNTRANSPORTED_R_COLUMNS: Readonly<Record<string, string>> = {
  // T1-D11: derived local state, recomputed by merge from the row set. It is not
  // part of the row, and the sender's copy of it is none of the reader's
  // business — carrying it would let arrival order, not the rows, decide a head.
  _r_superseded: "derived local supersession flag, recomputed by merge (T1-D11)",
};

/** Read one carried field from a stored row, in its declared kind. */
function readField(stored: Record<string, unknown>, field: CarriedRField): unknown {
  const raw = stored[field.col];
  switch (field.kind) {
    case "bytes":
      return field.optional ? (raw instanceof Uint8Array ? raw : undefined) : (raw as Uint8Array);
    case "bytesOrNull":
      return (raw as Uint8Array | null) ?? null;
    case "number":
      return Number(raw);
    case "string":
      return String(raw);
  }
}

/** Whether a table carries the session column, i.e. the document declares the profile. */
export function hasSessionColumn(db: Rows, table: string): boolean {
  return db.all(`SELECT 1 FROM pragma_table_info(?) WHERE name = '_r_session'`, [table]).length > 0;
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A row's id in the text form `_r_parents` uses. */
export const rowId = (replica: Uint8Array, seq: number): string => `${hex(replica)}:${seq}`;

/** The parents of a row, as ids. Sorted on the way in, so two writers agree. */
export function parentsOf(row: { _r_parents: string }): string[] {
  const parsed: unknown = JSON.parse(row._r_parents);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is string => typeof value === "string");
}

/** The author's columns of a table, in declared order. */
export function authorColumnsOf(db: Rows, table: string): string[] {
  return db
    .all(`SELECT name FROM pragma_table_info(?)`, [table])
    .map((row) => String(row["name"]))
    .filter((name) => !name.startsWith("_r_"));
}

/**
 * A stored row, read back into the shape merge and the mailbox both consume.
 *
 * One reader, used by `mergeFrom` and by the mailbox's `authoredSince`, so the
 * two never disagree about what a row is. `_r_superseded` is deliberately not
 * read — it is derived local state (T1-D11), not part of the row, and the
 * sender's copy of it is none of the reader's business.
 */
export function readRow(stored: Record<string, unknown>, authored: readonly string[]): ReplicatedRow {
  const columns: Record<string, unknown> = {};
  for (const name of authored) columns[name] = stored[name];
  // The `_r_` fields come from the one carried-field list, so a field added
  // there is read here without touching this function. An optional field a plain
  // row lacks (`_r_session`) reads back as undefined and is left off entirely, so
  // the shape still carries the profile with it.
  const row: Record<string, unknown> = { columns };
  for (const field of CARRIED_R_FIELDS) {
    const value = readField(stored, field);
    if (field.optional && value === undefined) continue;
    row[field.col] = value;
  }
  return row as unknown as ReplicatedRow;
}

/**
 * Puts one row in, and keeps the supersession flag true of the row set.
 *
 * This is T1-D2, and the second half is the part that looks redundant and is
 * not. Marking a row's parents superseded is obvious. Marking *the row itself*
 * superseded when something already present names it is what makes the flag a
 * function of the set rather than of arrival order — on a merge a child can
 * land before its parent, and without this the parent would arrive later and
 * sit there as a head forever, on that host and no other.
 *
 * Returns what happened, because merge counts it.
 */
export function applyRow(db: Rows, table: string, row: ReplicatedRow): "added" | "duplicate" {
  const authored = authorColumnsOf(db, table);
  const session = hasSessionColumn(db, table);
  const id = rowId(row._r_replica, row._r_seq);

  // A session table's rows must carry a session, on both the local write and the
  // merge path (T1-D26). `_r_session` is NOT NULL, so SQLite would refuse the
  // insert anyway; caught here with a reason rather than a constraint message.
  if (session && !(row._r_session instanceof Uint8Array)) {
    throw new RowRejected(
      `A row for ${id} carries no session, but ${table} declares the session profile. ` +
        "Every row in a session document belongs to a session.",
    );
  }

  const existing = db.all(
    `SELECT * FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`,
    [row._r_replica, row._r_seq],
  )[0];

  if (existing) {
    /*
     * The same row again, or a different row wearing its name.
     *
     * Merge hits the first case constantly — every exchange re-sends
     * everything — so it is a no-op and not an error. The second case is what
     * tampering looks like: a row id is `(replica, seq)`, a replica issues each
     * seq once, so two different contents under one id cannot both be honest.
     *
     * `_r_superseded` is excluded from the comparison because it is derived
     * local state and not part of the row (T1-D11). The sender's copy of it
     * says what *they* have seen, which is none of our business.
     */
    const same =
      Number(existing["_r_lc"]) === row._r_lc &&
      hex(existing["_r_entity"] as Uint8Array) === hex(row._r_entity) &&
      String(existing["_r_parents"]) === row._r_parents &&
      Number(existing["_r_deleted"]) === row._r_deleted &&
      (!session || sameValue(existing["_r_session"], row._r_session)) &&
      authored.every((name) => sameValue(existing[name], row.columns[name]));
    if (same) return "duplicate";
    throw new RowRejected(
      `A different row already exists as ${id}. A replica issues each sequence number once, ` +
        "so two contents under one id cannot both be honest.",
    );
  }

  // Superseded on arrival if anything already present names this row as a
  // parent. The DAG is not ordered by arrival, so this is not a rare case.
  const namedAlready = db.all(
    `SELECT 1 FROM "${table}", json_each("${table}"._r_parents)
      WHERE json_each.value = ? LIMIT 1`,
    [id],
  ).length > 0;

  const names = [
    ...authored,
    "_r_replica", "_r_seq", "_r_lc", "_r_entity", "_r_parents", "_r_deleted", "_r_superseded", "_r_sig",
    ...(session ? ["_r_session"] : []),
  ];
  const values = [
    ...authored.map((name) => row.columns[name] ?? null),
    row._r_replica,
    row._r_seq,
    row._r_lc,
    row._r_entity,
    row._r_parents,
    row._r_deleted,
    namedAlready ? 1 : 0,
    row._r_sig ?? null,
    ...(session ? [row._r_session as Uint8Array] : []),
  ];
  db.run(
    `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    values,
  );

  // And every parent this row names is now superseded. Rows that have not
  // arrived yet are covered by the check above when they do.
  for (const parent of parentsOf(row)) {
    const [replicaHex, seq] = parent.split(":");
    if (!replicaHex || seq === undefined) continue;
    db.run(
      `UPDATE "${table}" SET _r_superseded = 1
        WHERE hex(_r_replica) = ? AND _r_seq = ? AND _r_superseded = 0`,
      [replicaHex.toUpperCase(), Number(seq)],
    );
  }

  return "added";
}

/** SQLite comparison, not JavaScript's: a blob equals a blob by its bytes. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return hex(a) === hex(b);
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

/* ------------------------------------------------------------------ writes */

/** This copy's replica id and clocks. */
function replicaState(db: Rows): { id: Uint8Array; seq: number; lc: number } {
  const row = db.all("SELECT id, seq, lc FROM _dai_replica LIMIT 1")[0];
  if (!row) throw new RowRejected("This copy has no replica; nothing has been written yet.");
  return { id: row["id"] as Uint8Array, seq: Number(row["seq"]), lc: Number(row["lc"]) };
}

/** Mints this copy's replica on the first write (§5.1 of Draft 1). */
export function ensureReplica(db: Rows, id: Uint8Array): void {
  if (db.all("SELECT 1 FROM _dai_replica LIMIT 1").length > 0) return;
  db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [id]);
  db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [id]);
}

/**
 * Takes over a copy that arrived from somewhere else, under a new identity
 * (T1-D22).
 *
 * A replica is per *copy*, not per document. A file that arrives from another
 * person carries their `_dai_replica`, and `ensureReplica` above will not
 * touch it, because a row is already there — so without this the recipient
 * writes rows stamped with the sender's id.
 *
 * That is not a cosmetic attribution problem. Both people then allocate the
 * same `(replica, seq)` pairs independently, and the next exchange refuses one
 * of them: `ROW_REJECTED`, the code that means a row id was claimed twice with
 * different contents. Two people using the document exactly as intended
 * produce a row rejected as tampering, and neither has done anything wrong.
 *
 * So the host calls this when it opens a copy this device did not write. The
 * sender's id moves into `_dai_replicas` — their rows stay theirs, and their
 * authorship of everything already in the file is untouched.
 *
 * `seq` restarts at zero because sequence numbers are per replica and this
 * replica has issued none. The clock does **not** restart: this copy has seen
 * everything in the file, so its clock must be at least as high as anything
 * it holds, or the first row it writes would sort below rows it was written
 * after.
 */
export function adoptReplica(db: Rows, id: Uint8Array): boolean {
  const current = db.all("SELECT id, lc FROM _dai_replica LIMIT 1")[0];
  if (!current) {
    ensureReplica(db, id);
    return true;
  }
  const held = current["id"] as Uint8Array;
  if (held instanceof Uint8Array && hex(held) === hex(id)) return false;

  // The previous owner keeps their place among the replicas this copy knows.
  db.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, ?, 0)", [
    held,
    Number(current["lc"] ?? 0),
  ]);
  db.run("DELETE FROM _dai_replica");
  db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, ?)", [
    id,
    Number(current["lc"] ?? 0),
  ]);
  db.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, ?, 0)", [
    id,
    Number(current["lc"] ?? 0),
  ]);
  return true;
}

/** The ids of an entity's current heads, sorted, for a row that supersedes them. */
export function headsOf(db: Rows, table: string, entity: Uint8Array): string[] {
  return db
    .all(
      `SELECT _r_replica, _r_seq FROM "${table}" WHERE _r_entity = ? AND _r_superseded = 0`,
      [entity],
    )
    .map((row) => rowId(row["_r_replica"] as Uint8Array, Number(row["_r_seq"])))
    .sort();
}

function stamp(
  db: Rows,
  table: string,
  entity: Uint8Array,
  parents: string[],
  columns: Record<string, unknown>,
  deleted: number,
  session: Uint8Array | undefined,
): ReplicatedRow {
  const state = replicaState(db);
  const seq = state.seq + 1;
  const lc = state.lc + 1;
  db.run("UPDATE _dai_replica SET seq = ?, lc = ?", [seq, lc]);
  return {
    _r_replica: state.id,
    _r_seq: seq,
    _r_lc: lc,
    _r_entity: entity,
    _r_parents: JSON.stringify([...parents].sort()),
    _r_deleted: deleted,
    ...(session ? { _r_session: session } : {}),
    columns,
  };
}

/** A new entity: no parents, a fresh id. */
export function createEntity(
  db: Rows,
  table: string,
  entity: Uint8Array,
  columns: Record<string, unknown>,
  session?: Uint8Array,
): ReplicatedRow {
  const row = stamp(db, table, entity, [], columns, 0, session);
  applyRow(db, table, row);
  return row;
}

/**
 * A change: a new row naming the entity's current heads.
 *
 * Naming *all* the heads is what makes an edit made while a conflict is open a
 * resolution of it. Draft 1 says "normally one; two or more = resolving a
 * conflict", and there is no separate resolve operation for that reason.
 */
export function changeEntity(
  db: Rows,
  table: string,
  entity: Uint8Array,
  columns: Record<string, unknown>,
): ReplicatedRow {
  // The session is inherited from the entity's head, not supplied by the caller
  // (T1-D28). An entity belongs to one session for its whole history; letting a
  // change name a different session is what would produce a row whose parents
  // are in another session, which the export refuses as malformed. Deriving it
  // here means the honest write rules cannot construct that crossing at all —
  // and matches the caller, which passes no session (bootloader `changeEntity`).
  // Only a session table has `_r_session` to read; a `SELECT` of it against a
  // plain table is a "no such column" error, so the column check gates the query.
  let session: Uint8Array | undefined;
  if (hasSessionColumn(db, table)) {
    const head = db.all(
      `SELECT _r_session FROM "${table}" WHERE _r_entity = ? AND _r_superseded = 0
        ORDER BY _r_lc DESC, hex(_r_replica) ASC, _r_seq ASC LIMIT 1`,
      [entity],
    )[0];
    if (head?.["_r_session"] instanceof Uint8Array) session = head["_r_session"] as Uint8Array;
  }
  const row = stamp(db, table, entity, headsOf(db, table, entity), columns, 0, session);
  applyRow(db, table, row);
  return row;
}

/** A delete: a tombstone carrying the columns of the head it buries. */
export function deleteEntity(db: Rows, table: string, entity: Uint8Array): ReplicatedRow {
  const authored = authorColumnsOf(db, table);
  const heads = headsOf(db, table, entity);
  const head = db.all(
    `SELECT * FROM "${table}" WHERE _r_entity = ? AND _r_superseded = 0
      ORDER BY _r_lc DESC, hex(_r_replica) ASC, _r_seq ASC LIMIT 1`,
    [entity],
  )[0];
  const columns: Record<string, unknown> = {};
  for (const name of authored) columns[name] = head ? head[name] : null;
  // A delete belongs to the same session as the entity it buries, so the session
  // is taken from the head rather than asked for again — the caller deleting a
  // row need not know which session it was in (T1-D26).
  const session =
    hasSessionColumn(db, table) && head?.["_r_session"] instanceof Uint8Array
      ? (head["_r_session"] as Uint8Array)
      : undefined;
  const row = stamp(db, table, entity, heads, columns, 1, session);
  applyRow(db, table, row);
  return row;
}

/* ---------------------------------------------------- the invite carrier */

/**
 * Filters a **scratch** database down to one session, for the invite carrier
 * (T1-D28). Mutates the database it is given, so the caller passes a throwaway
 * copy of the sender's — never the sender's own, which is append-only and whose
 * other games must not be touched.
 *
 * The set of tables is **derived from the database shape, not handed in.** Every
 * replicated-shaped table — author tables and the roster's `_dai_seat` /
 * `_dai_binding` alike — is filtered to `session`; the two document tables
 * (`_dai_replica`, `_dai_replicas`) travel whole as this copy's identity; local
 * author tables are emptied (§4 keeps them off any carrier but a full export);
 * and a table that fits none of those paths is refused. This is deliberate and
 * load-bearing: an earlier version filtered only a caller's list of author
 * tables, so every *other* session's seat and binding rows travelled in the
 * invite — the whole roster of every group this person is in, leaving with a
 * two-person game. A caller cannot hand an incomplete list, because there is no
 * list to hand; the same structural fix as the merge-coverage guard.
 *
 * D4: a session's kept rows must be closed under `_r_parents`. An entity lives in
 * one session by construction, so this holds — and is asserted rather than
 * assumed, because a kept row naming a parent in another session is a malformed
 * source (an entity's history crossed sessions) and would export an invite with
 * a parent that never arrives.
 */
const DOCUMENT_TABLES = new Set(["_dai_replica", "_dai_replicas"]);

export function filterToSession(db: Rows, session: Uint8Array): void {
  const replicated: string[] = [];
  const local: string[] = [];
  for (const table of db
    .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .map((r) => String(r["name"]))) {
    if (DOCUMENT_TABLES.has(table)) continue; // this copy's identity — travels whole
    const columns = db.all(`SELECT name FROM pragma_table_info(?)`, [table]).map((c) => String(c["name"]));
    const isReplicated = columns.includes("_r_replica") && columns.includes("_r_seq");
    if (isReplicated) {
      if (!columns.includes("_r_session")) {
        // Every replicated table in a session document carries `_r_session`; one
        // without it is either a plain document, or a malformed session one.
        throw new SessionExportIncomplete(
          `${table} is a replicated table with no session column, so it cannot be filtered to a ` +
            "session. Either this is not a session document, or its schema is malformed.",
        );
      }
      replicated.push(table);
    } else if (table.startsWith("_dai")) {
      // A system table that is neither a known document table nor replicated fits
      // no path. Refusing rather than guessing whether it travels is the point:
      // guessing is what leaked the roster, and a Step 5 system table added
      // without classifying it here should fail loudly, not travel by default.
      throw new SessionExportIncomplete(
        `${table} fits neither the replicated nor the local path, so the export cannot decide ` +
          "whether it should travel. A new system table must be classified before it can be exported.",
      );
    } else {
      local.push(table);
    }
  }

  // D4 over every replicated table — author and roster alike, not a subset.
  for (const table of replicated) {
    const crossing = db.all(
      `SELECT count(*) AS n
         FROM "${table}" k
         JOIN json_each(k._r_parents) p
         JOIN "${table}" parent
           ON lower(hex(parent._r_replica)) || ':' || parent._r_seq = p.value
        WHERE k._r_session = ? AND parent._r_session != ?`,
      [session, session],
    );
    if (Number(crossing[0]?.["n"] ?? 0) > 0) {
      throw new SessionExportIncomplete(
        `In ${table}, a row kept for this session names a parent in another session. The source ` +
          "document is malformed — an entity's history has crossed sessions — so no honest invite " +
          "can be exported from it.",
      );
    }
  }

  // The scratch's append-only DELETE guard is dropped so the other sessions can
  // be removed; the recipient's open re-creates it from the schema block (§3).
  for (const table of replicated) {
    db.run(`DROP TRIGGER IF EXISTS "${table}__no_delete"`);
    db.run(`DELETE FROM "${table}" WHERE _r_session != ?`, [session]);
  }

  // Local (non-replicated) author tables travel as schema, emptied of rows.
  for (const table of local) db.run(`DELETE FROM "${table}"`);
}

/* -------------------------------------------------------------- the dump */

/**
 * One value, printed the way both implementations must print it (T1-D9).
 *
 * The rows are the easy part. Two languages agree on which rows are present
 * and disagree on how to write a float, and then the merge takes the blame.
 */
export function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (value instanceof Uint8Array) return hex(value);
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (Number.isInteger(value) && Object.is(value, Math.trunc(value)) && !Object.is(value, -0)) {
      // An integer column and a float column holding a whole number are
      // different storage classes, and SQLite reports them apart; this is only
      // reached for INTEGER, where a plain decimal is right.
      return String(value);
    }
    if (Number.isNaN(value)) return "nan";
    if (value === Number.POSITIVE_INFINITY) return "inf";
    if (value === Number.NEGATIVE_INFINITY) return "-inf";
    if (Object.is(value, -0)) return "-0.0";
    const text = String(value);
    // Always readable as a float, so a REAL holding 2 is never mistaken for
    // an INTEGER 2 in a diff.
    return /[.e]/.test(text) ? text : `${text}.0`;
  }
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n");
}

/**
 * The canonical dump a conformance vector compares (T1-D9).
 *
 * Not the file: SQLite bytes depend on page allocation and insertion order, so
 * two hosts that converged perfectly can hold different files.
 */
export function canonicalDump(db: Rows, tables: readonly string[]): string {
  const lines: string[] = [];
  for (const table of [...tables].sort()) {
    const columns = db.all(`SELECT name FROM pragma_table_info(?)`, [table]).map((r) => String(r["name"]));
    lines.push(`# ${table}`);
    const rows = db.all(
      `SELECT * FROM "${table}" ORDER BY hex(_r_replica) ASC, _r_seq ASC`,
    );
    for (const row of rows) lines.push(columns.map((name) => encodeValue(row[name])).join("\t"));
  }
  /*
   * The replicas this copy knows of — the ids, and only the ids (T1-D12).
   *
   * `first_seen` and `rows_seen` are observations about this copy's own
   * history, not facts about the document: A records seeing B on the merge
   * that introduced them and B records the same about A, so the two can never
   * agree and never should. The fixture generator caught this on its first
   * run, with every row converging perfectly and the dumps differing anyway.
   *
   * `label` is out for a different reason: at Level 1 it is a claim a replica
   * makes about itself, nothing propagates a rename, and two copies holding
   * different labels for one id have not failed to converge — they have heard
   * different things. The set of ids does converge, so that is what is
   * asserted here.
   */
  lines.push("# _dai_replicas");
  for (const row of db.all("SELECT id FROM _dai_replicas ORDER BY hex(id) ASC")) {
    lines.push(encodeValue(row["id"]));
  }
  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------- the merge */

export interface MergeResult {
  /** Rows this copy did not have. */
  applied: number;
  /** Rows it already had, unchanged. Every exchange re-sends everything. */
  duplicate: number;
  /** Row ids refused, and the reason is always the same one: a different row wearing that id. */
  rejected: string[];
  /** Replica ids this copy had never seen. */
  newReplicas: number;
}

/**
 * Union-merges a sibling's rows into this copy (§6).
 *
 * Nothing here decides anything. Union on a set keyed by `(_r_replica, _r_seq)`
 * is commutative, associative and idempotent, so the answer does not depend on
 * which copy merged which, nor in what order, nor how many times.
 *
 * At Level 1 there is nothing to verify. A replica id is a claim and a label is
 * a claim, and this reconciles them by union precisely because inferring
 * anything more from them would be inventing an authority Level 1 does not
 * have. Who wrote a row is Level 2's question.
 */
export function mergeFrom(
  local: Rows,
  sibling: Rows,
  tables: readonly string[],
): MergeResult {
  const result: MergeResult = { applied: 0, duplicate: 0, rejected: [], newReplicas: 0 };

  /*
   * The clock first, and durably before any local write that follows.
   *
   * A local row written after a merge must carry a clock above everything the
   * merge brought in. If the advance were left until after the rows, a crash
   * between the two would leave this copy able to write a row with a clock
   * lower than rows it has already seen — and `_current` picks the highest
   * `_r_lc`, so that row would lose to its own ancestors and the person's
   * newest edit would vanish behind an older one.
   */
  const before = Number(local.all("SELECT lc FROM _dai_replica LIMIT 1")[0]?.["lc"] ?? 0);
  let ceiling = before;
  ceiling = Math.max(ceiling, Number(sibling.all("SELECT lc FROM _dai_replica LIMIT 1")[0]?.["lc"] ?? 0));
  for (const table of tables) {
    const highest = sibling.all(`SELECT max(_r_lc) AS m FROM "${table}"`)[0]?.["m"];
    if (typeof highest === "number") ceiling = Math.max(ceiling, highest);
  }
  local.run("UPDATE _dai_replica SET lc = ?", [ceiling]);

  // Union, and nothing else. A replica id seen is a replica id known.
  const known = new Set(
    local.all("SELECT hex(id) AS h FROM _dai_replicas").map((row) => String(row["h"])),
  );
  const theirs = [
    ...sibling.all("SELECT id FROM _dai_replica"),
    ...sibling.all("SELECT id FROM _dai_replicas"),
  ];
  for (const replica of theirs) {
    const id = replica["id"] as Uint8Array;
    if (!(id instanceof Uint8Array)) continue;
    const key = [...id].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    if (known.has(key)) continue;
    known.add(key);
    result.newReplicas += 1;
    /*
     * The id, and nothing the sibling said about it.
     *
     * The label is deliberately not carried across (T1-D12). A label is a name
     * this copy gives a key, never a name the key carries — keys cannot be
     * faked and names can — so importing the sender's label would be a name
     * travelling with an identity, which is the one thing that decision
     * refused. This copy has not named this replica, so it has no name.
     *
     * `first_seen` is the local clock as it stood when the merge began, not
     * the ceiling it is about to become (T1-D19): it records where in this
     * copy's own timeline the replica appeared, and every replica arriving in
     * one exchange sharing the ceiling would record nothing at all.
     */
    local.run("INSERT INTO _dai_replicas (id, label, first_seen, rows_seen) VALUES (?, NULL, ?, 0)", [
      id,
      before,
    ]);
  }

  for (const table of tables) {
    const authored = authorColumnsOf(sibling, table);
    for (const incoming of sibling.all(`SELECT * FROM "${table}"`)) {
      const row = readRow(incoming, authored);
      try {
        if (applyRow(local, table, row) === "added") result.applied += 1;
        else result.duplicate += 1;
      } catch (error) {
        if (!(error instanceof RowRejected)) throw error;
        /*
         * One row refused, the rest still merged (T1-D13).
         *
         * A refusal must never be cheaper than the thing it refuses. Refusing
         * the whole exchange on one bad row would mean somebody who wanted to
         * stop two people syncing needed one malformed row rather than a
         * plausible document — the refusal becomes the attack. The same rule
         * governs the relay in Track 5.
         *
         * The id is reported so a person can be told what was dropped. Who
         * sent it is not, because at Level 1 nothing here knows: a replica id
         * is a claim, and reporting it as authorship would dress a guess as a
         * fact.
         */
        result.rejected.push(rowId(row._r_replica, row._r_seq));
      }
    }
  }

  return result;
}
