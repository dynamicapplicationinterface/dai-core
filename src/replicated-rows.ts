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

/** The `_r_` columns as they travel. `_r_superseded` is not among them (T1-D11). */
export interface ReplicatedRow {
  _r_replica: Uint8Array;
  _r_seq: number;
  _r_lc: number;
  _r_entity: Uint8Array;
  _r_parents: string;
  _r_deleted: number;
  _r_sig?: Uint8Array | null;
  /** The author's own columns. */
  columns: Record<string, unknown>;
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
  const id = rowId(row._r_replica, row._r_seq);

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

  const names = [...authored, "_r_replica", "_r_seq", "_r_lc", "_r_entity", "_r_parents", "_r_deleted", "_r_superseded", "_r_sig"];
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

function stamp(db: Rows, table: string, entity: Uint8Array, parents: string[], columns: Record<string, unknown>, deleted: number): ReplicatedRow {
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
    columns,
  };
}

/** A new entity: no parents, a fresh id. */
export function createEntity(
  db: Rows,
  table: string,
  entity: Uint8Array,
  columns: Record<string, unknown>,
): ReplicatedRow {
  const row = stamp(db, table, entity, [], columns, 0);
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
  const row = stamp(db, table, entity, headsOf(db, table, entity), columns, 0);
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
  const row = stamp(db, table, entity, heads, columns, 1);
  applyRow(db, table, row);
  return row;
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
  lines.push("# _dai_replicas");
  for (const row of db.all("SELECT id, label, first_seen, rows_seen FROM _dai_replicas ORDER BY hex(id) ASC")) {
    lines.push(
      [row["id"], row["label"], row["first_seen"], row["rows_seen"]].map(encodeValue).join("\t"),
    );
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
  let ceiling = Number(local.all("SELECT lc FROM _dai_replica LIMIT 1")[0]?.["lc"] ?? 0);
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
    ...sibling.all("SELECT id, label FROM _dai_replica"),
    ...sibling.all("SELECT id, label FROM _dai_replicas"),
  ];
  for (const replica of theirs) {
    const id = replica["id"] as Uint8Array;
    if (!(id instanceof Uint8Array)) continue;
    const key = [...id].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    if (known.has(key)) continue;
    known.add(key);
    result.newReplicas += 1;
    local.run("INSERT INTO _dai_replicas (id, label, first_seen, rows_seen) VALUES (?, ?, ?, 0)", [
      id,
      replica["label"] ?? null,
      ceiling,
    ]);
  }

  for (const table of tables) {
    const authored = authorColumnsOf(sibling, table);
    for (const incoming of sibling.all(`SELECT * FROM "${table}"`)) {
      const columns: Record<string, unknown> = {};
      for (const name of authored) columns[name] = incoming[name];
      const row: ReplicatedRow = {
        _r_replica: incoming["_r_replica"] as Uint8Array,
        _r_seq: Number(incoming["_r_seq"]),
        _r_lc: Number(incoming["_r_lc"]),
        _r_entity: incoming["_r_entity"] as Uint8Array,
        _r_parents: String(incoming["_r_parents"]),
        _r_deleted: Number(incoming["_r_deleted"]),
        _r_sig: (incoming["_r_sig"] as Uint8Array | null) ?? null,
        columns,
      };
      try {
        if (applyRow(local, table, row) === "added") result.applied += 1;
        else result.duplicate += 1;
      } catch (error) {
        if (!(error instanceof RowRejected)) throw error;
        /*
         * One row refused, the rest still merged.
         *
         * Refusing the whole exchange would let one bad row deny every good
         * one, which is a cheaper attack than forging a row. The id is
         * reported so a person can be told what was dropped; who sent it is
         * not reported, because at Level 1 nothing here knows.
         */
        result.rejected.push(rowId(row._r_replica, row._r_seq));
      }
    }
  }

  return result;
}
