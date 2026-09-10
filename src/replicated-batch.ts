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
import { authorColumnsOf, readRow, type ReplicatedRow, type Rows } from "./replicated-rows.js";

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
): BatchEntry[] {
  const entries: BatchEntry[] = [];
  for (const table of tables) {
    const authored = authorColumnsOf(db, table);
    const stored = db.all(
      `SELECT * FROM "${table}" WHERE _r_replica = ? AND _r_seq > ? ORDER BY _r_seq ASC`,
      [replica, sinceSeq],
    );
    for (const record of stored) entries.push({ table, row: readRow(record, authored) });
  }
  return entries;
}

/** The highest seq this replica has authored, or 0 — the watermark a publish advances to. */
export function authoredHead(db: Rows, replica: Uint8Array, tables: readonly string[]): number {
  let head = 0;
  for (const table of tables) {
    const max = db.all(`SELECT max(_r_seq) AS m FROM "${table}" WHERE _r_replica = ?`, [replica])[0]?.["m"];
    if (typeof max === "number") head = Math.max(head, max);
  }
  return head;
}

function rowToMap(entry: BatchEntry): Map<CborValue, CborValue> {
  const columns = new Map<CborValue, CborValue>();
  for (const [name, value] of Object.entries(entry.row.columns)) columns.set(name, value as CborValue);
  return new Map<CborValue, CborValue>([
    ["t", entry.table],
    ["r", entry.row._r_replica],
    ["s", entry.row._r_seq],
    ["lc", entry.row._r_lc],
    ["e", entry.row._r_entity],
    ["p", entry.row._r_parents],
    ["d", entry.row._r_deleted],
    ["sig", entry.row._r_sig ?? null],
    ["c", columns],
  ]);
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
    const sig = raw.get("sig");
    return {
      table: asString(raw.get("t")),
      row: {
        _r_replica: asBytes(raw.get("r")),
        _r_seq: asNumber(raw.get("s")),
        _r_lc: asNumber(raw.get("lc")),
        _r_entity: asBytes(raw.get("e")),
        _r_parents: asString(raw.get("p")),
        _r_deleted: asNumber(raw.get("d")),
        _r_sig: sig instanceof Uint8Array ? sig : null,
        columns,
      },
    };
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
    const names = Object.keys(row.columns);
    const cols = [
      ...names,
      "_r_replica",
      "_r_seq",
      "_r_lc",
      "_r_entity",
      "_r_parents",
      "_r_deleted",
      "_r_sig",
    ];
    const placeholders = cols.map(() => "?").join(", ");
    const values = [
      ...names.map((name) => row.columns[name]),
      row._r_replica,
      row._r_seq,
      row._r_lc,
      row._r_entity,
      row._r_parents,
      row._r_deleted,
      row._r_sig ?? null,
    ];
    staged.run(
      `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
      values,
    );
  }
}

const authoredHeadOf = (batch: Batch): number =>
  batch.entries.reduce((max, entry) => Math.max(max, entry.row._r_seq), 0);

/** A batch's own document id, when the caller wants to check what it holds. */
export const batchReplicaHex = (batch: Batch): string => hex(batch.replica);
