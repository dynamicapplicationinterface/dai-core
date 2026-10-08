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
import { encode as cborEncode, type CborValue } from "./cbor.js";
import { showAuthorId } from "./identity.js";
import type { BatchEntry } from "./replicated-batch.js";
import { PARENTS_CAP, closedSessionsSql, parentsSql } from "./replicated.js";
import { sessionIdOf, sha256 } from "./session-id.js";

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
  /**
   * The signed batch this row left its author's device in, or null while it is
   * pending: written and not yet sealed (docs/identity.md, step 3). Not part of
   * the row's identity or its canonical bytes: the batch is named after them.
   */
  _r_batch?: Uint8Array | null;
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
  { col: "_r_batch", key: "b", kind: "bytesOrNull" },
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

/**
 * The parents of a row, as ids. Sorted on the way in, so two writers agree.
 * Parents that are not the one shape name nothing, as `parentsSql` reads them
 * in the views (docs/format.md, `parents-own-malformed`): the shape is checked
 * before parents are read for any purpose, not only in a merge.
 */
export function parentsOf(row: { _r_parents: string; _r_replica?: Uint8Array; _r_seq?: number }): string[] {
  if (!wellFormedParents(row._r_parents, row._r_replica, row._r_seq)) return [];
  return JSON.parse(row._r_parents) as string[];
}

const PARENT_ID = /^[0-9a-f]{32}:[1-9][0-9]{0,15}$/;

/**
 * Whether a row's `_r_parents` is the one shape every reader walks alike
 * (D159): a flat JSON array of at most `PARENTS_CAP` row ids, each 32
 * lowercase hex characters, a colon and a seq. JavaScript's JSON.parse takes
 * nesting SQLite's json_each refuses (depth over 1000), and a row one reader
 * parses and another throws on stops every read that walks it. Given the row's
 * own author and seq, a parent naming that author at a seq at or above the
 * row's own is malformed too (R19): an honest writer names only rows it wrote
 * before, and a parent named ahead of its row let the row's author take back an
 * admitted row later by writing at that id.
 */
export function wellFormedParents(text: unknown, author?: Uint8Array, seq?: number): boolean {
  if (typeof text !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length > PARENTS_CAP) return false;
  const own = author instanceof Uint8Array ? hex(author) : null;
  return parsed.every(
    (p) =>
      typeof p === "string" &&
      PARENT_ID.test(p) &&
      Number.isSafeInteger(Number(p.slice(33))) &&
      !(own !== null && seq !== undefined && p.slice(0, 32) === own && Number(p.slice(33)) >= Number(seq)),
  );
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
    if (same) {
      /*
       * The same row, sealed where this copy still holds it pending: a save
       * that never landed, and the row coming back from the mailbox in the
       * batch it was published in. The copy takes the seal. The trigger allows
       * _r_batch to change exactly once, from NULL.
       */
      if (existing["_r_batch"] == null && row._r_batch instanceof Uint8Array) {
        db.run(`UPDATE "${table}" SET _r_batch = ? WHERE _r_replica = ? AND _r_seq = ?`, [
          row._r_batch,
          row._r_replica,
          row._r_seq,
        ]);
      }
      return "duplicate";
    }
    throw new RowRejected(
      `A different row already exists as ${id}. A replica issues each sequence number once, ` +
        "so two contents under one id cannot both be honest.",
    );
  }

  // Superseded on arrival if anything of its own entity already present names
  // this row as a parent. The DAG is not ordered by arrival, so this is not a
  // rare case. A row of another entity naming it says nothing about this
  // entity's history, and hides nothing (T1-D35).
  const namedAlready = db.all(
    `SELECT 1 FROM "${table}", json_each(${parentsSql(`"${table}"._r_parents`)})
      WHERE json_each.value = ? AND "${table}"._r_entity = ? LIMIT 1`,
    [id, row._r_entity],
  ).length > 0;

  const names = [
    ...authored,
    "_r_replica", "_r_seq", "_r_lc", "_r_entity", "_r_parents", "_r_deleted", "_r_superseded", "_r_batch",
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
    row._r_batch ?? null,
    ...(session ? [row._r_session as Uint8Array] : []),
  ];
  db.run(
    `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    values,
  );

  // And every parent this row names in its own entity is now superseded. Rows
  // that have not arrived yet are covered by the check above when they do.
  for (const parent of parentsOf(row)) {
    const [replicaHex, seq] = parent.split(":");
    if (!replicaHex || seq === undefined) continue;
    db.run(
      `UPDATE "${table}" SET _r_superseded = 1
        WHERE hex(_r_replica) = ? AND _r_seq = ? AND _r_entity = ?`,
      [replicaHex.toUpperCase(), Number(seq), row._r_entity],
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
 * `seq` resumes from the highest this id has already issued in the file, 0 if
 * none. The id is this device's author id (docs/identity.md), the same for
 * every copy the device holds, so a file can come back carrying rows this
 * device wrote before: a copy sent out and returned, or a document forgotten
 * and received again. Restarting at zero there would issue a `(replica, seq)`
 * this device already issued, and the next exchange refuses one of them as
 * `ROW_REJECTED`. The clock does **not** restart: this copy has seen
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
  db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, ?, ?)", [
    id,
    highestSeqOf(db, id),
    Number(current["lc"] ?? 0),
  ]);
  db.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, ?, 0)", [
    id,
    Number(current["lc"] ?? 0),
  ]);
  return true;
}

/** The highest `_r_seq` any replicated table holds under `id`, or 0. An index seek per table: the key is (_r_replica, _r_seq). */
export function highestSeqOf(db: Rows, id: Uint8Array): number {
  let highest = 0;
  for (const { name } of db.all("SELECT name FROM sqlite_schema WHERE type = 'table'") as { name: string }[]) {
    const columns = db.all("SELECT name FROM pragma_table_info(?)", [name]).map((c) => String(c["name"]));
    if (!columns.includes("_r_replica") || !columns.includes("_r_seq")) continue;
    const found = db.all(`SELECT max(_r_seq) AS m FROM "${name}" WHERE _r_replica = ?`, [id])[0]?.["m"];
    if (typeof found === "number" && found > highest) highest = found;
  }
  return highest;
}

const rowIdOf = (row: Record<string, unknown>): string => rowId(row["_r_replica"] as Uint8Array, Number(row["_r_seq"]));

/** What a write versions: the session it writes in, and the heads it names, first the one `_current` would show. */
export interface WriteTarget {
  session?: Uint8Array;
  /** In a seated table, the seat column and the seat the heads act for (D144). */
  seat?: { column: string; value: Uint8Array };
  heads: Record<string, unknown>[];
}

/**
 * The heads a write of this copy versions, found the way admission finds them
 * (D135 to D138).
 *
 * Admission partitions an entity: in an admission-filtered session table by
 * (session, entity), in a seated table by seat too (D131, D132). A writer that
 * found heads by the id alone, through the stored `_r_superseded` flag, took a
 * stranger's row reusing the id in another session or seat as a head, and
 * wrote a row every copy refuses, or into the stranger's session. So a writer
 * reads the one view the merge admits by, and only a partition this copy
 * writes in:
 *
 * - a plain table: `t_heads`, the entity alone;
 * - an admission-filtered session table: `t_heads` in a session this copy is a
 *   member of or waits in (in a seated table, its own rows, since an admitted
 *   row's author holds its seat), and this copy's own rows waiting in
 *   `t_waiting`, tombstones included (D143), less any head one of them
 *   already versions;
 * - a roster table (`_dai_seat` and its kin): this copy's own versions, as
 *   `_dai_open_seat` and `_dai_holder` count only the creator's.
 *
 * In a session table a row is named by its session and its id (D134, batch
 * format version 2): the caller names the session, and only that session is
 * read, so an id reused in another session is never a head of this write. An
 * id with no session there names no row, and is refused. No partition in the
 * named session is a write nobody would admit, refused too; in a seated table,
 * versions of one id in two seats of one session are refused, not guessed.
 */
export function writeTargetOf(db: Rows, table: string, entity: Uint8Array, session?: Uint8Array): WriteTarget {
  const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;
  // The order `_current` shows by: the highest clock, then the lowest author id, then the lowest seq.
  const order = (rows: Record<string, unknown>[]) =>
    [...new Map(rows.map((row) => [rowIdOf(row), row])).values()].sort((a, b) => {
      const ra = hex(a["_r_replica"] as Uint8Array);
      const rb = hex(b["_r_replica"] as Uint8Array);
      return Number(b["_r_lc"]) - Number(a["_r_lc"]) || (ra < rb ? -1 : ra > rb ? 1 : 0) || Number(a["_r_seq"]) - Number(b["_r_seq"]);
    });
  if (!hasSessionColumn(db, table)) {
    return { heads: order(db.all(`SELECT * FROM ${quoted(`${table}_heads`)} WHERE _r_entity = ?`, [entity])) };
  }
  if (!session) {
    throw new RowRejected(`A ${table} row is named by its session and its id, and this write names no session.`);
  }
  const me = replicaState(db).id;
  const view = (name: string) => db.all("SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = ?", [name]).length > 0;
  let seat: string | undefined;
  let rows: Record<string, unknown>[];
  if (view(`${table}_pending`)) {
    const column = view("_dai_seat_rules") ? db.all("SELECT col FROM _dai_seat_rules WHERE tbl = ?", [table])[0]?.["col"] : undefined;
    seat = typeof column === "string" ? column : undefined;
    // A session this copy writes in: one it is a member of, or one it waits in,
    // having asked for an open seat nobody holds yet, since its rows there are
    // pending, not refused, and admitted once it is confirmed.
    const mine = seat
      ? "h._r_replica = ?1"
      : "(EXISTS (SELECT 1 FROM _dai_member m WHERE m.session = h._r_session AND m.replica = ?1)" +
        " OR EXISTS (SELECT 1 FROM _dai_binding_current b JOIN _dai_open_seat s ON s.session = b._r_session AND s.seat = b.seat" +
        " WHERE b._r_session = h._r_session AND b._r_replica = ?1" +
        " AND NOT EXISTS (SELECT 1 FROM _dai_holder x WHERE x.session = s.session AND x.seat = s.seat)))";
    // This copy's own waiting versions come from `_waiting`, which keeps its
    // tombstones (D143); `_pending` is what a screen shows.
    const waiting = view(`${table}_waiting`) ? `${table}_waiting` : `${table}_pending`;
    rows = [
      ...db.all(`SELECT h.* FROM ${quoted(`${table}_heads`)} h WHERE h._r_entity = ?2 AND h._r_session = ?3 AND ${mine}`, [me, entity, session]),
      ...db.all(`SELECT * FROM ${quoted(waiting)} WHERE _r_entity = ? AND _r_replica = ? AND _r_session = ?`, [entity, me, session]),
    ];
    // An admitted head this copy's own waiting row already versions is not a
    // head of its next write: seated, the waiting row would be admitted and the
    // head behind it. So a waiting write names what the same write names seated.
    const named = new Set(
      rows.flatMap((r) => parentsOf({ _r_parents: String(r["_r_parents"] ?? "[]"), _r_replica: r["_r_replica"] as Uint8Array, _r_seq: Number(r["_r_seq"]) })),
    );
    rows = rows.filter((r) => !named.has(rowIdOf(r)));
  } else {
    const t = quoted(table);
    rows = db.all(
      `SELECT * FROM ${t} r WHERE r._r_entity = ? AND r._r_replica = ? AND r._r_session = ?
         AND NOT EXISTS (SELECT 1 FROM ${t} n, json_each(${parentsSql("n._r_parents")}) p
                          WHERE n._r_entity = r._r_entity AND n._r_session = r._r_session AND n._r_replica = r._r_replica
                            AND p.value = lower(hex(r._r_replica)) || ':' || r._r_seq)`,
      [entity, me, session],
    );
  }
  const partitions = new Set(rows.map((r) => (seat ? hex(r[seat] as Uint8Array) : "")));
  if (partitions.size === 0) {
    throw new RowRejected(`This copy holds no version of that ${table} row it may write: nothing to change or delete.`);
  }
  if (partitions.size > 1) {
    throw new RowRejected(
      `That ${table} row has versions in ${partitions.size} seats of its session; a write to one would be a guess.`,
    );
  }
  const heads = order(rows);
  return seat ? { session, seat: { column: seat, value: heads[0]![seat] as Uint8Array }, heads } : { session, heads };
}

/** The ids of the heads a write of this copy versions (`writeTargetOf`), sorted, for a row that supersedes them. */
export function headsOf(db: Rows, table: string, entity: Uint8Array, session?: Uint8Array): string[] {
  return writeTargetOf(db, table, entity, session).heads.map(rowIdOf).sort();
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
  session?: Uint8Array,
): ReplicatedRow {
  // In a session table the caller names the session with the entity (D134):
  // a row is (session, entity), and the heads are the ones admission reads in
  // that session alone (`writeTargetOf`). The version stays in it (T1-D28).
  const target = writeTargetOf(db, table, entity, session);
  // In a seated table a version acts for its heads' seat, which is the
  // partition it replaces: naming another would be a row admission never takes
  // and nothing reports (D144).
  if (target.seat) {
    const named = columns[target.seat.column];
    if (!(named instanceof Uint8Array) || hex(named) !== hex(target.seat.value)) {
      throw new RowRejected(`SEAT_NOT_HELD: a change of a ${table} row acts for the seat its earlier version acts for, and this one names another.`);
    }
  }
  const row = stamp(db, table, entity, target.heads.map(rowIdOf), columns, 0, target.session);
  applyRow(db, table, row);
  return row;
}

/** A delete: a tombstone carrying the columns of the head it buries. */
export function deleteEntity(db: Rows, table: string, entity: Uint8Array, session?: Uint8Array): ReplicatedRow {
  const authored = authorColumnsOf(db, table);
  // The heads and the head whose columns the tombstone carries come from the
  // one session the caller names (D134) and the partition this copy writes in
  // there (D137): a row of another session or seat reusing the id is neither
  // buried nor copied.
  const target = writeTargetOf(db, table, entity, session);
  const head = target.heads[0];
  const columns: Record<string, unknown> = {};
  for (const name of authored) columns[name] = head ? head[name] : null;
  const row = stamp(db, table, entity, target.heads.map(rowIdOf), columns, 1, target.session);
  applyRow(db, table, row);
  return row;
}

/* ------------------------------------------------------- the seat writers */

/** What a new session is made from: fresh random bytes, 16 each, and the close rule. */
export interface NewSession {
  /** The creator's own seat. */
  creatorSeat: Uint8Array;
  /** The open seats, distinct and none the creator's: at most max_parties - 1 of them (R14). */
  openSeats: readonly Uint8Array[];
  /** The close rule the session keeps, from the manifest's session profile. */
  close: "any" | "creator";
  /** The entity of the creator's seat row. */
  entity: Uint8Array;
}

/**
 * A new session under this copy's author: one row, the creator's seat row,
 * declaring the roster (R14): her seat, the open seats as one run of 16-byte
 * values, and the close rule. Its id commits to that row,
 * `SHA-256(author ‖ seq ‖ CBOR([seat, seats, close]))` first 16 bytes, the seq
 * the one the row is about to be stamped with (D158, R15), which is what makes
 * the creator and her roster checkable from the rows. A roster that is not
 * valid is refused here, since every copy would read its session as void.
 * Returns the session id.
 */
export function startSession(db: Rows, ids: NewSession): Uint8Array {
  const bound = Number(db.all("SELECT max_parties AS n FROM _dai_session_rules")[0]?.["n"] ?? 0);
  const values = [ids.creatorSeat, ...ids.openSeats].map(hex);
  if (
    [ids.creatorSeat, ...ids.openSeats].some((v) => !(v instanceof Uint8Array) || v.length !== 16) ||
    new Set(values).size !== values.length ||
    values.length > bound ||
    (ids.close !== "any" && ids.close !== "creator")
  ) {
    throw new RowRejected(
      `A session's roster is the creator's seat and up to ${Math.max(bound - 1, 0)} open seats, each 16 bytes and all different, and a close rule of any or creator.`,
    );
  }
  const seats = new Uint8Array(16 * ids.openSeats.length);
  ids.openSeats.forEach((v, i) => seats.set(v, 16 * i));
  const state = replicaState(db);
  const session = sessionIdOf(state.id, state.seq + 1, ids.creatorSeat, seats, ids.close);
  if (!session) throw new RowRejected("A session id needs a 16-byte author id and the seq of the creator's seat row.");
  const row = createEntity(db, "_dai_seat", ids.entity, { seat: ids.creatorSeat, seats, close: ids.close }, session);
  // The id names this row; a row stamped at any other seq would name nothing.
  if (row._r_seq !== state.seq + 1) throw new RowRejected("The creator's seat row was not stamped at the seq its session names.");
  return session;
}

/**
 * The creator's confirmation that `holder` holds `seat`: the only thing that
 * seats anyone in an open seat. Only rows by the session's creator count, so a
 * caller checks that this copy is the creator first.
 */
export function confirmSeat(db: Rows, session: Uint8Array, seat: Uint8Array, holder: Uint8Array, entity: Uint8Array): void {
  createEntity(db, "_dai_confirm", entity, { seat, holder }, session);
}

/**
 * The sessions `me` takes part in, as lowercase hex: those it holds a seat in,
 * and those it waits in, having asked for an open seat nobody holds yet
 * (admission's `waiting`). What the host opens a mailbox for (D149): a session
 * that merely arrived in a file, in which this copy holds and asks for nothing,
 * is none of its business.
 */
export function sessionsOf(db: Rows, me: Uint8Array): string[] {
  if (db.all("SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = '_dai_member'").length === 0) return [];
  return db
    .all(
      "SELECT lower(hex(session)) AS s FROM _dai_member WHERE replica = ?1 " +
        "UNION SELECT lower(hex(b._r_session)) FROM _dai_binding_current b " +
        "JOIN _dai_open_seat o ON o.session = b._r_session AND o.seat = b.seat " +
        "WHERE b._r_replica = ?1 AND NOT EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = o.session AND h.seat = o.seat) " +
        "ORDER BY 1",
      [me],
    )
    .map((row) => String(row["s"]));
}

/**
 * The closed sessions, as lowercase hex, under the document's close rule: what
 * the host stops polling. `_dai_closed` where the document has it; for one built
 * before it, the same rule over the close table (D154). A document with no
 * close table, or older than the seat views (D155), has none.
 */
export function closedSessionsOf(db: Rows, policy: "any" | "creator"): string[] {
  const has = (type: "table" | "view", name: string): boolean =>
    db.all("SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?", [type, name]).length > 0;
  if (has("view", "_dai_closed")) return db.all("SELECT lower(hex(session)) AS s FROM _dai_closed ORDER BY 1").map((row) => String(row["s"]));
  if (!has("table", "_dai_close") || !has("view", policy === "creator" ? "_dai_creator" : "_dai_member")) return [];
  return db.all(closedSessionsSql(policy === "creator")).map((row) => String(row["s"]));
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
/*
 * `_dai_meta` joined when the filter first ran on a document an application had
 * opened: the runtime creates it on every open to record the schema digest the
 * data was made under, and reads it back on the next open to decide whether the
 * data needs migrating. It describes the document's data, not any session, and
 * an invite carries the same application and schema — so it travels whole. The
 * filter's earlier tests built their databases directly and never had one.
 */
const DOCUMENT_TABLES = new Set(["_dai_replica", "_dai_replicas", "_dai_meta"]);

export function filterToSession(db: Rows, session: Uint8Array): void {
  const replicated: string[] = [];
  const local: string[] = [];
  for (const table of db
    .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .map((r) => String(r["name"]))) {
    if (DOCUMENT_TABLES.has(table)) continue; // this copy's identity — travels whole
    if (table === "_dai_batch") continue; // signed headers: filtered to the kept rows' below
    // Each header's listings, derived from `_dai_batch` by its triggers: a header
    // the filter removes takes its listings with it (D160).
    if (table === "_dai_covers") continue;
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

  // D4 over every replicated table — author and roster alike, not a subset. A
  // parent of another entity is not the row's history (T1-D35), so only a
  // parent of the row's own entity can cross.
  for (const table of replicated) {
    const crossing = db.all(
      `SELECT count(*) AS n
         FROM "${table}" k
         JOIN json_each(${parentsSql("k._r_parents")}) p
         JOIN "${table}" parent
           ON lower(hex(parent._r_replica)) || ':' || parent._r_seq = p.value
          AND parent._r_entity = k._r_entity
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

  /*
   * The signed batch headers travel, but only those whose rows all travel
   * (docs/identity.md). A batch is sealed per session, so an invite for one game
   * carries that game's signatures and nothing about any other. By what a header
   * lists, not by what the rows name: a row's `_r_batch` is a cache a lost save
   * can leave unset, and the header is what says it was signed (ruling #3).
   */
  const hasBatches =
    db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_dai_batch'").length > 0;
  if (hasBatches) {
    const kept = replicated
      .map((table) => `SELECT '${table}' AS t, _r_replica AS r, _r_seq AS s FROM "${table}"`)
      .join(" UNION ALL ");
    db.run(
      kept
        ? `DELETE FROM _dai_batch WHERE EXISTS (SELECT 1 FROM json_each(_dai_batch.covers) AS listed
             WHERE NOT EXISTS (SELECT 1 FROM (${kept}) AS k
               WHERE k.t = json_extract(listed.value, '$[0]') AND k.r = _dai_batch.author
                 AND k.s = json_extract(listed.value, '$[1]')))`
        : "DELETE FROM _dai_batch",
    );
  }
}

/* -------------------------------------------------------------- the dump */

/**
 * One value, printed the way both implementations must print it (T1-D9).
 *
 * The rows are the easy part. Two languages agree on which rows are present
 * and disagree on how to write a float, and then the merge takes the blame.
 *
 * `storage` is the value's SQLite storage class (`typeof()`), which a dump
 * must pass: SQLite hands a REAL 2.0 to JavaScript as the number 2, the same
 * as an INTEGER 2, so the value alone cannot say which it was, and a whole
 * REAL written as `2` is the bug the dump's float rule exists to prevent
 * (docs/format.md#merge-dump; branch review pass A, H2). Without it a whole
 * number is written as an integer.
 */
export function encodeValue(value: unknown, storage?: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (value instanceof Uint8Array) return hex(value);
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (storage !== "real" && Number.isInteger(value) && !Object.is(value, -0)) return String(value);
    if (Number.isNaN(value)) return "nan";
    if (value === Number.POSITIVE_INFINITY) return "inf";
    if (value === Number.NEGATIVE_INFINITY) return "-inf";
    if (Object.is(value, -0)) return "-0.0";
    // The shortest digits that read back as the same double, placed as
    // docs/format.md#dump-real says (which is how String() places them), and
    // always readable as a float: a REAL holding 2 is `2.0`, never `2`.
    const text = String(value);
    return /[.e]/.test(text) ? text : `${text}.0`;
  }
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n");
}

/**
 * A replicated table's rows as the dump writes them, one line each, ordered by
 * author id and seq, the `columns` given in that order, each value written
 * with its storage class (`encodeValue`).
 */
export function dumpRows(db: Rows, table: string, columns: readonly string[]): string[] {
  const picked = columns.map((name, i) => `"${name}" AS "v${i}", typeof("${name}") AS "s${i}"`).join(", ");
  return db
    .all(`SELECT ${picked} FROM "${table}" ORDER BY hex(_r_replica) ASC, _r_seq ASC`)
    .map((row) => columns.map((_, i) => encodeValue(row[`v${i}`], row[`s${i}`])).join("\t"));
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
    lines.push(...dumpRows(db, table, columns));
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
  /*
   * The signed batch headers (docs/identity.md), every column: a header is the
   * same bytes on every copy that holds it, so two copies that merged agree on
   * the set. In the dump so that a reader that does not carry them disagrees
   * out loud, rather than passing for an unrelated reason.
   */
  if (db.all("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_dai_batch'").length > 0) {
    lines.push("# _dai_batch");
    for (const row of db.all(
      "SELECT id, author, lc, sig, pub, att, version, digest, covers FROM _dai_batch ORDER BY hex(id) ASC",
    )) {
      lines.push(["id", "author", "lc", "sig", "pub", "att", "version", "digest", "covers"].map((c) => encodeValue(row[c])).join("\t"));
    }
  }
  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------- the merge */

/** Why a merge refused a batch (src/refusals.ts). */
export type BatchRefusal =
  | "BATCH_SIGNATURE_INVALID"
  | "BATCH_DIGEST_MISMATCH"
  | "BATCH_UNSIGNED"
  | "ROW_MALFORMED"
  | "SEAT_NOT_HELD"
  | "ENTITY_OTHER_SESSION"
  | "AUTHOR_EQUIVOCATED";

/**
 * What verifying one signed header found (`verifyBatches`), keyed by the
 * header's id in lowercase hex: the author's, with the rows it lists and
 * whether this copy holds them all as signed (`complete`), or not the author's
 * and why. An authentic header that is not complete is kept and takes no row.
 */
export type BatchVerdict =
  | { ok: true; author: Uint8Array; covers: readonly (readonly [string, number])[]; complete: boolean }
  | { ok: false; author: Uint8Array; reason: BatchRefusal };

/** A batch the merge refused, by the author it names and the reason's code. */
export interface RefusedBatch {
  author: string;
  reason: BatchRefusal;
}

/** Code-unit order, the same in every reader; never a locale's. */
const plainOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Bytewise order of two strings' UTF-8, the order every canonical list is sorted by. */
function utf8Order(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/**
 * The canonical bytes of a batch's rows (format version 1; the layout is held
 * by tests/identity-vectors.spec.ts): a CBOR array of rows ordered by table,
 * then `_r_seq`, each `[table, [replica, seq, lc, entity, parents, deleted,
 * session|null], [[column, value]...]]`, the columns ordered by name.
 * `_r_batch` is not in it: the batch is named after the rows, not before.
 */
export function canonicalRows(entries: readonly BatchEntry[]): Uint8Array {
  const ordered = [...entries].sort((a, b) => utf8Order(a.table, b.table) || a.row._r_seq - b.row._r_seq);
  return cborEncode(
    ordered.map(({ table, row }) => [
      table,
      [
        row._r_replica,
        row._r_seq,
        row._r_lc,
        row._r_entity,
        row._r_parents,
        row._r_deleted,
        row._r_session instanceof Uint8Array ? row._r_session : null,
      ],
      Object.keys(row.columns)
        .sort(utf8Order)
        .map((name) => [name, (row.columns[name] ?? null) as CborValue]),
    ]),
  );
}

/**
 * The list a header this copy holds stores, when the header is complete here
 * (docs/format.md, verify-complete): every row the list names found, as the
 * header's author's row in the table listed, and the digest over them the
 * header's. Otherwise null. Synchronous, for the merge, which may hold a
 * transaction open; not a check of the signature, since the copy's own
 * headers are not verified (equivocation-own-headers).
 */
function completeHere(db: Rows, tables: readonly string[], header: Record<string, unknown>): [string, number][] | null {
  const covers = coveredRowsOf(header["covers"]);
  if (!covers || !(header["digest"] instanceof Uint8Array)) return null;
  const entries: BatchEntry[] = [];
  for (const [table, seq] of covers) {
    if (!tables.includes(table)) return null;
    const found = db.all(`SELECT * FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [header["author"], seq]);
    if (found.length !== 1) return null;
    entries.push({ table, row: readRow(found[0]!, authorColumnsOf(db, table)) });
  }
  return hex(sha256(canonicalRows(entries))) === hex(header["digest"]) ? covers : null;
}

/**
 * The `covers` a header stores: its rows as `[table, seq]`, the author being the
 * header's, ordered by table (UTF-8 bytes) and then seq, as JSON. By table as
 * well as seq, so a row is found where it was signed and nowhere else (cold
 * review of step 4, finding 1).
 */
export function coversText(entries: readonly { table: string; row: { _r_seq: number } }[]): string {
  const pairs = entries.map((e) => [e.table, e.row._r_seq] as const);
  pairs.sort((a, b) => utf8Order(a[0], b[0]) || a[1] - b[1]);
  return JSON.stringify(pairs);
}

/**
 * A header's `covers`, or null when it is not the one spelling `coversText`
 * writes: a non-empty JSON array of distinct `[table, seq]` pairs, each seq a
 * positive integer, in that order, and no seq twice in any tables. One
 * spelling, so two readers never disagree about which rows a header lists; and
 * one seq is one row (docs/format.md, `covers-spelling`), so a list that
 * repeats one is not a list, and no header is authentic under it.
 */
export function coveredRowsOf(text: unknown): [string, number][] | null {
  if (typeof text !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const shaped = parsed.every(
    (p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && Number.isSafeInteger(p[1]) && p[1] > 0,
  );
  if (!shaped) return null;
  const pairs = parsed as [string, number][];
  for (let i = 1; i < pairs.length; i++) {
    const order = utf8Order(pairs[i - 1]![0], pairs[i]![0]) || pairs[i - 1]![1] - pairs[i]![1];
    if (order >= 0) return null;
  }
  if (new Set(pairs.map(([, seq]) => seq)).size !== pairs.length) return null;
  if (JSON.stringify(pairs) !== text) return null;
  return pairs;
}

export interface MergeResult {
  /** Rows this copy did not have. */
  applied: number;
  /** Rows it already had, unchanged. Every exchange re-sends everything. */
  duplicate: number;
  /** Row ids refused, and the reason is always the same one: a different row wearing that id. */
  rejected: string[];
  /** Replica ids this copy had never seen. */
  newReplicas: number;
  /**
   * Batches refused, one entry per batch and reason, ordered by batch id. Always
   * present, empty when nothing was refused. Not `rejected`, which counts row ids
   * reused, and not `refused`, which means the merge did not run.
   */
  refusedBatches: RefusedBatch[];
  /**
   * Set when the merge did not run: the two copies' signed views differ
   * (`SIGNED_VIEW_MISMATCH`, R16), so nothing was taken. Absent otherwise.
   */
  refused?: string;
}

/** What a merge is told beside the two copies. */
export interface MergeOptions {
  /**
   * Each copy's signed-view digest (the manifest's signed bytes, hashed): two
   * that differ are two builds of the document, which may declare a different
   * bound or tables, and the merge refuses the sibling whole (R16). A caller
   * that knows neither passes none, and nothing is compared.
   */
  views?: { local: string; sibling: string };
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
  /** This copy's own author, as the host holds it (binding rule 1); never read from a row. */
  author?: Uint8Array,
  /**
   * The sibling's signed headers, verified (`verifyBatches`). Nothing verified
   * is the default, and then nothing sealed is taken: a seal is adopted only
   * once it has been checked (identity ruling #3).
   */
  verdicts: ReadonlyMap<string, BatchVerdict> = new Map(),
  options: MergeOptions = {},
): MergeResult {
  const result: MergeResult = { applied: 0, duplicate: 0, rejected: [], newReplicas: 0, refusedBatches: [] };
  /*
   * Two builds of one document are two sets of rules over the same rows: one
   * declaring max_parties=2 and one 3 seat different holders for the same rows
   * (the ninth attack review, A04). Which one is right is not the merge's to
   * choose, so it takes nothing (R16).
   */
  if (options.views && options.views.local !== options.views.sibling) return { ...result, refused: "SIGNED_VIEW_MISMATCH" };
  const refusals = new Map<string, { id: string; author: Uint8Array; reason: BatchRefusal }>();
  const refuseBatch = (id: string, who: Uint8Array, reason: BatchRefusal): void => {
    refusals.set(`${id}|${reason}|${hex(who)}`, { id, author: who, reason });
  };
  // The seats a creator confirmed to two copies (D165), keyed by session and
  // seat: the creator signing twice. Not a seat void because its holder is an
  // equivocator (R17), which accuses the holder, not her, and is revealed as
  // his equivocation is.
  const hasView = (name: string): boolean => local.all("SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = ?", [name]).length > 0;
  const voidedSeats = (): Map<string, Uint8Array> =>
    !hasView("_dai_voided")
      ? new Map()
      : new Map(
          local
            .all("SELECT * FROM _dai_voided")
            .filter((r) => !("holders" in r) || Number(r["holders"]) > 1)
            .map((r) => [`${hex(r["session"] as Uint8Array)}|${hex(r["seat"] as Uint8Array)}`, r["creator"] as Uint8Array]),
        );
  const voidedBefore = voidedSeats();
  // The authors who wrote in a session after a close of theirs there that
  // counts (R18), by session: equivocation, revealed by the merge that makes
  // it true.
  const closeEquivocated = (): Set<string> =>
    !hasView("_dai_close_equivocated")
      ? new Set()
      : new Set(local.all("SELECT session, replica FROM _dai_close_equivocated").map((r) => `${hex(r["session"] as Uint8Array)}|${hex(r["replica"] as Uint8Array)}`));
  const closeEquivocatedBefore = closeEquivocated();

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

  /*
   * The signed headers travel with the rows they cover (docs/identity.md). A
   * header is the same bytes on every copy, so this is a union by id, of the
   * verified ones only; a header that did not verify is refused and reported
   * with the author it names. Before the rows: a row may name only a header this
   * copy holds.
   *
   * Which rows a header covers is its own list, checked by the verifier against
   * the digest; a row's `_r_batch` is a cache of one covering header (ruling
   * #3). A row may be covered by more than one: the same rows sealed again after
   * a save that held the first seal was lost.
   */
  const hasBatchTable = (rows: Rows): boolean =>
    rows.all("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_dai_batch'").length > 0;
  // The headers this copy held before the merge: its own, sealed here or kept before.
  const heldBefore = new Set(hasBatchTable(local) ? local.all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => String(r["id"])) : []);
  const held = new Map<string, Uint8Array>(); // every header the sibling holds, by id
  const covering = new Map<string, string>(); // "table|author:seq" -> the lowest verified id listing it
  const covers = new Set<string>(); // "id|table|author:seq", every verified listing
  /*
   * A row whose parents are not the one shape is refused before anything else
   * reads it (D159), and so is every row of a batch that signed one: the
   * author signed them together, and a header kept without one of its rows
   * would fail at the next copy in the author's name. The header is not kept.
   */
  const malformed = new Set<string>(); // "table|author:seq"
  for (const table of tables) {
    for (const r of sibling.all(`SELECT _r_replica, _r_seq, _r_parents FROM "${table}"`)) {
      if (!wellFormedParents(r["_r_parents"], r["_r_replica"] as Uint8Array, Number(r["_r_seq"]))) malformed.add(`${table}|${rowId(r["_r_replica"] as Uint8Array, Number(r["_r_seq"]))}`);
    }
  }
  const tainted = new Set<string>(); // "table|author:seq" listed by a header that signed a malformed row
  /*
   * The headers that reveal an author signing twice, by author (D160, D165):
   * a merge reports what it made true, once per author, filed under the lowest
   * revealing header (D171). Reported with the rest, at the end.
   */
  const revealed = new Map<string, { author: Uint8Array; ids: string[] }>();
  const reveal = (who: Uint8Array, id: string): void => {
    const entry = revealed.get(hex(who)) ?? { author: who, ids: [] };
    entry.ids.push(id);
    revealed.set(hex(who), entry);
  };
  if (hasBatchTable(local) && hasBatchTable(sibling)) {
    // The ids already signed twice here, so a header reveals only a new one.
    const equivocatedBefore = new Set(
      local.all("SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = '_dai_equivocated'").length === 0
        ? []
        : local
            .all("SELECT lower(hex(author)) AS a, seq FROM _dai_equivocated")
            .map((r) => `${String(r["a"])}|${Number(r["seq"])}`),
    );
    const headers = sibling
      .all("SELECT id, author, lc, sig, pub, att, version, digest, covers FROM _dai_batch")
      .sort((a, b) => plainOrder(hex(a["id"] as Uint8Array), hex(b["id"] as Uint8Array)));
    const arrived: { id: Uint8Array; author: Uint8Array; digest: Uint8Array; covers: readonly (readonly [string, number])[] }[] = [];
    for (const header of headers) {
      const id = hex(header["id"] as Uint8Array);
      held.set(id, header["id"] as Uint8Array);
      const verdict = verdicts.get(id);
      if (!verdict || !verdict.ok) {
        // Not checked is not signed: a header nobody verified is refused as one
        // whose signature does not verify.
        refuseBatch(id, header["author"] as Uint8Array, verdict && !verdict.ok ? verdict.reason : "BATCH_SIGNATURE_INVALID");
        continue;
      }
      const listed = verdict.covers.map(([table, seq]) => `${table}|${rowId(verdict.author, seq)}`);
      if (verdict.complete && listed.some((key) => malformed.has(key))) {
        for (const key of listed) tainted.add(key);
        refuseBatch(id, verdict.author, "ROW_MALFORMED");
        continue;
      }
      /*
       * Kept under the list it signed, whatever list the sibling stored: a
       * relabeled list was recovered by the verifier (D161), and is not passed
       * on. Kept whether or not this copy holds its rows: an authentic header is
       * the author's statement, and the evidence of two conflicting ones has to
       * travel with every copy (D160).
       */
      const isNew = local.all("SELECT 1 FROM _dai_batch WHERE id = ?", [header["id"]]).length === 0;
      const signedList = JSON.stringify(verdict.covers);
      local.run(
        "INSERT OR IGNORE INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [header["id"], header["author"], header["lc"], header["sig"], header["pub"], header["att"] ?? null, header["version"], header["digest"], signedList],
      );
      // A header this copy held already, under a relabeled list, is rewritten to
      // the list it signed: the stored list is a cache of the signed one, and a
      // cache that disagrees with what verified is the one that changes (the
      // step 6 re-review).
      if (!isNew) local.run("UPDATE _dai_batch SET covers = ? WHERE id = ? AND covers <> ?", [signedList, header["id"], signedList]);
      if (isNew) arrived.push({ id: header["id"] as Uint8Array, author: verdict.author, digest: header["digest"] as Uint8Array, covers: verdict.covers });
      // Rows are taken only through a header whose rows the sibling holds, as signed.
      if (!verdict.complete) continue;
      for (const [table, seq] of verdict.covers) {
        const key = `${table}|${rowId(verdict.author, seq)}`;
        covers.add(`${id}|${key}`);
        if (!covering.has(key)) covering.set(key, id);
      }
    }
    /*
     * Equivocation (D160): two authentic headers of one author listing one row
     * id with different digests. An honest author never has two headers over one
     * row (a header leaves only in landed bytes, and the host signs only above
     * the floor), so this is the author signing two histories. Neither row at
     * that id is admitted, on any copy holding both headers (`_dai_equivocated`,
     * src/replicated.ts). A header this merge kept reveals it when it makes an
     * id equivocated that was not before; a third conflicting header at an id
     * already signed twice reveals nothing new (D171). The id is the author and
     * the seq, whatever table either header lists it in (batch format version
     * 2, the step 6 review).
     */
    for (const h of arrived) {
      const reveals = h.covers.some(
        ([, seq]) =>
          !equivocatedBefore.has(`${hex(h.author)}|${seq}`) &&
          local.all("SELECT 1 FROM _dai_covers WHERE author = ? AND seq = ? AND id <> ? AND digest <> ? LIMIT 1", [
            h.author,
            seq,
            h.id,
            h.digest,
          ]).length > 0,
      );
      if (reveals) reveal(h.author, hex(h.id));
    }
  }

  /*
   * A row this copy holds with `_r_batch` unset, listed by a header the copy
   * held before the merge that is complete here, is signed, not pending: the
   * save that wrote the header lost the row's pointer, or the rows were sealed
   * again after. The merge sets the cache, to the lowest such header, before
   * any row is placed, so a signed row arriving at that id, in any table, meets
   * a signed row and does not outrank it (the step 6 re-review, silence A).
   * Only the headers that list a pending row are digested.
   */
  if (heldBefore.size > 0) {
    const pending = new Map<string, { table: string; replica: Uint8Array; seq: number }>();
    for (const table of tables) {
      for (const r of local.all(`SELECT _r_replica, _r_seq FROM "${table}" WHERE _r_batch IS NULL`)) {
        const replica = r["_r_replica"] as Uint8Array;
        pending.set(`${table}|${rowId(replica, Number(r["_r_seq"]))}`, { table, replica, seq: Number(r["_r_seq"]) });
      }
    }
    const own = pending.size === 0
      ? []
      : local
          .all("SELECT id, author, digest, covers FROM _dai_batch")
          .filter((h) => heldBefore.has(hex(h["id"] as Uint8Array)))
          .sort((a, b) => plainOrder(hex(a["id"] as Uint8Array), hex(b["id"] as Uint8Array)));
    for (const header of own) {
      const author = header["author"] as Uint8Array;
      const listed = (coveredRowsOf(header["covers"]) ?? []).map(([table, seq]) => `${table}|${rowId(author, seq)}`);
      if (!listed.some((key) => pending.has(key)) || !completeHere(local, tables, header)) continue;
      for (const key of listed) {
        const row = pending.get(key);
        if (!row) continue;
        local.run(`UPDATE "${row.table}" SET _r_batch = ? WHERE _r_replica = ? AND _r_seq = ? AND _r_batch IS NULL`, [header["id"], row.replica, row.seq]);
        pending.delete(key);
      }
    }
  }

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

  /*
   * Signed means listed by a verified header, whatever the row says. The row's
   * own pointer is kept when it names a header that lists it, and otherwise set
   * to the one that does. A row that claims a batch and is listed by none is
   * refused: it names a signature that does not vouch for it
   * (BATCH_DIGEST_MISMATCH, in the name of whoever wrote the row, unless the
   * batch it names was refused already). A row that claims none and is listed by
   * none is unsigned, and is refused in every table (BATCH_UNSIGNED, batch
   * format version 2): nobody's key vouches for it, so it is nobody's row. It
   * began in the seat and close tables (D133, D147), where an unsigned confirm
   * under the creator's id seated whoever wrote it; the legacy rule that let it
   * merge anywhere else is gone. A row naming this copy's own id is refused too,
   * since a forgery under someone's id arriving at their own copy is the case.
   * A row this copy already holds at the same id in the same table is not new,
   * so it is not refused: the same row is a duplicate, as ever, and a different
   * one is rejected as a second row under one id (a save of this copy's own
   * pending rows, merged back, is the first).
   */
  const signedRows: { table: string; row: ReplicatedRow }[] = [];
  const unsignedRows: { table: string; row: ReplicatedRow }[] = [];
  for (const table of tables) {
    const authored = authorColumnsOf(sibling, table);
    for (const incoming of sibling.all(`SELECT * FROM "${table}"`)) {
      const row = readRow(incoming, authored);
      const key = `${table}|${rowId(row._r_replica, row._r_seq)}`;
      const named = row._r_batch instanceof Uint8Array ? hex(row._r_batch) : null;
      const cover = covering.get(key);
      // Malformed, or signed only with one that is (D159): never taken. Reported
      // once, with the batch that signed it, or here when nothing did.
      if (malformed.has(key) || (!cover && tainted.has(key))) {
        if (!tainted.has(key)) refuseBatch(named ?? "", row._r_replica, "ROW_MALFORMED");
        continue;
      }
      if (cover) {
        const keep = named && covers.has(`${named}|${key}`) ? named : cover;
        row._r_batch = held.get(keep)!;
        signedRows.push({ table, row });
      } else if (named) {
        const verdict = verdicts.get(named);
        if (!held.has(named) || verdict?.ok) refuseBatch(named, row._r_replica, "BATCH_DIGEST_MISMATCH");
      } else {
        // Held already: the ordinary path, which cannot insert (the id is taken)
        // and counts the same row a duplicate and a different one a rejection.
        const already = local.all(`SELECT 1 FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [row._r_replica, row._r_seq]);
        if (already.length > 0) unsignedRows.push({ table, row });
        else refuseBatch("", row._r_replica, "BATCH_UNSIGNED");
      }
    }
  }

  /*
   * One id, one row. A per-author seq is one counter per document, so
   * `(author, seq)` names one row whatever table it sits in: an unsigned row at
   * a number another table holds is a collision, refused as a different row
   * wearing that id (two signed ones are equivocation, below in `place`). And a
   * signed row always outranks an unsigned row at the same id, whichever arrived
   * first: the unsigned one is removed and the signed one takes its place (the
   * delete trigger allows exactly that), and the removed id is reported the same
   * way. Signed rows go first, so which one wins never depends on table order.
   * (Cold review of identity step 4, findings 1 and 2.)
   */
  const reject = (id: string): void => {
    if (!result.rejected.includes(id)) result.rejected.push(id);
  };
  const displace = (table: string, row: ReplicatedRow): void => {
    const gone = local.all(`SELECT _r_parents FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [row._r_replica, row._r_seq])[0];
    local.run(`DELETE FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [row._r_replica, row._r_seq]);
    // What the removed row superseded is a head again unless something else of
    // its entity names it (T1-D2, T1-D35).
    for (const parent of parentsOf({ _r_parents: String(gone?.["_r_parents"] ?? "[]"), _r_replica: row._r_replica, _r_seq: row._r_seq })) {
      local.run(
        `UPDATE "${table}" SET _r_superseded = 0
          WHERE lower(hex(_r_replica)) || ':' || _r_seq = ?
            AND NOT EXISTS (SELECT 1 FROM "${table}" n, json_each(${parentsSql("n._r_parents")}) p
                             WHERE p.value = ? AND n._r_entity = "${table}"._r_entity)`,
        [parent, parent],
      );
    }
    reject(rowId(row._r_replica, row._r_seq));
  };
  /*
   * The rows waiting on a parent this copy does not hold (R21), by id, before
   * anything is placed. One this merge stops waiting is decided now, once, and
   * reported as a row it took is: what this merge made true.
   */
  const waitingParent = (): Set<string> =>
    !hasView("_dai_waiting_parent")
      ? new Set()
      : new Set(local.all("SELECT _r_replica, _r_seq FROM _dai_waiting_parent").map((r) => rowId(r["_r_replica"] as Uint8Array, Number(r["_r_seq"]))));
  const waitingBefore = waitingParent();
  const added: { table: string; row: ReplicatedRow }[] = [];
  const place = (table: string, row: ReplicatedRow, signed: boolean): void => {
    for (const other of tables) {
      if (other === table) continue;
      const there = local.all(`SELECT _r_batch FROM "${other}" WHERE _r_replica = ? AND _r_seq = ?`, [row._r_replica, row._r_seq])[0];
      if (!there) continue;
      if (signed && there["_r_batch"] == null) {
        displace(other, row);
        continue;
      }
      /*
       * Two signed rows at one id in two tables are both taken (batch format
       * version 2, the step 6 review). Refusing the second made the first to
       * arrive win, so two copies split and nothing was reported; taken, the
       * two headers are equivocation per (author, seq), and neither row counts
       * on any copy holding both. The collision is an unsigned row's rule.
       */
      if (signed) continue;
      throw new RowRejected(
        `${rowId(row._r_replica, row._r_seq)} is already a row of ${other}. One author's seq names one row, whatever table it is in.`,
      );
    }
    try {
      if (applyRow(local, table, row) === "added") {
        result.applied += 1;
        added.push({ table, row });
      } else result.duplicate += 1;
    } catch (error) {
      const there = local.all(`SELECT _r_batch FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [row._r_replica, row._r_seq])[0];
      if (!(error instanceof RowRejected) || !signed || !there || there["_r_batch"] != null) throw error;
      displace(table, row);
      applyRow(local, table, row);
      result.applied += 1;
      added.push({ table, row });
    }
  };
  for (const [rows, signed] of [
    [signedRows, true],
    [unsignedRows, false],
  ] as const) {
    for (const { table, row } of rows) {
      try {
        place(table, row, signed);
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
        reject(rowId(row._r_replica, row._r_seq));
      }
    }
  }

  /*
   * Rows taken and not admitted because their author did not hold the seat they
   * name when they wrote them (identity step 5). Stored, since they are signed
   * and attributable, and reported by author, as every refusal is. Read after
   * every row is in, so a binding that arrived in the same exchange counts.
   */
  const seated = new Set(
    local.all("SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = '_dai_seat_rules'").length > 0
      ? local.all("SELECT tbl FROM _dai_seat_rules").map((r) => String(r["tbl"]))
      : [],
  );
  // The rows waiting on a parent after the merge (R21), reported nowhere, and
  // those this merge released from waiting, reported as taken.
  const waitingAfter = waitingParent();
  const waits = (id: string): boolean => waitingAfter.has(id);
  for (const { table, row } of added) {
    if (!seated.has(table) || waits(rowId(row._r_replica, row._r_seq))) continue;
    const unseated = local.all(`SELECT 1 FROM "${table}_unseated" WHERE _r_replica = ? AND _r_seq = ?`, [row._r_replica, row._r_seq]);
    if (unseated.length > 0) {
      refuseBatch(row._r_batch instanceof Uint8Array ? hex(row._r_batch) : "", row._r_replica, "SEAT_NOT_HELD");
    }
  }
  const released = new Set([...waitingBefore].filter((id) => !waits(id)));
  for (const table of seated) {
    for (const id of released) {
      const [author = "", seq = "0"] = id.split(":");
      for (const r of local.all(`SELECT _r_replica, _r_batch FROM "${table}_unseated" WHERE lower(hex(_r_replica)) = ? AND _r_seq = ?`, [author, Number(seq)])) {
        refuseBatch(r["_r_batch"] instanceof Uint8Array ? hex(r["_r_batch"]) : "", r["_r_replica"] as Uint8Array, "SEAT_NOT_HELD");
      }
    }
  }

  /*
   * Rows taken and not admitted because they name as an earlier version a row
   * of their entity from another session (D131). Stored, and reported by author,
   * whichever of the two rows this exchange brought: the admission is a fact of
   * the row set, and the report says what this merge made true.
   */
  // And, in a seated table, a row naming a row of another seat of its session
  // (D132), reported as SEAT_NOT_HELD the same way.
  const views = new Set(local.all("SELECT name FROM sqlite_schema WHERE type = 'view'").map((r) => String(r["name"])));
  const crossings = [
    ["_foreign", "ENTITY_OTHER_SESSION"],
    ["_other_seat", "SEAT_NOT_HELD"],
  ] as const;
  for (const table of tables) {
    const arrived = new Set([...added.filter((a) => a.table === table).map((a) => rowId(a.row._r_replica, a.row._r_seq)), ...released]);
    if (arrived.size === 0) continue;
    for (const [suffix, reason] of crossings) {
      if (!views.has(`${table}${suffix}`)) continue;
      for (const f of local.all(`SELECT _r_replica, _r_seq, _r_batch, parent_replica, parent_seq FROM "${table}${suffix}"`)) {
        const child = rowId(f["_r_replica"] as Uint8Array, Number(f["_r_seq"]));
        const parent = rowId(f["parent_replica"] as Uint8Array, Number(f["parent_seq"]));
        if ((!arrived.has(child) && !arrived.has(parent)) || waits(child)) continue;
        refuseBatch(f["_r_batch"] instanceof Uint8Array ? hex(f["_r_batch"]) : "", f["_r_replica"] as Uint8Array, reason);
      }
    }
  }

  /*
   * This copy's own rows can come back to it: a save that never landed, and
   * the same rows returning from the mailbox. The counter is raised past the
   * highest of them, or this copy's next row reissues a seq it already issued
   * (cold review of identity step 2, #3).
   */
  if (author instanceof Uint8Array) raiseSeq(local, highestSeqOf(local, author));

  /*
   * Equivocation at the seat (D165): the creator confirmed one seat to two
   * copies. Both confirms are void on every copy holding them (`_dai_voided`).
   * The merge that made the seat void says so, in the creator's name, as D160
   * does for two rows at one id: the accusation is of the author. Its
   * revealing headers are those of the rows it took that the void rests on
   * (D171): the seat's counting confirms (`_dai_confirmed`, so not one at an
   * equivocated id) and the session's creator's seat row that counts
   * (`_dai_creator`, so not deleted and not equivocated), and nothing else
   * (batch format version 2, the step 6 review, X3). With no taken row it
   * rests on, the report is filed under no id.
   */
  for (const [key, creator] of voidedSeats()) {
    if (voidedBefore.has(key)) continue;
    const [session, seat] = key.split("|");
    const counting = new Set(
      local
        .all("SELECT seq FROM _dai_confirmed WHERE lower(hex(session)) = ? AND lower(hex(seat)) = ? AND creator = ?", [session, seat, creator])
        .map((r) => Number(r["seq"])),
    );
    const seatRow = local.all("SELECT seq FROM _dai_creator WHERE lower(hex(session)) = ? AND replica = ?", [session, creator])[0];
    const resting = added.filter(
      ({ table, row }) =>
        row._r_session instanceof Uint8Array &&
        hex(row._r_session) === session &&
        hex(row._r_replica) === hex(creator) &&
        ((table === "_dai_confirm" && counting.has(row._r_seq)) || (table === "_dai_seat" && seatRow && Number(seatRow["seq"]) === row._r_seq)),
    );
    for (const { row } of resting) reveal(creator, row._r_batch instanceof Uint8Array ? hex(row._r_batch) : "");
    if (resting.length === 0) reveal(creator, "");
  }
  /*
   * Equivocation by a close (R18): an author who wrote in a session after a
   * close of his there that counts. The merge that makes it true reports it,
   * in his name, filed under the lowest header of a row it took that it rests
   * on: the close, or a row of his in that session above it; under no id when
   * it took none of them (a row it took made the close count).
   */
  for (const key of closeEquivocated()) {
    if (closeEquivocatedBefore.has(key)) continue;
    const [session = "", author = ""] = key.split("|");
    const closes = local
      .all("SELECT seq FROM _dai_close0 WHERE lower(hex(session)) = ? AND lower(hex(replica)) = ?", [session, author])
      .map((r) => Number(r["seq"]));
    const first = Math.min(...closes);
    const resting = added.filter(
      ({ table, row }) =>
        row._r_session instanceof Uint8Array &&
        hex(row._r_session) === session &&
        hex(row._r_replica) === author &&
        ((table === "_dai_close" && closes.includes(row._r_seq)) || row._r_seq > first),
    );
    const who = Uint8Array.from(author.match(/../g) ?? [], (pair) => parseInt(pair, 16));
    for (const { row } of resting) reveal(who, row._r_batch instanceof Uint8Array ? hex(row._r_batch) : "");
    if (resting.length === 0) reveal(who, "");
  }
  // Under the lowest revealing header of any of the three kinds; under no id
  // only for an author this merge revealed with none (equivocated-filed,
  // equivocated-filed-no-id; branch review pass A, M1).
  for (const { author: who, ids } of revealed.values()) {
    refuseBatch([...ids].filter((id) => id !== "").sort(plainOrder)[0] ?? "", who, "AUTHOR_EQUIVOCATED");
  }

  // A set, ordered by id: the author in hex, then the seq as a number (report-set).
  const seqOf = (id: string): number => Number(id.slice(id.indexOf(":") + 1));
  result.rejected.sort((a, b) => plainOrder(a.slice(0, a.indexOf(":")), b.slice(0, b.indexOf(":"))) || seqOf(a) - seqOf(b));
  result.refusedBatches = [...refusals.values()]
    .sort((a, b) => plainOrder(a.id, b.id) || plainOrder(a.reason, b.reason) || plainOrder(hex(a.author), hex(b.author)))
    .map(({ author: who, reason }) => ({ author: showAuthorId(who), reason }));
  return result;
}

/**
 * Holds this copy's counter at or above `floor`, never lowering it.
 *
 * The floor is the highest seq this device has let leave it for this document,
 * or the highest this copy holds under its own id: either way, a seq at or
 * below it has been issued already. Returns whether the counter moved.
 */
export function raiseSeq(db: Rows, floor: number): boolean {
  const held = Number(db.all("SELECT seq FROM _dai_replica LIMIT 1")[0]?.["seq"] ?? 0);
  if (!(floor > held)) return false;
  db.run("UPDATE _dai_replica SET seq = ?", [floor]);
  return true;
}
