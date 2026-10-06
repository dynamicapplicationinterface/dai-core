/**
 * The adversarial sealer: what a client that skips the writers can sign.
 *
 * The honest writers (createEntity, startSession, confirmSeat) write at the
 * next seq, name parents that exist and check the values they write. A hostile
 * client holds the author's key and signs anything: a row at any seq (a gap,
 * one below the creator's seat row, one already used), a second header over a
 * seq, a close at a seq it skipped, a parent that does not exist yet, a header
 * held back and released later, a header without its rows, a tombstone at any
 * seq, a seat value of any type. Every facility here writes the row the way
 * the runtime stores one (applyRow) and signs it through the runtime's own
 * seal (pendingBatches, signBatch, recordSeal), so what it makes is exactly
 * what such a client can send.
 *
 * Used by scripts/build-merge-fixtures.mjs, whose vectors are built from it,
 * and by scripts/properties.mjs, whose mutations are. Nothing here decides
 * what a merge does with what it signs; that is the runtime's, and the
 * readers'.
 */
import { createECDH, createHash, webcrypto } from "node:crypto";
import { applyRow, pendingBatches, recordSeal, signBatch } from "../dist/dai-merge.js";
import { coversText } from "../dist/replicated-rows.js";
import { authorIdOf, signBytes } from "../dist/identity.js";

/** The document every vector is a copy of. */
export const DOC = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** A CBOR head: major type and argument, in the shortest form (RFC 8949 §4.2.1). */
function cborHead(major, n) {
  const v = BigInt(n);
  if (v < 24n) return Buffer.from([(major << 5) | Number(v)]);
  if (v < 0x100n) return Buffer.from([(major << 5) | 24, Number(v)]);
  if (v < 0x10000n) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(Number(v), 1);
    return b;
  }
  if (v < 0x100000000n) {
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(Number(v), 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(v, 1);
  return b;
}

/** One column value as canonical CBOR (docs/format.md#cbor), written from the page. */
function cborValue(value) {
  if (value === null || value === undefined) return Buffer.from([0xf6]);
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (typeof value === "bigint" || Number.isInteger(value)) {
    const n = BigInt(value);
    return n >= 0n ? cborHead(0, n) : cborHead(1, -1n - n);
  }
  const b = Buffer.alloc(9);
  b[0] = 0xfb;
  b.writeDoubleBE(value, 1);
  return b;
}

/**
 * `dai_session_id(author, seq, seat, seats, close)`: SHA-256 of the author id,
 * the seq as eight bytes, unsigned, big-endian, and the canonical CBOR of the
 * array [seat, seats, close] as the row holds them, first 16 bytes
 * (docs/format.md#session-id, R15). Written here from the page with
 * node:crypto, not imported: the roster views call it, and a fixture should not
 * take the runtime's own hash on trust.
 */
export function sessionIdOf(author, seq, seat, seats, close) {
  if (!(author instanceof Uint8Array) || author.length !== 16) return null;
  const n = typeof seq === "bigint" ? seq : BigInt(seq);
  if (n < 1n || n >= 1n << 64n) return null;
  const be = Buffer.alloc(8);
  be.writeBigUInt64BE(n);
  const roster = Buffer.concat([cborHead(4, 3), cborValue(seat), cborValue(seats), cborValue(close)]);
  return new Uint8Array(createHash("sha256").update(author).update(be).update(roster).digest().subarray(0, 16));
}

/*
 * The authors of the sealed vectors: fixed private scalars, so the keys, the
 * author ids and every header are the same on every run.
 */
async function fixedPerson(scalarHex) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(scalarHex, "hex"));
  const pub = new Uint8Array(ecdh.getPublicKey());
  const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
  const jwk = { kty: "EC", crv: "P-256", x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33)), ext: true };
  const curve = { name: "ECDSA", namedCurve: "P-256" };
  const privateKey = await webcrypto.subtle.importKey("jwk", { ...jwk, d: b64(Buffer.from(scalarHex, "hex")) }, curve, true, ["sign"]);
  const publicKey = await webcrypto.subtle.importKey("jwk", jwk, curve, true, ["verify"]);
  return { keys: { privateKey, publicKey }, pub, author: await authorIdOf(pub) };
}
export const ADA = await fixedPerson("1111111111111111111111111111111111111111111111111111111111111111");
export const BO = await fixedPerson("2222222222222222222222222222222222222222222222222222222222222222");
/** A third author, for the vectors where the creator confirms someone else: a copy that never held the seat. */
export const CY = await fixedPerson("3333333333333333333333333333333333333333333333333333333333333333");
/** Everyone the vectors sign as. */
export const PEOPLE = [ADA, BO, CY];

/*
 * What a session document admits after a merge (backlog D171), from the
 * runtime's own views: the admitted heads of every table the merge covers, by
 * id with the deleted flag, then who holds each seat, the seats voided, the ids
 * signed twice and the sessions closed. A reader computes the same from the
 * tables alone.
 */
export function admittedDump(db) {
  const hexId = "lower(hex(_r_replica)) || ':' || _r_seq";
  const lines = [];
  for (const table of [...db.tables].sort()) {
    lines.push(`# ${table}`);
    for (const r of db.all(`SELECT ${hexId} AS id, _r_deleted AS d FROM "${table}_heads" ORDER BY hex(_r_replica), _r_seq`))
      lines.push(`${r.id}\t${r.d}`);
  }
  // A plain document has no roster: its holders, voided and closed are empty.
  const views = new Set(db.all("SELECT name FROM sqlite_schema WHERE type = 'view'").map((r) => r.name));
  const section = (title, sql) => {
    lines.push(`# ${title}`);
    if (!views.has(/FROM (\w+)/.exec(sql)[1])) return;
    for (const r of db.all(sql)) lines.push(Object.values(r).join("\t"));
  };
  section("holders", "SELECT lower(hex(session)), lower(hex(seat)), lower(hex(replica)) FROM _dai_holder ORDER BY 1, 2, 3");
  section("voided", "SELECT lower(hex(session)), lower(hex(seat)), lower(hex(creator)) FROM _dai_voided ORDER BY 1, 2, 3");
  section("equivocated", "SELECT lower(hex(author)), tbl, seq FROM _dai_equivocated ORDER BY 1, 2, 3");
  section("closed", "SELECT lower(hex(session)) FROM _dai_closed ORDER BY 1");
  return `${lines.join("\n")}\n`;
}

/** A signer that signs every header afresh with `person`'s key. */
export const signerOf = (person) => async (header) => ({ sig: await signBytes(person.keys.privateKey, header), pub: person.pub });

/** The next seq this copy's author would write at. */
export const nextSeq = (db) => Number(db.all("SELECT seq FROM _dai_replica")[0].seq) + 1;
/** Leaves `n` seqs unused, as a client that skips seqs leaves them. */
export const skip = (db, n = 1) => db.run("UPDATE _dai_replica SET seq = seq + ?", [n]);

/**
 * Seals everything `person` has pending in `db`, as a leave does
 * (docs/identity.md, step 3), signing with `sign`. Returns the ids of the
 * headers it made, lowest first.
 */
export async function seal(db, person, sign = signerOf(person), document = DOC) {
  const before = new Set(db.all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => r.id));
  for (const batch of pendingBatches(db, person.author, db.tables)) {
    recordSeal(db, await signBatch(batch, { document, sign }));
  }
  return db.all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => r.id).filter((x) => !before.has(x)).sort();
}

/**
 * A seal with one signature held while `during` runs (D178): the batches are
 * listed once, then each is signed and recorded in turn, as a leave does.
 */
export async function sealHolding(db, person, holdAt, during, signer = signerOf(person), document = DOC) {
  const batches = pendingBatches(db, person.author, db.tables);
  const index = holdAt === "first" ? 0 : batches.length - 1;
  for (const [i, batch] of batches.entries()) {
    const sign = async (header) => {
      if (i === index) await during();
      return signer(header);
    };
    recordSeal(db, await signBatch(batch, { document, sign }));
  }
  return batches.length;
}

/** A row at this copy's next seq and clock with the parents text given, as a copy that skips the writers can write it; the row written. */
export function raw(db, table, entity, columns, session, parentsText, deleted = 0) {
  const state = db.all("SELECT id, seq, lc FROM _dai_replica")[0];
  db.run("UPDATE _dai_replica SET seq = ?, lc = ?", [state.seq + 1, state.lc + 1]);
  const row = {
    _r_replica: state.id,
    _r_seq: state.seq + 1,
    _r_lc: state.lc + 1,
    _r_entity: entity,
    _r_parents: parentsText,
    _r_deleted: deleted,
    _r_session: session,
    columns,
  };
  applyRow(db, table, row);
  return row;
}

/**
 * `raw` at a seq of the caller's choosing: one skipped (a gap), one below the
 * creator's seat row, or one this copy has issued already (a second row at
 * that seq, which a copy holding the first cannot store in the same table).
 * The counter is left where it stood, or at `seq` if higher.
 */
export function rawAt(db, seq, table, entity, columns, session, parentsText = "[]", deleted = 0) {
  const state = db.all("SELECT seq FROM _dai_replica")[0];
  db.run("UPDATE _dai_replica SET seq = ?", [seq - 1]);
  const row = raw(db, table, entity, columns, session, parentsText, deleted);
  db.run("UPDATE _dai_replica SET seq = ?", [Math.max(state.seq, seq)]);
  return row;
}

/**
 * A second header over a seq `person` has signed already: a different row at
 * that seq, written into `db` (a copy that does not hold the first row in
 * `table`: a second copy of the author's store, or an empty one) and sealed
 * there. Two headers over one seq with different digests are equivocation
 * (docs/format.md#equivocation). Returns the ids of the headers made.
 */
export async function secondHeaderAt(db, person, seq, table, entity, columns, session, sign = signerOf(person), parentsText = "[]") {
  rawAt(db, seq, table, entity, columns, session, parentsText);
  return seal(db, person, sign);
}

/**
 * Signs what `person` has pending in `db` now and keeps the headers back:
 * `release(to)` carries them, with their rows, into another copy later, after
 * whatever was sent in between.
 */
export async function holdBack(db, person, sign = signerOf(person)) {
  const ids = await seal(db, person, sign);
  return { ids, release: (to, options) => carry(to, db, ids, options) };
}

/** A row's id as `_r_parents` spells it. */
export const rowIdOf = (author, seq) => `${Buffer.from(author).toString("hex")}:${seq}`;

/** A close at a seq of the caller's choosing: one skipped, so it sits below rows already sent (back-dated). */
export const closeAt = (db, seq, entity, session) => rawAt(db, seq, "_dai_close", entity, {}, session);

/** A tombstone of `row` (a version of its entity, deleted, naming it) at any seq. */
export const tombstoneAt = (db, seq, table, row) =>
  rawAt(db, seq, table, row._r_entity, row.columns ?? columnsOf(row), row._r_session ?? null, JSON.stringify([rowIdOf(row._r_replica, row._r_seq)]), 1);

/**
 * A row whose parent is an id that does not exist yet: `parent` is
 * `{ author, seq }`, the author's own (at or above the row's seq: malformed,
 * R19) or another author's, at a seq that author has not written.
 */
export const forwardParentAt = (db, seq, table, entity, columns, session, parent) =>
  rawAt(db, seq, table, entity, columns, session, JSON.stringify([rowIdOf(parent.author, parent.seq)]));

/** A row's author columns, as a version of it carries them. */
export const columnsOf = (row) => Object.fromEntries(Object.entries(row).filter(([name]) => !name.startsWith("_r_")));

/**
 * A row this copy's author already signed, written again as pending, so the
 * next seal signs it under a second header: what a re-seal after a lost save
 * does. Its digest equals the first header's only when that header listed this
 * row alone.
 */
export function resealed(db, table, row) {
  const { _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted } = row;
  applyRow(db, table, { _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_session: row._r_session ?? null, columns: row.columns ?? columnsOf(row) });
  const state = db.all("SELECT seq FROM _dai_replica")[0];
  if (state.seq < _r_seq) db.run("UPDATE _dai_replica SET seq = ?", [_r_seq]);
}

/**
 * Seat values of every type a column can hold: the 16-byte string a seat is,
 * and what is not one (docs/format.md#seat-value-shape). No table refuses any
 * of them: the roster tables carry no CHECK on a seat or a holder, so a signed
 * row holding one is taken and names nobody.
 */
export const SEAT_VALUES = {
  bytes: new Uint8Array(16).fill(0xe1),
  text: "SEATSEAT-SEATSEA",
  integer: 1234567890123456,
  real: 0.5,
  null: null,
  short: new Uint8Array(15).fill(0xe1),
  long: new Uint8Array(17).fill(0xe1),
};

/**
 * A bad seat value in a signed batch beside a row that counts: a confirm at
 * `seq` with `confirm`'s seat and holder, one of them not 16 bytes, and at
 * `seq + 1` the row `beside` names (`{ table, entity, columns }`), both
 * pending, so one seal signs them together. Written past any CHECK a copy's
 * schema still carries, as a client that skips the writers signs it: the
 * value must cost nothing but its own row (seat-value-shape, T1-D13), and a
 * merge that throws on it takes the whole batch (branch review pass A, H1).
 */
export function badSeatValueAt(db, seq, session, confirm, beside) {
  db.run("PRAGMA ignore_check_constraints = ON");
  try {
    rawAt(db, seq, "_dai_confirm", new Uint8Array(16).fill(0xe3), { seat: confirm.seat, holder: confirm.holder }, session);
  } finally {
    db.run("PRAGMA ignore_check_constraints = OFF");
  }
  rawAt(db, seq + 1, beside.table, beside.entity, beside.columns, session);
}

/** A header put into a copy without any row it lists, as a forwarder holds one. */
export function carryHeaderOnly(to, from, hid) {
  const header = from.all("SELECT * FROM _dai_batch WHERE lower(hex(id)) = ?", [hid])[0];
  if (!header) throw new Error(`no header ${hid}`);
  const names = Object.keys(header);
  to.run(`INSERT INTO _dai_batch (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => header[n]));
  to.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [header.author]);
}

/**
 * Headers carried from one copy into another by hand, with every row they
 * list, as a copy that received those batches and not the others holds them;
 * with `pointers: false`, each row's `_r_batch` left unset, as a lost save leaves it.
 * A header signed and kept back, then carried, is a header held and released later.
 */
export function carry(to, from, ids, { pointers = true } = {}) {
  for (const hid of ids) {
    const header = from.all("SELECT * FROM _dai_batch WHERE lower(hex(id)) = ?", [hid])[0];
    const names = Object.keys(header);
    to.run(`INSERT OR IGNORE INTO _dai_batch (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => header[n]));
    for (const [table, seq] of JSON.parse(header.covers)) {
      const row = from.all(`SELECT * FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [header.author, seq])[0];
      if (!pointers) row._r_batch = null;
      const columns = Object.keys(row);
      to.run(`INSERT OR IGNORE INTO "${table}" (${columns.map((n) => `"${n}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, columns.map((n) => row[n]));
    }
    to.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [header.author]);
  }
}

/** A header put into a copy by hand, as a copy holds one whose rows' pointers a lost save never wrote. */
export function holdHeader(db, sealed) {
  db.run(
    "INSERT INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [sealed.id, sealed.replica, sealed.lc, sealed.sig, sealed.pub, sealed.att, sealed.version, sealed.digest, coversText(sealed.entries)],
  );
}

/** A row written into a copy by hand under someone else's author id and seq, with no batch. */
export function forge(db, table, author, seq, columns, entity = new Uint8Array(16).fill(0x66)) {
  const names = Object.keys(columns);
  db.run(
    `INSERT INTO "${table}" (${names.join(", ")}, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted) VALUES (${names.map(() => "?").join(", ")}, ?, ?, ?, ?, '[]', 0)`,
    [...names.map((n) => columns[n]), author, seq, seq, entity],
  );
}

/**
 * A write the triggers would stop, made with those triggers dropped and put
 * back as they were: how a copy that skips the writers holds a row they refuse.
 */
export function withoutTriggers(db, names, write) {
  const kept = names.map((name) => {
    const [trigger] = db.all("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?", [name]);
    if (!trigger) throw new Error(`no trigger ${name}`);
    db.run(`DROP TRIGGER "${name}"`);
    return trigger.sql;
  });
  write();
  for (const sql of kept) db.run(sql);
}

/** The ids of the headers of `author` that list `seq` in `table`, lowest first. */
export function headersListing(db, author, table, seq) {
  return db
    .all("SELECT lower(hex(b.id)) AS id FROM _dai_batch b, json_each(b.covers) c WHERE b.author = ? AND json_extract(c.value, '$[0]') = ? AND json_extract(c.value, '$[1]') = ?", [author, table, seq])
    .map((r) => r.id)
    .sort();
}

/** The ids of the headers of `author` that list `seq` in any table, lowest first. */
export function headersAt(db, author, seq) {
  return db
    .all("SELECT DISTINCT lower(hex(b.id)) AS id FROM _dai_batch b, json_each(b.covers) c WHERE b.author = ? AND json_extract(c.value, '$[1]') = ?", [author, seq])
    .map((r) => r.id)
    .sort();
}
