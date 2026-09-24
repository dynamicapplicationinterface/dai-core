import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { authorIdOf, mintPersonKey, rawPublicKey, showAuthorId, signBytes } from "../src/identity.js";
import { rewriteReplicated } from "../src/replicated.js";
import {
  authoredSince,
  batchIdOf,
  canonicalHeader,
  decodeBatch,
  encodeBatch,
  rowsDigest,
  signBatch,
  stageBatch,
  type SignedBatch,
} from "../src/replicated-batch.js";
import { mergeSibling } from "../src/replicated-frame.js";
import { createEntity, ensureReplica, type Rows } from "../src/replicated-rows.js";

/**
 * The merge verifies before it applies (docs/identity.md, binding rules 3-6;
 * tests 2, 3 and 4 of the sitting).
 *
 * A batch is one change set from one author with one signature over it. The
 * merge checks that signature under the author id the batch names, and checks
 * that every row claiming the batch is covered by its digest. What does not
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
    const header = canonicalHeader({ version: 1, document: DOC, author: ada.author, lc, digest });

    for (const pub of [ada.pub, bo.pub]) {
      // Either way a forger could try it: Ada's public key (the signature fails),
      // or its own (the key does not fingerprint to the id it names).
      const forged: SignedBatch = {
        replica: ada.author,
        lc,
        entries,
        document: DOC,
        version: 1,
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

  test("a whole file: a row naming a batch whose digest does not cover it is refused, not applied as an orphan", async () => {
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
    expect(count(local, "moves"), "neither the signed row nor the stowaway applied").toBe(0);
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

test.describe("the stored form (ruling B)", () => {
  test("a replicated table carries _r_batch and no _r_sig; the signed headers live in _dai_batch", () => {
    const db = open();
    const columns = (table: string) => db.all("SELECT name FROM pragma_table_info(?)", [table]).map((r) => String(r["name"]));
    expect(columns("moves")).toContain("_r_batch");
    expect(columns("moves"), "one place a signature lives, not two").not.toContain("_r_sig");
    expect(columns("_dai_batch").sort()).toEqual(["att", "author", "digest", "id", "lc", "pub", "sig", "version"]);
    db.close();
  });
});
