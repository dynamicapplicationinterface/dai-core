import { createECDH } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { authorIdOf, mintPersonKey, rawPublicKey, showAuthorId, signBytes } from "../src/identity.js";
import { rewriteReplicated } from "../src/replicated.js";
import {
  authoredSince,
  BATCH_FORMAT_VERSION,
  batchIdOf,
  canonicalHeader,
  coversOf,
  decodeBatch,
  encodeBatch,
  pendingBatches,
  recordSeal,
  rowsDigest,
  signBatch,
  stageBatch,
  type SignedBatch,
} from "../src/replicated-batch.js";
import { mergeSibling } from "../src/replicated-frame.js";
import { coversText, createEntity, ensureReplica, mergeFrom, type Rows } from "../src/replicated-rows.js";

/**
 * The merge verifies before it applies (docs/identity.md, binding rules 3-6;
 * tests 2, 3 and 4 of the sitting).
 *
 * A batch is one change set from one author with one signature over it. The
 * merge checks that signature under the author id the batch names, over the
 * rows the header lists, found and digested (ruling #3). What does not
 * check is refused, not applied, and reported in `refusedBatches` by author and
 * by a code from the refusal family. `refused` keeps its one meaning: the merge
 * did not run.
 *
 * Both merge paths are exercised: a mailbox batch (encode, decode, stage) and a
 * whole file whose `_dai_batch` table holds the signed headers. They verify the
 * same object.
 */

const DOC = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SCHEMA = `-- dai:replicated
CREATE TABLE seats (
  role TEXT NOT NULL,
  name TEXT NOT NULL
);
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
`;
const TABLES = ["moves", "seats"];

function open(): Rows & { close(): void } {
  const db = new DatabaseSync(":memory:");
  db.exec(rewriteReplicated(SCHEMA).sql);
  return {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
}

/** A person: a key made on their device, and the author id it fingerprints to. */
async function person() {
  const keys = await mintPersonKey();
  const pub = await rawPublicKey(keys.publicKey);
  const author = await authorIdOf(pub);
  return { keys, pub, author, shown: showAuthorId(author) };
}

/**
 * A person whose key is a fixed scalar, so their author id, and every batch id
 * over their rows, is the same on every run: for a test whose teeth depend on
 * which of two ids sorts lower.
 */
async function fixedPerson(scalarHex: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(scalarHex, "hex"));
  const pub = new Uint8Array(ecdh.getPublicKey());
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const jwk = { kty: "EC", crv: "P-256", x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33)), ext: true };
  const curve = { name: "ECDSA", namedCurve: "P-256" };
  const privateKey = await crypto.subtle.importKey("jwk", { ...jwk, d: b64(Buffer.from(scalarHex, "hex")) }, curve, true, ["sign"]);
  const publicKey = await crypto.subtle.importKey("jwk", jwk, curve, true, ["verify"]);
  const author = await authorIdOf(pub);
  return { keys: { privateKey, publicKey }, pub, author, shown: showAuthorId(author) };
}

/** A copy of the document on a person's device, writing under their author id. */
function copyFor(who: { author: Uint8Array }): Rows & { close(): void } {
  const db = open();
  ensureReplica(db, who.author);
  return db;
}

/** The rows a copy wrote, sealed by the key given. */
async function signed(db: Rows, who: { author: Uint8Array; keys: CryptoKeyPair }): Promise<SignedBatch> {
  const entries = authoredSince(db, who.author, 0, TABLES);
  const lc = Math.max(...entries.map((e) => e.row._r_lc));
  return signBatch({ replica: who.author, lc, entries }, { document: DOC, keys: who.keys });
}

/** A batch through the mailbox: bytes out, bytes in, staged, merged. */
async function mergeArrived(local: Rows, bytes: Uint8Array) {
  const sibling = open();
  stageBatch(sibling, decodeBatch(bytes), TABLES);
  return mergeSibling(local, sibling, { document: DOC });
}

const count = (db: Rows, table: string): number => Number(db.all(`SELECT count(*) AS n FROM "${table}"`)[0]!["n"]);

test.describe("a forged seat is refused (test 2)", () => {
  test("a batch naming the creator's author id, signed by a different key, is refused and reported with that id", async () => {
    const ada = await person();
    const bo = await person();
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "seats", crypto.getRandomValues(new Uint8Array(16)), { role: "creator", name: "Ada" });

    // Bo's copy writes rows under Ada's id — the state d22's route produced on
    // the phones — and signs them with the only key it holds, its own.
    const boCopy = copyFor(ada);
    createEntity(boCopy, "seats", crypto.getRandomValues(new Uint8Array(16)), { role: "creator", name: "Bo" });
    const entries = authoredSince(boCopy, ada.author, 0, TABLES);
    const lc = Math.max(...entries.map((e) => e.row._r_lc));
    const digest = await rowsDigest(entries);
    const header = canonicalHeader({ version: BATCH_FORMAT_VERSION, document: DOC, author: ada.author, lc, digest, covers: coversOf(entries) });

    for (const pub of [ada.pub, bo.pub]) {
      // Either way a forger could try it: Ada's public key (the signature fails),
      // or its own (the key does not fingerprint to the id it names).
      const forged: SignedBatch = {
        replica: ada.author,
        lc,
        entries,
        document: DOC,
        version: BATCH_FORMAT_VERSION,
        digest,
        id: await batchIdOf(header),
        sig: await signBytes(bo.keys.privateKey, header),
        pub,
        att: null,
      };
      const local = copyFor(bo);
      const seatsBefore = count(local, "seats");
      const report = await mergeArrived(local, encodeBatch(forged));

      expect(report.refused, "the merge ran").toBeUndefined();
      expect(report.refusedBatches).toEqual([{ author: ada.shown, reason: "BATCH_SIGNATURE_INVALID" }]);
      expect(report.applied, "nothing of the forged batch applied").toBe(0);
      expect(count(local, "seats"), "no seat was taken").toBe(seatsBefore);
      local.close();
    }

    adaCopy.close();
    boCopy.close();
  });
});

test.describe("a tampered batch is refused (test 3)", () => {
  test("one byte of a row changed in transit: refused as a digest mismatch, reported with its author", async () => {
    const ada = await person();
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
    const bytes = encodeBatch(await signed(adaCopy, ada));

    // "e4" as CBOR text is 62 65 34. Change it to "e5" and nothing else.
    const at = bytes.findIndex((_, i) => bytes[i] === 0x62 && bytes[i + 1] === 0x65 && bytes[i + 2] === 0x34);
    expect(at, "the move is in the bytes").toBeGreaterThan(-1);
    const tampered = bytes.slice();
    tampered[at + 2] = 0x35;

    const local = copyFor(await person());
    const report = await mergeArrived(local, tampered);
    expect(report.refused).toBeUndefined();
    expect(report.refusedBatches).toEqual([{ author: ada.shown, reason: "BATCH_DIGEST_MISMATCH" }]);
    expect(report.applied).toBe(0);
    expect(count(local, "moves")).toBe(0);
    local.close();
    adaCopy.close();
  });

  test("one byte of the signature changed in transit: refused as an invalid signature", async () => {
    const ada = await person();
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
    const batch = await signed(adaCopy, ada);
    const sig = batch.sig.slice();
    sig[0] ^= 0x01;

    const local = copyFor(await person());
    const report = await mergeArrived(local, encodeBatch({ ...batch, sig }));
    expect(report.refusedBatches).toEqual([{ author: ada.shown, reason: "BATCH_SIGNATURE_INVALID" }]);
    expect(report.applied).toBe(0);
    local.close();
    adaCopy.close();
  });

  /*
   * Verification is by signed row set (ruling #3): the header lists the rows it
   * covers, and verifying it finds those rows and digests them. The stowaway is
   * not among them, so the header still verifies and the row it covers applies;
   * the stowaway names a batch that does not vouch for it and is refused. This
   * test used to expect neither row applied: that was verification by pointer,
   * where the row that claimed the batch spoiled the batch for the honest row.
   */
  test("a whole file: a row naming a batch that does not list it is refused; the rows the batch lists still apply", async () => {
    const ada = await person();
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
    const batch = await signed(adaCopy, ada);

    // The file as it would arrive: the signed header in `_dai_batch`, the rows
    // naming it. Then one more row, claiming the same batch, that it never signed.
    const file = open();
    stageBatch(file, batch, TABLES);
    const named = file.all("SELECT _r_batch FROM moves LIMIT 1")[0]!["_r_batch"] as Uint8Array;
    expect(named, "a staged row names its batch").toBeInstanceOf(Uint8Array);
    file.run(
      "INSERT INTO moves (ply, san, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_batch) VALUES (2, 'Qh5', ?, 99, 99, ?, '[]', 0, ?)",
      [ada.author, crypto.getRandomValues(new Uint8Array(16)), named],
    );

    const local = copyFor(await person());
    const report = await mergeSibling(local, file, { document: DOC });
    expect(report.refused).toBeUndefined();
    expect(report.refusedBatches).toEqual([{ author: ada.shown, reason: "BATCH_DIGEST_MISMATCH" }]);
    expect(local.all("SELECT san FROM moves").map((r) => r["san"]), "the signed row applied, the stowaway did not").toEqual(["e4"]);
    local.close();
    file.close();
    adaCopy.close();
  });
});

test.describe("a new author is accepted (test 4)", () => {
  test("a batch from a key this copy has never seen, validly signed, applies and refuses nothing", async () => {
    const dan = await person();
    const danCopy = copyFor(dan);
    createEntity(danCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "d4" });

    const grace = await person();
    const local = copyFor(grace);
    const report = await mergeArrived(local, encodeBatch(await signed(danCopy, dan)));
    expect(report.refused).toBeUndefined();
    expect(report.refusedBatches, "always present, empty when nothing was refused").toEqual([]);
    expect(report.applied).toBe(1);
    expect(report.newReplicas, "Dan is a new author here").toBe(1);
    expect(local.all("SELECT san FROM moves").map((r) => r["san"])).toEqual(["d4"]);
    local.close();
    danCopy.close();
  });
});

/**
 * Verification by signed row set (identity ruling #3).
 *
 * A header names the rows it covers by its author and their seqs; verifying it
 * is finding those rows, digesting them and checking the signature. A row's
 * `_r_batch` is a cache of one header that covers it, never the truth: a save
 * can be lost between the rows and their seal, and the same rows can be sealed
 * twice. So a row may be covered by more than one header, a row with no
 * pointer may still be covered, and a seal nobody verified is never adopted.
 */
test.describe("verification by signed row set (ruling #3)", () => {
  const moveOf = (db: Rows) => db.all("SELECT san, _r_batch FROM moves").map((r) => ({
    san: r["san"],
    batch: r["_r_batch"] instanceof Uint8Array ? Buffer.from(r["_r_batch"] as Uint8Array).toString("hex") : null,
  }));
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const headerIds = (db: Rows) => db.all("SELECT lower(hex(id)) AS id FROM _dai_batch ORDER BY id").map((r) => String(r["id"]));
  /** A header put into a copy by hand, as a copy that sealed these rows holds it. */
  const holdHeader = (db: Rows, batch: SignedBatch) =>
    db.run(
      "INSERT INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [batch.id, batch.replica, batch.lc, batch.sig, batch.pub, batch.att, batch.version, batch.digest, coversText(batch.entries)],
    );

  test("the same rows sealed twice: both headers verify, both are kept, and the row keeps the one it names", async () => {
    // A fixed key and entity, so the ids are the same every run.
    const ada = await fixedPerson("1111111111111111111111111111111111111111111111111111111111111111");
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "moves", new Uint8Array(16).fill(0x11), { ply: 1, san: "e4" });
    const first = await signed(adaCopy, ada);
    // Sealed again after the save that held the first seal was lost: the same
    // rows, a later clock, so another header and another id. The first clock
    // whose id sorts below the first's: the teeth (docs/format.md,
    // merge-row-batch) are that the row keeps the header it names though a
    // lower complete one lists it too.
    let again = first;
    for (let lc = first.lc + 1; hexOf(again.id) >= hexOf(first.id); lc += 1) {
      again = await signBatch({ replica: ada.author, lc, entries: first.entries }, { document: DOC, keys: ada.keys });
    }
    expect(hexOf(again.id) < hexOf(first.id), "the header the row names is the higher id").toBe(true);

    const file = open();
    stageBatch(file, first, TABLES);
    holdHeader(file, again);

    const local = copyFor(await person());
    const report = await mergeSibling(local, file, { document: DOC });
    expect(report.refusedBatches).toEqual([]);
    expect(moveOf(local)).toEqual([{ san: "e4", batch: hexOf(first.id) }]);
    expect(headerIds(local), "both headers cover the row, and both verified").toEqual([hexOf(first.id), hexOf(again.id)].sort());
    local.close();
    file.close();
    adaCopy.close();
  });

  test("a row whose pointer a lost save never wrote is still covered, and signed here", async () => {
    const ada = await person();
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
    const batch = await signed(adaCopy, ada);
    // Ada's copy holds the header and the row, and the row still says pending.
    holdHeader(adaCopy, batch);
    expect(moveOf(adaCopy)).toEqual([{ san: "e4", batch: null }]);

    const local = copyFor(await person());
    const report = await mergeSibling(local, adaCopy, { document: DOC });
    expect(report.refusedBatches).toEqual([]);
    expect(moveOf(local), "the header lists the row, so it is signed; the pointer is filled from it").toEqual([
      { san: "e4", batch: hexOf(batch.id) },
    ]);
    local.close();
    adaCopy.close();
  });

  test("a row naming a refused header, covered by one that verifies, applies under the one that verifies", async () => {
    const ada = await person();
    const bo = await person();
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
    const honest = await signed(adaCopy, ada);
    // The same rows under Ada's name, signed with Bo's key: a header that does not verify.
    const forged = await signBatch({ replica: ada.author, lc: honest.lc + 1, entries: honest.entries }, { document: DOC, keys: bo.keys });

    const file = open();
    stageBatch(file, forged, TABLES); // the row names the forged header
    holdHeader(file, honest);

    const local = copyFor(await person());
    const report = await mergeSibling(local, file, { document: DOC });
    expect(moveOf(local), "the row applies, under the header that verifies").toEqual([{ san: "e4", batch: hexOf(honest.id) }]);
    expect(report.refusedBatches).toEqual([{ author: ada.shown, reason: "BATCH_SIGNATURE_INVALID" }]);
    expect(headerIds(local), "the forged header is not kept").toEqual([hexOf(honest.id)]);
    local.close();
    file.close();
    adaCopy.close();
  });

  test("a seal that does not verify is never adopted onto a row this copy holds pending", async () => {
    const ada = await person();
    const bo = await person();
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
    // This copy already holds Ada's row, pending: carried in whole, as a file she
    // sent before her save sealed it carries it (no merge takes an unsigned row).
    const local = copyFor(await person());
    const pending = adaCopy.all("SELECT ply, san, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted FROM moves")[0]!;
    const names = Object.keys(pending);
    local.run(`INSERT INTO moves (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => pending[n]));
    expect(moveOf(local)).toEqual([{ san: "e4", batch: null }]);

    const entries = authoredSince(adaCopy, ada.author, 0, TABLES);
    const forged = await signBatch({ replica: ada.author, lc: 1, entries }, { document: DOC, keys: bo.keys });
    const report = await mergeArrived(local, encodeBatch(forged));
    expect(moveOf(local), "the pending row does not take a seal nobody could verify").toEqual([{ san: "e4", batch: null }]);
    expect(report.refusedBatches).toEqual([{ author: ada.shown, reason: "BATCH_SIGNATURE_INVALID" }]);
    expect(headerIds(local)).toEqual([]);

    // And the real one is taken.
    const real = await signed(adaCopy, ada);
    const taken = await mergeArrived(local, encodeBatch(real));
    expect(taken.refusedBatches).toEqual([]);
    expect(moveOf(local)).toEqual([{ san: "e4", batch: hexOf(real.id) }]);
    local.close();
    adaCopy.close();
  });

  test("a merge given no verdicts takes nothing sealed: unchecked is not signed", async () => {
    const ada = await person();
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
    const file = open();
    stageBatch(file, await signed(adaCopy, ada), TABLES);
    const local = copyFor(await person());
    const result = mergeFrom(local, file, TABLES);
    expect(result.refusedBatches).toEqual([{ author: ada.shown, reason: "BATCH_SIGNATURE_INVALID" }]);
    expect(count(local, "moves")).toBe(0);
    local.close();
    file.close();
    adaCopy.close();
  });
});

/**
 * A forger's unsigned rows against an honest signed batch (cold review of step
 * 4, findings 1-3; ruled 24 September).
 *
 * A per-author seq is one counter per document, so `(author, seq)` names one
 * row whatever table it sits in: the same number in two tables is a collision,
 * not two rows. And a signed row always outranks an unsigned row at the same
 * id, whichever arrived first. A forger's row can therefore never spoil a
 * signed batch, here or downstream, and a refusal names who wrote the refused
 * row, not whose batch it pointed at.
 */
test.describe("a forger's unsigned rows cannot spoil a signed batch (review of step 4)", () => {
  const moves = (db: Rows) => db.all("SELECT san, _r_batch IS NOT NULL AS sealed FROM moves").map((r) => ({ san: r["san"], sealed: Number(r["sealed"]) }));
  const seats = (db: Rows) => db.all("SELECT name FROM seats").map((r) => r["name"]);
  /** A row written into a copy by hand under someone else's author id, with no batch. */
  const forge = (db: Rows, table: "moves" | "seats", author: Uint8Array, seq: number, columns: Record<string, unknown>) => {
    const names = Object.keys(columns);
    db.run(
      `INSERT INTO ${table} (${names.join(", ")}, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted) VALUES (${names.map(() => "?").join(", ")}, ?, ?, ?, ?, '[]', 0)`,
      [...names.map((n) => columns[n]), author, seq, seq, crypto.getRandomValues(new Uint8Array(16))],
    );
  };
  const idOf = (author: Uint8Array, seq: number) => `${Buffer.from(author).toString("hex")}:${seq}`;

  /** Ada's signed move at seq 1, as a file: header and row. */
  async function adasMove() {
    const ada = await person();
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
    const batch = await signed(adaCopy, ada);
    const file = open();
    stageBatch(file, batch, TABLES);
    adaCopy.close();
    return { ada, file };
  }

  test("batch format version 2: an unsigned row is refused in every table, not only the seat tables (BATCH_UNSIGNED)", async () => {
    const ada = await person();
    const mal = copyFor(await person());
    // A move under Ada's id that no header of hers lists, in a plain table.
    forge(mal, "moves", ada.author, 1, { ply: 1, san: "e4" });
    const bo = copyFor(await person());
    const report = await mergeSibling(bo, mal, { document: DOC });
    expect(report.refusedBatches).toEqual([{ author: ada.shown, reason: "BATCH_UNSIGNED" }]);
    expect(moves(bo), "nothing unsigned is taken").toEqual([]);
    mal.close();
    bo.close();
  });

  test("the same (author, seq) in another table, unsigned, is refused on arrival, and the signed batch still verifies downstream", async () => {
    const { ada, file } = await adasMove();
    // Mal's copy: a seat under Ada's id at Ada's seq 1, unsigned.
    const mal = copyFor(await person());
    forge(mal, "seats", ada.author, 1, { role: "creator", name: "Mallory" });

    const bo = copyFor(await person());
    await mergeSibling(bo, file, { document: DOC });
    const fromMal = await mergeSibling(bo, mal, { document: DOC });
    expect(fromMal.refusedBatches, "nobody signed Mal's seat, so it is nobody's").toEqual([{ author: ada.shown, reason: "BATCH_UNSIGNED" }]);
    expect(fromMal.rejected).toEqual([]);
    expect(seats(bo)).toEqual([]);

    // And Bo's copy, passed on, still carries Ada's move signed.
    const carol = copyFor(await person());
    const fromBo = await mergeSibling(carol, bo, { document: DOC });
    expect(fromBo.refusedBatches).toEqual([]);
    expect(moves(carol)).toEqual([{ san: "e4", sealed: 1 }]);
    for (const db of [file, mal, bo, carol]) db.close();
  });

  test("the forgery first, the signed row after: the forgery never lands, so the signed row takes its id with nothing displaced", async () => {
    const { ada, file } = await adasMove();
    const mal = copyFor(await person());
    forge(mal, "seats", ada.author, 1, { role: "creator", name: "Mallory" });

    const bo = copyFor(await person());
    const fromMal = await mergeSibling(bo, mal, { document: DOC });
    expect(fromMal.refusedBatches).toEqual([{ author: ada.shown, reason: "BATCH_UNSIGNED" }]);
    expect(seats(bo), "unsigned, it is refused in every table").toEqual([]);
    const fromAda = await mergeSibling(bo, file, { document: DOC });
    expect(moves(bo)).toEqual([{ san: "e4", sealed: 1 }]);
    expect(fromAda.rejected).toEqual([]);
    expect(fromAda.refusedBatches).toEqual([]);
    for (const db of [file, mal, bo]) db.close();
  });

  test("one hostile file holding both: the signed row is taken and the forgery refused, in either table order", async () => {
    const { ada, file } = await adasMove();
    // The forgery rides in the same file as Ada's honest, signed move.
    forge(file, "seats", ada.author, 1, { role: "creator", name: "Mallory" });

    const carol = copyFor(await person());
    const report = await mergeSibling(carol, file, { document: DOC });
    expect(moves(carol)).toEqual([{ san: "e4", sealed: 1 }]);
    expect(seats(carol)).toEqual([]);
    expect(report.refusedBatches, "Ada's batch verified; only the row nobody signed is refused").toEqual([{ author: ada.shown, reason: "BATCH_UNSIGNED" }]);
    expect(report.rejected).toEqual([]);
    file.close();
    carol.close();
  });

  test("a signed row outranks an unsigned row at the same id: this copy's own pending row, reissued after a lost save, gives way", async () => {
    /*
     * At batch format version 2 no merge takes an unsigned row, so the one
     * unsigned row a copy can hold is its own, pending. A save that never
     * landed leaves a copy whose counter is behind what it already sent: it
     * issues seq 1 again, for a different row. When its signed seq 1 comes back,
     * the signed row takes the id, and the pending one is reported as a
     * different row wearing it.
     */
    const { ada, file } = await adasMove();
    const lost = copyFor(ada);
    createEntity(lost, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "f3" });
    expect(moves(lost)).toEqual([{ san: "f3", sealed: 0 }]);
    const back = await mergeSibling(lost, file, { document: DOC, author: ada.author });
    expect(moves(lost), "her signed e4, not the pending f3 reissued at its seq").toEqual([{ san: "e4", sealed: 1 }]);
    expect(back.rejected).toEqual([idOf(ada.author, 1)]);
    expect(back.refusedBatches).toEqual([]);
    for (const db of [file, lost]) db.close();
  });
  test("a stowaway naming someone else's batch is refused in the name of whoever wrote it", async () => {
    const { ada, file } = await adasMove();
    const mal = await person();
    const named = file.all("SELECT _r_batch FROM moves LIMIT 1")[0]!["_r_batch"] as Uint8Array;
    // Mal's own row, claiming Ada's batch, which does not list it.
    file.run(
      "INSERT INTO moves (ply, san, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_batch) VALUES (2, 'Qh5', ?, 7, 7, ?, '[]', 0, ?)",
      [mal.author, crypto.getRandomValues(new Uint8Array(16)), named],
    );
    const carol = copyFor(await person());
    const report = await mergeSibling(carol, file, { document: DOC });
    expect(report.refusedBatches, "Mal wrote the refused row; Ada's batch was taken").toEqual([{ author: mal.shown, reason: "BATCH_DIGEST_MISMATCH" }]);
    expect(moves(carol)).toEqual([{ san: "e4", sealed: 1 }]);
    file.close();
    carol.close();
  });

  test("a forwarder relabels which rows an honest header covers: the honest row is still taken, and nothing is refused in its author's name", async () => {
    const ada = await person();
    const adaCopy = copyFor(ada);
    createEntity(adaCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
    for (const b of pendingBatches(adaCopy, ada.author, TABLES)) recordSeal(adaCopy, await signBatch(b, { document: DOC, keys: ada.keys }));
    createEntity(adaCopy, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 2, san: "e5" });
    for (const b of pendingBatches(adaCopy, ada.author, TABLES)) recordSeal(adaCopy, await signBatch(b, { document: DOC, keys: ada.keys }));

    // Mal holds Ada's copy and forwards it, with her second header's list of
    // rows changed to her first row's. Nothing he did needed her key.
    const mal = copyFor(await person());
    expect((await mergeSibling(mal, adaCopy, { document: DOC })).refusedBatches).toEqual([]);
    const [first, second] = ["e4", "e5"].map(
      (san) => mal.all("SELECT _r_batch FROM moves WHERE san = ?", [san])[0]!["_r_batch"] as Uint8Array,
    );
    const firstCovers = mal.all("SELECT covers FROM _dai_batch WHERE id = ?", [first])[0]!["covers"];
    mal.run("UPDATE _dai_batch SET covers = ? WHERE id = ?", [firstCovers, second]);

    const bo = copyFor(await person());
    const report = await mergeSibling(bo, mal, { document: DOC });
    expect.soft(report.refusedBatches, "nothing is refused in Ada's name: she signed nothing wrong").toEqual([]);
    expect.soft(moves(bo).map((m) => m.san), "both of Ada's signed moves are taken").toEqual(["e4", "e5"]);
    for (const db of [adaCopy, mal, bo]) db.close();
  });
});

test.describe("a row's earlier versions have one shape (D159)", () => {
  /** Ada's copy with two rows in one pending batch: a plain move, and one whose parents are `parents`. */
  async function batchWith(parents: string) {
    const ada = await person();
    const db = copyFor(ada);
    const ins = (seq: number, san: string, text: string) =>
      db.run(
        "INSERT INTO moves (ply, san, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        [seq, san, ada.author, seq, seq, crypto.getRandomValues(new Uint8Array(16)), text],
      );
    ins(1, "e4", "[]");
    ins(2, "e5", parents);
    for (const b of pendingBatches(db, ada.author, TABLES)) recordSeal(db, await signBatch(b, { document: DOC, keys: ada.keys }));
    return { ada, db };
  }
  const id = "0123456789abcdef0123456789abcdef";
  const MALFORMED: [string, string][] = [
    ["nested past SQLite's depth", "[".repeat(1100) + "]".repeat(1100)],
    ["nested at all", `[["${id}:1"]]`],
    ["past the cap", JSON.stringify(Array.from({ length: 257 }, (_, i) => `${id}:${i + 1}`))],
    ["uppercase hex", `["${id.toUpperCase()}:1"]`],
    ["a seq of 0", `["${id}:0"]`],
    ["a number, not an id", "[7]"],
    ["an object", `{"a":"${id}:1"}`],
    ["not JSON", "[,"],
  ];
  for (const [what, text] of MALFORMED) {
    test(`parents ${what}: the batch that signed it is refused, in its author's name, and its header is not kept`, async () => {
      const { ada, db } = await batchWith(text);
      const bo = copyFor(await person());
      const report = await mergeSibling(bo, db, { document: DOC });
      expect(report.refusedBatches).toEqual([{ author: ada.shown, reason: "ROW_MALFORMED" }]);
      expect(count(bo, "moves"), "neither row of the batch is taken").toBe(0);
      expect(count(bo, "_dai_batch"), "the header is not kept").toBe(0);
      db.close();
      bo.close();
    });
  }
  test("parents of the one shape, up to the cap, are taken", async () => {
    for (const text of ["[]", `["${id}:1"]`, JSON.stringify(Array.from({ length: 256 }, (_, i) => `${id}:${i + 1}`))]) {
      const { db } = await batchWith(text);
      const bo = copyFor(await person());
      expect((await mergeSibling(bo, db, { document: DOC })).refusedBatches, text.slice(0, 40)).toEqual([]);
      expect(count(bo, "moves")).toBe(2);
      db.close();
      bo.close();
    }
  });
  test("an unsigned row with malformed parents is refused in the name it carries", async () => {
    const ada = await person();
    const db = copyFor(ada);
    db.run(
      "INSERT INTO moves (ply, san, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted) VALUES (1, 'e4', ?, 1, 1, ?, ?, 0)",
      [ada.author, crypto.getRandomValues(new Uint8Array(16)), `[["${id}:1"]]`],
    );
    const bo = copyFor(await person());
    const report = await mergeSibling(bo, db, { document: DOC });
    expect(report.refusedBatches).toEqual([{ author: ada.shown, reason: "ROW_MALFORMED" }]);
    expect(count(bo, "moves")).toBe(0);
    db.close();
    bo.close();
  });
});

test.describe("the stored form (ruling B)", () => {
  test("a replicated table carries _r_batch and no _r_sig; the signed headers live in _dai_batch", () => {
    const db = open();
    const columns = (table: string) => db.all("SELECT name FROM pragma_table_info(?)", [table]).map((r) => String(r["name"]));
    expect(columns("moves")).toContain("_r_batch");
    expect(columns("moves"), "one place a signature lives, not two").not.toContain("_r_sig");
    // covers: the rows each header lists, as [table, seq], which is what a merge verifies (ruling #3).
    expect(columns("_dai_batch").sort()).toEqual(["att", "author", "covers", "digest", "id", "lc", "pub", "sig", "version"]);
    db.close();
  });
});
