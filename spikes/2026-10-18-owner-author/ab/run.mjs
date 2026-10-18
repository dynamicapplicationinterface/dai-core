/**
 * Spike, 18 October: experiments A and B (owner/author).
 *
 * Two runtime copies of one plain replicated document, each its own SQLite
 * file driven by the runtime's own modules (dist/), the same ones the frame
 * calls: createEntity/changeEntity to write, pendingBatches/signBatch/
 * recordSeal to seal (as a leave does), mergeSibling to verify and merge.
 * Keys are fresh ES256 keys made here, private half non-extractable.
 *
 *   A: both copies hold the SAME author key. Each writes a different row at
 *      its next seq, offline. Batches exchanged both ways.
 *   B: two DIFFERENT author keys on one document. (i) different rows;
 *      (ii) the same row.
 *
 * Each copy's state before the exchange is written to out/<exp>-{a,b}.db with
 * the verdicts, so reader.py can run the Python reader on the same inputs.
 *
 *     npm run build:all   (dist/ must be this commit's)
 *     node spikes/2026-10-18-owner-author/ab/run.mjs
 *     python spikes/2026-10-18-owner-author/ab/reader.py
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, existsSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { rewriteReplicated } from "../../../dist/replicated.js";
import { adoptReplica, canonicalDump, changeEntity, createEntity, pendingBatches, recordSeal, signBatch, verifyBatches } from "../../../dist/dai-merge.js";
import { mergeSibling, mergeTablesOf } from "../../../dist/replicated-frame.js";
import { authorIdOf, signBytes } from "../../../dist/identity.js";
import { sessionIdOf, withoutTriggers } from "../../../scripts/sealer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });

const DOC = "5e1f0a2b-0d3c-4e5f-8a9b-182a10c0ffee";
// The receipts example's shape: a plain ("passable") replicated document, no session, no seats.
const SCHEMA = `-- dai:replicated
CREATE TABLE receipts (
  store TEXT NOT NULL,
  cents INTEGER NOT NULL
);
`;
const E1 = new Uint8Array(16).fill(0x11);
const E2 = new Uint8Array(16).fill(0x22);
const E3 = new Uint8Array(16).fill(0x33);
const E4 = new Uint8Array(16).fill(0x44);
const hex = (b) => Buffer.from(b).toString("hex");

/** A fresh author: ES256, private key non-extractable, author id from the public key. */
async function newAuthor() {
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const pub = new Uint8Array(await webcrypto.subtle.exportKey("raw", keys.publicKey));
  return { keys, pub, author: await authorIdOf(pub), extractable: keys.privateKey.extractable };
}

function open(path) {
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.function("dai_session_id", { deterministic: true }, sessionIdOf);
  db.exec(rewriteReplicated(SCHEMA).sql);
  const rows = {
    all: (sql, params = []) => db.prepare(sql).all(...params),
    run: (sql, params = []) => void db.prepare(sql).run(...params),
    close: () => db.close(),
    path,
  };
  rows.tables = mergeTablesOf(rows);
  return rows;
}

function asReplica(db, id) {
  db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [id]);
  db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [id]);
}

/** Seals what `person` has pending, as a leave does. */
async function seal(db, person) {
  const sign = async (header) => ({ sig: await signBytes(person.keys.privateKey, header), pub: person.pub });
  for (const batch of pendingBatches(db, person.author, db.tables)) recordSeal(db, await signBatch(batch, { document: DOC, sign }));
}

/** `to` becomes a copy of `from`'s file: every header and row, and `from`'s replica row as it stands. */
function receiveFile(to, from) {
  for (const header of from.all("SELECT * FROM _dai_batch")) {
    const names = Object.keys(header);
    to.run(`INSERT INTO _dai_batch (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => header[n]));
  }
  for (const row of from.all("SELECT * FROM receipts")) {
    const names = Object.keys(row);
    to.run(`INSERT INTO receipts (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => row[n]));
  }
  const theirs = from.all("SELECT id, seq, lc FROM _dai_replica")[0];
  withoutTriggers(to, ["_dai_replica__kept", "_dai_replica__one"], () => {
    to.run("DELETE FROM _dai_replica");
    to.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, ?, ?)", [theirs.id, theirs.seq, theirs.lc]);
  });
  to.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [theirs.id]);
}

async function verdictsOf(db) {
  const found = {};
  for (const [id, v] of await verifyBatches(db, db.tables, DOC)) found[id] = v.ok ? (v.complete ? "ok" : "incomplete") : v.reason;
  return found;
}

/** What a person and an app would see, from the views the apps read. */
function views(db) {
  const q = (sql) => db.all(sql);
  return {
    own: hex(db.all("SELECT id FROM _dai_replica")[0].id),
    rows: q("SELECT lower(hex(_r_replica)) || ':' || _r_seq AS id, lower(hex(_r_entity)) AS entity, store, cents, _r_parents AS parents, _r_lc AS lc, lower(hex(_r_batch)) AS batch FROM receipts ORDER BY 1"),
    heads: q("SELECT lower(hex(_r_replica)) || ':' || _r_seq AS id, lower(hex(_r_entity)) AS entity, store, cents, _r_deleted AS deleted FROM receipts_heads ORDER BY 2, 1"),
    current: q("SELECT lower(hex(_r_replica)) || ':' || _r_seq AS id, lower(hex(_r_entity)) AS entity, store, cents, _r_conflicted AS conflicted FROM receipts_current ORDER BY 2"),
    conflicts: q("SELECT lower(hex(_r_entity)) AS entity, heads, head_ids FROM receipts_conflicts ORDER BY 1"),
    equivocated: q("SELECT lower(hex(author)) AS author, tbl, seq FROM _dai_equivocated ORDER BY 1, 2, 3"),
  };
}

const short = (r) => r;

/** Exchange both ways from the state each copy holds now (a snapshot, so neither merge sees the other's result). */
async function exchange(name, a, b, authorA, authorB) {
  const snapA = join(out, `${name}-a.db`);
  const snapB = join(out, `${name}-b.db`);
  for (const [db, path] of [[a, snapA], [b, snapB]]) {
    if (existsSync(path)) rmSync(path);
    db.run(`VACUUM INTO '${path.replaceAll("\\", "/")}'`);
  }
  const verdicts = { a: await verdictsOf(a), b: await verdictsOf(b) };
  copyFileSync(snapB, join(out, `${name}-sibB.db`));
  copyFileSync(snapA, join(out, `${name}-sibA.db`));
  const reopen = (p) => {
    const db = new DatabaseSync(p);
    db.function("dai_session_id", { deterministic: true }, sessionIdOf);
    const rows = { all: (s, ps = []) => db.prepare(s).all(...ps), run: (s, ps = []) => void db.prepare(s).run(...ps), close: () => db.close() };
    rows.tables = mergeTablesOf(rows);
    return rows;
  };
  const fromB = reopen(join(out, `${name}-sibB.db`));
  const fromA = reopen(join(out, `${name}-sibA.db`));
  const ab = await mergeSibling(a, fromB, { document: DOC, author: authorA });
  const ba = await mergeSibling(b, fromA, { document: DOC, author: authorB });
  fromA.close(); fromB.close();
  rmSync(join(out, `${name}-sibA.db`)); rmSync(join(out, `${name}-sibB.db`));
  const dumpA = canonicalDump(a, a.tables);
  const dumpB = canonicalDump(b, b.tables);
  writeFileSync(join(out, `${name}-verdicts.json`), `${JSON.stringify({ doc: DOC, ...verdicts }, null, 2)}\n`);
  return { ab: short(ab), ba: short(ba), converged: dumpA === dumpB, a: views(a), b: views(b) };
}

const report = {};

// ---- A: one key, two contexts --------------------------------------------
{
  const shared = await newAuthor();
  const a = open(join(out, "A-live-a.db"));
  const b = open(join(out, "A-live-b.db"));
  asReplica(a, shared.author);
  createEntity(a, "receipts", E1, { store: "base", cents: 100 });
  await seal(a, shared);
  receiveFile(b, a); // context 2 holds the same document and, under the rejected design, the same key
  const nA = Number(a.all("SELECT seq FROM _dai_replica")[0].seq) + 1;
  const nB = Number(b.all("SELECT seq FROM _dai_replica")[0].seq) + 1;
  // Offline, each context writes at its next seq.
  createEntity(a, "receipts", E2, { store: "written in Safari", cents: 250 });
  createEntity(b, "receipts", E3, { store: "written in the installed app", cents: 975 });
  await seal(a, shared);
  await seal(b, shared);
  report.A = { author: hex(shared.author), privateKeyExtractable: shared.extractable, seqAllocated: { a: nA, b: nB }, ...(await exchange("A", a, b, shared.author, shared.author)) };
  a.close(); b.close();
}

// ---- B: two keys, one plain replicated document --------------------------
for (const part of ["i", "ii"]) {
  const ada = await newAuthor();
  const bo = await newAuthor();
  const a = open(join(out, `B${part}-live-a.db`));
  const b = open(join(out, `B${part}-live-b.db`));
  asReplica(a, ada.author);
  createEntity(a, "receipts", E1, { store: "base one", cents: 100 });
  createEntity(a, "receipts", E2, { store: "base two", cents: 200 });
  await seal(a, ada);
  receiveFile(b, a);
  adoptReplica(b, bo.author); // the second context is itself (its own author key)
  if (part === "i") {
    changeEntity(a, "receipts", E1, { store: "one, edited in Safari", cents: 111 });
    changeEntity(b, "receipts", E2, { store: "two, edited in the app", cents: 222 });
    createEntity(a, "receipts", E3, { store: "new in Safari", cents: 300 });
    createEntity(b, "receipts", E4, { store: "new in the app", cents: 400 });
  } else {
    changeEntity(a, "receipts", E1, { store: "one, edited in Safari", cents: 111 });
    changeEntity(b, "receipts", E1, { store: "one, edited in the app", cents: 199 });
  }
  await seal(a, ada);
  await seal(b, bo);
  report[`B${part}`] = { authors: { a: hex(ada.author), b: hex(bo.author) }, ...(await exchange(`B${part}`, a, b, ada.author, bo.author)) };
  a.close(); b.close();
}

writeFileSync(join(out, "runtime-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
