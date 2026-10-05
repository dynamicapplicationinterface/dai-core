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
 *     node scripts/build-merge-fixtures.mjs --check --only <name>,<name>
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
import { adoptReplica, headerOf, mergeTablesOf, pendingBatches, recordSeal, signBatch, stageBatch, verifyBatches } from "../dist/dai-merge.js";
import { confirmSeat, coversText, startSession } from "../dist/replicated-rows.js";
import { signBytes } from "../dist/identity.js";
import { signedBytes, signedViewOf } from "../dist/core.js";
import { createHash } from "node:crypto";
import {
  ADA,
  BO,
  CY,
  DOC,
  admittedDump,
  carry,
  carryHeaderOnly,
  columnsOf,
  forge,
  forwardParentAt,
  headersListing,
  holdHeader,
  raw,
  rawAt,
  seal,
  sealHolding as sealHoldingWith,
  sessionIdOf,
  withoutTriggers,
} from "./sealer.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "conformance", "merge");
const check = process.argv.includes("--check");
/*
 * Some vectors only, by name: how scripts/holdout.py runs a runtime with one
 * rule removed against the vectors that witness it. Every kept signature is
 * kept, since the vectors not run still use theirs.
 */
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? new Set(process.argv[onlyAt + 1].split(",")) : null;

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

/** The session document with an unseated author table beside the seated one: admission by membership (admitted-member). */
const SESSION_NOTES_SCHEMA = `${SESSION_SCHEMA}-- dai:replicated
CREATE TABLE notes (
  body TEXT NOT NULL
);
`;

/** The session document of the three-party vectors: the same tables, max_parties=3. */
const SESSION_SCHEMA_3 = SESSION_SCHEMA.replace("max_parties=2", "max_parties=3");

const id = (byte) => new Uint8Array(16).fill(byte);
const E1 = id(0x11);
const E2 = id(0x22);
/** A row id's author part as `_r_parents` spells it: lowercase hex. */
const hexOf = (bytes) => Buffer.from(bytes).toString("hex");

const SIGNATURES = join(repo, "conformance", "merge", "signatures.json");
const signatures = existsSync(SIGNATURES) ? JSON.parse(readFileSync(SIGNATURES, "utf8")) : {};
let signaturesAdded = 0;
const signaturesUsed = new Set();
/** A signer that reuses the kept signature for a header it has seen, and signs (when writing) one it has not. */
const keptSigner = (person) => async (header) => {
  const key = Buffer.from(header).toString("hex");
  signaturesUsed.add(key);
  if (!signatures[key]) {
    if (check) throw new Error(`no kept signature for header ${key.slice(0, 16)}...; run the generator to write one`);
    signatures[key] = Buffer.from(await signBytes(person.keys.privateKey, header)).toString("hex");
    signaturesAdded += 1;
  }
  return { sig: new Uint8Array(Buffer.from(signatures[key], "hex")), pub: person.pub };
};

/** Seals everything an author has pending, as a leave does (docs/identity.md, step 3). */
async function sealAll(db, person) {
  await seal(db, person, keptSigner(person));
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

/** The schema copy `which` ("a" or "b") of a vector is built from: the session schema for a session vector. */
const schemaFor = (vector, which) => vector.schemas?.[which] ?? vector.schema ?? (vector.session ? SESSION_SCHEMA : SCHEMA);
/** A copy of a vector's document. */
const openFor = (vector, path, extra, which = "a") => open(path, extra, schemaFor(vector, which));

/**
 * What each copy's signed manifest says, as a reader is given it
 * (`manifest.json`, D184): the digest of the signed view, and the session
 * profile's max_parties and close rule where the document declares one. Two
 * copies whose views differ are two builds, and a merge between them is
 * refused whole (R16). The view is built from the schema the copy was made
 * under, the way the compiler builds it from the document's.
 */
function manifestOf(schema) {
  const rewritten = rewriteReplicated(schema);
  const session = rewritten.session ? { max_parties: rewritten.session.maxParties, close: rewritten.session.close } : undefined;
  const view = signedViewOf({
    manifestVersion: 4,
    documentUuid: DOC,
    appName: "Merge fixture",
    requires: ["authorship"],
    replication: { tables: rewritten.tables, level: 1 },
    ...(session ? { session } : {}),
    createdAt: "2026-01-01T00:00:00.000Z",
    algorithm: "SHA-256",
    integrityPolicy: "enforce",
  });
  return { view: createHash("sha256").update(signedBytes(view)).digest("hex"), ...(session ? { session } : {}) };
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
      "B's row was changed after it was signed. B's header is still authentic, and incomplete, since the row it lists no longer digests to it: merging B into A keeps the header and takes no row through it, and refuses the changed row, which names that header, as BATCH_DIGEST_MISMATCH in the name of the row's author. B keeps its own.",
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
      "A holds its rows with no batch named (the save that wrote their pointers was lost) and two headers that each list them (sealed again after). Merging A into B signs the rows under the lower id and keeps both headers. Merging B into A signs them there too: a row a complete header the copy holds lists is signed, and the merge sets its pointer to the lowest such header, so the copies end the same.",
    authors: true,
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
      "Bo, the seated joiner, signs two headers over one (moves, seq) with different rows, one on each copy. Each merge reports AUTHOR_EQUIVOCATED once and refuses the other row at that id; both headers are kept, and the row at that id is admitted on neither copy (D160). Bo is no creator, so the session stands and his hold with it (R10).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const fork = await forkOf(b, BO);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      createEntity(fork, "moves", id(0x85), { seat: SEAT_OPEN, san: "d5" }, session);
      await exchange(a, fork, BO);
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
      "Bo moves, then closes the session; Ada then moves after his close, at a seq and a clock both past his. A close binds only its author: Ada's moves are admitted, by any order a reader might compare them in, and so are Bo's, all written before his close; the session is closed and nothing is reported. A close carries no frontier (D151, batch format version 2).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(b, a, ADA);
      for (const [byte, san] of [[0x82, "e5"], [0x87, "Nc6"]]) {
        createEntity(b, "moves", id(byte), { seat: SEAT_OPEN, san }, session);
      }
      const close = createEntity(b, "_dai_close", id(0x91), {}, session);
      await exchange(a, b, BO);
      // Ada's seqs run past the seq of Bo's close, so a reader that compared
      // one author's seq with another's is caught as surely as one that
      // compared clocks.
      const last = [[0x86, "Nf3"], [0x88, "Bc4"], [0x89, "Qe2"], [0x8a, "d3"]].map(([byte, san]) =>
        createEntity(a, "moves", id(byte), { seat: SEAT_W, san }, session),
      ).at(-1);
      if (!(last._r_seq > close._r_seq)) throw new Error(`session-close-no-frontier: Ada's last move is at ${last._r_seq}, not past Bo's close at ${close._r_seq}`);
    },
    expect: (runs) => {
      const wrong = ruled(runs, { holders: [[SEAT_W, ADA.author], [SEAT_OPEN, BO.author]], closed: 1, reports: [] });
      if (wrong) return wrong;
      for (const [direction, run] of Object.entries(runs)) {
        const movers = sectionOf(run.admitted, "moves").map((line) => line.split(":")[0]);
        if (movers.filter((m) => m === hexOf(ADA.author)).length !== 5 || movers.filter((m) => m === hexOf(BO.author)).length !== 2) return `${direction}: admitted moves are by [${movers.join(", ")}], not Ada's five and Bo's two`;
      }
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
      "Ada writes a version of Bo's binding in its session, Bo writes a version of it in another session, and Ada a row of another entity naming it. Roster heads partition by session, entity and author, so all four bindings are heads (D171, T1-D35). A reader partitioning by entity alone, by entity and author, by entity and session, or by session and author hides Bo's binding.",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const ask = b.all("SELECT _r_replica, _r_seq, _r_entity FROM _dai_binding WHERE _r_replica = ? AND _r_session = ?", [BO.author, session])[0];
      const named = JSON.stringify([idOf(ask)]);
      raw(a, "_dai_binding", ask._r_entity, { seat: SEAT_OPEN }, session, named);
      raw(b, "_dai_binding", ask._r_entity, { seat: SEAT_OPEN }, id(0xe2), named);
      // And a row of another entity naming it, which is no version of it (T1-D35).
      raw(a, "_dai_binding", id(0x54), { seat: SEAT_OPEN }, session, named);
    },
    expect: (runs) => {
      for (const [direction, run] of Object.entries(runs)) {
        const asks = sectionOf(run.admitted, "_dai_binding");
        if (asks.length !== 4) return `${direction}: binding heads are [${asks.join(" | ")}], not all four`;
      }
    },
  },
  {
    name: "session-equivocation-filed",
    session: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "A holds two of Ada's headers over one (moves, seq) with different rows, and two later headers of Cy's, each with a move for Bo's seat in Bo's own session; B holds a third header of Ada's at that id. B into A reveals nothing new and reports no equivocation. A into B reports Ada AUTHOR_EQUIVOCATED once, under the lower of A's two headers, after the SEAT_NOT_HELD of Cy's first later header, whose id sorts below both, and before that of his second, whose id sorts between them: the report is filed under the revealing header, and emitted by batch id, then code (D160, D171). The later moves are Cy's, in Bo's session, because Ada's own session is void once she signs twice and an equivocator's rows are reported nowhere but as her signing twice (R10, R17).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const bos = begin(b, { seat: id(0xa4), seats: [id(0xb6)], entity: id(0x5e) });
      await exchange(a, b, BO);
      // Cy, who holds no seat in Bo's session, writes the later moves there.
      const cy = copyFor(CY);
      await exchange(cy, b, BO);
      const first = await forkOf(a, ADA);
      const second = await forkOf(a, ADA);
      // A's two headers at the id, one in [4, 8) and one at c or above, so the
      // later headers below and between them are found in a few tries.
      const tried = async (from, entity, prefix, fits) => {
        for (let i = 0; ; i += 1) {
          const [h] = await probe(from, ADA, (c) => createEntity(c, "moves", id(entity), { seat: SEAT_W, san: `${prefix}${i}` }, session));
          if (fits(h)) return `${prefix}${i}`;
        }
      };
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: await tried(a, 0x81, "e", (h) => "4" <= h && h < "8") }, session);
      await sealAll(a, ADA);
      createEntity(first, "moves", id(0x84), { seat: SEAT_W, san: await tried(first, 0x84, "d", (h) => h >= "c") }, session);
      await exchange(a, first, ADA);
      createEntity(second, "moves", id(0x8c), { seat: SEAT_W, san: "c4" }, session);
      await exchange(b, second, ADA);
      first.done();
      second.done();
      const doubled = a.all("SELECT _r_seq FROM moves WHERE _r_entity = ?", [id(0x81)])[0]._r_seq;
      const ids = (seq, who = ADA) =>
        a.all("SELECT lower(hex(b.id)) AS id FROM _dai_batch b, json_each(b.covers) c WHERE b.author = ? AND json_extract(c.value, '$[0]') = 'moves' AND json_extract(c.value, '$[1]') = ?", [who.author, seq]).map((r) => r.id);
      const held = ids(doubled).sort();
      // The two later moves, Cy's, each found by trying moves in order, for where its header falls.
      const later = async (entity, prefix, fits) => {
        for (let i = 0; ; i += 1) {
          const write = (c) => createEntity(c, "moves", id(entity), { seat: id(0xa4), san: `${prefix}${i}` }, bos);
          const [h] = await probe(cy, CY, write);
          if (fits(h)) {
            const row = write(cy);
            await sealAll(cy, CY);
            return row;
          }
        }
      };
      const q = await later(0x8b, "Q", (h) => h < held[0]);
      const hh = await later(0x8d, "h", (h) => held[0] < h && h < held[1]);
      await exchange(a, cy, CY);
      cy.done();
      /*
       * The teeth: the first later header's id sorts below both revealing ones,
       * and the second's between them, so a reader filing the report under no
       * id, under the lowest header that arrived, under the higher revealing
       * one, or under any header of that id it already held, emits a
       * different list. Asserted, so a change to the rows above cannot quietly
       * remove them (the second was added when a blind reader showed the first
       * alone passed a reader filing under the higher revealing header).
       */
      const revealing = ids(doubled).sort();
      const [below] = ids(q._r_seq, CY);
      const [between] = ids(hh._r_seq, CY);
      if (revealing.length !== 2 || !(below < revealing[0] && revealing[0] < between && between < revealing[1])) {
        throw new Error(`session-equivocation-filed: need ${below} < ${revealing[0]} < ${between} < ${revealing[1]}`);
      }
    },
    expect: (runs) =>
      ruled(runs, {
        ab: { reports: [] },
        ba: { reports: ["Cy SEAT_NOT_HELD", "Ada AUTHOR_EQUIVOCATED", "Cy SEAT_NOT_HELD"] },
      }),
  },

  /*
   * The step 6 review's fixtures and the rulings on them (29 September, batch
   * format version 2). Each asserts the ruled answer (`expect`), so a runtime
   * that has it wrong fails the generator, not only a diff.
   */
  {
    name: "session-equivocated-parent",
    session: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "Ada's move for her own seat names, as its earlier version, Bo's move for his seat at an id Bo signed twice. A row naming an equivocated id as a parent is neither admitted nor reported, on either copy, whichever version of the parent it holds: it neither shows nor hides (review X1). A reader skipping the equivocated parent admits Ada's move; one reading the parent it holds reports SEAT_NOT_HELD. The equivocator is the joiner, so the session stands (R10), and he holds no seat: the open seat is void (R17).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const fork = await forkOf(b, BO);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      createEntity(fork, "moves", id(0x82), { seat: SEAT_OPEN, san: "d5" }, session);
      await exchange(a, fork, BO);
      fork.done();
      const parent = a.all("SELECT _r_replica, _r_seq FROM moves WHERE _r_entity = ?", [id(0x82)])[0];
      raw(a, "moves", id(0x82), { seat: SEAT_W, san: "Nc3" }, session, JSON.stringify([`${hexOf(parent._r_replica)}:${parent._r_seq}`]));
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        const crossing = run.result.refusedBatches.filter((r) => r.author === b64Of(ADA.author));
        if (crossing.length > 0) return `${direction}: Ada is reported ${crossing.map((r) => r.reason).join(", ")}`;
        if (sectionOf(run.admitted, "moves").some((line) => line.startsWith(hexOf(ADA.author)))) return `${direction}: Ada's move is admitted`;
        if (!sectionOf(run.admitted, "voided").some((line) => line.split(String.fromCharCode(9))[1] === hexOf(SEAT_OPEN))) return `${direction}: the open seat of the equivocator Bo is not void`;
      }
    },
  },
  {
    name: "merge-named-incomplete-header",
    authors: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "B holds Ada's row naming header H1, which lists it and a row B does not hold (so H1 is incomplete), and header H2, which lists the row alone. The row is taken through H2, and its _r_batch is H2: the header it names only when that header is complete and kept, else the lowest complete kept header that lists it (review X2). H1 and H2 both list the row, with different digests, so the merge that keeps both, B into A, also reports AUTHOR_EQUIVOCATED in Ada's name: the comparison is of whole-batch digests.",
    fill: async (a, b) => {
      const path = join(out, "scratch-plain-fork.db");
      const src = open(path);
      asReplica(src, ADA.author);
      createEntity(src, "notes", id(0x31), { body: "one" });
      createEntity(src, "notes", id(0x32), { body: "two" });
      await sealAll(src, ADA);
      const r1 = src.all("SELECT * FROM notes WHERE _r_entity = ?", [id(0x31)])[0];
      const row = {
        _r_replica: r1._r_replica,
        _r_seq: r1._r_seq,
        _r_lc: r1._r_lc,
        _r_entity: r1._r_entity,
        _r_parents: r1._r_parents,
        _r_deleted: r1._r_deleted,
        _r_batch: null,
        columns: { body: r1.body },
      };
      holdHeader(b, await signBatch({ replica: ADA.author, lc: r1._r_lc, entries: [{ table: "notes", row }] }, { document: DOC, sign: keptSigner(ADA) }));
      for (const header of src.all("SELECT * FROM _dai_batch")) {
        const names = Object.keys(header);
        b.run(`INSERT INTO _dai_batch (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => header[n]));
      }
      const names = Object.keys(r1);
      b.run(`INSERT INTO notes (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => r1[n]));
      b.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [ADA.author]);
      src.close();
      rmSync(path);
    },
  },
  {
    name: "session-void-equivocated-confirm",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "B holds two headers of Ada's at one confirm's seq, so on B she is already an equivocator and her session void. A into B takes a confirm of the open seat to another copy (header Hc) and a confirm at the equivocated id (Hx), with Ada's move naming no seat (Hn) between them (Hx < Hn < Hc). A void session stays void and reports nothing but its creator signing twice, which this merge does not newly reveal: nothing is reported, and no seat is voided (R10). Before R10, the merge voided the open seat and filed AUTHOR_EQUIVOCATED under Hc, after the SEAT_NOT_HELD of Hn (review X3).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const headerOf = (db, table, seq) =>
        db.all("SELECT lower(hex(b.id)) AS id FROM _dai_batch b, json_each(b.covers) c WHERE b.author = ? AND json_extract(c.value, '$[0]') = ? AND json_extract(c.value, '$[1]') = ?", [ADA.author, table, seq])[0].id;
      /** The id of the header `write` would seal on a copy standing where `a` stands, found without a kept signature. */
      const probe = async (write) => {
        const copy = await forkOf(a, ADA);
        const before = new Set(copy.all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => r.id));
        write(copy);
        for (const batch of pendingBatches(copy, ADA.author, copy.tables)) {
          recordSeal(copy, await signBatch(batch, { document: DOC, sign: async () => ({ sig: new Uint8Array(64), pub: ADA.pub }) }));
        }
        const [found] = copy.all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => r.id).filter((x) => !before.has(x));
        copy.done();
        return found;
      };
      const k = a.all("SELECT seq FROM _dai_replica")[0].seq + 1;
      // The confirm Ada signs twice at seq k, the one A takes under the lower header.
      let e = 0x10;
      while ((await probe((c) => confirmSeat(c, session, SEAT_OPEN, id(0xdd), id(e)))) >= "4") e += 1;
      const f1 = await forkOf(a, ADA);
      confirmSeat(f1, session, SEAT_OPEN, id(0xdd), id(e));
      await sealAll(f1, ADA);
      const hx = headerOf(f1, "_dai_confirm", k);
      const f2 = await forkOf(a, ADA);
      confirmSeat(f2, session, SEAT_OPEN, id(0xee), id(0x74));
      await sealAll(f2, ADA);
      const hy = headerOf(f2, "_dai_confirm", k);
      // A takes the first; B holds both headers and neither row, so on B the id
      // is equivocated before the merge.
      await exchange(a, f1, ADA);
      a.run("UPDATE _dai_replica SET seq = ?", [k]);
      for (const [from, hid] of [[f1, hx], [f2, hy]]) {
        const header = from.all("SELECT * FROM _dai_batch WHERE lower(hex(id)) = ?", [hid])[0];
        const names = Object.keys(header);
        b.run(`INSERT INTO _dai_batch (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => header[n]));
      }
      f1.done();
      f2.done();
      // The neighbour: Ada's move naming no seat, sealed alone, between Hx and "c".
      let i = 0;
      for (;;) {
        const hn = await probe((c) => createEntity(c, "moves", id(0x8f), { seat: new Uint8Array([7]), san: `n${i}` }, session));
        if (hx < hn && hn < "c") break;
        i += 1;
      }
      createEntity(a, "moves", id(0x8f), { seat: new Uint8Array([7]), san: `n${i}` }, session);
      await sealAll(a, ADA);
      const hn = headerOf(a, "moves", k + 1);
      // The counting confirm naming another holder, sealed alone, above the neighbour.
      e = 0x75;
      while ((await probe((c) => confirmSeat(c, session, SEAT_OPEN, id(0xcc), id(e)))) <= hn) e += 1;
      confirmSeat(a, session, SEAT_OPEN, id(0xcc), id(e));
      await sealAll(a, ADA);
      const hc = headerOf(a, "_dai_confirm", k + 2);
      if (!(hx < hn && hn < hc)) throw new Error(`session-void-equivocated-confirm: need ${hx} < ${hn} < ${hc}`);
    },
    expect: ({ ba }) => {
      if (ba.result.refusedBatches.length > 0) return `A into B: reported ${ba.result.refusedBatches.map((r) => r.reason).join(", ")} in a session void before the merge`;
      if (sectionOf(ba.admitted, "voided").length > 0) return "A into B: a seat of a void session is voided";
      if (sectionOf(ba.admitted, "holders").length > 0) return `A into B: holders are [${sectionOf(ba.admitted, "holders").join(" | ")}] in a void session`;
    },
  },
  {
    name: "session-equivocation-two-tables",
    session: true,
    cites: ["6", "T1-D13"],
    what:
      "Ada signs one seq twice under two headers: a move on A, a close on B. Equivocation is per (author, seq), in any tables: every merge takes both rows, reports AUTHOR_EQUIVOCATED in Ada's name, and neither row counts, so the copies agree. A reader comparing seqs within one table keeps whichever row arrived first as the only one, and the copies split with nothing reported (review, outside the fifteen).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const fork = await forkOf(a, ADA);
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      createEntity(fork, "_dai_close", id(0x91), {}, session);
      await exchange(b, fork, ADA);
      fork.done();
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        if (!run.result.refusedBatches.some((r) => r.author === b64Of(ADA.author) && r.reason === "AUTHOR_EQUIVOCATED")) return `${direction}: no AUTHOR_EQUIVOCATED`;
        if (run.result.rejected.length > 0) return `${direction}: rejected ${run.result.rejected.join(", ")}`;
        if (sectionOf(run.admitted, "closed").length > 0) return `${direction}: an equivocated close closed the session`;
        if (sectionOf(run.admitted, "equivocated").length !== 2) return `${direction}: equivocated is [${sectionOf(run.admitted, "equivocated").join(" | ")}]`;
      }
    },
  },
  {
    name: "merge-seal-seq-twice",
    cites: ["6", "T1-D13"],
    what:
      "Ada signs one header listing her seq 1 twice, a case and a note, each row naming it. A list that repeats a seq in any tables is not a list, so the header is not authentic: merging A into B refuses it as BATCH_SIGNATURE_INVALID in Ada's name and takes neither row, and the rows, naming a header refused already, are not reported again. A reader taking both rows spends one seq on two rows (the step 6 review).",
    authors: true,
    converges: false,
    fill: async (a) => {
      createEntity(a, "cases", E1, { title: "one seq", status: "open", weight: null });
      forge(a, "notes", ADA.author, 1, { body: "the same seq" });
      await sealAll(a, ADA);
      const listed = a.all("SELECT covers FROM _dai_batch").map((h) => h.covers);
      if (listed.join() !== '[["cases",1],["notes",1]]') throw new Error(`merge-seal-seq-twice: A holds headers listing ${listed.join(" and ")}`);
    },
    expect: ({ ba }) => {
      const refused = ba.result.refusedBatches.map((r) => `${r.author === b64Of(ADA.author) ? "Ada" : r.author} ${r.reason}`);
      if (refused.join() !== "Ada BATCH_SIGNATURE_INVALID") return `A into B: refused [${refused.join(", ")}], not Ada's header alone as BATCH_SIGNATURE_INVALID`;
      if (ba.result.applied !== 0) return `A into B: ${ba.result.applied} rows taken`;
    },
  },

  /*
   * The witness pass (30 September): a fixture for each rule of the step 6
   * review's Pass 2 that had none, in the Reports, Session admission and
   * Equivocation groups. Each was run against a Python reader with its one rule
   * removed, and failed; each asserts the ruled answer (`expect`).
   */
  {
    name: "session-entity-other-session",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Ada moves in her session S, then starts a session S2 and writes a version of that move's entity in S2 naming it. B holds S2 and the S2 version, not the move it names; Bo moves in S2 for the seat he holds in S. A into B takes only the parent: the S2 version is reported ENTITY_OTHER_SESSION in Ada's name under its own batch, after the SEAT_NOT_HELD of a header whose id sorts between the parent's and its own. B into A makes no crossing true, and reports Bo's S2 move SEAT_NOT_HELD: in S2 nobody holds the seat it names and he never asked for it, so it names a value no counting confirm names (A03). Neither the S2 version nor Bo's S2 move is admitted: an entity belongs to its session, and a seat is the pair of session and seat.",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const s2Of = (c) => begin(c, { seat: SEAT_W, seats: [SEAT_OPEN], entity: id(0x56) });
      const parentSeq = a.all("SELECT seq FROM _dai_replica")[0].seq + 1;
      const version = (c, s2) => raw(c, "moves", id(0x81), { seat: SEAT_W, san: "d4" }, s2, JSON.stringify([`${hexOf(ADA.author)}:${parentSeq}`]));
      // The parent's header below the S2 version's, so a neighbor can sit between them.
      let i = 0;
      for (;;) {
        const [hp, hc] = await probe(a, ADA, (c) => createEntity(c, "moves", id(0x81), { seat: SEAT_W, san: `e${i}` }, session), (c) => version(c, s2Of(c)));
        if (hp < hc) break;
        i += 1;
      }
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: `e${i}` }, session);
      await sealAll(a, ADA);
      const s2 = s2Of(a);
      version(a, s2);
      await sealAll(a, ADA);
      const [hp] = headersListing(a, ADA.author, "moves", parentSeq);
      const [hc] = headersListing(a, ADA.author, "moves", parentSeq + 2);
      carry(b, a, [hc]);
      // Bo's move in S2 for the seat he holds in S, which in S2 nobody holds.
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, s2);
      await sealAll(b, BO);
      // The neighbor: Ada's move naming no seat, sealed alone, between the two.
      let j = 0;
      for (;;) {
        const [hn] = await probe(a, ADA, (c) => createEntity(c, "moves", id(0x8f), { seat: new Uint8Array([7]), san: `n${j}` }, session));
        if (hp < hn && hn < hc) break;
        j += 1;
      }
      createEntity(a, "moves", id(0x8f), { seat: new Uint8Array([7]), san: `n${j}` }, session);
      await sealAll(a, ADA);
    },
    expect: ({ ab, ba }) => {
      const ada = ba.result.refusedBatches.filter((r) => r.author === b64Of(ADA.author)).map((r) => r.reason);
      if (ada.join() !== "SEAT_NOT_HELD,ENTITY_OTHER_SESSION") return `A into B: Ada is reported ${ada.join(", ")}, not SEAT_NOT_HELD then ENTITY_OTHER_SESSION`;
      const bo = reported(ab);
      if (bo.join() !== "Bo SEAT_NOT_HELD") return `B into A: reported [${bo.join(", ")}], not Bo's move in S2 as SEAT_NOT_HELD (A03)`;
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        const moves = sectionOf(run.admitted, "moves");
        if (moves.some((line) => line.startsWith(hexOf(BO.author)))) return `${direction}: Bo's move in S2 is admitted`;
        if (moves.length !== 1) return `${direction}: admitted moves are [${moves.join(" | ")}], not Ada's move in S alone`;
      }
    },
  },
  {
    name: "session-other-seat",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Bo, holding the open seat, writes a move for his seat naming as its earlier version Ada's move for her seat, which B does not hold, and a move of another entity naming the same. A version acts only for its own seat: Bo's first move is not admitted on either copy, and Ada's stays a head. B into A takes the child and A into B only the parent; each reports SEAT_NOT_HELD in Bo's name, under his moves' batch (D132). A parent of another entity is no version: Bo's second move crosses nothing and is admitted, and hides nothing (T1-D35).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const parent = createEntity(a, "moves", id(0x83), { seat: SEAT_W, san: "e4" }, session);
      await sealAll(a, ADA);
      const named = JSON.stringify([`${hexOf(ADA.author)}:${parent._r_seq}`]);
      raw(b, "moves", id(0x83), { seat: SEAT_OPEN, san: "e5" }, session, named);
      const second = raw(b, "moves", id(0x87), { seat: SEAT_OPEN, san: "Nc6" }, session, named);
      await sealAll(b, BO);
      marks["session-other-seat"] = [idOf(parent), idOf(second)];
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        const refused = run.result.refusedBatches.map((r) => `${r.author === b64Of(BO.author) ? "Bo" : r.author} ${r.reason}`);
        if (refused.join() !== "Bo SEAT_NOT_HELD") return `${direction}: refused [${refused.join(", ")}], not Bo's move as SEAT_NOT_HELD`;
        const moves = sectionOf(run.admitted, "moves").map((line) => line.split("\t")[0]);
        if (moves.join() !== marks["session-other-seat"].join()) return `${direction}: admitted moves are [${moves.join(" | ")}], not Ada's and Bo's second`;
      }
    },
  },
  {
    name: "session-close-scope",
    session: true,
    cites: ["6", "T1-D31"],
    what:
      "Ada closes S, then starts S2 and moves there. Bo writes a close of S that is itself a delete, then moves in S; and closes S2, where he holds no seat, then asks for a seat in S2. A close binds its author in its own session only: Ada's S2 move is admitted. A deleted close row counts for nothing, so Bo's S move, after it, is admitted and no equivocation (R18). A close counts only by a member of its own session, so S2 is not closed and Bo's ask after his close there is no equivocation either. S is closed by Ada's close, and nothing is reported (D151, D152, D153, R18).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      createEntity(a, "_dai_close", id(0x91), {}, session);
      const s2 = begin(a, { seat: SEAT_W, seats: [SEAT_OPEN], entity: id(0x56) });
      createEntity(a, "moves", id(0x84), { seat: SEAT_W, san: "d4" }, s2);
      await sealAll(a, ADA);
      raw(b, "_dai_close", id(0x92), {}, session, "[]", 1);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      createEntity(b, "_dai_close", id(0x93), {}, s2);
      createEntity(b, "_dai_binding", id(0x64), { seat: SEAT_OPEN }, s2);
      await sealAll(b, BO);
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        if (run.result.refusedBatches.length > 0) return `${direction}: reported ${run.result.refusedBatches.map((r) => r.reason).join(", ")}`;
        const closed = sectionOf(run.admitted, "closed");
        if (closed.length !== 1) return `${direction}: closed is [${closed.join(" | ")}], not S alone`;
        const moves = sectionOf(run.admitted, "moves").map((line) => line.split(":")[0]);
        if (moves.join() !== [hexOf(ADA.author), hexOf(BO.author)].join()) return `${direction}: admitted moves are by [${moves.join(", ")}], not Ada's S2 move and Bo's`;
      }
    },
  },
  {
    name: "session-creator-deleted",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Ada starts a session S whose creator's seat row is written deleted, and moves for its seat. Bo starts a session T, and Ada, creator of another session of her own, confirms herself in T's open seat. A copy holding only a tombstone at a creator's seat row's id has no live session (R20), so S admits nothing and Ada's move is not admitted; a confirm counts only by the creator of its own session, so nobody holds T's open seat (D158, D165).",
    fill: async (a, b) => {
      const t = begin(b, { seat: id(0xa2), seats: [SEAT_OPEN], entity: id(0x5a) });
      await sealAll(b, BO);
      begin(a, { seat: SEAT_W, seats: [SEAT_OPEN], entity: id(0x51) });
      confirmSeat(a, t, SEAT_OPEN, ADA.author, id(0x71));
      const seq = a.all("SELECT seq FROM _dai_replica")[0].seq + 1;
      const s = sessionIdOf(ADA.author, seq, SEAT_W, SEAT_OPEN, "any");
      raw(a, "_dai_seat", id(0x58), { seat: SEAT_W, seats: SEAT_OPEN, close: "any" }, s, "[]", 1);
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, s);
      await sealAll(a, ADA);
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        if (sectionOf(run.admitted, "moves").length > 0) return `${direction}: a move is admitted in a session with no creator`;
        const holders = sectionOf(run.admitted, "holders");
        if (holders.length !== 2 || holders.some((line) => line.includes(hexOf(SEAT_OPEN)))) return `${direction}: holders are [${holders.join(" | ")}], not the two creators' seats`;
      }
    },
  },
  {
    name: "session-equivocated-seat-version",
    session: true,
    cites: ["6", "T1-D13"],
    what:
      "Ada writes a version of her creator's seat row on A, and from a second copy of her store a move at the same seq on B. The id is equivocated on both copies after either merge, and Ada is an equivocator: every seat row of hers counts for nothing, so none is a head of the roster, and her session is void; each merge reports AUTHOR_EQUIVOCATED (D160, D171, R10). Before R10 the version alone was no head and her earlier seat rows stayed heads.",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const fork = await forkOf(a, ADA);
      const row = a.all("SELECT * FROM _dai_seat WHERE _r_replica = ? AND _r_session = ? ORDER BY _r_seq LIMIT 1", [ADA.author, session])[0];
      raw(a, "_dai_seat", row._r_entity, columnsOf(row), session, JSON.stringify([idOf(row)]));
      await sealAll(a, ADA);
      createEntity(fork, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(b, fork, ADA);
      fork.done();
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        const seats = sectionOf(run.admitted, "_dai_seat").map((line) => line.split("\t")[0]);
        if (seats.length > 0) return `${direction}: seat heads are [${seats.join(", ")}], not none: an equivocator's seat rows count for nothing`;
        if (sectionOf(run.admitted, "holders").length > 0) return `${direction}: holders are [${sectionOf(run.admitted, "holders").join(" | ")}] in a void session`;
        if (!run.result.refusedBatches.some((r) => r.reason === "AUTHOR_EQUIVOCATED")) return `${direction}: no AUTHOR_EQUIVOCATED`;
      }
    },
  },
  {
    name: "session-equivocated-creator",
    session: true,
    cites: ["6", "T1-D13"],
    what:
      "Ada starts a session on A and moves for her seat; from a second copy of her store she signs a move at the seq of her creator's seat row, which B holds. The creator's seat row is at an equivocated id, so it seats nobody: the session has no creator on either copy after either merge, and her move is not admitted (D158, D160).",
    fill: async (a, b) => {
      const fork = await forkOf(a, ADA);
      const session = begin(a, { seat: SEAT_W, seats: [SEAT_OPEN], entity: id(0x51) });
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await sealAll(a, ADA);
      createEntity(fork, "moves", id(0x84), { seat: SEAT_W, san: "d4" }, session);
      await exchange(b, fork, ADA);
      fork.done();
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        if (sectionOf(run.admitted, "holders").length > 0) return `${direction}: holders are [${sectionOf(run.admitted, "holders").join(" | ")}]`;
        if (sectionOf(run.admitted, "moves").length > 0) return `${direction}: a move is admitted`;
      }
    },
  },
  {
    name: "session-equivocation-whole-digest",
    session: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "Bo signs one header over two moves on B, and from a second copy of his store a header over the first of them alone, the same row, on A. The comparison is of whole-batch digests: the two headers list one seq with different digests, so that id is equivocated though the row is the same, and each merge reports AUTHOR_EQUIVOCATED. He is the joiner, so the session stands (R10), but he holds no seat and none of his moves is admitted, the one listed once included (R17). Each copy keeps its own pointer on the shared row (D160).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const fork = await forkOf(b, BO);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      createEntity(b, "moves", id(0x87), { seat: SEAT_OPEN, san: "Nc6" }, session);
      await sealAll(b, BO);
      createEntity(fork, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      await exchange(a, fork, BO);
      fork.done();
      const [one] = b.all("SELECT * FROM moves WHERE _r_entity = ?", [id(0x82)]);
      const [other] = a.all("SELECT * FROM moves WHERE _r_entity = ?", [id(0x82)]);
      // The teeth: the one row both headers list is the same row on both copies.
      const shape = (r) =>
        JSON.stringify(Object.entries(r).filter(([k]) => k !== "_r_batch" && k !== "_r_superseded").map(([k, v]) => [k, v instanceof Uint8Array ? hexOf(v) : v]));
      if (shape(one) !== shape(other)) throw new Error(`session-equivocation-whole-digest: the rows differ: ${shape(one)} and ${shape(other)}`);
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        if (!run.result.refusedBatches.some((r) => r.reason === "AUTHOR_EQUIVOCATED")) return `${direction}: no AUTHOR_EQUIVOCATED`;
        const moves = sectionOf(run.admitted, "moves");
        if (moves.length !== 0) return `${direction}: admitted moves are [${moves.join(" | ")}], not none: Bo is an equivocator`;
      }
    },
  },
  {
    name: "merge-equivocated-plain-heads",
    authors: true,
    admits: true,
    cites: ["6", "T1-D13"],
    what:
      "A plain document. Ada edits her note on A, and from a second copy of her store signs a case at the same seq on B. The edit's id is equivocated after either merge, so among a plain table's heads it is no head and hides nothing: her first note is a head again. It ships the heads it admits, as a session vector does (D160).",
    fill: async (a, b) => {
      createEntity(a, "notes", E1, { body: "first" });
      await exchange(b, a, ADA);
      const fork = await forkOf(a, ADA, SCHEMA);
      changeEntity(a, "notes", E1, { body: "edited" });
      await sealAll(a, ADA);
      createEntity(fork, "cases", E2, { title: "signed at the same seq", status: "open", weight: null });
      await exchange(b, fork, ADA);
      fork.done();
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        const notes = sectionOf(run.admitted, "notes");
        if (notes.join() !== `${hexOf(ADA.author)}:1\t0`) return `${direction}: note heads are [${notes.join(" | ")}], not the first note`;
        if (sectionOf(run.admitted, "cases").length > 0) return `${direction}: the case at the equivocated id is a head`;
      }
    },
  },
  {
    name: "merge-report-order",
    authors: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "B holds, beside Bo's signed case: an unsigned case under Ada's id and one under Bo's; a malformed row of Ada's naming no batch; a malformed row of Bo's naming his own batch, which does not list it; Ada's header H over a note and a malformed note; a row of Bo's naming H, which does not list it; and Ada's header over one seq listed twice. Merging B into A files each refusal where docs/format.md says and emits them by batch id (no id first), then code, then author id in hex: under no id, BATCH_UNSIGNED for Ada then Bo, then ROW_MALFORMED; under H, BATCH_DIGEST_MISMATCH (Bo) before ROW_MALFORMED (Ada); ROW_MALFORMED under Bo's batch; BATCH_SIGNATURE_INVALID under its own header.",
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "Ada's", status: "open", weight: null });
      await sealAll(a, ADA);
      createEntity(b, "cases", E2, { title: "Bo's", status: "open", weight: null });
      await sealAll(b, BO);
      const [hb] = headersListing(b, BO.author, "cases", 1);
      // Ada's two headers, signed on a second copy of her store and carried to B.
      const fork = await forkOf(a, ADA, SCHEMA);
      createEntity(fork, "notes", id(0x31), { body: "fine" });
      raw(fork, "notes", id(0x32), { body: "malformed" }, undefined, '["zz"]');
      await sealAll(fork, ADA);
      const [h] = headersListing(fork, ADA.author, "notes", 2);
      const twice = createEntity(fork, "cases", id(0x33), { title: "one seq", status: "open", weight: null });
      forge(fork, "notes", ADA.author, twice._r_seq, { body: "the same seq" });
      await sealAll(fork, ADA);
      const [hs] = headersListing(fork, ADA.author, "cases", twice._r_seq);
      carry(b, fork, [h, hs]);
      fork.done();
      const put = (table, author, seq, parents, batch, columns) => {
        const names = Object.keys(columns);
        b.run(
          `INSERT INTO "${table}" (${names.join(", ")}, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_batch) VALUES (${names.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, 0, ?)`,
          [...names.map((n) => columns[n]), author, seq, seq, id(seq), parents, batch === null ? null : Buffer.from(batch, "hex")],
        );
      };
      put("cases", BO.author, 50, "[]", h, { title: "names H", status: "open" });
      put("cases", ADA.author, 90, "[]", null, { title: "unsigned, Ada's id", status: "open" });
      put("cases", BO.author, 91, "[]", null, { title: "unsigned, Bo's id", status: "open" });
      put("cases", ADA.author, 92, '["zz"]', null, { title: "malformed, no batch", status: "open" });
      put("cases", BO.author, 93, "nope", hb, { title: "malformed, names Bo's batch", status: "open" });
      // The ruled answer, from docs/format.md#report-order and the table of codes.
      reportOrder.wanted = [
        ["", "BATCH_UNSIGNED", ADA],
        ["", "BATCH_UNSIGNED", BO],
        ["", "ROW_MALFORMED", ADA],
        [h, "BATCH_DIGEST_MISMATCH", BO],
        [h, "ROW_MALFORMED", ADA],
        [hb, "ROW_MALFORMED", BO],
        [hs, "BATCH_SIGNATURE_INVALID", ADA],
      ]
        .sort(([i, c, p], [j, d, q]) => (i < j ? -1 : i > j ? 1 : c < d ? -1 : c > d ? 1 : hexOf(p.author) < hexOf(q.author) ? -1 : 1))
        .map(([, code, person]) => `${person === ADA ? "Ada" : "Bo"} ${code}`)
        .join(", ");
    },
    expect: ({ ab }) => {
      const who = (r) => (r.author === b64Of(ADA.author) ? "Ada" : r.author === b64Of(BO.author) ? "Bo" : r.author);
      const got = ab.result.refusedBatches.map((r) => `${who(r)} ${r.reason}`).join(", ");
      if (got !== reportOrder.wanted) return `B into A: refused [${got}], not [${reportOrder.wanted}]`;
    },
  },
  {
    name: "session-equivocation-and-void",
    session: true,
    converges: false,
    cites: ["6", "T1-D29"],
    what:
      "Ada moves on A (header Ha). From a second copy of her store she signs a move at the same seq (Fe) and confirms the open seat, already Bo's, to another copy (Fv); B holds both. B into A reveals her signing twice: she is an equivocator, so her session is void and the second confirm voids no seat (R10). AUTHOR_EQUIVOCATED once, under Fe, after the SEAT_NOT_HELD of Bo's move naming no seat in a session of his own, whose header sorts between Ha and Fe. Ha, held before the merge, lists the newly equivocated id and reveals nothing (D160, D165, D171). Before R10 the merge revealed her both ways, under the lower of Fe and Fv.",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const fork = await forkOf(a, ADA);
      // The fork's two headers high, Ha low, and Bo's neighbor between.
      let i = 0;
      for (;;) {
        const found = await probe(fork, ADA, (c) => createEntity(c, "moves", id(0x84), { seat: SEAT_W, san: `d${i}` }, session), (c) => confirmSeat(c, session, SEAT_OPEN, id(0xcc), id(0x72)));
        if (found.every((x) => x >= "8")) break;
        i += 1;
      }
      createEntity(fork, "moves", id(0x84), { seat: SEAT_W, san: `d${i}` }, session);
      await sealAll(fork, ADA);
      confirmSeat(fork, session, SEAT_OPEN, id(0xcc), id(0x72));
      await exchange(b, fork, ADA);
      fork.done();
      let j = 0;
      while ((await probe(a, ADA, (c) => createEntity(c, "moves", id(0x81), { seat: SEAT_W, san: `e${j}` }, session)))[0] >= "4") j += 1;
      createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: `e${j}` }, session);
      await sealAll(a, ADA);
      // The neighbor: Bo's move naming no seat, in a session of his own, which
      // is not void, so it is reported (Ada's is void, and reports nothing else).
      const bos = begin(b, { seat: id(0xa4), seats: [id(0xb6)], entity: id(0x5e) });
      await sealAll(b, BO);
      let k = 0;
      for (;;) {
        const [hn] = await probe(b, BO, (c) => createEntity(c, "moves", id(0x8f), { seat: new Uint8Array([7]), san: `n${k}` }, bos));
        if ("4" <= hn && hn < "8") break;
        k += 1;
      }
      createEntity(b, "moves", id(0x8f), { seat: new Uint8Array([7]), san: `n${k}` }, bos);
      await sealAll(b, BO);
    },
    expect: ({ ab }) => {
      const who = (r) => (r.author === b64Of(ADA.author) ? "Ada" : r.author === b64Of(BO.author) ? "Bo" : r.author);
      const got = ab.result.refusedBatches.map((r) => `${who(r)} ${r.reason}`).join(", ");
      if (got !== "Bo SEAT_NOT_HELD, Ada AUTHOR_EQUIVOCATED") return `B into A: refused [${got}], not Bo's SEAT_NOT_HELD then one AUTHOR_EQUIVOCATED`;
      if (sectionOf(ab.admitted, "voided").length > 0) return "B into A: a seat of a void session is voided";
    },
  },
  {
    name: "session-void-creator-seat-row",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "B holds Ada's confirm of the open seat to Bo, and not her creator's seat row, so it counts nothing there. A holds the seat row (header Hs) and a second confirm of the seat to another copy (Hc). A into B takes both, making the seat void: the creator's seat row reveals as a counting confirm does, and AUTHOR_EQUIVOCATED is filed under the lower of the two, Hs, before the SEAT_NOT_HELD of a header between them (D165, D171).",
    fill: async (a, b) => {
      let e = 0x40;
      while ((await probe(a, ADA, (c) => begin(c, { seat: SEAT_W, seats: [SEAT_OPEN], entity: id(e) })))[0] >= "6") e += 2;
      const session = begin(a, { seat: SEAT_W, seats: [SEAT_OPEN], entity: id(e) });
      await sealAll(a, ADA);
      confirmSeat(a, session, SEAT_OPEN, BO.author, id(0x71));
      await sealAll(a, ADA);
      const [hc1] = headersListing(a, ADA.author, "_dai_confirm", a.all("SELECT _r_seq AS s FROM _dai_confirm WHERE _r_replica = ?", [ADA.author])[0].s);
      carry(b, a, [hc1]);
      const fork = await forkOf(a, ADA);
      let f = 0x72;
      while ((await probe(fork, ADA, (c) => confirmSeat(c, session, SEAT_OPEN, id(0xcc), id(f))))[0] < "a") f += 1;
      confirmSeat(fork, session, SEAT_OPEN, id(0xcc), id(f));
      await exchange(a, fork, ADA);
      fork.done();
      // Her own row came back, so her counter passes it, as a host's does.
      a.run("UPDATE _dai_replica SET seq = seq + 1");
      let k = 0;
      for (;;) {
        const [hn] = await probe(a, ADA, (c) => createEntity(c, "moves", id(0x8f), { seat: new Uint8Array([7]), san: `n${k}` }, session));
        if ("6" <= hn && hn < "a") break;
        k += 1;
      }
      createEntity(a, "moves", id(0x8f), { seat: new Uint8Array([7]), san: `n${k}` }, session);
      await sealAll(a, ADA);
    },
    expect: ({ ba }) => {
      const got = ba.result.refusedBatches.map((r) => r.reason).join(", ");
      if (got !== "AUTHOR_EQUIVOCATED, SEAT_NOT_HELD") return `A into B: refused [${got}], not AUTHOR_EQUIVOCATED under the seat row's header, then SEAT_NOT_HELD`;
      if (sectionOf(ba.admitted, "voided").length !== 1) return "A into B: the seat is not void";
    },
  },
  {
    name: "session-seat-not-held-after-merge",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "B holds Ada's move naming no seat, with its batch unset (the save that wrote its pointer was lost), and the header H that lists it. B into A takes the move through H, so its _r_batch after the merge is H, and SEAT_NOT_HELD is filed there, not under the no id the row carried: after the SEAT_NOT_HELD of Bo's move, whose header sorts below H. A into B sets B's own pointer to H too, since a complete header B holds lists the move, so the copies end the same.",
    fill: async (a, b) => {
      const session = await seated(a, b);
      let i = 0;
      while ((await probe(a, ADA, (c) => createEntity(c, "moves", id(0x8e), { seat: new Uint8Array([7]), san: `K${i}` }, session)))[0] < "8") i += 1;
      const fork = await forkOf(a, ADA);
      const move = createEntity(fork, "moves", id(0x8e), { seat: new Uint8Array([7]), san: `K${i}` }, session);
      await sealAll(fork, ADA);
      const [h] = headersListing(fork, ADA.author, "moves", move._r_seq);
      carry(b, fork, [h], { pointers: false });
      fork.done();
      let k = 0;
      while ((await probe(b, BO, (c) => createEntity(c, "moves", id(0x8f), { seat: new Uint8Array([7]), san: `n${k}` }, session)))[0] >= "8") k += 1;
      createEntity(b, "moves", id(0x8f), { seat: new Uint8Array([7]), san: `n${k}` }, session);
      await sealAll(b, BO);
    },
    expect: ({ ab }) => {
      const who = (r) => (r.author === b64Of(ADA.author) ? "Ada" : r.author === b64Of(BO.author) ? "Bo" : r.author);
      const got = ab.result.refusedBatches.map((r) => `${who(r)} ${r.reason}`).join(", ");
      if (got !== "Bo SEAT_NOT_HELD, Ada SEAT_NOT_HELD") return `B into A: refused [${got}], not Bo's SEAT_NOT_HELD then Ada's`;
    },
  },

  /*
   * R9 (30 September): a row at an equivocated id is reported nowhere but
   * AUTHOR_EQUIVOCATED. Found building the vector above; the readers split on it.
   */
  {
    name: "session-equivocated-row-silent",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Bo writes, on B, a move naming no seat, a version of Ada's move for his own seat, and in Ada's session S2 a version of his move in S, each naming a row at an id not equivocated. A second copy of his signs the same seqs as closes, which A holds. Every one of those ids is equivocated after either merge, so the three rows count for nothing and are reported nowhere but AUTHOR_EQUIVOCATED, in Bo's name, in both directions: no SEAT_NOT_HELD, for no seat or for another seat's version, and no ENTITY_OTHER_SESSION (R9). Bo is no session's creator, so neither session is void (R10).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const adas = createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      const s2 = begin(a, { seat: SEAT_W, seats: [SEAT_OPEN], entity: id(0x56) });
      await exchange(b, a, ADA);
      const mine = createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      await exchange(a, b, BO);
      const fork = await forkOf(b, BO);
      const first = b.all("SELECT seq FROM _dai_replica")[0].seq + 1;
      createEntity(b, "moves", id(0x8e), { seat: new Uint8Array([7]), san: "Nf6" }, session);
      raw(b, "moves", id(0x81), { seat: SEAT_OPEN, san: "d5" }, session, JSON.stringify([`${hexOf(ADA.author)}:${adas._r_seq}`]));
      raw(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "d6" }, s2, JSON.stringify([`${hexOf(BO.author)}:${mine._r_seq}`]));
      await sealAll(b, BO);
      const last = b.all("SELECT seq FROM _dai_replica")[0].seq;
      for (let seq = first; seq <= last; seq += 1) createEntity(fork, "_dai_close", id(0x90 + seq - first), {}, session);
      await exchange(a, fork, BO);
      fork.done();
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        const refused = run.result.refusedBatches.map((r) => `${r.author === b64Of(BO.author) ? "Bo" : r.author} ${r.reason}`);
        if (refused.join() !== "Bo AUTHOR_EQUIVOCATED") return `${direction}: refused [${refused.join(", ")}], not Bo's AUTHOR_EQUIVOCATED alone`;
        if (sectionOf(run.admitted, "equivocated").length !== 6) return `${direction}: equivocated is [${sectionOf(run.admitted, "equivocated").join(" | ")}], not three ids in two tables each`;
        if (sectionOf(run.admitted, "closed").length > 0) return `${direction}: an equivocated close closed the session`;
      }
    },
  },

  /*
   * Witness pass 2 (30 September): a fixture for each rule of the step 6
   * review's Pass 2 that had none in the Parents and ordering, Verification,
   * Merge and Versions groups, and for the page lines from the blind Rust
   * reader's silences. Each rule's hold-out is named in scripts/holdout.py:
   * the Python reader with the rule removed, or, for what the verifier and the
   * signer decide, the runtime with it removed.
   */
  {
    name: "merge-parents-shape",
    authors: true,
    admits: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "Bo signs his case and an edit of it, then a third version naming the two out of order and one of them twice, which is the shape. Then, each under a header of its own, a note whose parents are a BLOB, one naming a seq past 2^53 - 1, and one naming a seq with a leading zero: none is the shape. Merging B into A takes the three versions, of which the third is the only head, and refuses the other three headers as ROW_MALFORMED in Bo's name. A holds Ada's note and her own later version of it, pending, naming 257 ids, the note's among them: not the shape, so on A it names nothing, and both are heads; merging A into B refuses it as ROW_MALFORMED under no id.",
    fill: async (a, b) => {
      const bo = hexOf(BO.author);
      const one = createEntity(b, "cases", E1, { title: "one", status: "open", weight: null });
      const two = changeEntity(b, "cases", E1, { title: "two", status: "open", weight: null });
      await sealAll(b, BO);
      raw(b, "cases", E1, { title: "three", status: "open", weight: null }, null, JSON.stringify([`${bo}:${two._r_seq}`, `${bo}:${one._r_seq}`, `${bo}:${two._r_seq}`]));
      await sealAll(b, BO);
      const shapes = [
        ["a BLOB", new TextEncoder().encode(JSON.stringify([`${bo}:${one._r_seq}`]))],
        // Ada's id, not Bo's own: an id of his own at a seq above his row's is malformed for that alone (R19).
        ["past 2^53 - 1", JSON.stringify([`${hexOf(ADA.author)}:9007199254740992`])],
        ["a leading zero", JSON.stringify([`${bo}:0${one._r_seq}`])],
      ];
      for (const [i, [body, parents]] of shapes.entries()) {
        raw(b, "notes", id(0x41 + i), { body }, null, parents);
        await sealAll(b, BO);
      }
      const note = createEntity(a, "notes", id(0x31), { body: "Ada's note" });
      await sealAll(a, ADA);
      const named = [`${hexOf(ADA.author)}:${note._r_seq}`, ...Array.from({ length: 256 }, (_, i) => `${"ab".repeat(16)}:${i + 1}`)];
      raw(a, "notes", id(0x31), { body: "Ada's edit, naming 257" }, null, JSON.stringify(named));
    },
    expect: ({ ab, ba }) => {
      const refused = ab.result.refusedBatches.map((r) => `${r.author === b64Of(BO.author) ? "Bo" : r.author} ${r.reason}`);
      if (refused.join() !== "Bo ROW_MALFORMED,Bo ROW_MALFORMED,Bo ROW_MALFORMED") return `B into A: refused [${refused.join(", ")}], not Bo's three headers as ROW_MALFORMED`;
      if (sectionOf(ab.admitted, "cases").join() !== `${hexOf(BO.author)}:3\t0`) return `B into A: case heads are [${sectionOf(ab.admitted, "cases").join(" | ")}], not the third version`;
      if (sectionOf(ab.admitted, "notes").length !== 2) return `B into A: note heads are [${sectionOf(ab.admitted, "notes").join(" | ")}], not Ada's note and her edit`;
      const back = ba.result.refusedBatches.map((r) => `${r.author === b64Of(ADA.author) ? "Ada" : r.author} ${r.reason}`);
      if (back.join() !== "Ada ROW_MALFORMED") return `A into B: refused [${back.join(", ")}], not Ada's edit as ROW_MALFORMED`;
    },
  },
  {
    name: "merge-row-refusals",
    authors: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "B holds, beside Bo's signed case (header H0): a note of Bo's that is not the shape, signed alone under Hm, whose _r_batch names H0; a header Hi of Bo's over a note that is not the shape and a note B no longer holds, so Hi is authentic and not complete; and a case of Bo's naming a header nobody holds. Merging B into A refuses Hm as ROW_MALFORMED and does not report its note again under H0; keeps Hi, which is not complete, and reports its note ROW_MALFORMED under Hi, the batch it names; and reports the last case BATCH_DIGEST_MISMATCH under the id it names, since the sibling held no header there to refuse.",
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "Ada's", status: "open", weight: null });
      await sealAll(a, ADA);
      createEntity(b, "cases", E2, { title: "Bo's", status: "open", weight: null });
      await sealAll(b, BO);
      const [h0] = b.all("SELECT id FROM _dai_batch").map((r) => r.id);
      const m = raw(b, "notes", id(0x42), { body: "not the shape, signed alone" }, null, '["zz"]');
      await sealAll(b, BO);
      withoutTriggers(b, ["notes__sealed_once"], () => b.run("UPDATE notes SET _r_batch = ? WHERE _r_replica = ? AND _r_seq = ?", [h0, BO.author, m._r_seq]));
      raw(b, "notes", id(0x43), { body: "not the shape, in an incomplete batch" }, null, '["zz"]');
      const gone = raw(b, "notes", id(0x44), { body: "not held" }, null, "[]");
      await sealAll(b, BO);
      withoutTriggers(b, ["notes__no_delete"], () => b.run("DELETE FROM notes WHERE _r_replica = ? AND _r_seq = ?", [BO.author, gone._r_seq]));
      const x = raw(b, "cases", id(0x45), { title: "names a header nobody holds", status: "open", weight: null }, null, "[]");
      withoutTriggers(b, ["cases__batch_known_update"], () => b.run("UPDATE cases SET _r_batch = ? WHERE _r_replica = ? AND _r_seq = ?", [id(0x5a), BO.author, x._r_seq]));
    },
    expect: ({ ab }) => {
      const refused = ab.result.refusedBatches.map((r) => `${r.author === b64Of(BO.author) ? "Bo" : r.author} ${r.reason}`).sort();
      if (refused.join() !== "Bo BATCH_DIGEST_MISMATCH,Bo ROW_MALFORMED,Bo ROW_MALFORMED") return `B into A: refused [${refused.join(", ")}], not Hm's and Hi's ROW_MALFORMED and a BATCH_DIGEST_MISMATCH`;
      if (ab.result.applied !== 1) return `B into A: ${ab.result.applied} rows taken, not Bo's signed case alone`;
    },
  },
  {
    name: "merge-seal-outranks-named",
    authors: true,
    converges: false,
    cites: ["6", "T1-D13", "T1-D35"],
    what:
      "B holds Bo's note P and his signed edit V of it, and an unsigned note U under Ada's id and seq that also names P. A holds Ada's signed case at that seq and the same unsigned note U. Merging A into B places the signed case first: it outranks U in another table, U is removed and reported in rejected, and P stays superseded, since V still names it. Then A's copy of U, unsigned, collides with the signed case and is refused: nothing is counted a duplicate.",
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "signed", status: "open", weight: null });
      await sealAll(a, ADA);
      const p = createEntity(b, "notes", id(0x46), { body: "P" });
      changeEntity(b, "notes", id(0x46), { body: "V" });
      await sealAll(b, BO);
      const u = { _r_replica: ADA.author, _r_seq: 1, _r_lc: 9, _r_entity: id(0x46), _r_parents: JSON.stringify([`${hexOf(BO.author)}:${p._r_seq}`]), _r_deleted: 0, columns: { body: "U, unsigned" } };
      applyRow(b, "notes", u);
      applyRow(a, "notes", u);
    },
    expect: ({ ba }) => {
      if (ba.result.rejected.join() !== `${hexOf(ADA.author)}:1`) return `A into B: rejected [${ba.result.rejected.join(", ")}], not U`;
      if (ba.result.duplicate !== 0) return `A into B: ${ba.result.duplicate} duplicate, so the unsigned note was placed before the signed case`;
      const p = ba.dump.split("\n").find((line) => line.startsWith("P\t"));
      if (!p || p.split("\t")[7] !== "1") return `A into B: P is [${p}], not superseded`;
    },
  },
  {
    name: "merge-verify-refused",
    authors: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "B holds five headers under Ada's name, none of them authentic, each for one reason: a header whose signature does not verify, listing a row B does not hold (refused, not kept as incomplete: authenticity is checked first); a real header stored under an id its bytes do not hash to; a header signed at batch format version 3; a header whose only list names a table the document does not replicate; and a header whose stored list is not in the one spelling, whose row names no header. Merging B into A refuses each as BATCH_SIGNATURE_INVALID in Ada's name and takes none of their rows; the rows naming a refused header are not reported again, and the row naming none is BATCH_UNSIGNED.",
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "Ada's own", status: "open", weight: null });
      await sealAll(a, ADA);
      const src = open(join(out, "scratch-verify.db"));
      asReplica(src, ADA.author);
      src.run("UPDATE _dai_replica SET seq = 10, lc = 10");
      const dummy = async () => ({ sig: new Uint8Array(64), pub: ADA.pub });
      /** One case of Ada's at the next seq, sealed on the scratch copy by `sign`, and the batch it made. */
      const sealOne = async (title, sign) => {
        createEntity(src, "cases", id(0x60 + Number(src.all("SELECT seq FROM _dai_replica")[0].seq)), { title, status: "open", weight: null });
        const [batch] = pendingBatches(src, ADA.author, TABLES);
        const sealed = await signBatch(batch, { document: DOC, sign });
        recordSeal(src, sealed);
        return sealed;
      };
      /** A header into B by hand, with the covers text and fields given, and its rows naming `named`. */
      const hold = (sealed, fields, named, rows = sealed.entries) => {
        const h = { id: sealed.id, author: sealed.replica, lc: sealed.lc, sig: sealed.sig, pub: sealed.pub, att: null, version: sealed.version, digest: sealed.digest, covers: coversText(sealed.entries), ...fields };
        b.run("INSERT INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [h.id, h.author, h.lc, h.sig, h.pub, h.att, h.version, h.digest, h.covers]);
        for (const { table, row } of rows) {
          const stored = src.all(`SELECT * FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [ADA.author, row._r_seq])[0];
          stored._r_batch = named;
          const names = Object.keys(stored);
          b.run(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => stored[n]));
        }
      };
      // Not authentic, and not complete: its signature is no signature, and B holds none of its rows.
      hold(await sealOne("forged", dummy), {}, null, []);
      // A real header, under an id it does not hash to; its row names that id.
      const real = await sealOne("under another id", keptSigner(ADA));
      const other = new Uint8Array(real.id);
      other[0] ^= 0xff;
      hold(real, { id: other }, other);
      // Batch format version 3, signed; its row names it.
      const three = await sealOne("version 3", dummy);
      const header3 = headerOf({ ...three, version: 3 });
      const id3 = new Uint8Array(createHash("sha256").update(header3).digest().subarray(0, 16));
      hold(three, { version: 3, id: id3, sig: (await keptSigner(ADA)(header3)).sig }, id3);
      // A list naming a table the document does not replicate (nor B hold).
      createEntity(src, "cases", id(0x7d), { title: "beside a ghost", status: "open", weight: null });
      const [ghostly] = pendingBatches(src, ADA.author, TABLES);
      const ghostRow = { _r_replica: ADA.author, _r_seq: ghostly.entries[0].row._r_seq + 1, _r_lc: ghostly.lc, _r_entity: id(0x7e), _r_parents: "[]", _r_deleted: 0, _r_session: null, columns: {} };
      src.run("UPDATE _dai_replica SET seq = ?", [ghostRow._r_seq]);
      const withGhost = await signBatch({ ...ghostly, entries: [...ghostly.entries, { table: "ghost", row: ghostRow }] }, { document: DOC, sign: keptSigner(ADA) });
      recordSeal(src, { ...withGhost, entries: ghostly.entries });
      hold({ ...withGhost, entries: withGhost.entries }, {}, withGhost.id, ghostly.entries);
      // Not the one spelling, and its row names no header.
      const spelled = await sealOne("spelled otherwise", keptSigner(ADA));
      hold(spelled, { covers: coversText(spelled.entries).replace(",", ", ") }, null);
      src.close();
      rmSync(join(out, "scratch-verify.db"));
    },
    expect: ({ ab }) => {
      const refused = ab.result.refusedBatches.map((r) => `${r.author === b64Of(ADA.author) ? "Ada" : r.author} ${r.reason}`);
      if (refused.join() !== "Ada BATCH_UNSIGNED,Ada BATCH_SIGNATURE_INVALID,Ada BATCH_SIGNATURE_INVALID,Ada BATCH_SIGNATURE_INVALID,Ada BATCH_SIGNATURE_INVALID,Ada BATCH_SIGNATURE_INVALID")
        return `B into A: refused [${refused.join(", ")}], not BATCH_UNSIGNED under no id and five headers BATCH_SIGNATURE_INVALID`;
      if (ab.result.applied !== 0) return `B into A: ${ab.result.applied} rows taken`;
    },
  },
  {
    name: "merge-relabeled-list",
    authors: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "B holds Ada's header H over her case and her note, with its stored list relabeled to the case alone, and both rows naming H; and a note of Bo's naming H. The stored list does not make the header; the list of Ada's rows naming H does, so H is authentic and complete, and Bo's note is not in that list, since only the header's author's rows are. Merging B into A takes both rows and keeps H under the list it signed, the case and the note, not the list B stored; Bo's note is BATCH_DIGEST_MISMATCH under H. lists.json carries the list that made H authentic.",
    fill: async (a, b) => {
      const src = open(join(out, "scratch-relabel.db"));
      asReplica(src, ADA.author);
      createEntity(src, "cases", E1, { title: "listed", status: "open", weight: null });
      createEntity(src, "notes", E2, { body: "listed too" });
      await sealAll(src, ADA);
      const [h] = headersListing(src, ADA.author, "cases", 1);
      carry(b, src, [h]);
      b.run("UPDATE _dai_batch SET covers = ? WHERE lower(hex(id)) = ?", ['[["cases",1]]', h]);
      src.close();
      rmSync(join(out, "scratch-relabel.db"));
      const bos = createEntity(b, "notes", id(0x57), { body: "Bo's, naming Ada's header" });
      b.run("UPDATE notes SET _r_batch = (SELECT id FROM _dai_batch WHERE lower(hex(id)) = ?) WHERE _r_replica = ? AND _r_seq = ?", [h, BO.author, bos._r_seq]);
    },
    expect: ({ ab }) => {
      const refused = ab.result.refusedBatches.map((r) => `${r.author === b64Of(BO.author) ? "Bo" : r.author} ${r.reason}`);
      if (refused.join() !== "Bo BATCH_DIGEST_MISMATCH") return `B into A: refused [${refused.join(", ")}], not Bo's note alone`;
      if (!ab.dump.includes('\t[["cases",1],["notes",2]]\n')) return "B into A: H is not kept under the list it signed";
    },
  },
  {
    name: "merge-canonical-order",
    cites: ["6", "T1-D7"],
    schema: `-- dai:replicated
CREATE TABLE Zones (
  name TEXT NOT NULL
);
-- dai:replicated
CREATE TABLE cards (
  Zeta TEXT,
  alpha TEXT,
  ａ TEXT,
  \u{10400} TEXT
);
`,
    what:
      "Ada writes a card, then a zone, and seals them together: seq 1 in cards and seq 2 in Zones. Canonical rows and covers are ordered by table in UTF-8 order, then seq, so the zone comes first ([[\"Zones\",2],[\"cards\",1]]), though its seq is higher; a card's columns are ordered by name in UTF-8 order: Zeta, alpha, U+FF41, U+10400. Locale order puts alpha first, and UTF-16 order puts U+10400 before U+FF41. The header's id hashes those bytes, so a reader or signer using any other order makes other ids.",
    fill: async (a, b) => {
      createEntity(a, "cards", E1, { Zeta: "Z", alpha: "a", "ａ": "fullwidth a", "\u{10400}": "Deseret" });
      createEntity(a, "Zones", E2, { name: "the first table" });
      await sealAll(a, ADA);
      const covers = a.all("SELECT covers FROM _dai_batch").map((r) => r.covers);
      if (covers.join() !== '[["Zones",2],["cards",1]]') throw new Error(`merge-canonical-order: A's header lists ${covers.join()}`);
      createEntity(b, "Zones", id(0x33), { name: "Bo's zone" });
    },
  },
  {
    name: "merge-equivocated-parent-plain",
    authors: true,
    admits: true,
    cites: ["6", "T1-D13"],
    what:
      "A plain document. Ada edits her note on A, and edits it again, naming the first edit; from a second copy of her store she signs a case at the first edit's seq, which B holds. The first edit's id is equivocated after either merge: it is no head and hides nothing. Admission is only a session author table's, so the second edit, which names it, counts like any other row and is a head; her note, which only the equivocated edit names, is a head again.",
    fill: async (a, b) => {
      createEntity(a, "notes", E1, { body: "first" });
      await exchange(b, a, ADA);
      const fork = await forkOf(a, ADA, SCHEMA);
      changeEntity(a, "notes", E1, { body: "edited" });
      changeEntity(a, "notes", E1, { body: "edited again" });
      await sealAll(a, ADA);
      createEntity(fork, "cases", E2, { title: "signed at the first edit's seq", status: "open", weight: null });
      await exchange(b, fork, ADA);
      fork.done();
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        const notes = sectionOf(run.admitted, "notes");
        if (notes.join() !== [`${hexOf(ADA.author)}:1\t0`, `${hexOf(ADA.author)}:3\t0`].join()) return `${direction}: note heads are [${notes.join(" | ")}], not the note and the second edit`;
      }
    },
  },

  /*
   * The step 6 re-review's fix-up (1 October): a fixture for each silence it
   * ruled on, and a witness for each MEDIUM. Each rule's hold-out is named in
   * scripts/holdout.py, and each vector asserts the ruled answer (`expect`).
   */
  {
    name: "merge-held-row-signed",
    authors: true,
    cites: ["6", "T1-D13"],
    what:
      "A, Ada's copy, holds her note at seq 1 with _r_batch unset (the save that wrote its pointer was lost) and her header H that lists it, complete on A. B holds, from a second copy of her store, her case at seq 1 under H2. A held row that a complete header the copy holds lists is signed, not pending: merging B into A sets the note's _r_batch to H, and the signed case does not replace it; both rows are kept in both directions, the id is equivocated, and each merge reports AUTHOR_EQUIVOCATED in Ada's name. The copies end the same.",
    fill: async (a, b) => {
      const fork = await forkOf(a, ADA, SCHEMA);
      createEntity(a, "notes", E1, { body: "Ada's note, its pointer lost" });
      await sealAll(a, ADA);
      withoutTriggers(a, ["notes__sealed_once"], () => a.run("UPDATE notes SET _r_batch = NULL WHERE _r_replica = ?", [ADA.author]));
      createEntity(fork, "cases", E2, { title: "Ada's case at the note's seq", status: "open", weight: null });
      await exchange(b, fork, ADA);
      fork.done();
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        const refused = run.result.refusedBatches.map((r) => `${r.author === b64Of(ADA.author) ? "Ada" : r.author} ${r.reason}`);
        if (refused.join() !== "Ada AUTHOR_EQUIVOCATED") return `${direction}: refused [${refused.join(", ")}], not Ada's AUTHOR_EQUIVOCATED alone`;
        if (run.result.rejected.length > 0) return `${direction}: rejected ${run.result.rejected.join(", ")}`;
      }
      const note = ab.dump.split("\n").find((line) => line.startsWith("Ada's note"));
      if (!note || note.split("\t").includes("nil")) return `B into A: the note is [${note}], its _r_batch not set to H`;
    },
  },
  {
    name: "merge-held-header-relabeled",
    authors: true,
    cites: ["6", "T1-D13"],
    what:
      "A holds Ada's header H over her case and her note with its stored list relabeled to the case alone, and both rows naming H; B holds H under the list she signed. A header the copy already holds under another list is rewritten to the list it signed when a merge keeps it: merging B into A stores H's covers as the case and the note. Merging A into B keeps B's as it was, so the copies end the same.",
    fill: async (a, b) => {
      const path = join(out, "scratch-held-relabel.db");
      const src = open(path);
      asReplica(src, ADA.author);
      createEntity(src, "cases", E1, { title: "listed", status: "open", weight: null });
      createEntity(src, "notes", E2, { body: "listed too" });
      await sealAll(src, ADA);
      const [h] = headersListing(src, ADA.author, "cases", 1);
      carry(a, src, [h]);
      carry(b, src, [h]);
      a.run("UPDATE _dai_replica SET seq = 2, lc = 2");
      a.run("UPDATE _dai_batch SET covers = ? WHERE lower(hex(id)) = ?", ['[["cases",1]]', h]);
      src.close();
      rmSync(path);
      createEntity(b, "cases", id(0x33), { title: "Bo's", status: "open", weight: null });
      await sealAll(b, BO);
    },
    expect: ({ ab }) => {
      if (!ab.dump.includes('\t[["cases",1],["notes",2]]\n')) return "B into A: A's H is not rewritten to the list it signed";
    },
  },
  {
    name: "session-equivocated-own-seat-parent",
    session: true,
    cites: ["6", "T1-D13"],
    what:
      "Bo moves for his own seat on B and then writes the move's next version, naming it, for the same seat; from a second copy of his store he signs a close at the first move's seq, which A holds. The first move's id is equivocated after either merge. Its next version names an equivocated id as a parent, though the row that id holds here is its own seat's earlier version in its own session: it is not admitted, not a head and not reported, in both directions. A reader admitting a row whose equivocated parent would otherwise be a version it may replace shows the second move. Bo is the joiner, so the session stands (R10).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const fork = await forkOf(b, BO);
      const first = createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      const next = changeEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5, again" }, session);
      // The teeth: the next version names the first, its own seat's, alone.
      if (next._r_parents !== JSON.stringify([`${hexOf(BO.author)}:${first._r_seq}`])) throw new Error(`session-equivocated-own-seat-parent: the next version names ${next._r_parents}`);
      await sealAll(b, BO);
      createEntity(fork, "_dai_close", id(0x91), {}, session);
      await exchange(a, fork, BO);
      fork.done();
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        const refused = run.result.refusedBatches.map((r) => `${r.author === b64Of(BO.author) ? "Bo" : r.author} ${r.reason}`);
        if (refused.join() !== "Bo AUTHOR_EQUIVOCATED") return `${direction}: refused [${refused.join(", ")}], not Bo's AUTHOR_EQUIVOCATED alone`;
        const moves = sectionOf(run.admitted, "moves");
        if (moves.length > 0) return `${direction}: admitted moves are [${moves.join(" | ")}]`;
        if (sectionOf(run.admitted, "equivocated").length !== 2) return `${direction}: equivocated is [${sectionOf(run.admitted, "equivocated").join(" | ")}], not the first move's id in two tables`;
      }
    },
  },
  {
    name: "merge-row-batch-named-higher",
    authors: true,
    cites: ["6", "T1-D7"],
    what:
      "B holds Ada's note under two complete headers, the same rows sealed twice after a lost save, and the note names the one with the higher id. A row listed by a complete kept header keeps the header it names when that header is complete and kept: merging B into A gives the note the higher id, not the lowest complete header that lists it.",
    fill: async (a, b) => {
      createEntity(a, "cases", E1, { title: "Ada's", status: "open", weight: null });
      await sealAll(a, ADA);
      const path = join(out, "scratch-named-higher.db");
      const src = open(path);
      asReplica(src, ADA.author);
      src.run("UPDATE _dai_replica SET seq = 5, lc = 5");
      createEntity(src, "notes", id(0x35), { body: "sealed twice" });
      const [batch] = pendingBatches(src, ADA.author, TABLES);
      const first = await signBatch(batch, { document: DOC, sign: keptSigner(ADA) });
      const again = await signBatch({ ...batch, lc: batch.lc + 1 }, { document: DOC, sign: keptSigner(ADA) });
      const [low, high] = [first, again].sort((x, y) => (hexOf(x.id) < hexOf(y.id) ? -1 : 1));
      // The teeth: the header the row names sorts above another complete one listing it.
      if (!(hexOf(low.id) < hexOf(high.id))) throw new Error("merge-row-batch-named-higher: the two headers have one id");
      holdHeader(b, first);
      holdHeader(b, again);
      const row = src.all("SELECT * FROM notes")[0];
      row._r_batch = high.id;
      const names = Object.keys(row);
      b.run(`INSERT INTO notes (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => row[n]));
      b.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [ADA.author]);
      src.close();
      rmSync(path);
      namedHigher.id = hexOf(high.id);
    },
    expect: ({ ab }) => {
      const note = ab.dump.split("\n").find((line) => line.startsWith("sealed twice\t"));
      if (!note || note.split("\t").at(-1) !== namedHigher.id) return `B into A: the note is [${note}], not under the header it names, ${namedHigher.id}`;
    },
  },
  {
    name: "session-roster-names-equivocated",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Bo asks for the open seat (B holds his binding's header) and from a second copy of his store signs a move at his binding's seq (A holds that header and not the binding). Ada confirms Bo in the open seat with a confirm naming his binding's id, and writes a close of the session naming the same. After either merge that id is equivocated and Bo is an equivocator, so his binding counts for nothing; the rows naming it, in the roster tables and the close, count like any other row. Ada's confirm counts and is a head, though the seat it confirms is void since its holder is an equivocator (R17), and her close closes the session and is a head, in both directions (R10: an equivocator's own roster rows count for nothing, not those naming them).",
    fill: async (a, b) => {
      const session = begin(a, { seat: SEAT_W, seats: [SEAT_OPEN], entity: id(0x51) });
      await exchange(b, a, ADA);
      const fork = await forkOf(b, BO);
      const binding = createEntity(b, "_dai_binding", id(0x61), { seat: SEAT_OPEN }, session);
      await sealAll(b, BO);
      const move = createEntity(fork, "moves", id(0x84), { seat: SEAT_OPEN, san: "d5" }, session);
      if (move._r_seq !== binding._r_seq) throw new Error(`session-roster-names-equivocated: the fork's move is at ${move._r_seq}, not the binding's ${binding._r_seq}`);
      await sealAll(fork, BO);
      carry(a, fork, headersListing(fork, BO.author, "moves", move._r_seq));
      fork.done();
      const named = JSON.stringify([`${hexOf(BO.author)}:${binding._r_seq}`]);
      raw(a, "_dai_confirm", id(0x71), { seat: SEAT_OPEN, holder: BO.author }, session, named);
      raw(a, "_dai_close", id(0x92), {}, session, named);
      await sealAll(a, ADA);
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        const refused = run.result.refusedBatches.map((r) => `${r.author === b64Of(BO.author) ? "Bo" : r.author} ${r.reason}`);
        if (refused.join() !== "Bo AUTHOR_EQUIVOCATED") return `${direction}: refused [${refused.join(", ")}], not Bo's AUTHOR_EQUIVOCATED alone`;
        if (!sectionOf(run.admitted, "voided").some((line) => line.split(String.fromCharCode(9))[1] === hexOf(SEAT_OPEN))) return `${direction}: the open seat of the equivocator Bo is not void`;
        if (sectionOf(run.admitted, "closed").length !== 1) return `${direction}: closed is [${sectionOf(run.admitted, "closed").join(" | ")}]`;
        if (!sectionOf(run.admitted, "_dai_confirm").some((line) => line.startsWith(hexOf(ADA.author)))) return `${direction}: Ada's confirm is not a head`;
        if (!sectionOf(run.admitted, "_dai_close").some((line) => line.startsWith(hexOf(ADA.author)))) return `${direction}: Ada's close is not a head`;
        if (sectionOf(run.admitted, "_dai_binding").length > 0) return `${direction}: Bo's binding is a head`;
      }
    },
  },
  {
    name: "session-parent-in-another-table",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Bo, holding the open seat, writes two moves for it: one of entity 0x51, the entity of Ada's creator's seat row, naming that _dai_seat row (its seat column Ada's seat) as its parent; one of entity 0x61, his binding's entity, naming his binding. Parents name rows by (author, seq), and a version of a row is a row of its own table and entity, so neither named row is a version of a move: neither move crosses a seat or hides anything. Both are admitted, nothing is reported, and the seat row and the binding are still heads.",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const seatRow = a.all("SELECT _r_seq AS s FROM _dai_seat WHERE _r_replica = ? AND seat = ?", [ADA.author, SEAT_W])[0].s;
      const binding = b.all("SELECT _r_seq AS s FROM _dai_binding WHERE _r_replica = ?", [BO.author])[0].s;
      raw(b, "moves", id(0x51), { seat: SEAT_OPEN, san: "e5" }, session, JSON.stringify([`${hexOf(ADA.author)}:${seatRow}`]));
      raw(b, "moves", id(0x61), { seat: SEAT_OPEN, san: "Nc6" }, session, JSON.stringify([`${hexOf(BO.author)}:${binding}`]));
      await sealAll(b, BO);
    },
    expect: ({ ab, ba }) => {
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        if (run.result.refusedBatches.length > 0) return `${direction}: reported ${run.result.refusedBatches.map((r) => r.reason).join(", ")}`;
        const moves = sectionOf(run.admitted, "moves");
        if (moves.length !== 2 || moves.some((line) => !line.startsWith(hexOf(BO.author)))) return `${direction}: admitted moves are [${moves.join(" | ")}], not Bo's two`;
        if (sectionOf(run.admitted, "_dai_binding").length !== 1) return `${direction}: Bo's binding is not a head`;
        if (!sectionOf(run.admitted, "_dai_seat").includes(`${hexOf(ADA.author)}:1\t0`)) return `${direction}: Ada's creator's seat row is not a head`;
      }
    },
  },

  /*
   * The eighth attack review (2 October) and its rulings, R10 and R11. Each
   * asserts the ruled answer (`expect`), and those of A1, A2, A3 and A8 were
   * red against the runtime before the rulings were built.
   */
  {
    name: "session-creator-equivocates-reconfirm",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Ada confirmed Bo in the open seat (C1) and Bo moved. From a second copy of her store she signs a move at C1's seq, then confirms herself in the open seat and moves for it. Ada is an equivocator in the document, and a session whose creator is an equivocator is void: no row in it is admitted, nobody holds a seat, and only AUTHOR_EQUIVOCATED is reported, by the merge that reveals it (R10). Before the ruling, C1 counted for nothing and her own confirm seated her in Bo's seat (review 8, A1).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const c1 = a.all("SELECT _r_seq AS s FROM _dai_confirm WHERE _r_replica = ?", [ADA.author])[0].s;
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      const fork = await forkOf(a, ADA);
      rawAt(fork, c1, "moves", id(0x8e), { seat: SEAT_W, san: "Qxf7" }, session);
      confirmSeat(a, session, SEAT_OPEN, ADA.author, id(0x72));
      createEntity(a, "moves", id(0x83), { seat: SEAT_OPEN, san: "c5" }, session);
      await exchange(a, fork, ADA);
      fork.done();
    },
    expect: ({ ab, ba }) => voidAnswer({ ab, ba }, { ab: [], ba: ["Ada AUTHOR_EQUIVOCATED"] }),
  },
  {
    name: "session-creator-equivocates-void-undone",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Ada confirmed Bo and then Cy in the open seat, so the seat is void (D165), and Cy moved; B is Bo's copy holding all of that. A, Ada's copy, also holds a close she signed at the first confirm's seq from a second copy of her store. The session is void on both copies after either merge and stays void: Cy holds nothing, his move and Bo's are admitted nowhere, and only AUTHOR_EQUIVOCATED is reported (R10: void is monotone). Before the ruling, the first confirm stopped counting and the seat's void lifted onto Cy (review 8, A2).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const c1 = a.all("SELECT _r_seq AS s FROM _dai_confirm WHERE _r_replica = ?", [ADA.author])[0].s;
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      const fork = await forkOf(a, ADA);
      confirmSeat(a, session, SEAT_OPEN, CY.author, id(0x73));
      await exchange(b, a, ADA);
      const cy = copyFor(CY);
      await exchange(cy, a, ADA);
      createEntity(cy, "moves", id(0x89), { seat: SEAT_OPEN, san: "Nc6" }, session);
      await exchange(b, cy, CY);
      await exchange(a, cy, CY);
      cy.done();
      rawAt(fork, c1, "_dai_close", id(0x93), {}, session);
      await exchange(a, fork, ADA);
      fork.done();
    },
    expect: ({ ab, ba }) => voidAnswer({ ab, ba }, { ab: [], ba: ["Ada AUTHOR_EQUIVOCATED"] }),
  },
  {
    name: "session-creator-equivocates-header-only",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "As session-creator-equivocates-reconfirm, with no equivocating row anywhere but the fork: A holds Ada's header over a move at her first confirm's seq and not its row (authentic, not complete, kept), her confirm of herself in the open seat and her move for it. The session is void after either merge (R10), and Bo's honest move, arriving at A, is reported nowhere: before the ruling it was reported SEAT_NOT_HELD in Bo's own name (review 8, A3).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const c1 = a.all("SELECT _r_seq AS s FROM _dai_confirm WHERE _r_replica = ?", [ADA.author])[0].s;
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      const fork = await forkOf(a, ADA);
      rawAt(fork, c1, "moves", id(0x8e), { seat: SEAT_W, san: "Qxf7" }, session);
      await sealAll(fork, ADA);
      const [hx] = headersListing(fork, ADA.author, "moves", c1);
      confirmSeat(a, session, SEAT_OPEN, ADA.author, id(0x72));
      createEntity(a, "moves", id(0x83), { seat: SEAT_OPEN, san: "c5" }, session);
      await sealAll(a, ADA);
      carryHeaderOnly(a, fork, hx);
      fork.done();
      if (a.all("SELECT 1 FROM moves WHERE _r_replica = ? AND _r_seq = ?", [ADA.author, c1]).length > 0) throw new Error("session-creator-equivocates-header-only: A holds the fork's row");
    },
    expect: ({ ab, ba }) => voidAnswer({ ab, ba }, { ab: [], ba: ["Ada AUTHOR_EQUIVOCATED"] }),
  },
  {
    name: "session-seat-beyond-max-parties",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "A session declared max_parties=2, Bo seated in its open seat. Ada writes a second seat row naming a third seat, confirms Cy in it, and Cy moves for it (A). The roster is declared by the creator's seat row alone, and a confirm counts only for a value it lists: nobody holds the third seat, Cy's move is admitted nowhere and the merge into B, which takes it, reports it SEAT_NOT_HELD; Bo's hold stands (R14, A03). Before R11, Cy held the third seat and three parties played (review 8, A8).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      createEntity(a, "_dai_seat", id(0x53), { seat: SEAT_THIRD }, session);
      confirmSeat(a, session, SEAT_THIRD, CY.author, id(0x74));
      const cy = copyFor(CY);
      await exchange(cy, a, ADA);
      createEntity(cy, "moves", id(0x89), { seat: SEAT_THIRD, san: "Nc6" }, session);
      await exchange(a, cy, CY);
      cy.done();
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author], [SEAT_OPEN, BO.author]],
        voided: [],
        moves: () => [],
        ab: { reports: [] },
        ba: { reports: ["Cy SEAT_NOT_HELD"] },
      }),
  },
  {
    name: "session-roster-row-below-creator",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Ada skips two seqs before her creator's seat row, so the session id is hers to compute before the row exists. Bo is confirmed in the open seat and moves (B). Then she signs, at the two skipped seqs below her creator's seat row, a seat row in the session naming a third seat and a confirm of Cy in the open seat (A). No rule of the roster reads a seq (R14): the seat row counts for nothing, as every seat row but the creator's does, and the confirm is a confirm like any other, so the open seat's confirms name two holders and it is void (D165): nobody holds it, Bo's move is not admitted, and the merge into B, which takes the confirm, reports Ada AUTHOR_EQUIVOCATED. Under R13 the rows below counted for nothing; under R11 alone the third seat came first and the open seat fell past max_parties=2, so Bo's hold went to nobody with nothing reported (the R10 and R11 handoff's finding).",
    fill: async (a, b) => {
      a.run("UPDATE _dai_replica SET seq = seq + 2");
      const creatorSeq = a.all("SELECT seq FROM _dai_replica")[0].seq + 1;
      const session = begin(a, { seat: SEAT_W, seats: [SEAT_OPEN], entity: id(0x51) });
      await exchange(b, a, ADA);
      createEntity(b, "_dai_binding", id(0x61), { seat: SEAT_OPEN }, session);
      await exchange(a, b, BO);
      confirmSeat(a, session, SEAT_OPEN, BO.author, id(0x71));
      await exchange(b, a, ADA);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      await exchange(a, b, BO);
      rawAt(a, creatorSeq - 2, "_dai_seat", id(0x54), { seat: SEAT_THIRD }, session);
      rawAt(a, creatorSeq - 1, "_dai_confirm", id(0x74), { seat: SEAT_OPEN, holder: CY.author }, session);
      await sealAll(a, ADA);
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author]],
        voided: [SEAT_OPEN],
        moves: () => [],
        ab: { reports: [] },
        ba: { reports: ["Ada AUTHOR_EQUIVOCATED"] },
      }),
  },
  {
    name: "session-equivocated-parent-unseated",
    session: true,
    schema: SESSION_NOTES_SCHEMA,
    cites: ["6", "T1-D29"],
    what:
      "An unseated session author table: a row is admitted when its author is a member. Bo writes a note, Ada, a member, an edit of it naming it, and both are admitted; Bo closes the session; then from a second copy of his store Bo signs a move at the note's seq. After either merge the note's id is equivocated: the note counts for nothing and Ada's edit names an equivocated id, so neither is admitted, and the note is gone (admitted-parent-equivocated). Bo is an equivocator, so his close counts for nothing and the session is not closed, and he holds no seat: the open seat is void (R10, R17; review 8, A5).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const note = createEntity(b, "notes", id(0x31), { body: "Bo: we play on Sunday" }, session);
      await exchange(a, b, BO);
      changeEntity(a, "notes", id(0x31), { body: "Ada: Saturday, not Sunday" }, session);
      await exchange(b, a, ADA);
      createEntity(b, "_dai_close", id(0x92), {}, session);
      await sealAll(b, BO);
      const fork = await forkOf(b, BO, SESSION_NOTES_SCHEMA);
      rawAt(fork, note._r_seq, "moves", id(0x8e), { seat: SEAT_OPEN, san: "a6" }, session);
      await exchange(b, fork, BO);
      fork.done();
    },
    expect: ({ ab, ba }) => {
      const refused = ab.result.refusedBatches.map((r) => `${r.author === b64Of(BO.author) ? "Bo" : r.author} ${r.reason}`);
      if (refused.join() !== "Bo AUTHOR_EQUIVOCATED") return `B into A: refused [${refused.join(", ")}], not Bo's AUTHOR_EQUIVOCATED alone`;
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        if (sectionOf(run.admitted, "notes").length > 0) return `${direction}: note heads are [${sectionOf(run.admitted, "notes").join(" | ")}]`;
        if (sectionOf(run.admitted, "closed").length > 0) return `${direction}: an equivocator's close closed the session`;
      }
      return ruled({ ab, ba }, { holders: [[SEAT_W, ADA.author]], voided: [SEAT_OPEN] });
    },
  },
  ...["one-batch", "two-batch"].flatMap((order) =>
    ["first", "last"].map((holdAt) => ({
      name: `session-seal-hold-${order}-${holdAt}`,
      session: true,
      cites: ["6", "T1-D29"],
      what: `A ${order} seal by Ada with its ${holdAt} signature held (D178): while it is out, she writes a move in the session being sealed${order === "two-batch" ? ", a binding in her second session," : ""} and merges Bo's next move. The write stays pending and the next leave seals it alone: no seq of hers is listed by two of her headers, no row names a header that does not list it, no id is equivocated, Bo's hold stands and nothing is reported (review 8, A10; for the record).`,
      fill: async (a, b) => {
        const session = await seated(a, b);
        createEntity(a, "moves", id(0x86), { seat: SEAT_W, san: "Nf3" }, session);
        const s2 = order === "two-batch" ? begin(a, { seat: id(0xa3), seats: [id(0xb3)], entity: id(0x5c) }) : null;
        createEntity(b, "moves", id(0x87), { seat: SEAT_OPEN, san: "Nc6" }, session);
        await sealAll(b, BO);
        const batches = await sealHolding(a, ADA, holdAt, async () => {
          createEntity(a, "moves", id(0x88), { seat: SEAT_W, san: "Bc4" }, session);
          if (s2) createEntity(a, "_dai_binding", id(0x6c), { seat: id(0xb4) }, s2);
          await exchange(a, b, BO);
        });
        if (batches !== (s2 ? 2 : 1)) throw new Error(`session-seal-hold-${order}-${holdAt}: ${batches} batches, not ${s2 ? 2 : 1}`);
        if (pendingBatches(a, ADA.author, a.tables).length === 0) throw new Error(`session-seal-hold-${order}-${holdAt}: nothing written during the hold is pending`);
        await sealAll(a, ADA);
        const listed = new Map();
        for (const h of a.all("SELECT lower(hex(id)) AS id, covers FROM _dai_batch WHERE author = ?", [ADA.author])) {
          for (const [table, seq] of JSON.parse(h.covers)) listed.set(seq, [...(listed.get(seq) ?? []), `${h.id}:${table}`]);
        }
        for (const [seq, by] of listed) if (by.length > 1) throw new Error(`session-seal-hold-${order}-${holdAt}: seq ${seq} listed by ${by.join(", ")}`);
        for (const table of a.tables) {
          for (const r of a.all(`SELECT _r_seq AS s, lower(hex(_r_batch)) AS b FROM "${table}" WHERE _r_replica = ?`, [ADA.author])) {
            if (!(listed.get(r.s) ?? []).includes(`${r.b}:${table}`)) throw new Error(`session-seal-hold-${order}-${holdAt}: ${table}:${r.s} names ${r.b}, which does not list it`);
          }
        }
      },
      expect: ({ ab, ba }) => {
        for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
          if (run.result.refusedBatches.length > 0) return `${direction}: reported ${run.result.refusedBatches.map((r) => r.reason).join(", ")}`;
          if (sectionOf(run.admitted, "equivocated").length > 0) return `${direction}: equivocated is [${sectionOf(run.admitted, "equivocated").join(" | ")}]`;
          if (!sectionOf(run.admitted, "holders").some((line) => line.endsWith(`\t${hexOf(SEAT_OPEN)}\t${hexOf(BO.author)}`))) return `${direction}: Bo does not hold the open seat`;
        }
      },
    })),
  ),

  /*
   * The ninth attack review (3 October) and its rulings, R14 to R20 and the
   * two reader rulings. Each asserts the ruled answer (`expect`); each was run
   * against the runtime before the rulings were built, and the handoff says
   * which were red there.
   */
  {
    name: "session-gap-seat-row",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Ada's creator's seat row declares her seat and one open seat, and she leaves the seq after it unused. Bo is confirmed in the open seat and moves (B). Then she signs, at the unused seq, a seat row in the session naming a third value, confirms Cy in it, and Cy moves for it (A). The roster is declared: no _dai_seat row but the creator's counts for anything, and a confirm counts only for a value her creator's seat row lists. Bo holds the open seat, his move is admitted, Cy holds nothing, and the merge that takes Cy's move reports it SEAT_NOT_HELD (R14, A03). Minted by seq order, the row at the unused seq came second and the open seat's row fell past max_parties=2: Bo's hold went to nobody and Cy took the second seat, with nothing reported (review 9, A01).",
    fill: async (a, b) => {
      const session = await seated(a, b, { gap: 1 });
      const c = Number(a.all("SELECT min(_r_seq) AS s FROM _dai_seat WHERE _r_replica = ?", [ADA.author])[0].s);
      const e5 = createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      await exchange(a, b, BO);
      rawAt(a, c + 1, "_dai_seat", id(0x53), { seat: SEAT_THIRD }, session);
      confirmSeat(a, session, SEAT_THIRD, CY.author, id(0x74));
      const cy = copyFor(CY);
      await exchange(cy, a, ADA);
      createEntity(cy, "moves", id(0x89), { seat: SEAT_THIRD, san: "Nc6" }, session);
      await exchange(a, cy, CY);
      cy.done();
      marks["session-gap-seat-row"] = [idOf(e5)];
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author], [SEAT_OPEN, BO.author]],
        voided: [],
        moves: () => marks["session-gap-seat-row"],
        ab: { reports: [] },
        ba: { reports: ["Cy SEAT_NOT_HELD"] },
      }),
  },
  {
    name: "session-gap-creator-row-version",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "The same unused seq after Ada's creator's seat row, Bo confirmed in the open seat and moved (B). At the unused seq she signs a version of her creator's seat row naming the open seat's value; then a seat row naming a fresh value, a confirm of Cy in it, and Cy's move for it (A). The creator's seat row is immutable and its later versions count for nothing, and no other seat row counts: Bo holds the open seat, his move is admitted, Cy holds nothing and his move is reported SEAT_NOT_HELD by the merge that takes it (R14). Before, the value became the creator's seat row's, since its version named it first in her seq order, Bo's confirm counted for nothing and the reseat seated Cy (review 9, A02).",
    fill: async (a, b) => {
      const session = await seated(a, b, { gap: 1 });
      const row = a.all("SELECT * FROM _dai_seat WHERE _r_replica = ? ORDER BY _r_seq LIMIT 1", [ADA.author])[0];
      const e5 = createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      await exchange(a, b, BO);
      rawAt(a, row._r_seq + 1, "_dai_seat", row._r_entity, { ...columnsOf(row), seat: SEAT_OPEN }, session, JSON.stringify([idOf(row)]));
      createEntity(a, "_dai_seat", id(0x52), { seat: SEAT_FRESH }, session);
      confirmSeat(a, session, SEAT_FRESH, CY.author, id(0x74));
      const cy = copyFor(CY);
      await exchange(cy, a, ADA);
      createEntity(cy, "moves", id(0x89), { seat: SEAT_FRESH, san: "Nc6" }, session);
      await exchange(a, cy, CY);
      cy.done();
      marks["session-gap-creator-row-version"] = [idOf(e5)];
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author], [SEAT_OPEN, BO.author]],
        voided: [],
        moves: () => marks["session-gap-creator-row-version"],
        ab: { reports: [] },
        ba: { reports: ["Cy SEAT_NOT_HELD"] },
      }),
  },
  {
    name: "session-seat-value-unasked",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Bo never asks for the open seat, and writes a move for it. A row naming a value no counting confirm names, by an author not waiting in it, is SEAT_NOT_HELD: the merge that takes it reports it in Bo's name, and it is not admitted (A03). Before, a row for a seat nobody held was reported nowhere.",
    fill: async (a, b) => {
      const session = begin(a);
      await exchange(b, a, ADA);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author]],
        moves: () => [],
        ab: { reports: ["Bo SEAT_NOT_HELD"] },
        ba: { reports: [] },
      }),
  },
  {
    name: "session-seat-value-other-row",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Bo holds the open seat. Ada writes a second seat row in the session naming a third value; Cy asks for that value and moves for it (B). Only the creator's seat row declares seats, so the value is no seat: Cy is not waiting in it, his move is not admitted, and the merge that takes it reports it SEAT_NOT_HELD (R14, A03). Before, a value past max_parties was unminted and a row for it was reported nowhere.",
    fill: async (a, b) => {
      const session = await seated(a, b);
      createEntity(a, "_dai_seat", id(0x53), { seat: SEAT_THIRD }, session);
      const cy = copyFor(CY);
      await exchange(cy, a, ADA);
      createEntity(cy, "_dai_binding", id(0x63), { seat: SEAT_THIRD }, session);
      createEntity(cy, "moves", id(0x89), { seat: SEAT_THIRD, san: "Nc6" }, session);
      await exchange(b, cy, CY);
      cy.done();
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author], [SEAT_OPEN, BO.author]],
        moves: () => [],
        ab: { reports: ["Cy SEAT_NOT_HELD"] },
        ba: { reports: [] },
      }),
  },
  {
    name: "session-seat-value-creator-version",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "Bo holds the open seat. Ada writes a later version of her creator's seat row naming a fresh value, and Bo writes a move for that value (B). The creator's seat row is immutable, so the value is no seat: Bo's move for it is not admitted, and the merge that takes it reports it SEAT_NOT_HELD (R14, A03). Before, it was reported nowhere (review 9, A03).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const row = a.all("SELECT * FROM _dai_seat WHERE _r_replica = ? ORDER BY _r_seq LIMIT 1", [ADA.author])[0];
      raw(a, "_dai_seat", row._r_entity, { ...columnsOf(row), seat: SEAT_FRESH }, session, JSON.stringify([idOf(row)]));
      await exchange(b, a, ADA);
      createEntity(b, "moves", id(0x82), { seat: SEAT_FRESH, san: "Qh5" }, session);
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author], [SEAT_OPEN, BO.author]],
        moves: () => [],
        ab: { reports: ["Bo SEAT_NOT_HELD"] },
        ba: { reports: [] },
      }),
  },
  {
    name: "session-three-parties",
    session: true,
    schema: SESSION_SCHEMA_3,
    cites: ["6", "T1-D29"],
    what:
      "A document declared max_parties=3. Ada's creator's seat row lists two open seats; she confirms Bo in one and Cy in the other, and both move (Bo's move on B only, Cy's on A only). Three parties hold seats and both moves are admitted, and nothing is reported (R14). A reader must take max_parties from the manifest (manifest.json): one that assumes 2 finds the creator's seat row lists too many seats and the session void (review 9, A04).",
    fill: async (a, b) => {
      const session = await seated(a, b, { seats: [SEAT_OPEN, SEAT_THIRD] });
      const e5 = createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      const cy = copyFor(CY, SESSION_SCHEMA_3);
      await exchange(cy, a, ADA);
      createEntity(cy, "_dai_binding", id(0x63), { seat: SEAT_THIRD }, session);
      await exchange(a, cy, CY);
      confirmSeat(a, session, SEAT_THIRD, CY.author, id(0x74));
      await exchange(cy, a, ADA);
      const nc6 = createEntity(cy, "moves", id(0x89), { seat: SEAT_THIRD, san: "Nc6" }, session);
      await exchange(a, cy, CY);
      cy.done();
      marks["session-three-parties"] = [idOf(e5), idOf(nc6)];
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author], [SEAT_OPEN, BO.author], [SEAT_THIRD, CY.author]],
        voided: [],
        moves: () => marks["session-three-parties"],
        reports: [],
      }),
  },
  {
    name: "merge-signed-view-mismatch",
    session: true,
    schemas: { a: SESSION_SCHEMA, b: SESSION_SCHEMA_3 },
    converges: false,
    cites: ["6", "T1-D14"],
    what:
      "One document's rows on two copies built from two manifests: A under max_parties=2, B under max_parties=3 (manifest.json gives each copy's signed-view digest). Ada and Bo are seated on both; Ada's move is on A only and Bo's on B only. A merge refuses, whole, a sibling whose signed-view digest differs from its own (SIGNED_VIEW_MISMATCH): nothing is taken in either direction (R16). Before, the merge took everything and the two copies could seat differently for the same rows (review 9, A04).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const e4 = createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      const e5 = createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      marks["merge-signed-view-mismatch"] = { ab: [idOf(e4)], ba: [idOf(e5)] };
    },
    expect: (runs) =>
      ruled(runs, {
        refused: "SIGNED_VIEW_MISMATCH",
        reports: [],
        holders: [[SEAT_W, ADA.author], [SEAT_OPEN, BO.author]],
        ab: { moves: () => marks["merge-signed-view-mismatch"].ab },
        ba: { moves: () => marks["merge-signed-view-mismatch"].ba },
      }),
  },
  {
    name: "session-joiner-equivocator-close",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "close=any. Bo, seated, plays e5, closes the session and plays Nf6 after his close (A, Ada's copy, holds all of it). From a second copy of his store he then starts a session of his own in each copy at one seq, and writes a move for Ada's seat (B). Bo is an equivocator twice over: a close that counts and a row of his in that session at a higher seq (R18), and two headers at one seq. An equivocator holds no seat and none of his rows is admitted: the open seat is void, neither e5 nor Nf6 is admitted, his close closes nothing, and Ada's e4 stands; his move for her seat, taken by the merge into A, is reported nowhere but as his signing twice (R17). Before, his close stopped counting once he equivocated, the session reopened and his move after it was admitted (review 9, A05).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const e4 = createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(b, a, ADA);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      createEntity(b, "_dai_close", id(0x92), {}, session);
      createEntity(b, "moves", id(0x83), { seat: SEAT_OPEN, san: "Nf6" }, session);
      await exchange(a, b, BO);
      const fork = await forkOf(b, BO);
      begin(b, { seat: id(0xc1), seats: [id(0xc2)], entity: id(0x5a) });
      await sealAll(b, BO);
      begin(fork, { seat: id(0xc3), seats: [id(0xc4)], entity: id(0x5c) });
      await exchange(b, fork, BO);
      fork.done();
      // And a move of his for Ada's seat, at an id he signed once: an equivocator's row is reported nowhere (R17).
      createEntity(b, "moves", id(0x84), { seat: SEAT_W, san: "Qh5" }, session);
      marks["session-joiner-equivocator-close"] = [idOf(e4)];
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author]],
        voided: [SEAT_OPEN],
        moves: () => marks["session-joiner-equivocator-close"],
        closed: 0,
        ab: { reports: ["Bo AUTHOR_EQUIVOCATED"] },
        ba: { reports: [] },
      }),
  },
  {
    name: "session-void-creator-row-tombstone",
    session: true,
    converges: false,
    cites: ["6", "T1-D29"],
    what:
      "Ada signs two rows at her creator's seat row's id, both in _dai_seat: the row (header A) and, from a second copy of her store, a tombstone of it with the same columns (header B). A is a copy that met the tombstone first and then the game (Bo seated, e4, e5), so it keeps the tombstone and both headers; B, Bo's copy, keeps the row and header A, and holds a session of Bo's own with a move, and a move in Ada's session naming it. A session whose creator's seat row is at an equivocated id is void whichever row a copy holds there: nothing in it is admitted or reported on either copy, Bo's move in his own session is admitted, and only the merge into B, which brings header B, reports Ada AUTHOR_EQUIVOCATED (R20). Before, the copy holding the tombstone had no creator and was not void, and reported Bo's crossing ENTITY_OTHER_SESSION (review 9, A08).",
    fill: async (a, b) => {
      const ada = copyFor(ADA);
      const fork = await forkOf(ada, ADA);
      const session = begin(ada);
      const row = ada.all("SELECT * FROM _dai_seat WHERE _r_replica = ? ORDER BY _r_seq LIMIT 1", [ADA.author])[0];
      raw(fork, "_dai_seat", row._r_entity, columnsOf(row), session, "[]", 1);
      await sealAll(fork, ADA);
      await exchange(b, ada, ADA);
      createEntity(b, "_dai_binding", id(0x61), { seat: SEAT_OPEN }, session);
      await exchange(ada, b, BO);
      confirmSeat(ada, session, SEAT_OPEN, BO.author, id(0x71));
      createEntity(ada, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(b, ada, ADA);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      await exchange(ada, b, BO);
      await exchange(a, fork, ADA);
      await exchange(a, ada, ADA);
      const own = begin(b, { seat: id(0xc1), seats: [id(0xc2)], entity: id(0x5a) });
      const a3 = createEntity(b, "moves", id(0x8a), { seat: id(0xc1), san: "a3" }, own);
      raw(b, "moves", id(0x8a), { seat: SEAT_OPEN, san: "a4" }, session, JSON.stringify([idOf(a3)]));
      ada.done();
      fork.done();
      marks["session-void-creator-row-tombstone"] = { a3: idOf(a3), seat: id(0xc1) };
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[marks["session-void-creator-row-tombstone"].seat, BO.author]],
        voided: [],
        moves: () => [marks["session-void-creator-row-tombstone"].a3],
        ab: { reports: [] },
        ba: { reports: ["Ada AUTHOR_EQUIVOCATED"] },
      }),
  },
  {
    name: "session-seat-value-text",
    session: true,
    cites: ["6", "T1-D29"],
    what:
      "The open seat's value is 16 bytes (the UTF-8 of OPENSEAT-OPENSEA). Bo asks for it by the 16-character TEXT of the same bytes, Ada confirms him by that TEXT, and he moves naming it (B). A seat value is 16 bytes, and a TEXT is not one whatever its length: the confirm counts for nothing, Bo holds nothing, and his move is not admitted and is reported SEAT_NOT_HELD by the merge that takes it; no reader throws (A09). Before, a TEXT value matched the TEXT a seat row named, and one merge admitted the move and reported it (review 9, A09).",
    fill: async (a, b) => {
      const session = begin(a, { seats: [TEXT_SEAT_BYTES] });
      await exchange(b, a, ADA);
      createEntity(b, "_dai_binding", id(0x61), { seat: TEXT_SEAT }, session);
      await exchange(a, b, BO);
      confirmSeat(a, session, TEXT_SEAT, BO.author, id(0x71));
      await exchange(b, a, ADA);
      createEntity(b, "moves", id(0x82), { seat: TEXT_SEAT, san: "e5" }, session);
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author]],
        voided: [],
        moves: () => [],
        ab: { reports: ["Bo SEAT_NOT_HELD"] },
        ba: { reports: [] },
      }),
  },
  ...[
    ["null", null, "NULL"],
    ["short", new Uint8Array(15).fill(0xb1), "15 bytes"],
  ].map(([shape, value, spelled]) => ({
    name: `session-seat-value-${shape}`,
    session: true,
    cites: ["6", "T1-D29"],
    what: `Bo holds the open seat and writes a move whose seat column is ${spelled} (B). A seat value is 16 bytes, and anything else names no seat: the move is not admitted, the merge that takes it reports it SEAT_NOT_HELD, and no reader throws (A09).`,
    fill: async (a, b) => {
      const session = await seated(a, b);
      createEntity(b, "moves", id(0x82), { seat: value, san: "e5" }, session);
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author], [SEAT_OPEN, BO.author]],
        moves: () => [],
        ab: { reports: ["Bo SEAT_NOT_HELD"] },
        ba: { reports: [] },
      }),
  })),
  {
    name: "session-close-skipped-seq",
    session: true,
    cites: ["6", "T1-D31"],
    what:
      "close=any. Bo plays e5, leaves a seq unused, plays Nf6, and Ada answers both (A). Then he signs a close at the seq he left unused (B). A close that counts and a row by its author in that session at a higher seq are equivocation: Bo is an equivocator, reported AUTHOR_EQUIVOCATED by the merge that takes the close, so he holds no seat (the open seat is void), none of his moves is admitted, and his close closes nothing; Ada's moves stand (R18, R17). Before, his first close made Nf6 late after Ada had answered it, and nothing was reported (review 9, A10).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const e4 = createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(b, a, ADA);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      const gap = Number(b.all("SELECT seq FROM _dai_replica")[0].seq) + 1;
      b.run("UPDATE _dai_replica SET seq = seq + 1");
      createEntity(b, "moves", id(0x83), { seat: SEAT_OPEN, san: "Nf6" }, session);
      await exchange(a, b, BO);
      const nc3 = createEntity(a, "moves", id(0x84), { seat: SEAT_W, san: "Nc3" }, session);
      await exchange(b, a, ADA);
      rawAt(b, gap, "_dai_close", id(0x92), {}, session);
      marks["session-close-skipped-seq"] = [idOf(e4), idOf(nc3)];
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author]],
        voided: [SEAT_OPEN],
        moves: () => marks["session-close-skipped-seq"],
        closed: 0,
        ab: { reports: ["Bo AUTHOR_EQUIVOCATED"] },
        ba: { reports: [] },
      }),
  },
  {
    name: "session-close-deleted",
    session: true,
    cites: ["6", "T1-D31"],
    what:
      "close=any. Bo, seated, plays e5 and closes the session (A holds both), then writes a delete of his close (B). A delete of a close revokes nothing: it is a row of his in that session after his close, so he is an equivocator, reported by the merge into A, which takes the delete; he holds no seat and e5 is admitted nowhere, his close closes nothing, and Ada's e4 stands (D153, R18, R17).",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const e4 = createEntity(a, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(b, a, ADA);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      createEntity(b, "_dai_close", id(0x92), {}, session);
      await exchange(a, b, BO);
      deleteEntity(b, "_dai_close", id(0x92), session);
      marks["session-close-deleted"] = [idOf(e4)];
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author]],
        voided: [SEAT_OPEN],
        moves: () => marks["session-close-deleted"],
        closed: 0,
        ab: { reports: ["Bo AUTHOR_EQUIVOCATED"] },
        ba: { reports: [] },
      }),
  },
  {
    name: "session-parent-forward",
    session: true,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "Bo, seated, writes a move naming as its parent his own id at a seq above its own, which he has not used yet, and seals it alone. Then he starts a session of his own and writes, at exactly that seq, a move of the same entity there (B). A parent naming an id of the row's own author at a seq at or above the row's own is malformed: the merge refuses the first move's batch ROW_MALFORMED and takes the rest; Bo's move in his own session is admitted, and no crossing is reported. B, which holds the malformed row as its own, reads its parents as naming nothing (R19). Before, the move was taken and admitted, and the later row of its entity in another session took it back after the fact, reported ENTITY_OTHER_SESSION.",
    fill: async (a, b) => {
      const session = await seated(a, b);
      const k = Number(b.all("SELECT seq FROM _dai_replica")[0].seq) + 1;
      const later = k + 2;
      raw(b, "moves", id(0x8a), { seat: SEAT_OPEN, san: "e5" }, session, JSON.stringify([`${hexOf(BO.author)}:${later}`]));
      await sealAll(b, BO);
      const own = begin(b, { seat: id(0xc1), seats: [id(0xc2)], entity: id(0x5a) });
      const a3 = createEntity(b, "moves", id(0x8a), { seat: id(0xc1), san: "a3" }, own);
      if (a3._r_seq !== later) throw new Error(`session-parent-forward: the later row is at ${a3._r_seq}, not ${later}`);
      marks["session-parent-forward"] = { ab: [idOf(a3)], ba: [`${hexOf(BO.author)}:${k}`, idOf(a3)] };
    },
    expect: (runs) =>
      ruled(runs, {
        ab: { reports: ["Bo ROW_MALFORMED"], moves: () => marks["session-parent-forward"].ab },
        ba: { reports: [], moves: () => marks["session-parent-forward"].ba },
      }),
  },
  {
    name: "session-malformed-header-relayed",
    session: true,
    cites: ["6", "T1-D13"],
    what:
      "For the record (review 9, A06). From a second copy of her store Ada signs a header at her e4's seq over a move whose parents are malformed. A is a relay holding the game and that header without its row; B is Bo's copy. Without its row the header is authentic and incomplete, so it is kept: Ada is an equivocator and her session is void on both copies after either merge, and the merge into B reports Ada AUTHOR_EQUIVOCATED (R10).",
    fill: async (a, b) => {
      const ada = copyFor(ADA);
      const session = await seated(ada, b);
      const fork = await forkOf(ada, ADA);
      const e4 = createEntity(ada, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(b, ada, ADA);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      await exchange(ada, b, BO);
      raw(fork, "moves", id(0x8e), { seat: SEAT_W, san: "Qxf7" }, session, '["zz"]');
      await sealAll(fork, ADA);
      await exchange(a, b, BO);
      carryHeaderOnly(a, fork, headersListing(fork, ADA.author, "moves", e4._r_seq)[0]);
      ada.done();
      fork.done();
    },
    expect: ({ ab, ba }) => voidAnswer({ ab, ba }, { ab: [], ba: ["Ada AUTHOR_EQUIVOCATED"] }),
  },
  {
    name: "session-relayed-header-lost-save",
    session: true,
    authors: true,
    stable: false,
    converges: false,
    cites: ["6", "T1-D13"],
    what:
      "For the record (review 9, A07; D180). A is Ada's stored copy after a lost save: her confirm of Bo pending, the header H that sealed it not held. B, Bo's copy, holds H without the confirm, as a relay holds it. Merging B into A keeps H and leaves the confirm pending, and reports nothing; the merge is not a fixed point, since a second merge finds H held and adopts it for the confirm (D180, open).",
    fill: async (a, b) => {
      const session = begin(a);
      await sealAll(a, ADA);
      await exchange(b, a, ADA);
      createEntity(b, "_dai_binding", id(0x61), { seat: SEAT_OPEN }, session);
      await sealAll(b, BO);
      await exchange(a, b, BO);
      const confirm = (() => {
        confirmSeat(a, session, SEAT_OPEN, BO.author, id(0x71));
        return a.all("SELECT _r_seq AS s FROM _dai_confirm WHERE _r_replica = ?", [ADA.author])[0].s;
      })();
      await sealAll(a, ADA);
      const [h] = headersListing(a, ADA.author, "_dai_confirm", confirm);
      carryHeaderOnly(b, a, h);
      withoutTriggers(a, ["_dai_confirm__sealed_once"], () => a.run("UPDATE _dai_confirm SET _r_batch = NULL WHERE _r_replica = ?", [ADA.author]));
      a.run("DELETE FROM _dai_batch WHERE lower(hex(id)) = ?", [h]);
    },
    expect: ({ ab }) => {
      if (reported(ab).length > 0) return `ab: reported [${reported(ab).join(", ")}]`;
      const pending = ab.dump.split("\n").some((line) => line.startsWith(`${hexOf(SEAT_OPEN)}\t${hexOf(BO.author)}\t`) && line.split("\t").includes("nil"));
      if (!pending) return "ab: the confirm is not pending after the first merge";
    },
  },
  ...[
    ["own-seat", "lists her own seat among the open seats", () => Buffer.concat([SEAT_OPEN, SEAT_W]), "any"],
    ["too-many", "lists two open seats in a document declared max_parties=2", () => Buffer.concat([SEAT_OPEN, SEAT_THIRD]), "any"],
    ["close-rule", "declares the close rule anyone", () => Buffer.from(SEAT_OPEN), "anyone"],
  ].map(([shape, says, seats, close]) => ({
    name: `session-roster-invalid-${shape}`,
    session: true,
    cites: ["6", "T1-D29"],
    what: `Ada's creator's seat row ${says}. Bo asks for the open seat, Ada confirms him and he moves. A creator's seat row whose roster is not valid makes its session void: nobody holds a seat in it, nothing in it is admitted, and nothing is reported, since nobody signed twice (R14).`,
    fill: async (a, b) => {
      const state = a.all("SELECT id, seq FROM _dai_replica")[0];
      const session = sessionIdOf(state.id, state.seq + 1, SEAT_W, new Uint8Array(seats()), close);
      raw(a, "_dai_seat", id(0x51), { seat: SEAT_W, seats: new Uint8Array(seats()), close }, session, "[]");
      await exchange(b, a, ADA);
      createEntity(b, "_dai_binding", id(0x61), { seat: SEAT_OPEN }, session);
      await exchange(a, b, BO);
      confirmSeat(a, session, SEAT_OPEN, BO.author, id(0x71));
      await exchange(b, a, ADA);
      createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
    },
    expect: (runs) => ruled(runs, { holders: [], voided: [], moves: () => [], reports: [] }),
  })),
  {
    name: "session-three-parties-equivocator",
    session: true,
    schema: SESSION_SCHEMA_3,
    cites: ["6", "T1-D29"],
    what:
      "max_parties=3: Bo holds one open seat and Cy the other, and each moves. Then Cy, from a second copy of his store, signs two moves at one seq (A holds both headers; B, Bo's copy, holds neither). An equivocator holds no seat and none of his rows is admitted: Cy's seat is void and his moves are admitted nowhere, while Bo's hold and his move stand, and the merge into B reports Cy AUTHOR_EQUIVOCATED (R17). Before, Cy's hold stood and his moves at other ids were admitted.",
    fill: async (a, b) => {
      const session = await seated(a, b, { seats: [SEAT_OPEN, SEAT_THIRD] });
      const e5 = createEntity(b, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session);
      await exchange(a, b, BO);
      const cy = copyFor(CY, SESSION_SCHEMA_3);
      await exchange(cy, a, ADA);
      createEntity(cy, "_dai_binding", id(0x63), { seat: SEAT_THIRD }, session);
      await exchange(a, cy, CY);
      confirmSeat(a, session, SEAT_THIRD, CY.author, id(0x74));
      await exchange(cy, a, ADA);
      createEntity(cy, "moves", id(0x89), { seat: SEAT_THIRD, san: "Nc6" }, session);
      await exchange(b, cy, CY);
      const fork = await forkOf(cy, CY, SESSION_SCHEMA_3);
      createEntity(cy, "moves", id(0x8b), { seat: SEAT_THIRD, san: "Nf6" }, session);
      await sealAll(cy, CY);
      createEntity(fork, "moves", id(0x8c), { seat: SEAT_THIRD, san: "d6" }, session);
      await exchange(cy, fork, CY);
      await exchange(a, cy, CY);
      fork.done();
      cy.done();
      marks["session-three-parties-equivocator"] = [idOf(e5)];
    },
    expect: (runs) =>
      ruled(runs, {
        holders: [[SEAT_W, ADA.author], [SEAT_OPEN, BO.author]],
        voided: [SEAT_THIRD],
        moves: () => marks["session-three-parties-equivocator"],
        ab: { reports: [] },
        ba: { reports: ["Cy AUTHOR_EQUIVOCATED"] },
      }),
  },

  /*
   * R21 (D189, 4 October): a row of an author table naming as a parent an id
   * the copy holds no row at waits on it, neither admitted nor reported, until
   * the parent is held. The eight removals the property pass found
   * (scripts/properties.mjs, P1), each as a vector: A holds the set of headers
   * the pass found it from, B that set and the header released. Each ships
   * what A admits before the merge (`before`), and each was red against the
   * runtime before R21: the child admitted on A, then removed by the merge that
   * brings its parent. And one honest order: a reply that arrives before the
   * move it names.
   */
  waitsOn("session-waits-entity-other-session", "session-entity-other-session", {
    what:
      "A holds Ada's session S2: her creator's seat row and a version, in S2, of the entity of a move she made in S, naming that move, which A does not hold. B holds the move as well. On A the version waits on its parent, neither admitted nor reported; the merge into A brings the parent, the version names another session's row of its entity, and it is reported ENTITY_OTHER_SESSION, once (R21). Before, A admitted the version and the parent's arrival removed it (D189).",
    holding: ["70635438"],
    release: ["5765697a"],
    child: () => `${hexOf(ADA.author)}:5`,
    reports: ["Ada ENTITY_OTHER_SESSION"],
  }),
  waitsOn("session-waits-equivocated-parent-e5", "session-equivocated-parent", {
    what:
      "A holds the game and Ada's Nc3, a version naming Bo's e5 as its parent, and neither of the two rows Bo signed at that id; B holds the game and one of them, e5. On A, Nc3 waits on its parent. The merge into A brings e5, a row of another seat: Nc3 is reported SEAT_NOT_HELD, once (R21), beside Bo's e5, which names the seat he holds nowhere once his signing twice voids it on neither copy. Before, A admitted Nc3 and e5's arrival removed it (D189).",
    holding: ["5449fafc", "92f17227"],
    release: ["00e0276a"],
    child: () => `${hexOf(ADA.author)}:3`,
    reports: ["Ada SEAT_NOT_HELD", "Bo SEAT_NOT_HELD"],
  }),
  waitsOn("session-waits-equivocated-parent-d5", "session-equivocated-parent", {
    what:
      "As session-waits-equivocated-parent-e5, B holding the other of Bo's two rows at the id Ada's Nc3 names, d5. On A, Nc3 waits on its parent; the merge into A brings d5, a row of another seat, and Nc3 is reported SEAT_NOT_HELD, once (R21). Before, A admitted Nc3 and d5's arrival removed it (D189).",
    holding: ["5449fafc", "92f17227"],
    release: ["ccaf8838"],
    child: () => `${hexOf(ADA.author)}:3`,
    reports: ["Ada SEAT_NOT_HELD", "Bo SEAT_NOT_HELD"],
  }),
  waitsOn("session-waits-equivocated-row-silent", "session-equivocated-row-silent", {
    what:
      "A holds the game and Bo's d5, a version for his own seat of Ada's e4, and not e4; B holds e4 as well. On A, d5 waits on its parent. The merge into A brings e4, a row of another seat: d5 is reported SEAT_NOT_HELD, once (R21). Before, A admitted d5 and e4's arrival removed it (D189).",
    holding: ["39f7929d", "440d5e4a", "5c253e8b", "667ef6ee", "92f17227"],
    release: ["ff4d4d6c"],
    child: () => `${hexOf(BO.author)}:4`,
    reports: ["Bo SEAT_NOT_HELD"],
  }),
  waitsOn("session-waits-other-seat", "session-other-seat", {
    what:
      "A holds the game and Bo's e5, a version for his seat naming Ada's e4, and not e4; B holds e4 as well. On A, e5 waits on its parent, and so does Bo's Nc6, another entity naming the same. The merge into A brings e4: e5 acts for another seat's row and is reported SEAT_NOT_HELD, once, and Nc6, which crosses nothing, is admitted (R21). Before, A admitted e5 and e4's arrival removed it (D189).",
    holding: ["3cefa035", "5c253e8b", "92f17227"],
    release: ["679ea05c"],
    child: () => `${hexOf(BO.author)}:2`,
    reports: ["Bo SEAT_NOT_HELD"],
  }),
  waitsOn("session-waits-other-seat-forward-bo", "session-other-seat", {
    what:
      "A is session-other-seat's B: Bo's e5 and Nc6 name Ada's e4, which A does not hold. B holds that and, at e4's id, a row of Ada's written by a client that skips the writers: her move's entity for her seat, naming as its parent Bo's next id, which does not exist. On A, e5 and Nc6 wait on their parent. The merge into A brings Ada's row: e5 acts for another seat's row and is reported SEAT_NOT_HELD, once, Nc6 is admitted, and Ada's row waits on the id it names (R21). Before, A admitted e5 and Ada's row removed it (D189).",
    from: "b",
    forward: () => BO,
    child: () => `${hexOf(BO.author)}:2`,
    reports: ["Bo SEAT_NOT_HELD"],
  }),
  waitsOn("session-waits-other-seat-forward-cy", "session-other-seat", {
    what:
      "As session-waits-other-seat-forward-bo, Ada's row naming as its parent the first id of Cy, who writes nothing. On A, e5 and Nc6 wait on their parent; the merge into A brings Ada's row, e5 is reported SEAT_NOT_HELD, once, Nc6 is admitted, and Ada's row waits (R21). Before, A admitted e5 and Ada's row removed it (D189).",
    from: "b",
    forward: () => CY,
    child: () => `${hexOf(BO.author)}:2`,
    reports: ["Bo SEAT_NOT_HELD"],
  }),
  waitsOn("session-waits-void-creator-row-tombstone", "session-void-creator-row-tombstone", {
    what:
      "A holds Ada's game, Bo seated, and Bo's a4 in it, a version naming his a3, which A does not hold; B holds Bo's own session and a3 as well. On A, a4 waits on its parent. The merge into A brings a3, a row of a4's entity from another session: a4 is reported ENTITY_OTHER_SESSION, once (R21). Before, A admitted a4 and a3's arrival removed it (D189).",
    holding: ["589dc821", "847083bc", "92f17227"],
    release: ["7292ac62"],
    child: () => `${hexOf(BO.author)}:5`,
    reports: ["Bo ENTITY_OTHER_SESSION"],
  }),
  {
    name: "session-waits-reply-first",
    session: true,
    before: true,
    cites: ["6", "T1-D29"],
    what:
      "Ada plays e4, and Bo answers with e5, a move of another entity naming e4 as its parent. A copy of the game (A) receives Bo's batch before Ada's; B holds both. On A, e5 waits on the move it names, neither admitted nor reported. The merge into A brings e4: it names nothing that crosses, so e5 is admitted beside it, and nothing is reported (R21). A parent of another entity hides nothing (T1-D35).",
    fill: async (a, b) => {
      const ada = copyFor(ADA);
      const bo = copyFor(BO);
      await seated(ada, bo);
      const session = ada.all("SELECT _r_session AS s FROM _dai_seat LIMIT 1")[0].s;
      const e4 = createEntity(ada, "moves", id(0x81), { seat: SEAT_W, san: "e4" }, session);
      await exchange(bo, ada, ADA);
      const e5 = raw(bo, "moves", id(0x82), { seat: SEAT_OPEN, san: "e5" }, session, JSON.stringify([idOf(e4)]));
      await sealAll(bo, BO);
      const moveOf = (copy, row) => headersListing(copy, row._r_replica, "moves", row._r_seq);
      const game = ada.all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => r.id).filter((hid) => !moveOf(ada, e4).includes(hid));
      carry(a, ada, game);
      carry(a, bo, moveOf(bo, e5));
      settled(a);
      await exchange(b, ada, ADA);
      await exchange(b, bo, BO);
      ada.done();
      bo.done();
      marks["session-waits-reply-first"] = [idOf(e4), idOf(e5)];
    },
    expect: ({ ab, ba }) => {
      const [e4, e5] = marks["session-waits-reply-first"];
      const moves = (dump) => sectionOf(dump, "moves").map((line) => line.split("\t")[0]);
      if (moves(ab.before).length > 0) return `A, before the merge: admitted moves are [${moves(ab.before).join(" | ")}], though e5 names a move A does not hold`;
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        if (reported(run).length > 0) return `${direction}: reported [${reported(run).join(", ")}]`;
        if (moves(run.admitted).join() !== [e4, e5].join()) return `${direction}: admitted moves are [${moves(run.admitted).join(" | ")}], not e4 and e5`;
      }
    },
  },
];

/**
 * A vector's scenario built again in two scratch copies, as that vector's own
 * are (`populate`): where R21's vectors take their headers from.
 */
async function scenarioOf(name) {
  const source = VECTORS.find((vector) => vector.name === name);
  const paths = ["a", "b"].map((which) => join(out, `scratch-scenario-${copies++}-${which}.db`));
  const [a, b] = paths.map((path, i) => open(path, undefined, schemaFor(source, i === 0 ? "a" : "b")));
  await populate(source, a, b);
  return {
    a,
    b,
    done: () => {
      a.close();
      b.close();
      for (const path of paths) rmSync(path);
    },
  };
}

/** Carries into `to` each header named by an id prefix, from whichever of `copies` holds it complete. */
async function carriedFrom(to, copies, prefixes) {
  for (const prefix of prefixes) {
    let found = null;
    for (const copy of copies) {
      for (const [hid, verdict] of await verifyBatches(copy, copy.tables, DOC)) {
        if (hid.startsWith(prefix) && verdict.ok && verdict.complete) found = { copy, hid };
      }
      if (found) break;
    }
    if (!found) throw new Error(`no copy holds a header ${prefix}... complete`);
    carry(to, found.copy, [found.hid]);
  }
}

/**
 * `carry` copies the display cache as the source copy kept it; a copy that
 * took the same rows by merge keeps it true of its own rows (T1-D2).
 */
function settled(to) {
  for (const table of to.tables) {
    to.run(
      `UPDATE "${table}" SET _r_superseded = EXISTS (SELECT 1 FROM "${table}" c, json_each(CASE WHEN json_valid(c._r_parents) THEN c._r_parents ELSE '[]' END) p
         WHERE c._r_entity = "${table}"._r_entity AND p.value = lower(hex("${table}"._r_replica)) || ':' || "${table}"._r_seq)`,
    );
  }
}

/**
 * One of R21's vectors from the property pass: A holds the headers `holding`
 * names (or, with `from`, every header of that copy of the source), B holds
 * those and the headers `release` names (or, with `forward`, a row of Ada's at
 * her parent move's id naming that person's next id as its parent, as a
 * client that skips the writers signs it). The child is not admitted on A
 * before the merge, nor on either copy after it, and the merge into A reports
 * `reports`; the merge into B, nothing.
 */
function waitsOn(name, source, { what, holding, release, from, forward, child, reports }) {
  return {
    name,
    session: true,
    before: true,
    cites: ["6", "T1-D29"],
    what,
    fill: async (a, b) => {
      const scenario = await scenarioOf(source);
      const copies = [scenario.a, scenario.b];
      const held = holding ?? scenario[from].all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => r.id);
      await carriedFrom(a, copies, held);
      await carriedFrom(b, copies, held);
      if (release) await carriedFrom(b, copies, release);
      if (forward) {
        // Ada's move, which the child names, and the next id of the person named.
        const [move] = scenario.a.all("SELECT * FROM moves WHERE _r_replica = ? ORDER BY _r_seq", [ADA.author]);
        const next = 1 + Math.max(0, ...copies.flatMap((c) => c.tables.flatMap((t) => c.all(`SELECT _r_seq AS s FROM "${t}" WHERE _r_replica = ?`, [forward().author]).map((r) => Number(r.s)))));
        const ada = copyFor(ADA);
        forwardParentAt(ada, move._r_seq, "moves", move._r_entity, columnsOf(move), move._r_session, { author: forward().author, seq: next });
        await sealAll(ada, ADA);
        carry(b, ada, ada.all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => r.id));
        ada.done();
      }
      scenario.done();
      settled(a);
      settled(b);
    },
    expect: ({ ab, ba }) => {
      const admits = (dump) => sectionOf(dump, "moves").some((line) => line.split("\t")[0] === child());
      if (admits(ab.before)) return `A, before the merge: ${child()} is admitted, though a parent it names is not held`;
      for (const [direction, run] of [["ab", ab], ["ba", ba]]) {
        if (admits(run.admitted)) return `${direction}: ${child()} is admitted`;
      }
      if ([...reported(ab)].sort().join() !== [...reports].sort().join()) return `ab: reported [${reported(ab).join(", ")}], not [${reports.join(", ")}]`;
      if (reported(ba).length > 0) return `ba: reported [${reported(ba).join(", ")}]`;
    },
  };
}

/** A seat value spelled as a 16-character TEXT, and the 16 bytes of the same UTF-8 (A09). */
const TEXT_SEAT = "OPENSEAT-OPENSEA";
const TEXT_SEAT_BYTES = new Uint8Array(Buffer.from(TEXT_SEAT, "utf8"));

/**
 * The ruled answer of a void session (R10): nobody holds a seat in it, no row
 * of it is admitted, no seat of it is voided (its creator's confirms count for
 * nothing), and only AUTHOR_EQUIVOCATED is reported, as `reports` says per
 * direction.
 */
function voidAnswer(runs, reports) {
  for (const [direction, run] of Object.entries(runs)) {
    const refused = run.result.refusedBatches.map((r) => `${r.author === b64Of(ADA.author) ? "Ada" : r.author === b64Of(BO.author) ? "Bo" : r.author} ${r.reason}`);
    if (refused.join() !== reports[direction].join()) return `${direction}: refused [${refused.join(", ")}], not [${reports[direction].join(", ")}]`;
    if (sectionOf(run.admitted, "holders").length > 0) return `${direction}: holders are [${sectionOf(run.admitted, "holders").join(" | ")}] in a void session`;
    if (sectionOf(run.admitted, "voided").length > 0) return `${direction}: voided is [${sectionOf(run.admitted, "voided").join(" | ")}] in a void session`;
    if (sectionOf(run.admitted, "moves").length > 0) return `${direction}: admitted moves are [${sectionOf(run.admitted, "moves").join(" | ")}] in a void session`;
  }
}

/** An author id as `refusedBatches` spells it. */
const b64Of = (bytes) => Buffer.from(bytes).toString("base64url");
/** A merge's `refusedBatches` as "<name> <code>", the authors named. */
function reported(run) {
  const names = { [b64Of(ADA.author)]: "Ada", [b64Of(BO.author)]: "Bo", [b64Of(CY.author)]: "Cy" };
  return run.result.refusedBatches.map((r) => `${names[r.author] ?? r.author} ${r.reason}`);
}
/** A row's id as `_r_parents` and the admitted dump spell it. */
const idOf = (row) => `${hexOf(row._r_replica)}:${row._r_seq}`;
/** Row ids a vector's fill records for its `expect`, by vector. */
const marks = {};

/**
 * The state a vector rules, in both directions (`want.ab` and `want.ba`
 * override per direction): what each merge reports, whether it was refused,
 * who holds which seat (`[seat, author]`), which seats are void, which moves
 * are admitted (by id), and how many sessions are closed. A key left out is
 * not checked.
 */
function ruled(runs, want) {
  for (const [direction, run] of Object.entries(runs)) {
    const w = { ...want, ...(want[direction] ?? {}) };
    const refused = reported(run);
    if (w.reports && refused.join() !== w.reports.join()) return `${direction}: reported [${refused.join(", ")}], not [${w.reports.join(", ")}]`;
    if ((run.result.refused ?? null) !== (w.refused ?? null)) return `${direction}: the merge ${run.result.refused ? `was refused ${run.result.refused}` : "ran"}, not ${w.refused ? `refused ${w.refused}` : "ran"}`;
    const same = (got, expected) => [...got].sort().join() === [...expected].sort().join();
    if (w.holders) {
      const got = sectionOf(run.admitted, "holders").map((line) => line.split("\t").slice(1).join(" "));
      const expected = w.holders.map(([seat, who]) => `${hexOf(seat)} ${hexOf(who)}`);
      if (!same(got, expected)) return `${direction}: holders are [${got.join(" | ")}], not [${expected.join(" | ")}]`;
    }
    if (w.voided) {
      const got = sectionOf(run.admitted, "voided").map((line) => line.split("\t")[1]);
      const expected = w.voided.map(hexOf);
      if (!same(got, expected)) return `${direction}: voided is [${got.join(" | ")}], not [${expected.join(" | ")}]`;
    }
    if (w.moves) {
      const got = sectionOf(run.admitted, "moves").map((line) => line.split("\t")[0]);
      const expected = w.moves();
      if (!same(got, expected)) return `${direction}: admitted moves are [${got.join(" | ")}], not [${expected.join(" | ")}]`;
    }
    if (w.closed !== undefined && sectionOf(run.admitted, "closed").length !== w.closed) return `${direction}: closed is [${sectionOf(run.admitted, "closed").join(" | ")}]`;
  }
}
/** The lines of one `# name` section of an admitted dump. */
function sectionOf(dump, name) {
  const lines = dump.split("\n");
  const start = lines.indexOf(`# ${name}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith("# "));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line !== "");
}

/** merge-report-order's ruled answer, which depends on the ids its fill makes. */
const reportOrder = {};
/** merge-row-batch-named-higher's named header, the higher of its two. */
const namedHigher = {};

/** The session vectors' seats: Ada's own, and the open one Bo asks for. */
const SEAT_W = id(0xa1);
const SEAT_OPEN = id(0xb1);
/** A third seat Ada mints in a session declared max_parties=2. */
const SEAT_THIRD = id(0xb5);
/** The fresh open seat a reseat gives the open seat's row. */
const SEAT_FRESH = id(0xb7);

/**
 * A session of `db`'s author as R14 declares it: one row, her creator's seat
 * row, carrying her seat, the open seats and the close rule. `gap` seqs are
 * left unused after it, as a client that skips seqs leaves them.
 */
function begin(db, { seat = SEAT_W, seats = [SEAT_OPEN], close = "any", entity = id(0x51), gap = 0 } = {}) {
  const session = startSession(db, { creatorSeat: seat, openSeats: seats, close, entity });
  if (gap > 0) db.run("UPDATE _dai_replica SET seq = seq + ?", [gap]);
  return session;
}

/** Ada's session, Bo confirmed in its open seat, on both copies, every row signed. */
async function seated(a, b, options) {
  const session = begin(a, options);
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
async function forkOf(from, person, schema = SESSION_SCHEMA) {
  const path = join(out, `scratch-fork-${forks++}.db`);
  const fork = open(path, undefined, schema);
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

let copies = 0;
/** A copy of its own for `person`, beside the two a vector ships: a third author's device. */
function copyFor(person, schema = SESSION_SCHEMA) {
  const path = join(out, `scratch-copy-${copies++}.db`);
  const copy = open(path, undefined, schema);
  asReplica(copy, person.author);
  copy.done = () => {
    copy.close();
    rmSync(path);
  };
  return copy;
}

/** A seal with one signature held while `during` runs (D178), each signature a kept one. */
const sealHolding = (db, person, holdAt, during) => sealHoldingWith(db, person, holdAt, during, keptSigner(person));

/**
 * The id of the header `write` would seal on a copy standing where `from`
 * stands, found without a kept signature: a batch id hashes the canonical
 * header, never the signature. How a witness puts a neighbor's header where
 * the order of `refusedBatches` tells two filings apart.
 */
async function probe(from, person, ...writes) {
  const copy = await forkOf(from, person);
  const found = [];
  for (const write of writes) {
    const before = new Set(copy.all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => r.id));
    write(copy);
    for (const batch of pendingBatches(copy, person.author, copy.tables)) {
      recordSeal(copy, await signBatch(batch, { document: DOC, sign: async () => ({ sig: new Uint8Array(64), pub: person.pub }) }));
    }
    found.push(copy.all("SELECT lower(hex(id)) AS id FROM _dai_batch").map((r) => r.id).filter((x) => !before.has(x)).sort()[0]);
  }
  copy.done();
  return found;
}

/** Merges a fresh copy of `from` into a fresh copy of `into` and reports both. */
async function run(vector, direction) {
  const a = openFor(vector, join(out, vector.name, "scratch-a.db"), vector.localOnA, "a");
  const b = openFor(vector, join(out, vector.name, "scratch-b.db"), undefined, "b");
  await populate(vector, a, b);
  const [left, right] = direction === "ab" ? [a, b] : [b, a];
  // Verified first, as every merge is (identity ruling #3). The verdicts are
  // written beside the vector: a reader merges by them and does its own coverage.
  const verdicts = await verifyBatches(right, right.tables, DOC);
  // And each copy's signed view (manifest.json): two builds are refused whole (R16).
  const [own, theirs] = direction === "ab" ? ["a", "b"] : ["b", "a"];
  const views = { local: manifestOf(schemaFor(vector, own)).view, sibling: manifestOf(schemaFor(vector, theirs)).view };
  // What the copy merged into admits before the merge (`before`, R21).
  const before = vector.session || vector.admits ? admittedDump(left) : null;
  const result = mergeFrom(left, right, left.tables, undefined, verdicts, { views });
  const dump = canonicalDump(left, left.tables);
  const admitted = vector.session || vector.admits ? admittedDump(left) : null;

  /*
   * And again, changing nothing.
   *
   * For a converging vector this is idempotence. For the disputed one it is
   * the claim that matters more: two copies that will never agree must each
   * still be a fixed point. Non-convergent must not mean non-deterministic —
   * a dispute that grew on every exchange would be a copy that never settles,
   * which is worse than one that settles differently from its sibling.
   */
  const again = mergeFrom(left, right, left.tables, undefined, verdicts, { views });
  const settled = canonicalDump(left, left.tables);
  // A vector that records a merge which is not a fixed point (D180) says so (`stable: false`).
  if (settled !== dump && vector.stable !== false) {
    console.error(`${vector.name} [${direction}]: merging twice changed the table`);
    process.exit(1);
  }
  if (settled === dump && vector.stable === false && direction === "ab") {
    console.error(`${vector.name} [${direction}]: said not to be a fixed point, and merging twice changed nothing`);
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
  return { dump, result, admitted, before };
}

/** The inputs, written as they stand before any merge, and the verdict on every header in them. */
async function writeInputs(vector) {
  const dir = join(out, vector.name);
  mkdirSync(dir, { recursive: true });
  const a = openFor(vector, join(dir, "a.db"), vector.localOnA, "a");
  const b = openFor(vector, join(dir, "b.db"), undefined, "b");
  await populate(vector, a, b);
  compare(join(dir, "manifest.json"), `${JSON.stringify({ a: manifestOf(schemaFor(vector, "a")), b: manifestOf(schemaFor(vector, "b")) }, null, 2)}\n`);
  // Per copy: a header is verified against the rows of the copy that holds it,
  // so the same header can verify in one and not in the other.
  const verdicts = {};
  // And, for a header made authentic by a list other than the one it stores
  // (docs/format.md, verify-lists-tried), the list that did: the one it is
  // kept under (merge-headers-kept-list), which a reader without its own
  // signature check cannot know otherwise.
  const lists = {};
  for (const [name, copy] of [["a", a], ["b", b]]) {
    const found = {};
    const stored = new Map(copy.all("SELECT lower(hex(id)) AS id, covers FROM _dai_batch").map((r) => [r.id, r.covers]));
    for (const [id, verdict] of await verifyBatches(copy, copy.tables, DOC)) {
      found[id] = verdict.ok ? (verdict.complete ? "ok" : "incomplete") : verdict.reason;
      if (verdict.ok && JSON.stringify(verdict.covers) !== stored.get(id)) (lists[name] ??= {})[id] = JSON.stringify(verdict.covers);
    }
    verdicts[name] = Object.fromEntries(Object.entries(found).sort(([x], [y]) => (x < y ? -1 : 1)));
  }
  compare(join(dir, "verdicts.json"), `${JSON.stringify(verdicts, null, 2)}\n`);
  // A file of its own, written only where a vector has one, so a reader that
  // reads verdicts.json as two maps of strings still reads every vector.
  if (Object.keys(lists).length > 0) compare(join(dir, "lists.json"), `${JSON.stringify(lists, null, 2)}\n`);
  a.close();
  b.close();
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
| \`verdicts.json\` | per copy (\`a\`, \`b\`), the verdict on every signed header it holds: \`ok\`, \`incomplete\`, or a refusal code |
| \`lists.json\` | only where a vector has one: per copy, for a header made authentic by a list other than the one it stores, that list, in the one spelling (below) |
| \`manifest.json\` | per copy (\`a\`, \`b\`), what its signed manifest gives a reader: the signed-view digest (\`view\`) and, in a session document, the session profile's \`max_parties\` and close rule (\`session\`) |
| \`expected-admitted-ab.txt\`, \`expected-admitted-ba.txt\` | session vectors, and \`merge-equivocated-plain-heads\`: what the document admits after each merge (below) |
| \`expected-admitted-a.txt\`, \`expected-admitted-b.txt\` | only where \`result.json\` says \`before: true\`: what each copy admits before any merge (below) |

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

- a header made authentic by the list of its author's rows naming it, not by
  the list it stores (docs/format.md, verify-lists-tried), lists that list
  and is kept under it (merge-headers-kept-list); \`lists.json\` carries it,
  since a reader without its own signature check cannot tell which list made
  the header (\`merge-relabeled-list\`);
- a header that is not \`ok\` is not kept and lists nothing;
- a header lists its rows in \`covers\` as \`[table, seq]\`, the author being its own,
  and no seq twice in any tables: a list that repeats one is not a list, so a
  header signed over one is not authentic, and its verdict says so
  (\`merge-seal-seq-twice\`);
- a row is taken when an \`ok\` header lists it (its table, its author, its
  seq), whatever the row says, and names the header it names if that one is
  \`ok\` and lists it, else the lowest \`ok\` header that lists it;
- a row that names a header and is listed by none is refused, as
  \`BATCH_DIGEST_MISMATCH\` in the name of the row's own author, unless the
  header it names was refused already;
- a row that names none and is listed by none is unsigned, and is refused as
  \`BATCH_UNSIGNED\` in the name of the id it carries (batch format version 2),
  unless the copy already holds a row at that id in that table, where the ordinary
  path decides (a duplicate, or a second row at one id);
- one author's seq names one row whatever table it is in: an unsigned row
  whose (author, seq) the copy holds in another table is refused
  (\`rejected\`); two signed ones are both taken, and under two headers with
  different digests are equivocation (batch format version 2);
- a signed row outranks an unsigned row the copy holds at the same id (after
  version 2, only its own pending row can be one): the unsigned one is removed, the signed one takes its place, and the removed id is reported in
  \`rejected\`; whatever the removed row superseded is a head again unless
  something else names it. Signed rows are placed before unsigned ones, so the
  answer never depends on table order;
- a row the copy holds with \`_r_batch\` unset, listed by a header the copy held
  before the merge that is complete over its own rows (its \`ok\` in
  \`verdicts.json\`, under its list in \`lists.json\` where it has one), is
  signed, not pending: the merge sets its \`_r_batch\` to the lowest such
  header before any row is placed (docs/format.md, merge-row-held-signed;
  \`merge-held-row-signed\`);
- a header the copy already holds under another list is rewritten to the list
  it signed (merge-headers-rewritten; \`merge-held-header-relabeled\`).

\`merge-seal-stowaway\`, \`merge-seal-stowaway-other\`, \`merge-seal-tampered\`,
\`merge-seal-lost-pointer\`, \`merge-seal-cross-table\` and \`merge-seal-outranks\`
each disagree with a reader that has one of those wrong. \`refusedBatches\` in
\`result.json\` is one entry per batch, reason and author, ordered by batch id
(lowercase hex, no id first), then reason, then author id in hex, with the
author id shown as base64url. Which batch id each reason is filed under is in
docs/format.md#refused-batches.

**What a session document admits.** The \`session-\` vectors are session
documents (one seated table, \`moves\`, seated by its \`seat\` column), and
their \`result.json\` says \`admitted: true\`, as does
\`merge-equivocated-plain-heads\`'s, a plain document, whose roster sections
are empty. Each ships
\`expected-admitted-ab.txt\` and \`expected-admitted-ba.txt\`: after the merge,
the admitted heads of every table the merge covers (\`id\` and the deleted flag,
by author then seq), then \`# holders\` (session, seat, holder), \`# voided\`
(session, seat, creator), \`# equivocated\` (author, table, seq: one line for
each table a kept header lists an equivocated id in, the id being the author
and the seq) and \`# closed\`, each sorted, ids in lowercase hex. Batch format version 2 changed mostly what a
document admits, which the stored rows alone cannot show, so these are what a
reader without one of those changes disagrees with. A reader computes them from
the tables and headers alone, and \`max_parties\` from \`manifest.json\` (most
vectors 2, the three-party ones 3). A vector whose \`result.json\` says
\`before: true\` also ships \`expected-admitted-a.txt\` and
\`expected-admitted-b.txt\`, what each copy admits before any merge, in the
same text: where what a copy admits changes with what arrives, the state
before the merge is half of what the vector rules. It reads no view but \`_dai_seat_rules\` and
\`_dai_author_rules\`, which are declarations; the rest are computations, and a
reader that took them would be the generator agreeing with itself. The rules,
in docs/identity.md and docs/format.md:

- a row id one author signed twice (two headers listing its seq, in any
  tables, with different digests) counts nowhere (D160, and the step 6
  review), and a row naming such an id as a parent is neither admitted nor
  reported; a parent naming the row's own author at a seq at or above its own
  is malformed (R19);
- the creator's seat row is the one whose own author, seq and roster (\`seat\`,
  \`seats\`, \`close\`) hash to its session (D158, R15). It declares the
  roster: her seat, the open seats (16-byte values, one after another, in
  \`seats\`) and the close rule; a roster that is not valid (values not 16
  bytes or repeated, hers among them, more than \`max_parties\` in all, a close
  rule other than \`any\` or \`creator\`) makes the session void. It is
  immutable, and no other seat row counts (R14). Her seat is hers, and an open
  seat is held by whoever her confirms of it name, unless they name two copies
  or an equivocator, when it is void and held by nobody (D165, R17). A confirm
  counts deleted or not, superseded or not, at any seq (D171), and only for a
  value her creator's seat row lists (R14);
- an author with two headers at one id anywhere in the document, or with a
  close that counts and a row in that session at a higher seq (R18), is an
  equivocator: his seat, binding, confirm and close rows count for nothing, he
  holds no seat, none of his rows is admitted or reported, and a session he
  created is void: nothing in it is admitted, held, voided or closed, and
  nothing in it is reported but \`AUTHOR_EQUIVOCATED\` (R10, R17). A session
  whose creator's seat row is at an equivocated id is void whichever row a
  copy holds there, and one holding only a tombstone there admits nothing
  (R20);
- a merge that reveals an author signing twice, a header it did not hold
  making an id equivocated that was not, a row it took that makes a close of
  his followed by a row true, or a row it took that a seat newly confirmed to
  two copies rests on (a counting confirm, or the creator's seat row),
  reports \`AUTHOR_EQUIVOCATED\` in that author's name, once per merge, filed
  under the lowest revealing header, or under no id when it took no row it
  rests on (docs/format.md#equivocated-filed); a third conflicting header
  reveals nothing new;
- the heads of the roster tables and the close (\`_dai_seat\`,
  \`_dai_binding\`, \`_dai_confirm\`, \`_dai_close\`) partition by session,
  entity and author: only an author's own later row in the same session
  replaces one (D171), and in \`_dai_seat\` only creators' seat rows are heads;
- a close counts, by the rule its session's creator's seat row declares,
  when it is not deleted; it binds only its author (D151), and closes the
  session when its author is no equivocator;
- a seated row is admitted when its author holds the seat it names and it
  names no version from another session or another seat. Of the rows a merge
  takes in a live session and does not admit, one naming no seat value (16
  bytes), a seat its author does not hold and does not wait in that is not
  void, or another seat's version is reported \`SEAT_NOT_HELD\` (A03, A09),
  and one naming another session's version \`ENTITY_OTHER_SESSION\`; one
  waiting on a confirmation and one for a void seat are reported nowhere;
- a row of an author table naming as a parent an id at which the copy holds
  no row, in any table, waits on it: neither admitted nor reported. The merge
  that brings the parent decides it by the rules above, once, and reports it
  as a row it took (R21);
- a row whose parents are not the one shape (D159) is never taken, nor any
  row of a complete batch that signed one, and the batch is refused
  \`ROW_MALFORMED\`;
- a merge between two copies whose \`manifest.json\` gives different signed-view
  digests (\`view\`) is refused whole: \`refused\` is \`SIGNED_VIEW_MISMATCH\` and
  nothing is taken (R16).

Each \`session-\` vector was run against both readers with its change held
out, and failed; the step 6 review's (\`session-equivocated-parent\`,
\`session-void-equivocated-confirm\`, \`session-equivocation-two-tables\`)
against the Python reader before it was leveled. The witness pass's (30
September, from the step 6 review's Pass 2) were each run against a Python
reader with one rule removed, and failed; what the verifier or the signer
decides, against the runtime with one rule removed. Every such hold-out is
in \`scripts/holdout.py\`, which CI runs.
`;

let differences = 0;
let wrongs = 0;
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

const chosen = only ? VECTORS.filter((vector) => only.has(vector.name)) : VECTORS;
if (only && chosen.length !== only.size) {
  console.error(`--only names a vector the generator does not have: ${[...only].filter((name) => !VECTORS.some((v) => v.name === name)).join(", ")}`);
  process.exit(1);
}
for (const vector of chosen) {
  const dir = join(out, vector.name);
  mkdirSync(dir, { recursive: true });
  await writeInputs(vector);

  const ab = await run(vector, "ab");
  const ba = await run(vector, "ba");
  // The ruled answer, before convergence, so a vector fails for its own rule.
  const wrong = vector.expect?.({ ab, ba });
  if (wrong) {
    console.error(`${vector.name}: ${wrong}`);
    wrongs += 1;
  }
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
  if (vector.session || vector.admits) {
    compare(join(dir, "expected-admitted-ab.txt"), ab.admitted);
    compare(join(dir, "expected-admitted-ba.txt"), ba.admitted);
  }
  if (vector.before) {
    compare(join(dir, "expected-admitted-a.txt"), ab.before);
    compare(join(dir, "expected-admitted-b.txt"), ba.before);
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
        // A session vector, and a plain one that says so (`admits`), ships
        // what the document admits after each merge (expected-admitted-*.txt,
        // backlog D171); a reader that finds this and does not compute
        // admission fails rather than skipping.
        admitted: Boolean(vector.session || vector.admits),
        // And what each copy admits before any merge (expected-admitted-a.txt,
        // expected-admitted-b.txt), where the vector rules that too (R21).
        ...(vector.before ? { before: true } : {}),
        ...(vector.shrinksAt ? { shrinksAt: vector.shrinksAt } : {}),
        // Each copy is a fixed point whether or not the two agree: run()
        // merges a second time and requires nothing to move, except in a
        // vector that records a merge which is not one (D180).
        stable: vector.stable !== false,
        ab: ab.result,
        ba: ba.result,
      },
      null,
      2,
    )}\n`,
  );
}

// Kept only for headers some vector still signs, so a vector changed or removed
// leaves no signature behind for a header nothing makes.
const unused = only ? [] : Object.keys(signatures).filter((key) => !signaturesUsed.has(key));
if (!check && (signaturesAdded > 0 || unused.length > 0)) {
  for (const key of unused) delete signatures[key];
  const ordered = Object.fromEntries(Object.entries(signatures).sort(([x], [y]) => (x < y ? -1 : 1)));
  writeFileSync(SIGNATURES, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

if (wrongs > 0) {
  console.error(`\n${wrongs} vector(s) do not give the ruled answer.`);
  process.exit(1);
}
if (check && differences > 0) {
  console.error(`\n${differences} fixture file(s) differ. Regenerate and commit the diff.`);
  process.exit(1);
}
console.log(check ? "fixtures match" : `${chosen.length} merge fixtures written to conformance/merge`);
