/**
 * A mailbox batch: the rows one copy authored, in a form the relay carries and
 * the other copy merges the same way it merges a file (Track 5, slice one).
 *
 * The transport is lean — the new rows, not the whole database — but applying
 * one adds no merge logic. A pulled batch is staged into a throwaway sibling
 * and handed to the ordinary `mergeSibling`, so a batch converges by exactly
 * the union merge a file does, and T1-D13 governs a bad row here as it does
 * there. Building a second merge would be the drift this design refuses.
 *
 * Bytes are CBOR, which carries `Uint8Array` and mixed column values without a
 * lossy text step. This module is engine-agnostic: it reads and writes through
 * the same `Rows` interface `replicated-rows` uses, so it runs under node:sqlite
 * in a test and under the frame's sqlite-wasm in the opener.
 */
import { decode as cborDecode, encode as cborEncode, type CborValue } from "./cbor.js";
import {
  authorColumnsOf,
  CARRIED_R_FIELDS,
  readRow,
  type ReplicatedRow,
  type Rows,
} from "./replicated-rows.js";

/** One row, with the table it belongs to. */
export interface BatchEntry {
  table: string;
  row: ReplicatedRow;
}

/**
 * A batch: the authoring replica, the clock it had reached, and the rows.
 *
 * The replica and clock travel so the staged sibling has the same `_dai_replica`
 * a file would, and `mergeFrom` registers the author and raises the clock
 * exactly as it does for a file. Without them a pulled row would apply but its
 * author would go unrecorded and a later local write could take a clock beneath
 * it.
 */
export interface Batch {
  replica: Uint8Array;
  lc: number;
  entries: BatchEntry[];
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The rows a replica authored past a watermark, across the replicated tables.
 *
 * Its own rows only: each copy publishes what it wrote, and a row it merged in
 * from someone else is that someone's to publish. Ordered by seq so a batch
 * reads back in the order it was written.
 */
export function authoredSince(
  db: Rows,
  replica: Uint8Array,
  sinceSeq: number,
  tables: readonly string[],
  session?: Uint8Array,
): BatchEntry[] {
  const entries: BatchEntry[] = [];
  const scope = session ? " AND _r_session = ?" : "";
  const params = (rest: unknown[]): unknown[] => (session ? [...rest, session] : rest);
  for (const table of tables) {
    const authored = authorColumnsOf(db, table);
    const stored = db.all(
      `SELECT * FROM "${table}" WHERE _r_replica = ? AND _r_seq > ?${scope} ORDER BY _r_seq ASC`,
      params([replica, sinceSeq]),
    );
    for (const record of stored) entries.push({ table, row: readRow(record, authored) });
  }
  return entries;
}

/**
 * The highest seq this replica has authored, or 0 — the watermark a publish
 * advances to. Scoped to a session when one is given (T1-D30): each session's
 * mailbox carries only that session's rows, so its watermark is over them.
 */
export function authoredHead(
  db: Rows,
  replica: Uint8Array,
  tables: readonly string[],
  session?: Uint8Array,
): number {
  let head = 0;
  const scope = session ? " AND _r_session = ?" : "";
  for (const table of tables) {
    const params = session ? [replica, session] : [replica];
    const max = db.all(`SELECT max(_r_seq) AS m FROM "${table}" WHERE _r_replica = ?${scope}`, params)[0]?.["m"];
    if (typeof max === "number") head = Math.max(head, max);
  }
  return head;
}

/**
 * A publisher's watermark: how far its own authored rows have been sent.
 *
 * A seq counts only within the replica that issued it, so the watermark is a
 * `(replica, seq)` pair and never a bare number. The distinction is not
 * academic: a copy that arrives by file adopts a *new* identity when it opens
 * (T1-D22), and it has published none of its rows under that identity. A
 * watermark carried over from the identity it shed — the sender's — names a seq
 * in a sequence space that is not this copy's, and read as a bare number it
 * sits above this copy's own first rows and strands them. Bound to its replica,
 * it is recognised as belonging to a life that is not this one and read as zero.
 */
export interface Watermark {
  /** Hex of the replica the seq counts against; `""` before anything is published. */
  replica: string;
  seq: number;
}

/**
 * The batch of rows this copy authored above a watermark, scoped to its own
 * identity — the one answer the mailbox asks the frame for.
 *
 * The watermark's seq is honoured only when its replica is the one this copy
 * now writes under; a watermark from an identity this copy has shed is read as
 * zero, so the first row under a freshly adopted identity is sent rather than
 * stranded beneath the sender's count. The current replica travels back so the
 * caller rebinds its watermark to what it actually advanced, never leaving a
 * seq bound to a replica it no longer is.
 */
export function authoredBatchAbove(
  db: Rows,
  watermark: Watermark,
  tables: readonly string[],
  session?: Uint8Array,
): { batch: Uint8Array | null; head: number; replica: string } {
  const held = db.all("SELECT id, lc FROM _dai_replica LIMIT 1")[0];
  const replica = held?.["id"];
  if (!(replica instanceof Uint8Array)) return { batch: null, head: watermark.seq, replica: "" };
  const replicaHex = hex(replica);
  const since = watermark.replica === replicaHex ? watermark.seq : 0;
  // Scoped to the session when one is given (T1-D30): a copy is in many sessions
  // and each session's mailbox carries only its own rows.
  const head = authoredHead(db, replica, tables, session);
  const entries = authoredSince(db, replica, since, tables, session);
  if (entries.length === 0) return { batch: null, head, replica: replicaHex };
  const lc = Number(held?.["lc"] ?? 0);
  return { batch: encodeBatch({ replica, lc, entries }), head, replica: replicaHex };
}

function rowToMap(entry: BatchEntry): Map<CborValue, CborValue> {
  const columns = new Map<CborValue, CborValue>();
  for (const [name, value] of Object.entries(entry.row.columns)) columns.set(name, value as CborValue);
  // Every `_r_` field rides here from the one carried-field list, under its
  // compact key; an optional field a plain row lacks (`_r_session`) is sent as an
  // explicit null so decode never has to guess whether it was meant to be there.
  const map = new Map<CborValue, CborValue>([["t", entry.table]]);
  for (const field of CARRIED_R_FIELDS) {
    map.set(field.key, (entry.row[field.col] as CborValue) ?? null);
  }
  map.set("c", columns);
  return map;
}

export function encodeBatch(batch: Batch): Uint8Array {
  return cborEncode(
    new Map<CborValue, CborValue>([
      ["replica", batch.replica],
      ["lc", batch.lc],
      ["rows", batch.entries.map(rowToMap)],
    ]),
  );
}

const asBytes = (value: CborValue | undefined): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  throw new Error("MAILBOX_BATCH_MALFORMED");
};
const asString = (value: CborValue | undefined): string => {
  if (typeof value === "string") return value;
  throw new Error("MAILBOX_BATCH_MALFORMED");
};
const asNumber = (value: CborValue | undefined): number => {
  if (typeof value === "number") return value;
  throw new Error("MAILBOX_BATCH_MALFORMED");
};

export function decodeBatch(bytes: Uint8Array): Batch {
  const root = cborDecode(bytes);
  if (!(root instanceof Map)) throw new Error("MAILBOX_BATCH_MALFORMED");
  const rows = root.get("rows");
  if (!Array.isArray(rows)) throw new Error("MAILBOX_BATCH_MALFORMED");
  const entries: BatchEntry[] = rows.map((raw) => {
    if (!(raw instanceof Map)) throw new Error("MAILBOX_BATCH_MALFORMED");
    const columnsMap = raw.get("c");
    if (!(columnsMap instanceof Map)) throw new Error("MAILBOX_BATCH_MALFORMED");
    const columns: Record<string, unknown> = {};
    for (const [name, value] of columnsMap) columns[asString(name)] = value;
    // Every `_r_` field is read from the one carried-field list under its key, so
    // decode gains a field the moment the list does. A required field that is
    // missing is a malformed batch; an optional one that is absent (a plain row's
    // `_r_session`) is simply left off.
    const row: Record<string, unknown> = { columns };
    for (const field of CARRIED_R_FIELDS) {
      const value = raw.get(field.key);
      switch (field.kind) {
        case "bytes":
          if (value instanceof Uint8Array) row[field.col] = value;
          else if (!field.optional) throw new Error("MAILBOX_BATCH_MALFORMED");
          break;
        case "bytesOrNull":
          row[field.col] = value instanceof Uint8Array ? value : null;
          break;
        case "number":
          row[field.col] = asNumber(value);
          break;
        case "string":
          row[field.col] = asString(value);
          break;
      }
    }
    return { table: asString(raw.get("t")), row: row as unknown as ReplicatedRow };
  });
  return { replica: asBytes(root.get("replica")), lc: asNumber(root.get("lc")), entries };
}

/**
 * Writes a decoded batch into a fresh sibling, so `mergeSibling` can merge it.
 *
 * `staged` is an empty database with the document's replicated schema. This
 * fills in the author's `_dai_replica` — the clock and id a file would carry —
 * and inserts the rows verbatim, `_r_` columns and all. It writes with plain
 * INSERTs, not the write rules: this is not authoring rows, it is reconstituting
 * ones already authored elsewhere, exactly as deserializing a sibling file does.
 * `_r_superseded` is left at its default; merge recomputes it.
 */
export function stageBatch(staged: Rows, batch: Batch, tables: readonly string[]): void {
  staged.run("INSERT OR REPLACE INTO _dai_replica (id, seq, lc) VALUES (?, ?, ?)", [
    batch.replica,
    authoredHeadOf(batch),
    batch.lc,
  ]);
  staged.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [
    batch.replica,
  ]);
  const known = new Set(tables);
  for (const { table, row } of batch.entries) {
    if (!known.has(table)) throw new Error(`MAILBOX_BATCH_UNKNOWN_TABLE:${table}`);
    // The same row seen twice — same (_r_replica, _r_seq) — is the one expected
    // no-op, so it is skipped by hand. Everything else inserts plainly and a
    // constraint violation *throws*: `INSERT OR IGNORE` here was a blanket
    // amnesty when only a duplicate key was meant to pass, and it swallowed the
    // `NOT NULL` a short column list violated — the row vanished with no error.
    // One exception, made explicit, is a mechanism this can be reasoned about.
    const already = staged.all(`SELECT 1 FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [
      row._r_replica,
      row._r_seq,
    ]);
    if (already.length > 0) continue;

    const names = Object.keys(row.columns);
    // The `_r_` columns come from the one carried-field list: a required field
    // always, an optional one (`_r_session`) only when the row carries it. A
    // field added to that list is inserted here without touching this function.
    const carried = CARRIED_R_FIELDS.filter((f) => !f.optional || row[f.col] !== undefined);
    const cols = [...names, ...carried.map((f) => f.col)];
    const placeholders = cols.map(() => "?").join(", ");
    const values = [
      ...names.map((name) => row.columns[name]),
      ...carried.map((f) => (f.col === "_r_sig" ? (row._r_sig ?? null) : row[f.col])),
    ];
    staged.run(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
      values,
    );
  }
}

const authoredHeadOf = (batch: Batch): number =>
  batch.entries.reduce((max, entry) => Math.max(max, entry.row._r_seq), 0);

/** A batch's own document id, when the caller wants to check what it holds. */
export const batchReplicaHex = (batch: Batch): string => hex(batch.replica);
