import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { authorIdOf, mintPersonKey, rawPublicKey, verifySignature } from "../src/identity.js";
import { rewriteReplicated } from "../src/replicated.js";
import { authoredBatchAbove, decodeBatch, headerOf, pendingBatches, recordSeal, signBatch } from "../src/replicated-batch.js";
import { applyRow, coversText, createEntity, ensureReplica, filterToSession, type Rows } from "../src/replicated-rows.js";
import { mergeSibling } from "../src/replicated-frame.js";

/**
 * Sealing on leave (docs/identity.md, step 3, ruled 24 September).
 *
 * A row is written pending, `_r_batch` NULL, and sealed when it first leaves
 * the device: its author's pending rows become one signed batch, the header is
 * kept in `_dai_batch`, and every row covered names it. These hold the parts of
 * that which live in the rows themselves; when a seal happens is the runtime's.
 */

const DOC = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PLAIN = `-- dai:replicated
CREATE TABLE moves (ply INTEGER NOT NULL, san TEXT NOT NULL);
-- dai:replicated
CREATE TABLE notes (body TEXT NOT NULL);
`;
const SESSIONS = `-- dai:profile session max_parties=2 close=any
-- dai:replicated
CREATE TABLE moves (ply INTEGER NOT NULL, san TEXT NOT NULL);
`;

function open(schema: string): Rows & { close(): void } {
  const db = new DatabaseSync(":memory:");
  db.exec(rewriteReplicated(schema).sql);
  return wrap(db);
}

function wrap(db: DatabaseSync): Rows & { close(): void } {
  return {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
}

async function person() {
  const keys = await mintPersonKey();
  return { keys, author: await authorIdOf(await rawPublicKey(keys.publicKey)) };
}

const pendingCount = (db: Rows): number =>
  ["moves", "notes"].reduce(
    (n, t) =>
      n +
      (db.all("SELECT 1 FROM sqlite_schema WHERE name = ?", [t]).length
        ? Number(db.all(`SELECT count(*) AS n FROM "${t}" WHERE _r_batch IS NULL`)[0]!["n"])
        : 0),
    0,
  );

test("one leave seals every pending row of the author into one batch, across tables, and the header verifies", async () => {
  const ada = await person();
  const db = open(PLAIN);
  ensureReplica(db, ada.author);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
  createEntity(db, "notes", crypto.getRandomValues(new Uint8Array(16)), { body: "opening" });
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 2, san: "e5" });

  const batches = pendingBatches(db, ada.author, ["moves", "notes"]);
  expect(batches, "one batch per leave, not one per table").toHaveLength(1);
  expect(batches[0]!.entries).toHaveLength(3);

  const sealed = await signBatch(batches[0]!, { document: DOC, keys: ada.keys });
  recordSeal(db, sealed);
  expect(pendingCount(db), "nothing is pending after the seal").toBe(0);
  const header = db.all("SELECT * FROM _dai_batch")[0]!;
  expect(header["id"]).toEqual(sealed.id);
  expect(await verifySignature(header["pub"] as Uint8Array, headerOf(sealed), header["sig"] as Uint8Array)).toBe(true);
  db.close();
});

test("a batch holds one author's rows only: rows another author wrote are never sealed here", async () => {
  const ada = await person();
  const bo = await person();
  const db = open(PLAIN);
  ensureReplica(db, ada.author);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
  // Bo's row, arrived unsealed (a pre-signing copy's), sits in the same table.
  applyRow(db, "moves", {
    _r_replica: bo.author,
    _r_seq: 1,
    _r_lc: 1,
    _r_entity: crypto.getRandomValues(new Uint8Array(16)),
    _r_parents: "[]",
    _r_deleted: 0,
    columns: { ply: 2, san: "e5" },
  });
  const batches = pendingBatches(db, ada.author, ["moves", "notes"]);
  expect(batches.flatMap((b) => b.entries.map((e) => e.row._r_replica))).toEqual([ada.author]);
  db.close();
});

test("pending rows stored on disk are not orphans: after a reopen they seal at the next leave", async () => {
  const ada = await person();
  // A database on disk, as a stored copy is.
  const path = join(mkdtempSync(join(tmpdir(), "dai-seal-")), "stored.sqlite");
  const firstDb = new DatabaseSync(path);
  firstDb.exec(rewriteReplicated(PLAIN).sql);
  const first = wrap(firstDb);
  ensureReplica(first, ada.author);
  createEntity(first, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
  createEntity(first, "notes", crypto.getRandomValues(new Uint8Array(16)), { body: "unsent" });
  // The tab is closed before anything left: the stored database holds them pending.
  first.close();

  const db = wrap(new DatabaseSync(path));
  expect(pendingCount(db), "the stored rows came back pending").toBe(2);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 2, san: "Nf3" });

  const batches = pendingBatches(db, ada.author, ["moves", "notes"]);
  expect(batches).toHaveLength(1);
  expect(batches[0]!.entries, "the earlier session's rows and this one's, in one batch").toHaveLength(3);
  recordSeal(db, await signBatch(batches[0]!, { document: DOC, keys: ada.keys }));
  expect(pendingCount(db)).toBe(0);
  db.close();
});

test("in a session document, one batch per session: a lane never carries another game's rows", async () => {
  const ada = await person();
  const db = open(SESSIONS);
  ensureReplica(db, ada.author);
  const one = new Uint8Array(16).fill(1);
  const two = new Uint8Array(16).fill(2);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" }, one);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "d4" }, two);
  const batches = pendingBatches(db, ada.author, ["moves"]);
  expect(batches).toHaveLength(2);
  for (const batch of batches) {
    const sessions = new Set(batch.entries.map((e) => [...(e.row._r_session as Uint8Array)].join(",")));
    expect(sessions.size, "each batch is one session's rows").toBe(1);
  }
  db.close();
});

test("an invite for one session keeps the headers that list its rows, pointer or not, and no other session's", async () => {
  // Ruling #3: a header lists its rows, and a row's pointer is a cache a lost
  // save can leave unset. The copy an invite sends keeps a header by what it
  // lists, or the session's rows arrive signed by nothing.
  const ada = await person();
  const db = open(SESSIONS);
  ensureReplica(db, ada.author);
  const one = new Uint8Array(16).fill(1);
  const two = new Uint8Array(16).fill(2);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" }, one);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "d4" }, two);
  const [first, second] = pendingBatches(db, ada.author, ["moves"]);
  const ofOne = [first!, second!].find((b) => (b.entries[0]!.row._r_session as Uint8Array)[0] === 1)!;
  const ofTwo = [first!, second!].find((b) => b !== ofOne)!;
  // Session one's seal is held and its rows' pointers never written (the lost
  // save); session two is sealed as usual.
  const lost = await signBatch(ofOne, { document: DOC, keys: ada.keys });
  db.run(
    "INSERT INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [lost.id, lost.replica, lost.lc, lost.sig, lost.pub, lost.att, lost.version, lost.digest, coversText(lost.entries)],
  );
  const sealed = await signBatch(ofTwo, { document: DOC, keys: ada.keys });
  recordSeal(db, sealed);

  filterToSession(db, one);
  const kept = db.all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => String(r["id"]));
  expect(kept, "the header that lists session one's rows travels with them").toEqual([Buffer.from(lost.id).toString("hex")]);
  db.close();
});

test("the mailbox sends sealed batches only, and its head never passes a row still pending", async () => {
  /*
   * The host moves its watermark to the head even when nothing is sent, so a
   * head above an unsealed row would leave that row unsent for good. Here the
   * sealed batch sits above a pending row (another session's, not yet sealed):
   * the batch goes, and the head stays below the pending row.
   */
  const ada = await person();
  const db = open(SESSIONS);
  ensureReplica(db, ada.author);
  const one = new Uint8Array(16).fill(1);
  const two = new Uint8Array(16).fill(2);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "d4" }, two); // seq 1, stays pending
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" }, one); // seq 2
  const [forOne] = pendingBatches(db, ada.author, ["moves"]).filter((b) =>
    b.entries.every((e) => (e.row._r_session as Uint8Array)[0] === 1),
  );
  recordSeal(db, await signBatch(forOne!, { document: DOC, keys: ada.keys }));

  const answer = authoredBatchAbove(db, ada.author, { replica: "", seq: 0 }, ["moves"], undefined, DOC);
  expect(answer.batch, "the sealed batch is sent").not.toBeNull();
  expect(decodeBatch(answer.batch!).entries.map((e) => e.row.columns["san"])).toEqual(["e4"]);
  expect(answer.head, "and the head stays below the pending row, seq 1").toBe(0);
  db.close();
});

test("the mailbox answers for the author it is told, not for whatever _dai_replica says", async () => {
  /*
   * Binding rule 1 (cold review of identity step 3, #6): who this copy is comes
   * from the host, never from a row. A copy whose _dai_replica names somebody
   * else still publishes its own author's batch, under that author.
   */
  const ada = await person();
  const db = open(PLAIN);
  ensureReplica(db, ada.author);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
  recordSeal(db, await signBatch(pendingBatches(db, ada.author, ["moves", "notes"])[0]!, { document: DOC, keys: ada.keys }));
  db.run("UPDATE _dai_replica SET id = ?", [new Uint8Array(16).fill(0xee)]);

  const answer = authoredBatchAbove(db, ada.author, { replica: "", seq: 0 }, ["moves", "notes"], undefined, DOC);
  expect(answer.batch, "Ada's sealed batch is still hers to send").not.toBeNull();
  expect(decodeBatch(answer.batch!).replica).toEqual(ada.author);
  expect(answer.replica).toBe(Buffer.from(ada.author).toString("hex"));
  db.close();
});

test("a merge raises the counter for the author it is told, not for whatever _dai_replica says", async () => {
  const ada = await person();
  const source = open(PLAIN);
  ensureReplica(source, ada.author);
  for (const san of ["e4", "d4", "c4", "Nf3"]) {
    createEntity(source, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san });
  }
  // The copy that gets them back holds a _dai_replica naming somebody else.
  const back = open(PLAIN);
  ensureReplica(back, new Uint8Array(16).fill(0xee));
  await mergeSibling(back, source, { author: ada.author });
  expect(Number(back.all("SELECT seq FROM _dai_replica")[0]!["seq"]), "raised to Ada's highest, 4").toBe(4);
  back.close();
  source.close();
});

test("a row can name only a batch whose header this copy holds: the engine refuses any other", async () => {
  /*
   * Cold review of identity step 3, #2(c): application SQL could set _r_batch on
   * its own pending rows to any 16 bytes, so they counted as sealed and were
   * never signed, and the mailbox stalled on a batch with no header. The seal
   * is a courtesy to the honest path; the verifier is the enforcement, and this
   * keeps the honest path from being walked off by accident or on purpose.
   */
  const ada = await person();
  const db = open(PLAIN);
  ensureReplica(db, ada.author);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
  const bogus = new Uint8Array(16).fill(0x42);
  expect(() => db.run("UPDATE moves SET _r_batch = ?", [bogus]), "named by an update").toThrow(/REPLICATED_TABLE_IMMUTABLE|_dai_batch/);
  expect(
    () =>
      db.run(
        "INSERT INTO moves (ply, san, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_batch) VALUES (2, 'd4', ?, 9, 9, ?, '[]', 0, ?)",
        [ada.author, crypto.getRandomValues(new Uint8Array(16)), bogus],
      ),
    "named by an insert",
  ).toThrow(/REPLICATED_TABLE_IMMUTABLE|_dai_batch/);
  // A real seal still goes through: its header is written first.
  recordSeal(db, await signBatch(pendingBatches(db, ada.author, ["moves", "notes"])[0]!, { document: DOC, keys: ada.keys }));
  expect(pendingCount(db)).toBe(0);
  db.close();
});

test("a row is sealed once: _r_batch goes from NULL to an id, and the engine refuses any change after", async () => {
  const ada = await person();
  const db = open(PLAIN);
  ensureReplica(db, ada.author);
  createEntity(db, "moves", crypto.getRandomValues(new Uint8Array(16)), { ply: 1, san: "e4" });
  recordSeal(db, await signBatch(pendingBatches(db, ada.author, ["moves", "notes"])[0]!, { document: DOC, keys: ada.keys }));
  expect(() => db.run("UPDATE moves SET _r_batch = ?", [new Uint8Array(16).fill(9)])).toThrow(/REPLICATED_TABLE_IMMUTABLE/);
  expect(() => db.run("UPDATE moves SET _r_batch = NULL")).toThrow(/REPLICATED_TABLE_IMMUTABLE/);
  db.close();
});
