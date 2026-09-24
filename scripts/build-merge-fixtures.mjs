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
import { adoptReplica, pendingBatches, recordSeal, signBatch, stageBatch, verifyBatches } from "../dist/dai-merge.js";
import { coversText } from "../dist/replicated-rows.js";
import { authorIdOf, signBytes } from "../dist/identity.js";
import { createECDH, webcrypto } from "node:crypto";

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
const id = (byte) => new Uint8Array(16).fill(byte);
const A = id(0xaa);
const B = id(0xbb);
const E1 = id(0x11);
const E2 = id(0x22);

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
  for (const batch of pendingBatches(db, person.author, TABLES)) {
    recordSeal(db, await signBatch(batch, { document: DOC, sign: keptSigner(person) }));
  }
}

/** A database on disk, behind the interface the write rules ask for. */
function open(path, extra) {
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.exec(rewriteReplicated(SCHEMA).sql);
  // A table the author did not declare replicated. It never travels and never
  // merges, and the fixture exists to prove it does not stop one either.
  if (extra) db.exec(extra);
  return {
    all: (sql, params = []) => db.prepare(sql).all(...params),
    run: (sql, params = []) => void db.prepare(sql).run(...params),
    close: () => db.close(),
  };
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
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
      mergeFrom(b, a, TABLES);
      changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
      changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });
    },
  },
  {
    name: "merge-resolve",
    cites: ["5", "T1-D17"],
    what: "A change written while the conflict is open names both heads, which is what resolves it.",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
      mergeFrom(b, a, TABLES);
      changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
      changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });
      mergeFrom(a, b, TABLES);
      changeEntity(a, "cases", E1, { title: "settled", status: "open", weight: null });
    },
  },
  {
    name: "merge-tombstone",
    cites: ["5", "T1-D3"],
    what: "A delete on one side and nothing on the other. Absent from current, present in heads.",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "doomed", status: "open", weight: null });
      mergeFrom(b, a, TABLES);
      deleteEntity(b, "cases", E1);
    },
  },
  {
    name: "merge-tombstone-conflict",
    cites: ["T1-D3", "T1-D9"],
    what: "A delete on one side, a change on the other, concurrent. Current shows the change, flagged (T1-D3).",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
      mergeFrom(b, a, TABLES);
      changeEntity(a, "cases", E1, { title: "edited", status: "open", weight: null });
      deleteEntity(b, "cases", E1);
    },
  },
  {
    name: "merge-row-id-reused",
    cites: ["T1-D13", "T1-D15", "T1-D16"],
    what: "A row id already held with different content. Refused and counted; the honest rows still merge.",
    // The one vector where the copies do not end up the same, and that is the
    // answer. Each side holds different content under bb:1 and refuses the
    // other's: union merge converges over rows nobody disputes, and a disputed
    // id is where the guarantee stops. The alternative is one side silently
    // adopting the other's version of a row, which refusing it exists to stop.
    //
    // A Level 1 property, not a permanent one: at Level 2 the row that fails
    // to verify is refused and the one that verifies is kept, so the dispute
    // has an answer instead of two sides. Both copies are still fixed points
    // here — the run() above merges twice and requires nothing to move.
    converges: false,
    shrinksAt: "Track 2 — signatures decide a disputed row id",
    fill: (a, b) => {
      createEntity(b, "cases", E1, { title: "honest", status: "open", weight: null });
      createEntity(b, "cases", E2, { title: "also honest", status: "open", weight: null });
      applyRow(a, "cases", {
        _r_replica: B,
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
    name: "heads-via-superseded-flag",
    cites: ["4", "T1-D2", "T1-D10"],
    what: "A chain and a fork on one copy. Heads must equal what a full parents scan would say.",
    fill: (a, b) => {
      createEntity(a, "cases", E1, { title: "one", status: "open", weight: null });
      changeEntity(a, "cases", E1, { title: "two", status: "open", weight: null });
      createEntity(b, "cases", E2, { title: "other", status: "open", weight: null });
    },
  },
];

/** Merges a fresh copy of `from` into a fresh copy of `into` and reports both. */
async function run(vector, direction) {
  const a = open(join(out, vector.name, "scratch-a.db"), vector.localOnA);
  const b = open(join(out, vector.name, "scratch-b.db"));
  await populate(vector, a, b);
  const [left, right] = direction === "ab" ? [a, b] : [b, a];
  // Verified first, as every merge is (identity ruling #3). The verdicts are
  // written beside the vector: a reader merges by them and does its own coverage.
  const verdicts = await verifyBatches(right, TABLES, DOC);
  const result = mergeFrom(left, right, TABLES, undefined, verdicts);
  const dump = canonicalDump(left, TABLES);

  /*
   * And again, changing nothing.
   *
   * For a converging vector this is idempotence. For the disputed one it is
   * the claim that matters more: two copies that will never agree must each
   * still be a fixed point. Non-convergent must not mean non-deterministic —
   * a dispute that grew on every exchange would be a copy that never settles,
   * which is worse than one that settles differently from its sibling.
   */
  const again = mergeFrom(left, right, TABLES, undefined, verdicts);
  const settled = canonicalDump(left, TABLES);
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
  return { dump, result };
}

/** The inputs, written as they stand before any merge, and the verdict on every header in them. */
async function writeInputs(vector) {
  const dir = join(out, vector.name);
  mkdirSync(dir, { recursive: true });
  const a = open(join(dir, "a.db"), vector.localOnA);
  const b = open(join(dir, "b.db"));
  await populate(vector, a, b);
  // Per copy: a header is verified against the rows of the copy that holds it,
  // so the same header can verify in one and not in the other.
  const verdicts = {};
  for (const [name, copy] of [["a", a], ["b", b]]) {
    const found = {};
    for (const [id, verdict] of await verifyBatches(copy, TABLES, DOC)) found[id] = verdict.ok ? "ok" : verdict.reason;
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
  const [first, second] = vector.authors ? [ADA.author, BO.author] : [A, B];
  asReplica(a, first);
  if (vector.receives) {
    await vector.fill(a, b);
    receiveInto(b, a, second);
    await vector.afterReceive(a, b);
  } else {
    asReplica(b, second);
    await vector.fill(a, b);
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
- a row that names none and is listed by none is unsigned, and merges as before;
- one author's seq names one row whatever table it is in: a row whose
  (author, seq) the copy holds in another table is refused (\`rejected\`);
- a signed row outranks an unsigned row at the same id: the unsigned one is
  removed, the signed one takes its place, and the removed id is reported in
  \`rejected\`; whatever the removed row superseded is a head again unless
  something else names it. Signed rows are placed before unsigned ones, so the
  answer never depends on table order.

\`merge-seal-stowaway\`, \`merge-seal-stowaway-other\`, \`merge-seal-tampered\`,
\`merge-seal-lost-pointer\`, \`merge-seal-cross-table\` and \`merge-seal-outranks\`
each disagree with a reader that has one of those wrong. \`refusedBatches\` in
\`result.json\` is one entry per batch, reason and author, ordered by batch id,
then reason, then author id in hex, with the author id shown as base64url.
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
    const shape = open(join(dir, "scratch-shape.db"), vector.localOnA);
    const schema = replicatedSchemaOf(shape);
    shape.close();
    rmSync(join(dir, "scratch-shape.db"));
    compare(join(dir, "expected-schema.txt"), schema);
  }
  compare(join(dir, "expected-ab.txt"), ab.dump);
  compare(join(dir, "expected-ba.txt"), ba.dump);
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
