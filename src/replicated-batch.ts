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
import { authorIdOf, rawPublicKey, signBytes, verifySignature, type SubtleKey } from "./identity.js";
import {
  authorColumnsOf,
  canonicalRows,
  CARRIED_R_FIELDS,
  coveredRowsOf,
  coversText,
  readRow,
  type BatchVerdict,
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

/** A stored header's integer column as an integer, or null when it holds anything else (a blob, a text, a float). */
const storedInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;

/* ------------------------------------------------ signed batches (identity) */

/**
 * The batch format's version: signed into every header, bumped only by a
 * format change, never by a refactor (docs/identity.md, binding rule 10). Not
 * the container's format version (`FORMAT_VERSION`, src/format.ts), which is
 * another number with another history.
 *
 * Version 2 (identity step 6) signs the rows a header covers (D161): at version
 * 1 a copy forwarding a header could relabel its list, and the next copy
 * refused it in its honest author's name.
 */
export const BATCH_FORMAT_VERSION = 2;

/** What a batch's signature covers: `[version, document, author, lc, digest, covers]`. */
export interface BatchHeader {
  version: number;
  /** The document's uuid, so a batch signed for one document means nothing in another. */
  document: string;
  author: Uint8Array;
  lc: number;
  /** SHA-256 of the canonical rows. */
  digest: Uint8Array;
  /** The rows the header covers, `[table, seq]`, ordered by table (UTF-8 bytes) and then seq. */
  covers: readonly (readonly [string, number])[];
}

/**
 * The seal on a batch: its header fields, its id, and the signature.
 *
 * `pub` is the author's raw public key, which the author id must fingerprint to;
 * `att` is an authority's attestation, reserved and empty in V1. Neither is in
 * the signed bytes: `pub` is bound by the id it must hash to, and `att` is
 * outside the signature so vouching can arrive later without touching one.
 * `id` is SHA-256 of the canonical header, first 16 bytes: carried so a batch can
 * be staged without hashing, and recomputed by the merge that verifies it.
 */
export interface BatchSeal {
  document: string;
  version: number;
  digest: Uint8Array;
  id: Uint8Array;
  sig: Uint8Array;
  pub: Uint8Array;
  att: Uint8Array | null;
}

/** A batch with its seal: one author's rows, one signature over all of them. */
export type SignedBatch = Batch & BatchSeal;

/** Whether a batch carries a seal. */
export const isSigned = (batch: Batch): batch is SignedBatch =>
  (batch as Partial<SignedBatch>).sig instanceof Uint8Array && (batch as Partial<SignedBatch>).id instanceof Uint8Array;

/** Bytewise order of two strings' UTF-8, the order every canonical list here is sorted by. */
function utf8Order(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

// The canonical bytes of a batch's rows live beside the merge, which digests a
// copy's own headers' rows synchronously (docs/format.md, merge-row-held-signed).
export { canonicalRows };

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("UNSUPPORTED_CRYPTO");
  return new Uint8Array(await subtle.digest("SHA-256", new Uint8Array(bytes)));
}

/** SHA-256 of the canonical rows: what the header's `digest` holds. */
export async function rowsDigest(entries: readonly BatchEntry[]): Promise<Uint8Array> {
  return sha256(canonicalRows(entries));
}

/**
 * The canonical header, `[version, document, author, lc, digest, covers]`: the
 * bytes a batch's signature covers. `covers` is a CBOR array of `[table, seq]`
 * pairs, so the id, which hashes these bytes, commits to the list too.
 */
export function canonicalHeader(header: BatchHeader): Uint8Array {
  return cborEncode([
    header.version,
    header.document,
    header.author,
    header.lc,
    header.digest,
    header.covers.map(([table, seq]) => [table, seq]),
  ]);
}

/** The rows a batch covers, as its header lists them: `[table, seq]` in the one order. */
export const coversOf = (entries: readonly BatchEntry[]): [string, number][] =>
  JSON.parse(coversText(entries)) as [string, number][];

/** A batch's id: SHA-256 of its canonical header, first 16 bytes. */
export async function batchIdOf(header: Uint8Array): Promise<Uint8Array> {
  return (await sha256(header)).slice(0, 16);
}

/** The header a signed batch claims. */
export const headerOf = (batch: SignedBatch): Uint8Array =>
  canonicalHeader({
    version: batch.version,
    document: batch.document,
    author: batch.replica,
    lc: batch.lc,
    digest: batch.digest,
    covers: coversOf(batch.entries),
  });

/**
 * Signs a canonical header and says with which key. The host's own, over the
 * bridge, in a running document (the private key never leaves the host); a
 * key in hand, in a test.
 */
export type BatchSigner = (header: Uint8Array) => Promise<{ sig: Uint8Array; pub: Uint8Array }>;

/** A signer over a key pair held in hand. */
export const signerOf =
  (keys: { privateKey: SubtleKey; publicKey: SubtleKey }): BatchSigner =>
  async (header) => ({ sig: await signBytes(keys.privateKey, header), pub: await rawPublicKey(keys.publicKey) });

/**
 * Seals a batch: its rows digested, its header built and signed, its id named.
 * One signature for the whole batch, however many rows (binding rule 9).
 */
export async function signBatch(
  batch: Batch,
  options: { document: string; sign: BatchSigner } | { document: string; keys: { privateKey: SubtleKey; publicKey: SubtleKey } },
): Promise<SignedBatch> {
  const sign = "sign" in options ? options.sign : signerOf(options.keys);
  const digest = await rowsDigest(batch.entries);
  const header = canonicalHeader({
    version: BATCH_FORMAT_VERSION,
    document: options.document,
    author: batch.replica,
    lc: batch.lc,
    digest,
    covers: coversOf(batch.entries),
  });
  const { sig, pub } = await sign(header);
  return {
    ...batch,
    document: options.document,
    version: BATCH_FORMAT_VERSION,
    digest,
    id: await batchIdOf(header),
    sig,
    pub,
    att: null,
  };
}

/**
 * This author's rows that have not left the device yet: written, not sealed
 * (`_r_batch` NULL). Rows written in an earlier session and stored before
 * they were sealed are pending too, not orphans: they seal at the next leave.
 *
 * One batch per leave, of one author's rows only: here, one per session in a
 * session document, because each session travels in a mailbox of its own under
 * its own key (T1-D30, D37), and a batch carrying another game's rows into a
 * lane would hand them to whoever holds that lane's key. A plain document is
 * one batch.
 */
export function pendingBatches(db: Rows, author: Uint8Array, tables: readonly string[]): Batch[] {
  const bySession = new Map<string, BatchEntry[]>();
  for (const table of tables) {
    const authored = authorColumnsOf(db, table);
    const rows = db.all(
      `SELECT * FROM "${table}" WHERE _r_replica = ? AND _r_batch IS NULL ORDER BY _r_seq ASC`,
      [author],
    );
    for (const record of rows) {
      const row = readRow(record, authored);
      const key = row._r_session instanceof Uint8Array ? hex(row._r_session) : "";
      bySession.set(key, [...(bySession.get(key) ?? []), { table, row }]);
    }
  }
  const lc = Number(db.all("SELECT lc FROM _dai_replica LIMIT 1")[0]?.["lc"] ?? 0);
  return [...bySession.keys()].sort().map((key) => {
    const entries = bySession.get(key)!;
    return { replica: author, lc: Math.max(lc, ...entries.map((e) => e.row._r_lc)), entries };
  });
}

/**
 * Records a seal: the header into `_dai_batch`, and every row it covers
 * names it. In one transaction, so a copy never holds a header without its
 * rows' names or rows named for a header it does not hold. The trigger lets
 * `_r_batch` change once, from NULL.
 */
export function recordSeal(db: Rows, sealed: SignedBatch): void {
  db.run("SAVEPOINT dai_seal");
  try {
    db.run(
      "INSERT OR IGNORE INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [sealed.id, sealed.replica, sealed.lc, sealed.sig, sealed.pub, sealed.att, sealed.version, sealed.digest, coversText(sealed.entries)],
    );
    for (const { table, row } of sealed.entries) {
      db.run(`UPDATE "${table}" SET _r_batch = ? WHERE _r_replica = ? AND _r_seq = ? AND _r_batch IS NULL`, [
        sealed.id,
        row._r_replica,
        row._r_seq,
      ]);
    }
    db.run("RELEASE dai_seal");
  } catch (error) {
    db.run("ROLLBACK TO dai_seal");
    db.run("RELEASE dai_seal");
    throw error;
  }
}

/**
 * Verifies every signed header a copy holds (identity ruling #3; batch format
 * version 2, D160 and D161).
 *
 * A header is checked in two parts, and the order matters.
 *
 * **Authentic**: the header is the author's. Its signature covers the list of
 * rows it names, so it can be checked from the header alone, without holding a
 * single row. A list makes a canonical header; the header is authentic when
 * that header's hash is the id, `pub` fingerprints to the author, and the
 * signature verifies over it for `document`. The list tried first is the one
 * stored; if it does not make the header, the list of that author's rows
 * naming the id is tried. A copy that forwards a header can change the stored
 * list, never the signed one, and the honest rows still name their header.
 * When neither list makes it, the header is refused as
 * BATCH_SIGNATURE_INVALID with the author it names: what any forgery in that
 * name gets, and an accusation of nobody.
 *
 * **Complete**: each listed row found once, as that author's row in the table
 * listed, and the digest over them the header's. By table as well as seq: a
 * row of the same number in another table is not a row this header signed. An
 * authentic header whose rows are not all here (withheld, or a different row
 * at one of its ids) is still the author's statement: its verdict says it is
 * not complete, and the merge keeps it without taking rows through it. That is
 * what lets evidence of two conflicting headers travel (D160).
 *
 * What a row says about its batch (`_r_batch`) is a cache the merge fills from
 * the verdicts; it is read here only to recover a relabeled list.
 *
 * A batch format this copy does not know cannot be checked, so it does not
 * verify (BATCH_SIGNATURE_INVALID). A document holding one mounts read-only
 * (D108); this is the merge's answer to the same fact.
 */
export async function verifyBatches(
  db: Rows,
  tables: readonly string[],
  document: string,
): Promise<Map<string, BatchVerdict>> {
  const verdicts = new Map<string, BatchVerdict>();
  const present = db.all("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_dai_batch'").length > 0;
  if (!present) return verdicts;
  const carried = new Set(tables);
  for (const header of db.all("SELECT * FROM _dai_batch")) {
    const id = header["id"] as Uint8Array;
    const author = header["author"] as Uint8Array;
    const digest = header["digest"] as Uint8Array;
    const pub = header["pub"] as Uint8Array;
    // Integers as stored, never converted: `Number()` read a one-byte blob 0x02
    // as version 2 (docs/format.md#stored-header-integers; branch review pass A, M7).
    const version = storedInteger(header["version"]);
    const lc = storedInteger(header["lc"]);

    // The lists to try: the stored one, then the rows naming this header.
    const lists: [string, number][][] = [];
    const stored = coveredRowsOf(header["covers"]);
    if (stored) lists.push(stored);
    const naming: { table: string; row: { _r_seq: number } }[] = [];
    for (const table of tables) {
      for (const r of db.all(`SELECT _r_seq FROM "${table}" WHERE _r_batch = ? AND _r_replica = ?`, [id, author])) {
        naming.push({ table, row: { _r_seq: Number(r["_r_seq"]) } });
      }
    }
    if (naming.length > 0) {
      const recovered = coveredRowsOf(coversText(naming));
      if (recovered && JSON.stringify(recovered) !== JSON.stringify(stored)) lists.push(recovered);
    }

    let covers: [string, number][] | null = null;
    const keyed = version === BATCH_FORMAT_VERSION && lc !== null && pub instanceof Uint8Array && digest instanceof Uint8Array && hex(await authorIdOf(pub)) === hex(author);
    for (const list of keyed ? lists : []) {
      if (list.some(([table]) => !carried.has(table))) continue;
      const canonical = canonicalHeader({ version: version!, document, author, lc: lc!, digest, covers: list });
      if (hex(await batchIdOf(canonical)) !== hex(id)) continue;
      if (!(await verifySignature(pub, canonical, header["sig"] as Uint8Array))) continue;
      covers = list;
      break;
    }
    if (!covers) {
      verdicts.set(hex(id), { ok: false, author, reason: "BATCH_SIGNATURE_INVALID" });
      continue;
    }

    // Each listed row found once, where it was listed, digesting to the header's.
    const entries: BatchEntry[] = [];
    for (const [table, seq] of covers) {
      const found = db.all(`SELECT * FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [author, seq]);
      if (found.length !== 1) break;
      entries.push({ table, row: readRow(found[0]!, authorColumnsOf(db, table)) });
    }
    const complete = entries.length === covers.length && hex(await rowsDigest(entries)) === hex(digest);
    verdicts.set(hex(id), { ok: true, author, covers, complete });
  }
  return verdicts;
}

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
  author: Uint8Array,
  watermark: Watermark,
  tables: readonly string[],
  session?: Uint8Array,
  document = "",
  options: { held?: ReadonlySet<string> } = {},
): { batch: Uint8Array | null; head: number; replica: string; more: boolean; held: boolean } {
  // Whose rows these are is the caller's to say (the host's key, binding rule
  // 1), never _dai_replica's: a row is not a source of identity.
  const replica = author;
  const replicaHex = hex(replica);
  const since = watermark.replica === replicaHex ? watermark.seq : 0;
  // Scoped to the session when one is given (T1-D30): a copy is in many sessions
  // and each session's mailbox carries only its own rows.
  const entries = authoredSince(db, replica, since, tables, session);

  /*
   * Sealed batches only (docs/identity.md, step 3): nothing unsigned leaves the
   * device. The frame seals what is pending before it asks, so a pending row
   * here is one whose seal has not happened yet, and it waits for it.
   *
   * The head never passes a pending row. The host moves its watermark to the
   * head even when nothing is sent, and a watermark above an unsealed row would
   * leave that row unsent for good. A batch sent twice is a duplicate; a row
   * never sent is lost.
   */
  /*
   * And a sealed batch the caller holds back waits the same way (identity
   * ruling #3): the frame names the batches whose seal no landed save holds
   * yet. Published before the save lands, a batch can be on the relay and gone
   * from this device after a reload; so it is treated as pending, and `held`
   * tells the caller there is more to send once it lands.
   */
  const heldBack = options.held ?? new Set<string>();
  const waits = (e: BatchEntry): boolean =>
    !(e.row._r_batch instanceof Uint8Array) || heldBack.has(hex(e.row._r_batch));
  const pendingSeqs = entries.filter(waits).map((e) => e.row._r_seq);
  const ceiling = pendingSeqs.length > 0 ? Math.min(...pendingSeqs) - 1 : Number.POSITIVE_INFINITY;
  const held = entries.some((e) => e.row._r_batch instanceof Uint8Array && heldBack.has(hex(e.row._r_batch)));
  const byBatch = new Map<string, number>();
  for (const e of entries) {
    if (waits(e)) continue;
    const key = hex(e.row._r_batch as Uint8Array);
    byBatch.set(key, Math.min(byBatch.get(key) ?? Number.POSITIVE_INFINITY, e.row._r_seq));
  }
  if (byBatch.size === 0) return { batch: null, head: since, replica: replicaHex, more: false, held };

  // The lowest batch first, and the whole of it: a batch is signed as one, so
  // it travels as one, whatever part of it the watermark has already passed.
  const [lowest] = [...byBatch.entries()].sort((a, b) => a[1] - b[1])[0]!;
  const id = Uint8Array.from(lowest.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const header = db.all("SELECT * FROM _dai_batch WHERE id = ?", [id])[0];
  if (!header) throw new Error("A row names a batch this copy holds no header for; it cannot be sent signed.");
  const whole: BatchEntry[] = [];
  for (const table of tables) {
    const authored = authorColumnsOf(db, table);
    for (const record of db.all(`SELECT * FROM "${table}" WHERE _r_batch = ? ORDER BY _r_seq ASC`, [id])) {
      whole.push({ table, row: readRow(record, authored) });
    }
  }
  const top = Math.max(...whole.map((e) => e.row._r_seq));
  // The batch is the header's: its author and clock are what was signed.
  const signed: SignedBatch = {
    replica: header["author"] as Uint8Array,
    lc: Number(header["lc"]),
    entries: whole,
    document,
    version: Number(header["version"]),
    digest: header["digest"] as Uint8Array,
    id,
    sig: header["sig"] as Uint8Array,
    pub: header["pub"] as Uint8Array,
    att: (header["att"] as Uint8Array | null) ?? null,
  };
  return {
    batch: encodeBatch(signed),
    head: Math.max(since, Math.min(top, ceiling)),
    replica: replicaHex,
    more: byBatch.size > 1,
    held,
  };
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

export function encodeBatch(batch: Batch | SignedBatch): Uint8Array {
  const map = new Map<CborValue, CborValue>([
    ["replica", batch.replica],
    ["lc", batch.lc],
    ["rows", batch.entries.map(rowToMap)],
  ]);
  // The seal rides beside the rows it covers: one header, one signature.
  if (isSigned(batch)) {
    map.set("doc", batch.document);
    map.set("v", batch.version);
    map.set("dig", batch.digest);
    map.set("id", batch.id);
    map.set("sig", batch.sig);
    map.set("pub", batch.pub);
    map.set("att", batch.att);
  }
  return cborEncode(map);
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

export function decodeBatch(bytes: Uint8Array): Batch | SignedBatch {
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
  const batch: Batch = { replica: asBytes(root.get("replica")), lc: asNumber(root.get("lc")), entries };
  // A batch with no seal decodes as unsigned: what refuses it is the merge, by
  // name (BATCH_UNSIGNED, in every table from batch format version 2), not a
  // decode error.
  if (!root.has("sig")) return batch;
  const att = root.get("att");
  return {
    ...batch,
    document: asString(root.get("doc")),
    version: asNumber(root.get("v")),
    digest: asBytes(root.get("dig")),
    id: asBytes(root.get("id")),
    sig: asBytes(root.get("sig")),
    pub: asBytes(root.get("pub")),
    att: att instanceof Uint8Array ? att : null,
  } satisfies SignedBatch;
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
export function stageBatch(staged: Rows, batch: Batch | SignedBatch, tables: readonly string[]): void {
  const sealed = isSigned(batch) ? batch : null;
  if (sealed) {
    staged.run(
      "INSERT OR IGNORE INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [sealed.id, sealed.replica, sealed.lc, sealed.sig, sealed.pub, sealed.att, sealed.version, sealed.digest, coversText(sealed.entries)],
    );
  }
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
      // Every row of a sealed batch names it, whatever the wire said.
      ...carried.map((f) => (f.col === "_r_batch" ? (sealed ? sealed.id : (row._r_batch ?? null)) : row[f.col])),
    ];
    staged.run(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
      values,
    );
  }
}

const authoredHeadOf = (batch: Batch): number =>
  batch.entries.reduce((max, entry) => Math.max(max, entry.row._r_seq), 0);
