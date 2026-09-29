/**
 * Builds the Level 1 merge fixtures.
 *
 * Each vector ships as input databases and expected text, checked in. The
 * Python reader's `merge` subcommand consumes the same inputs and diffs its own
 * dump against the same expected text — it never reads this script's output at
 * run time. If the fixtures were generated on the fly and Python compared
 * against that, the G1 gate would be TypeScript agreeing with itself.
 *
 *     node scripts/build-merge-fixtures.mjs          # write
 *     node scripts/build-merge-fixtures.mjs --check  # fail if anything differs
 *
 * `--check` is what CI runs. A change to the merge then cannot land without the
 * expected text changing in the same diff, where a reviewer sees it.
 *
 * Everything here is deterministic: replica and entity ids are constants, there
 * is no clock and no randomness. Two runs must produce identical text, or the
 * check flaps and somebody turns it off.
 *
 * The sealed vectors (signed authorship, docs/identity.md) sign with two fixed
 * keys, so their authors are real key fingerprints and a verifying merge can
 * check them. ECDSA signatures are not deterministic, so each one is kept in
 * signatures.json by the header it covers: signed once, when written, and
 * reused after. `--check` never signs; a header with no kept signature fails.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteReplicated } from "../dist/replicated.js";
import {
  applyRow,
  canonicalDump,
  changeEntity,
  createEntity,
  deleteEntity,
  mergeFrom,
} from "../dist/dai-merge.js";
import { replicatedSchemaOf } from "../dist/replicated-frame.js";
import { adoptReplica, mergeTablesOf, pendingBatches, recordSeal, signBatch, stageBatch, verifyBatches } from "../dist/dai-merge.js";
import { confirmSeat, coversText, startSession } from "../dist/replicated-rows.js";
import { authorIdOf, signBytes } from "../dist/identity.js";
import { createECDH, createHash, webcrypto } from "node:crypto";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "conformance", "merge");
const check = process.argv.includes("--check");

const SCHEMA = `-- dai:replicated
CREATE TABLE cases (
  title  TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  weight REAL
);
-- dai:replicated
CREATE TABLE notes (
  body TEXT NOT NULL
);
`;

// Two shared tables, because one author's seq names one row across all of them
// (a collision in another table is a vector of its own).
const TABLES = ["cases", "notes"];

/*
 * The session vectors' document (backlog D171): a session profile with one
 * seated table, no author roles, and the close rule `any`. What batch format
 * version 2 changed after the signature is mostly what such a document
 * admits, so these vectors also ship the admitted state (`expected-admitted-*`).
 */
const SESSION_SCHEMA = `-- dai:profile session max_parties=2 close=any
-- dai:replicated seat=seat
CREATE TABLE moves (
  seat BLOB,
  san  TEXT NOT NULL
);
`;

/**
 * `dai_session_id(author, seq)`: SHA-256 of the author id and the seq as eight
 * bytes, unsigned, big-endian, first 16 bytes (docs/format.md#session-id).
 * Written here from the page with node:crypto, not imported: the roster views
 * call it, and a fixture should not take the runtime's own hash on trust.
 */
function sessionIdOf(author, seq) {
  if (!(author instanceof Uint8Array) || author.length !== 16) return null;
  const n = typeof seq === "bigint" ? seq : BigInt(seq);
  if (n < 0n || n >= 1n << 64n) return null;
  const be = Buffer.alloc(8);
  be.writeBigUInt64BE(n);
  return new Uint8Array(createHash("sha256").update(author).update(be).digest().subarray(0, 16));
}
const id = (byte) => new Uint8Array(16).fill(byte);
const E1 = id(0x11);
const E2 = id(0x22);
/** A row id's author part as `_r_parents` spells it: lowercase hex. */
const hexOf = (bytes) => Buffer.from(bytes).toString("hex");

/*
 * The two authors of the sealed vectors: fixed private scalars, so the keys,
 * the author ids and every header are the same on every run.
 */
const DOC = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
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
const ADA = await fixedPerson("1111111111111111111111111111111111111111111111111111111111111111");
const BO = await fixedPerson("2222222222222222222222222222222222222222222222222222222222222222");

const SIGNATURES = join(repo, "conformance", "merge", "signatures.json");
const signatures = existsSync(SIGNATURES) ? JSON.parse(readFileSync(SIGNATURES, "utf8")) : {};
let signaturesAdded = 0;
/** A signer that reuses the kept signature for a header it has seen, and signs (when writing) one it has not. */
const keptSigner = (person) => async (header) => {
  const key = Buffer.from(header).toString("hex");
  if (!signatures[key]) {
    if (check) throw new Error(`no kept signature for header ${key.slice(0, 16)}...; run the generator to write one`);
    signatures[key] = Buffer.from(await signBytes(person.keys.privateKey, header)).toString("hex");
    signaturesAdded += 1;
  }
  return { sig: new Uint8Array(Buffer.from(signatures[key], "hex")), pub: person.pub };
};

/** Seals everything an author has pending, as a leave does (docs/identity.md, step 3). */
async function sealAll(db, person) {
  for (const batch of pendingBatches(db, person.author, db.tables)) {
    recordSeal(db, await signBatch(batch, { document: DOC, sign: keptSigner(person) }));
  }
}

/**
 * One exchange inside a vector's own history, as an honest one is at batch
 * format version 2: the sender seals what it wrote, the receiver verifies the
 * sender's headers and takes only what verified. An unsigned row crosses no
 * merge (BATCH_UNSIGNED).
 */
async function exchange(into, from, sender) {
  await sealAll(from, sender);
  return mergeFrom(into, from, into.tables, undefined, await verifyBatches(from, from.tables, DOC));
}

/**
 * A database on disk, behind the interface the write rules ask for, carrying
 * the tables it merges (`tables`): the two plain ones, or for a session
 * document every table its merge covers, the seat tables and the close with it.
 */
function open(path, extra, schema = SCHEMA) {
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.function("dai_session_id", { deterministic: true }, sessionIdOf);
  db.exec(rewriteReplicated(schema).sql);
  // A table the author did not declare replicated. It never travels and never
  // merges, and the fixture exists to prove it does not stop one either.
  if (extra) db.exec(extra);
  const rows = {
    all: (sql, params = []) => db.prepare(sql).all(...params),
    run: (sql, params = []) => void db.prepare(sql).run(...params),
    close: () => db.close(),
  };
  rows.tables = schema === SCHEMA ? TABLES : mergeTablesOf(rows);
  return rows;
}

/** A copy of a vector's document: the session schema for a session vector. */
const openFor = (vector, path, extra) => open(path, extra, vector.session ? SESSION_SCHEMA : SCHEMA);

/*
 * What a session document admits after a merge (backlog D171), from the
 * runtime's own views: the admitted heads of every table the merge covers, by
 * id with the deleted flag, then who holds each seat, the seats voided, the ids
 * signed twice and the sessions closed. A reader computes the same from the
 * tables alone.
 */
function admittedDump(db) {
  const hexId = "lower(hex(_r_replica)) || ':' || _r_seq";
  const lines = [];
  for (const table of [...db.tables].sort()) {
    lines.push(`# ${table}`);
    for (const r of db.all(`SELECT ${hexId} AS id, _r_deleted AS d FROM "${table}_heads" ORDER BY hex(_r_replica), _r_seq`))
      lines.push(`${r.id}\t${r.d}`);
  }
  const section = (title, sql) => {
    lines.push(`# ${title}`);
    for (const r of db.all(sql)) lines.push(Object.values(r).join("\t"));
  };
  section("holders", "SELECT lower(hex(session)), lower(hex(seat)), lower(hex(replica)) FROM _dai_holder ORDER BY 1, 2, 3");
  section("voided", "SELECT lower(hex(session)), lower(hex(seat)), lower(hex(creator)) FROM _dai_voided ORDER BY 1, 2, 3");
  section("equivocated", "SELECT lower(hex(author)), tbl, seq FROM _dai_equivocated ORDER BY 1, 2, 3");
  section("closed", "SELECT lower(hex(session)) FROM _dai_closed ORDER BY 1");
  return `${lines.join("\n")}\n`;
}

/**
 * B as a copy of A's file rather than as a second database.
 *
 * Every other vector builds two independent copies, which is why none of them
 * could have caught T1-D22: the suite had no notion of a file arriving. This
 * copies every row and A's own `_dai_replica`, exactly as opening a received
 * file does, and then lets the recipient adopt an identity of its own.
 */
function receiveInto(to, from, id) {
  for (const header of from.all("SELECT * FROM _dai_batch")) {
    const names = Object.keys(header);
    to.run(
      `INSERT INTO _dai_batch (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      names.map((n) => header[n]),
    );
  }
  for (const table of TABLES) {
    for (const row of from.all(`SELECT * FROM "${table}"`)) {
      const names = Object.keys(row);
      to.run(
        `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        names.map((n) => row[n]),
      );
    }
  }
  const theirs = from.all("SELECT id, seq, lc FROM _dai_replica")[0];
  to.run("DELETE FROM _dai_replica");
  to.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, ?, ?)", [
    theirs.id, theirs.seq, theirs.lc,
  ]);
  to.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [theirs.id]);
  // And the recipient becomes itself (T1-D22).
  adoptReplica(to, id);
}

function asReplica(db, replicaId) {
  db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [replicaId]);
  db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [replicaId]);
}

/**
 * Every vector, as a pair of copies and what merging them must produce.
 *
 * `fill` is given both copies and populates them; nothing else may write.
 */
const VECTORS = [
  {
    name: "merge-disjoint",
    cites: ["6", "T1-D9"],
    what: "Two replicas, entities that never meet. Every row is new to the other side.",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "mine", status: "open", weight: 1.5 });
      createEntity(b, "cases", E2, { title: "yours", status: "open", weight: null });
    },
  },
  {
    name: "merge-idempotent",
    cites: ["6", "T1-D15"],
    what: "B's rows only. Merging the same copy again adds nothing.",
    fill: (a, b) => {
      createEntity(b, "cases", E2, { title: "yours", status: "open", weight: null });
      void a;
    },
  },
  {
    name: "merge-conflict",
    cites: ["4", "T1-D6", "T1-D9"],
    what: "Both changed one entity from the same head. Two heads; current shows the deterministic pick, flagged.",
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
      await exchange(b, a, ADA);
      changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
      changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });
    },
  },
  {
    name: "merge-resolve",
    cites: ["5", "T1-D17"],
    what: "A change written while the conflict is open names both heads, which is what resolves it.",
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
      await exchange(b, a, ADA);
      changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
      changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });
      await exchange(a, b, BO);
      changeEntity(a, "cases", E1, { title: "settled", status: "open", weight: null });
    },
  },
  {
    name: "merge-tombstone",
    cites: ["5", "T1-D3"],
    what: "A delete on one side and nothing on the other. Absent from current, present in heads.",
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "doomed", status: "open", weight: null });
      await exchange(b, a, ADA);
      deleteEntity(b, "cases", E1);
    },
  },
  {
    name: "merge-tombstone-conflict",
    cites: ["T1-D3", "T1-D9"],
    what: "A delete on one side, a change on the other, concurrent. Current shows the change, flagged (T1-D3).",
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
      await exchange(b, a, ADA);
      changeEntity(a, "cases", E1, { title: "edited", status: "open", weight: null });
      deleteEntity(b, "cases", E1);
    },
  },
  {
    name: "merge-row-id-reused",
    cites: ["T1-D13", "T1-D15", "T1-D16"],
    what:
      "A holds a row under Bo's id and seq that Bo never signed, with other content. Bo's signed row takes the id on A, the unsigned one is reported as a different row wearing it, and B refuses it; both copies end with Bo's.",
    // Until batch format version 2 this was the one vector where the copies did
    // not end up the same: each side held different content under Bo's first
    // id and refused the other's, and a disputed id was where the guarantee
    // stopped. The signature now answers the dispute, as this vector said it
    // would ("signatures decide a disputed row id"): the row that verifies is
    // kept and the one nobody signed is not.
    fill: (a, b) => {
      createEntity(b, "cases", E1, { title: "honest", status: "open", weight: null });
      createEntity(b, "cases", E2, { title: "also honest", status: "open", weight: null });
      applyRow(a, "cases", {
        _r_replica: BO.author,
        _r_seq: 1,
        _r_lc: 1,
        _r_entity: E1,
        _r_parents: "[]",
        _r_deleted: 0,
        columns: { title: "not what B wrote", status: "open", weight: null },
      });
    },
  },
  {
    name: "receive-then-write-both-sides",
    cites: ["5", "T1-D22"],
    what:
      "The sender's file, opened by a recipient who adopts a new identity, then a write on each side. Nothing is rejected and both copies converge.",
    // Half a property. The other half — that a host adopts an identity at all,
    // which happens before any merge and is already done in these inputs — is
    // tests/replicated-converge.spec.ts, 'a copy that arrived from somebody
    // else'. Delete either and the other still passes with the hole open.
    pairedWith: "tests/replicated-converge.spec.ts — a copy that arrived from somebody else",
    /*
     * The shape every exchange actually begins with, and the one no other
     * vector models: the copies here are not two independent databases, they
     * are one file and a copy of it.
     *
     * Without T1-D22 the recipient writes under the sender's replica id, both
     * allocate the same (replica, seq), and the next merge refuses one of two
     * honest rows as tampering. This vector is red against that reader and
     * green against this one.
     */
    receives: true,
    fill: (a, b) => {
      // A is the sender. B is A's file after a recipient opened it.
      createEntity(a, "cases", E1, { title: "e4", status: "open", weight: null });
      void b;
    },
    afterReceive: (a, b) => {
      createEntity(a, "cases", E2, { title: "Nf3", status: "open", weight: null });
      createEntity(b, "cases", id(0x33), { title: "e5", status: "open", weight: null });
    },
  },
  {
    name: "schema-digest-replicated-only",
    cites: ["T1-D14", "T1-D21"],
    what:
      "The same replicated table on both sides and a local table on one. The canonical replicated schema must be identical, and the pair is a sibling.",
    // The rows are almost beside the point here; what is asserted is that two
    // readers agree about *whether these may merge*. Two readers disagreeing
    // about a merge is caught by every other vector; disagreeing about
    // mergeability is not, because the rows never get compared.
    localOnA: "CREATE TABLE notes_local (body TEXT);",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
      createEntity(b, "cases", E2, { title: "yours", status: "open", weight: null });
    },
  },
  {
    name: "merge-sealed",
    cites: ["6", "T1-D7"],
    what: "Two authors, each row sealed in a signed batch. The rows and both headers union; every row keeps the batch it left in.",
    authors: true,
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "mine", status: "open", weight: 1.5 });
      createEntity(a, "cases", E2, { title: "also mine", status: "open", weight: null });
      await sealAll(a, ADA);
      createEntity(b, "cases", id(0x33), { title: "yours", status: "open", weight: null });
      await sealAll(b, BO);
    },
  },
  {
    name: "merge-seal-adopted",
    cites: ["6", "T1-D7"],
    what:
      "B received A's row before A sealed it, so B holds it pending. A seals; merging A into B gives B the seal and the header, and merging B into A leaves A's seal as it was.",
    authors: true,
    receives: true,
    fill: (a) => {
      createEntity(a, "cases", E1, { title: "sent before sealing", status: "open", weight: null });
    },
    afterReceive: async (a, b) => {
      await sealAll(a, ADA);
      createEntity(b, "cases", E2, { title: "the reply", status: "open", weight: null });
      await sealAll(b, BO);
    },
  },
  {
    name: "merge-seal-stowaway",
    cites: ["6", "T1-D13"],
    what:
      "B holds a row claiming B's batch that the batch does not list. Merging B into A refuses that row (BATCH_DIGEST_MISMATCH) and takes the row the batch lists; B keeps its own.",
    authors: true,
    converges: false,
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
      await sealAll(a, ADA);
      createEntity(b, "cases", E2, { title: "listed", status: "open", weight: null });
      await sealAll(b, BO);
      const named = b.all("SELECT _r_batch FROM cases WHERE _r_entity = ?", [E2])[0]["_r_batch"];
      b.run(
        "INSERT INTO cases (title, status, weight, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_batch) VALUES ('stowaway', 'open', NULL, ?, 50, 50, ?, '[]', 0, ?)",
        [BO.author, id(0x55), named],
      );
    },
  },
  {
    name: "merge-seal-tampered",
    cites: ["6", "T1-D13"],
    what:
      "B's row was changed after it was signed, so B's header does not verify (BATCH_DIGEST_MISMATCH). Merging B into A takes neither the row nor the header; B keeps its own.",
    authors: true,
    converges: false,
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
      await sealAll(a, ADA);
      // Signed in a scratch copy, then changed, then staged into B as a file arrives.
      const scratch = open(":memory:");
      asReplica(scratch, BO.author);
      createEntity(scratch, "cases", E2, { title: "as signed", status: "open", weight: null });
      const [batch] = pendingBatches(scratch, BO.author, TABLES);
      const sealed = await signBatch(batch, { document: DOC, sign: keptSigner(BO) });
      scratch.close();
      sealed.entries[0].row.columns.title = "changed after signing";
      stageBatch(b, sealed, TABLES);
    },
  },
  {
    name: "merge-seal-lost-pointer",
    cites: ["6", "T1-D7"],
    what:
      "A holds its rows with no batch named (the save that wrote their pointers was lost) and two headers that each list them (sealed again after). Merging A into B signs the rows under the lower id and keeps both headers.",
    authors: true,
    converges: false,
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "one", status: "open", weight: null });
      createEntity(a, "cases", E2, { title: "two", status: "open", weight: null });
      const [batch] = pendingBatches(a, ADA.author, TABLES);
      holdHeader(a, await signBatch(batch, { document: DOC, sign: keptSigner(ADA) }));
      holdHeader(a, await signBatch({ ...batch, lc: batch.lc + 1 }, { document: DOC, sign: keptSigner(ADA) }));
      createEntity(b, "cases", id(0x33), { title: "yours", status: "open", weight: null });
      await sealAll(b, BO);
    },
  },
  {
    name: "merge-seal-cross-table",
    cites: ["6", "T1-D13"],
    what:
      "B holds an unsigned note under Ada's id at the seq of Ada's signed case. One author's seq names one row in any table: A refuses the note as a collision, and B gives it up for the signed case, which outranks it.",
    authors: true,
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "signed", status: "open", weight: null });
      await sealAll(a, ADA);
      forge(b, "notes", ADA.author, 1, { body: "forged under Ada's id" });
    },
  },
  {
    name: "merge-seal-outranks",
    cites: ["6", "T1-D13"],
    what:
      "B holds an unsigned case under Ada's id and seq with other content. A signed row outranks an unsigned one at the same id: A keeps its own and refuses B's; B gives its up for A's.",
    authors: true,
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "signed", status: "open", weight: null });
      await sealAll(a, ADA);
      forge(b, "cases", ADA.author, 1, { title: "forged", status: "open", weight: null });
    },
  },
  {
    name: "merge-seal-stowaway-other",
    cites: ["6", "T1-D13"],
    what:
      "B received Ada's signed case, then wrote a row of its own naming Ada's batch, which does not list it. The refusal names Bo, who wrote the row, not Ada, whose batch was taken.",
    authors: true,
    receives: true,
    converges: false,
    fill: async (a) => {
      createEntity(a, "cases", E1, { title: "signed", status: "open", weight: null });
      await sealAll(a, ADA);
    },
    afterReceive: async (a, b) => {
      const named = b.all("SELECT _r_batch FROM cases WHERE _r_entity = ?", [E1])[0]["_r_batch"];
      b.run(
        "INSERT INTO cases (title, status, weight, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_batch) VALUES ('stowaway', 'open', NULL, ?, 5, 5, ?, '[]', 0, ?)",
        [BO.author, id(0x55), named],
      );
    },
  },
  {
    name: "merge-cross-entity-parent",
    cites: ["T1-D2", "T1-D35"],
    what:
      "B's note names A's note, another entity, as its parent. A holds the parent before the row naming it arrives and B the other way round; on both, A's note stays a head.",
    fill: (a, b) => {
      createEntity(a, "notes", E1, { body: "Ada's note" });
      applyRow(b, "notes", {
        _r_replica: BO.author,
        _r_seq: 1,
        _r_lc: 1,
        _r_entity: E2,
        _r_parents: JSON.stringify([`${hexOf(ADA.author)}:1`]),
        _r_deleted: 0,
        columns: { body: "Bo's note" },
      });
    },
  },
  {
    name: "merge-seal-outranks-cross-entity",
    cites: ["T1-D13", "T1-D35"],
    what:
      "B holds an unsigned edit of Bo's case under Ada's id and seq, and a case of another entity that also names Bo's case. When the unsigned edit gives way to Ada's signed row, Bo's case is a head again: the other entity's row does not hold it down.",
    authors: true,
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "signed", status: "open", weight: null });
      await sealAll(a, ADA);
      const bos = createEntity(b, "cases", id(0x66), { title: "Bo's case", status: "open", weight: null });
      const named = JSON.stringify([`${hexOf(BO.author)}:${bos._r_seq}`]);
      applyRow(b, "cases", {
        _r_replica: ADA.author,
        _r_seq: 1,
        _r_lc: 2,
        _r_entity: id(0x66),
        _r_parents: named,
        _r_deleted: 0,
        columns: { title: "forged edit", status: "open", weight: null },
      });
      applyRow(b, "cases", {
        _r_replica: BO.author,
        _r_seq: 2,
        _r_lc: 3,
        _r_entity: id(0x77),
        _r_parents: named,
        _r_deleted: 0,
        columns: { title: "names Bo's case", status: "open", weight: null },
      });
      await sealAll(b, BO);
    },
  },
  {
    name: "heads-via-superseded-flag",
    cites: ["4", "T1-D2", "T1-D10"],
    what: "A chain and a fork on one copy. Heads must equal what a full parents scan would say.",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "one", status: "open", weight: null });
      changeEntity(a, "cases", E1, { title: "two", status: "open", weight: null });
      createEntity(b, "cases", E2, { title: "other", status: "open", weight: null });
    },
  },

  /*
   * Session vectors (backlog D171): what batch format version 2 changed after
   * the signature. Each ships the admitted state too, and each makes a reader
   * without its change disagree.
   */
  {
    name: "session-creator-by-seq",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Ada signs a second seat row naming the seat she confirmed Bo in, and plays that seat. The session id names one row by (author, seq), so that row is not the creator's: Bo still holds the seat, her move is not admitted and is reported SEAT_NOT_HELD (D158).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(b, a, ADA);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      createEntity(a, "_dai_seat", id(0x53), { seat: SEAT_OPEN }, session);
      createEntity(a, "moves", id(0x83), { seat: SEAT_OPEN, san: "Nf3" }, session);
    },
  },
  {
    name: "session-equivocation",
    session: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "Ada signs two headers over one (moves, seq) with different rows, one on each copy. Each merge reports AUTHOR_EQUIVOCATED once and refuses the other row at that id; both headers are kept, and the row at that id is admitted on neither copy (D160).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const fork = await forkOf(a, ADA);
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      createEntity(fork, "moves", id(0x84), { seat: SEAT_W, san: "d4" }, session);
      await exchange(b, fork, ADA);
      fork.done();
    },
  },
  {
    name: "session-row-malformed",
    session: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "Bo signs one batch over a move and a row whose parents are not the one shape. Merging it refuses the batch as ROW_MALFORMED and takes none of its rows (D159).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      raw(b, "moves", id(0x85), { seat: SEAT_OPEN, san: "Nc6" }, session, '["zz"]');
    },
  },
  {
    name: "session-close-no-frontier",
    session: true,
    cites: ["6", "T1-D31"],
    what:
      "Ada closes the session, then moves; Bo moves after her close, at a seq and a clock both past hers. A close binds only its author: her later move is late, and Bo's is admitted, by any order a reader might compare them in. A close carries no frontier (D151, batch format version 2).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(b, a, ADA);
      // Bo's seqs run past the seq Ada's close will take, so a reader that
      // compared one author's seq with another's is caught as surely as one
      // that compared clocks.
      for (const [byte, san] of [[0x82, "e5"], [0x87, "Nc6"], [0x88, "d6"], [0x89, "g6"]]) {
        createEntity(b, "moves", id(byte), { seat: SEAT_OPEN, san }, session);
      }
      await exchange(a, b, BO);
      createEntity(a, "_dai_close", id(0x91), {}, session);
      createEntity(a, "moves", id(0x86), { seat: SEAT_W, san: "Nf3" }, session);
      await exchange(b, a, ADA);
      createEntity(b, "moves", id(0x8a), { seat: SEAT_OPEN, san: "Bg7" }, session);
    },
  },
  {
    name: "session-second-confirm",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Ada confirms Bo in the open seat, and from a second copy of her own store confirms the same seat to another copy at a later seq. The seat is void on every copy holding both, whatever the seqs: the merge that brings the second reports AUTHOR_EQUIVOCATED in Ada's name, and Bo's move is admitted nowhere (D165).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(b, a, ADA);
      const fork = await forkOf(a, ADA);
      confirmSeat(fork, session, SEAT_OPEN, id(0xcc), id(0x72));
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      await exchange(b, fork, ADA);
      fork.done();
    },
  },

  /*
   * The rulings on D171's divergences (29 September): each vector splits a
   * reader that has its ruling wrong.
   */
  {
    name: "session-deleted-confirm",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Ada confirms Bo in the open seat, then writes a delete of that confirm naming another copy as holder. A deleted confirm still counts, so the seat is void: the merge that brings the delete reports AUTHOR_EQUIVOCATED in Ada's name under the delete's header, and Bo's move is admitted nowhere (D165, D171). A reader skipping deleted confirms keeps Bo seated; one reading only current confirms seats nobody and voids nothing.",
    fill: async (a, b) => {
      const session = await seated(a, b);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      const confirm = a.all("SELECT _r_replica, _r_seq FROM _dai_confirm WHERE _r_entity = ?", [id(0x71)])[0];
      raw(a, "_dai_confirm", id(0x71), { seat: SEAT_OPEN, holder: id(0xcc) }, session, JSON.stringify([`${hexOf(confirm._r_replica)}:${confirm._r_seq}`]), 1);
    },
  },
  {
    name: "session-roster-heads",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Bo writes a version of Ada's open seat row, Ada writes a version of that row in another session, and a row of another entity naming it. Roster heads partition by session, entity and author, so all four rows are heads (D171, T1-D35). A reader partitioning by entity alone, by entity and author, by entity and session, or by session and author hides Ada's row.",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const open = a.all("SELECT _r_replica, _r_seq FROM _dai_seat WHERE seat = ? AND _r_session = ?", [SEAT_OPEN, session])[0];
      const named = JSON.stringify([`${hexOf(open._r_replica)}:${open._r_seq}`]);
      const entity = a.all("SELECT _r_entity FROM _dai_seat WHERE _r_replica = ? AND _r_seq = ?", [open._r_replica, open._r_seq])[0]._r_entity;
      raw(b, "_dai_seat", entity, { seat: SEAT_OPEN }, session, named);
      raw(a, "_dai_seat", entity, { seat: SEAT_OPEN }, id(0xe2), named);
      // And a row of another entity naming it, which is no version of it (T1-D35).
      raw(a, "_dai_seat", id(0x54), { seat: SEAT_OPEN }, session, named);
    },
  },
  {
    name: "session-equivocation-filed",
    session: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "A holds two of Ada's headers over one (moves, seq) with different rows, and a later header of hers with a move for Bo's seat; B holds a third header at that id. B into A reveals nothing new and reports no equivocation. A into B reports AUTHOR_EQUIVOCATED once, under the lower of A's two headers, after the SEAT_NOT_HELD of the later header, whose id sorts below both: the report is filed under the revealing header, and emitted by batch id, then code (D160, D171).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const first = await forkOf(a, ADA);
      const second = await forkOf(a, ADA);
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await sealAll(a, ADA);
      createEntity(first, "moves", id(0x84), { seat: SEAT_W, san: "d4" }, session);
      await exchange(a, first, ADA);
      createEntity(second, "moves", id(0x8c), { seat: SEAT_W, san: "c4" }, session);
      await exchange(b, second, ADA);
      first.done();
      second.done();
      createEntity(a, "moves", id(0x8b), { seat: SEAT_OPEN, san: "Qh5" }, session);
      await sealAll(a, ADA);
      createEntity(a, "moves", id(0x8d), { seat: SEAT_OPEN, san: BETWEEN_SAN }, session);
      await sealAll(a, ADA);
      /*
       * The teeth: the first later header's id sorts below both revealing ones,
       * and the second's between them, so a reader filing the report under no
       * id, under the lowest header that arrived, under the higher revealing
       * one, or under any header of that id it already held, emits a
       * different list. Asserted, so a change to the rows above cannot quietly
       * remove them (the second was added when a blind reader showed the first
       * alone passed a reader filing under the higher revealing header).
       */
      const doubled = a.all("SELECT _r_seq FROM moves WHERE _r_entity = ?", [id(0x81)])[0]._r_seq;
      const ids = (seq) =>
        a.all("SELECT lower(hex(b.id)) AS id FROM _dai_batch b, json_each(b.covers) c WHERE b.author = ? AND json_extract(c.value, '$[0]') = 'moves' AND json_extract(c.value, '$[1]') = ?", [ADA.author, seq]).map((r) => r.id);
      const revealing = ids(doubled).sort();
      const [below] = ids(doubled + 1);
      const [between] = ids(doubled + 2);
      if (revealing.length !== 2 || !(below < revealing[0] && revealing[0] < between && between < revealing[1])) {
        throw new Error(`session-equivocation-filed: need ${below} < ${revealing[0]} < ${between} < ${revealing[1]}`);
      }
    },
  },
];

/** The session vectors' seats: Ada's own, and the open one Bo asks for. */
const SEAT_W = id(0xa1);
const SEAT_OPEN = id(0xb1);
/** The move whose header's id falls between session-equivocation-filed's two revealing headers (found by trying moves in order). */
const BETWEEN_SAN = "h3";

/** Ada's session, Bo confirmed in its open seat, on both copies, every row signed. */
async function seated(a, b) {
  const session = startSession(a, { creatorSeat: SEAT_W, openSeat: SEAT_OPEN, entities: [id(0x51), id(0x52)] });
  await exchange(b, a, ADA);
  createEntity(b, "_dai_binding", id(0x61), { seat: SEAT_OPEN }, session);
  await exchange(a, b, BO);
  confirmSeat(a, session, SEAT_OPEN, BO.author, id(0x71));
  await exchange(b, a, ADA);
  return session;
}

let forks = 0;
/**
 * A second copy of one author's own store, standing where `from` stands: how
 * one author comes to sign two histories (a device restored from a backup, or
 * a hostile client). Its counter is `from`'s, so its next row takes the seq
 * `from`'s next row will.
 */
async function forkOf(from, person) {
  const path = join(out, `scratch-fork-${forks++}.db`);
  const fork = open(path, undefined, SESSION_SCHEMA);
  asReplica(fork, person.author);
  await exchange(fork, from, person);
  const state = from.all("SELECT seq, lc FROM _dai_replica")[0];
  fork.run("UPDATE _dai_replica SET seq = ?, lc = ?", [state.seq, state.lc]);
  fork.done = () => {
    fork.close();
    rmSync(path);
  };
  return fork;
}

/** A row at this copy's next seq and clock with the parents text given, as a copy that skips the writers can write it. */
function raw(db, table, entity, columns, session, parentsText, deleted = 0) {
  const state = db.all("SELECT id, seq, lc FROM _dai_replica")[0];
  db.run("UPDATE _dai_replica SET seq = ?, lc = ?", [state.seq + 1, state.lc + 1]);
  applyRow(db, table, {
    _r_replica: state.id,
    _r_seq: state.seq + 1,
    _r_lc: state.lc + 1,
    _r_entity: entity,
    _r_parents: parentsText,
    _r_deleted: deleted,
    _r_session: session,
    columns,
  });
}

/** Merges a fresh copy of `from` into a fresh copy of `into` and reports both. */
async function run(vector, direction) {
  const a = openFor(vector, join(out, vector.name, "scratch-a.db"), vector.localOnA);
  const b = openFor(vector, join(out, vector.name, "scratch-b.db"));
  await populate(vector, a, b);
  const [left, right] = direction === "ab" ? [a, b] : [b, a];
  // Verified first, as every merge is (identity ruling #3). The verdicts are
  // written beside the vector: a reader merges by them and does its own coverage.
  const verdicts = await verifyBatches(right, right.tables, DOC);
  const result = mergeFrom(left, right, left.tables, undefined, verdicts);
  const dump = canonicalDump(left, left.tables);
  const admitted = vector.session ? admittedDump(left) : null;

  /*
   * And again, changing nothing.
   *
   * For a converging vector this is idempotence. For the disputed one it is
   * the claim that matters more: two copies that will never agree must each
   * still be a fixed point. Non-convergent must not mean non-deterministic —
   * a dispute that grew on every exchange would be a copy that never settles,
   * which is worse than one that settles differently from its sibling.
   */
  const again = mergeFrom(left, right, left.tables, undefined, verdicts);
  const settled = canonicalDump(left, left.tables);
  if (settled !== dump) {
    console.error(`${vector.name} [${direction}]: merging twice changed the table`);
    process.exit(1);
  }
  if (again.applied !== 0) {
    console.error(`${vector.name} [${direction}]: the second merge applied ${again.applied} rows`);
    process.exit(1);
  }
  a.close();
  b.close();
  rmSync(join(out, vector.name, "scratch-a.db"));
  rmSync(join(out, vector.name, "scratch-b.db"));
  return { dump, result, admitted };
}

/** The inputs, written as they stand before any merge, and the verdict on every header in them. */
async function writeInputs(vector) {
  const dir = join(out, vector.name);
  mkdirSync(dir, { recursive: true });
  const a = openFor(vector, join(dir, "a.db"), vector.localOnA);
  const b = openFor(vector, join(dir, "b.db"));
  await populate(vector, a, b);
  // Per copy: a header is verified against the rows of the copy that holds it,
  // so the same header can verify in one and not in the other.
  const verdicts = {};
  for (const [name, copy] of [["a", a], ["b", b]]) {
    const found = {};
    for (const [id, verdict] of await verifyBatches(copy, copy.tables, DOC)) found[id] = verdict.ok ? (verdict.complete ? "ok" : "incomplete") : verdict.reason;
    verdicts[name] = Object.fromEntries(Object.entries(found).sort(([x], [y]) => (x < y ? -1 : 1)));
  }
  compare(join(dir, "verdicts.json"), `${JSON.stringify(verdicts, null, 2)}\n`);
  a.close();
  b.close();
}

/** A row written into a copy by hand under someone else's author id and seq, with no batch. */
function forge(db, table, author, seq, columns) {
  const names = Object.keys(columns);
  db.run(
    `INSERT INTO "${table}" (${names.join(", ")}, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted) VALUES (${names.map(() => "?").join(", ")}, ?, ?, ?, ?, '[]', 0)`,
    [...names.map((n) => columns[n]), author, seq, seq, id(0x66)],
  );
}

/** A header put into a copy by hand, as a copy holds one whose rows' pointers a lost save never wrote. */
function holdHeader(db, sealed) {
  db.run(
    "INSERT INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [sealed.id, sealed.replica, sealed.lc, sealed.sig, sealed.pub, sealed.att, sealed.version, sealed.digest, coversText(sealed.entries)],
  );
}

/** Both copies as the vector says: its authors, its rows, and a received file when it has one. */
async function populate(vector, a, b) {
  asReplica(a, ADA.author);
  if (vector.receives) {
    await vector.fill(a, b);
    if (!vector.authors) await sealAll(a, ADA);
    receiveInto(b, a, BO.author);
    await vector.afterReceive(a, b);
  } else {
    asReplica(b, BO.author);
    await vector.fill(a, b);
  }
  // A vector not about seals: every row as its author's saves left it, sealed.
  if (!vector.authors) {
    await sealAll(a, ADA);
    await sealAll(b, BO);
  }
}

const README = `# Level 1 merge fixtures

Generated by \`scripts/build-merge-fixtures.mjs\`; \`--check\` fails when anything
here differs from what the generator produces, so a change to the merge cannot
land without the expected text changing in the same diff.

Per vector:

| file | what it is |
|---|---|
| \`a.db\`, \`b.db\` | the two copies, before any merge |
| \`expected-ab.txt\` | the canonical dump of A after merging B into it |
| \`expected-ba.txt\` | the canonical dump of B after merging A into it |
| \`result.json\` | the counts, refused ids and refused batches the merge reports |
| \`verdicts.json\` | per copy (\`a\`, \`b\`), the verdict on every signed header it holds: \`ok\` or a \`BATCH_\` code |
| \`expected-admitted-ab.txt\`, \`expected-admitted-ba.txt\` | session vectors only: what the document admits after each merge (below) |

**The databases are inputs, never oracles.** SQLite file bytes depend on the
library version and on page layout, so two engines that agree perfectly produce
different files. Nothing may compare \`.db\` bytes — the comparison is always the
dump. Adding a byte comparison "for completeness" would make the suite fail on a
correct implementation.

**\`expected-ab.txt\` and \`expected-ba.txt\` are identical wherever
\`result.json\` says \`converges: true\`, and both are checked in anyway.** Union
merge is commutative, so they must be; a fixture asserting it is worth more than
a sentence claiming it.

Some vectors say \`converges: false\`, and that is the answer rather than a
failure. A copy keeps what it holds and a merge refuses what it cannot take, so
the two directions differ wherever one copy holds something the other refuses
or lacks: a disputed row id, a row no valid header lists, a pointer left unset
that the other side fills. When two copies hold different content under one row id, each refuses
the other's and each keeps its own: union merge converges over rows nobody
disputes, and a disputed id is where the guarantee stops. The alternative would
be one side silently adopting the other's version of a row, which is what
refusing it exists to prevent. Both dumps are checked in so the divergence is
pinned rather than described.

A second implementation reads \`a.db\` and \`b.db\`, performs its own merge in both
directions, and diffs its own dump against these files. It never reads the
generator's output at run time.

**Seals.** Every dump ends with a \`# _dai_batch\` section: the signed batch
headers the copy holds (docs/identity.md), which are the same bytes on every copy
that merged. \`merge-sealed\` and \`merge-seal-adopted\` carry real seals, so a
reader that does not union the headers, or does not let a row it holds pending
take the seal that arrives for it, disagrees here rather than passing without
ever meeting one. Their two authors sign with fixed keys, so the author ids are
real key fingerprints; the signatures themselves are not deterministic, so each
is kept in \`signatures.json\` by the header it covers, signed once when the
fixtures are written and reused after.

**Verdicts.** A merge verifies every header the other copy holds before it takes
anything (docs/format.md): it finds the rows the header lists, digests them, and
checks the signature. \`verdicts.json\` is that check's answer for every header in
\`a.db\` and in \`b.db\`, each against its own copy's rows (so a header can verify in
one and not the other), made by the TypeScript verifier; a merge of B into A
reads \`b\`'s, and of A into B, \`a\`'s; the canonical bytes and the
signatures are held apart, by tests/identity-vectors.spec.ts. A reader merges by
the verdicts and does the rest itself, which is the part these vectors test:

- a header that is not \`ok\` is not kept and lists nothing;
- a header lists its rows in \`covers\` as \`[table, seq]\`, the author being its own;
- a row is taken when an \`ok\` header lists it (its table, its author, its
  seq), whatever the row says, and names the header it names if that one lists
  it, else the lowest listed id;
- a row that names a header and is listed by none is refused, as
  \`BATCH_DIGEST_MISMATCH\` in the name of the row's own author, unless the
  header it names was refused already;
- a row that names none and is listed by none is unsigned, and is refused as
  \`BATCH_UNSIGNED\` in the name of the id it carries (batch format version 2),
  unless the copy already holds a row at that id in that table, where the ordinary
  path decides (a duplicate, or a second row at one id);
- one author's seq names one row whatever table it is in: a row whose
  (author, seq) the copy holds in another table is refused (\`rejected\`);
- a signed row outranks an unsigned row the copy holds at the same id (after
  version 2, only its own pending row can be one): the unsigned one is removed, the signed one takes its place, and the removed id is reported in
  \`rejected\`; whatever the removed row superseded is a head again unless
  something else names it. Signed rows are placed before unsigned ones, so the
  answer never depends on table order.

\`merge-seal-stowaway\`, \`merge-seal-stowaway-other\`, \`merge-seal-tampered\`,
\`merge-seal-lost-pointer\`, \`merge-seal-cross-table\` and \`merge-seal-outranks\`
each disagree with a reader that has one of those wrong. \`refusedBatches\` in
\`result.json\` is one entry per batch, reason and author, ordered by batch id
(lowercase hex, no id first), then reason, then author id in hex, with the
author id shown as base64url. Which batch id each reason is filed under is in
docs/format.md, "What a merge reports".

**What a session document admits.** The \`session-\` vectors are session
documents (one seated table, \`moves\`, seated by its \`seat\` column; the close
rule \`any\`), and their \`result.json\` says \`admitted: true\`. Each ships
\`expected-admitted-ab.txt\` and \`expected-admitted-ba.txt\`: after the merge,
the admitted heads of every table the merge covers (\`id\` and the deleted flag,
by author then seq), then \`# holders\` (session, seat, holder), \`# voided\`
(session, seat, creator), \`# equivocated\` (author, table, seq) and \`# closed\`,
each sorted, ids in lowercase hex. Batch format version 2 changed mostly what a
document admits, which the stored rows alone cannot show, so these are what a
reader without one of those changes disagrees with. A reader computes them from
the tables and headers alone. It reads no view but \`_dai_seat_rules\` and
\`_dai_author_rules\`, which are declarations; the rest are computations, and a
reader that took them would be the generator agreeing with itself. The rules,
in docs/identity.md and docs/format.md:

- a row id one author signed twice (two headers listing it with different
  digests) counts nowhere (D160);
- the creator's seat row is the one whose own author and seq hash to its
  session (D158); her seat is hers, and an open seat is held by whoever her
  confirms name, unless she confirmed it to two copies, when it is void and
  held by nobody (D165). A confirm counts deleted or not, superseded or not
  (D171);
- a merge that reveals an author signing twice, a header it did not hold
  making an id equivocated that was not, or a row it took making a seat void
  that was not, reports \`AUTHOR_EQUIVOCATED\` in that author's name, once per
  merge, filed under the lowest revealing header (docs/format.md, "What a
  merge reports"); a third conflicting header reveals nothing new;
- the heads of the roster tables and the close (\`_dai_seat\`,
  \`_dai_binding\`, \`_dai_confirm\`, \`_dai_close\`) partition by session,
  entity and author: only an author's own later row in the same session
  replaces one (D171);
- a close by a member binds only its author: their rows after it, by their
  own seq, are late (D151, and no frontier at version 2);
- a seated row is admitted when its author holds the seat it names, it names
  no version from another session or another seat, and it is not late. Of
  the rows a merge takes and does not admit, one naming no seat, a seat
  someone else holds, or another seat's version is reported
  \`SEAT_NOT_HELD\`, and one naming another session's version
  \`ENTITY_OTHER_SESSION\`; one waiting on a confirmation, one for a void
  seat, and a late one are reported nowhere;
- a row whose parents are not the one shape (D159) is never taken, nor any
  row of a complete batch that signed one, and the batch is refused
  \`ROW_MALFORMED\`.

Each \`session-\` vector was run against both readers with its change held
out, and failed.
`;

let differences = 0;
const compare = (path, content) => {
  if (!check) {
    writeFileSync(path, content, "utf8");
    return;
  }
  const held = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (held !== content) {
    console.error(`differs: ${path.slice(repo.length + 1)}`);
    differences += 1;
  }
};

/*
 * A vector asserts a property; the property has to be written down somewhere a
 * reader can find it.
 *
 * This check was added once and lost once, to a `git checkout` of this file
 * that reverted far more than the line it was aimed at — and nothing noticed,
 * because `--check` regenerates and compares, so a missing field is missing on
 * both sides and matches. The enforcement has to live here, in the build, or
 * it does not live anywhere.
 */
function checkCitations(vectors) {
  const spec = readFileSync(join(repo, "docs", "replicated-tables.md"), "utf8");
  const sections = new Set([
    ...[...spec.matchAll(/^#{2,3} (\d+(?:\.\d+)?)\.?\s/gm)].map((m) => m[1]),
    ...[...spec.matchAll(/\*\*(T1-D\d+)/g)].map((m) => m[1]),
  ]);
  const problems = [];
  for (const vector of vectors) {
    if (!vector.cites || vector.cites.length === 0) {
      problems.push(`${vector.name} cites no section. A vector nobody can trace to the document is a rule the suite invented.`);
      continue;
    }
    for (const where of vector.cites) {
      if (!sections.has(where)) problems.push(`${vector.name} cites ${where}, which the document does not have.`);
    }
  }
  if (problems.length === 0) return;
  for (const line of problems) console.error(line);
  process.exit(1);
}

checkCitations(VECTORS);

mkdirSync(out, { recursive: true });
compare(join(out, "README.md"), README);

for (const vector of VECTORS) {
  const dir = join(out, vector.name);
  mkdirSync(dir, { recursive: true });
  await writeInputs(vector);

  const ab = await run(vector, "ab");
  const ba = await run(vector, "ba");
  const shouldConverge = vector.converges !== false;
  if (shouldConverge && ab.dump !== ba.dump) {
    console.error(`${vector.name}: merging A<-B and B<-A disagree, which union merge forbids`);
    process.exit(1);
  }
  if (!shouldConverge && ab.dump === ba.dump) {
    console.error(`${vector.name}: the two directions were expected to differ, and did not`);
    process.exit(1);
  }

  {
    const shape = openFor(vector, join(dir, "scratch-shape.db"), vector.localOnA);
    const schema = replicatedSchemaOf(shape);
    shape.close();
    rmSync(join(dir, "scratch-shape.db"));
    compare(join(dir, "expected-schema.txt"), schema);
  }
  compare(join(dir, "expected-ab.txt"), ab.dump);
  compare(join(dir, "expected-ba.txt"), ba.dump);
  if (vector.session) {
    compare(join(dir, "expected-admitted-ab.txt"), ab.admitted);
    compare(join(dir, "expected-admitted-ba.txt"), ba.admitted);
  }
  compare(
    join(dir, "result.json"),
    `${JSON.stringify(
      {
        what: vector.what,
        // The sections this vector exercises. Dropped once already, by an edit
        // that rewrote this object for another field — and nothing caught it,
        // because `--check` regenerates and compares, so both sides lost the
        // field together. The generator's own citation check is what kept the
        // rule alive; this is only the record of it.
        cites: vector.cites,
        // The other half of a property split across a fixture and a runtime
        // test. Named here so deleting either half is visible from the one
        // that remains.
        ...(vector.pairedWith ? { pairedWith: vector.pairedWith } : {}),
        converges: shouldConverge,
        // A session vector ships what the document admits after each merge
        // (expected-admitted-*.txt, backlog D171); a reader that finds this and
        // does not compute admission fails rather than skipping.
        admitted: Boolean(vector.session),
        ...(vector.shrinksAt ? { shrinksAt: vector.shrinksAt } : {}),
        // Each copy is a fixed point whether or not the two agree: run()
        // merges a second time and requires nothing to move.
        stable: true,
        ab: ab.result,
        ba: ba.result,
      },
      null,
      2,
    )}\n`,
  );
}

if (!check && signaturesAdded > 0) {
  const ordered = Object.fromEntries(Object.entries(signatures).sort(([x], [y]) => (x < y ? -1 : 1)));
  writeFileSync(SIGNATURES, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

if (check && differences > 0) {
  console.error(`\n${differences} fixture file(s) differ. Regenerate and commit the diff.`);
  process.exit(1);
}
console.log(check ? "fixtures match" : `${VECTORS.length} merge fixtures written to conformance/merge`);
