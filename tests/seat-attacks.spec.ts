import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { authorIdOf, mintPersonKey, rawPublicKey, showAuthorId } from "../src/identity.js";
import { rewriteReplicated } from "../src/replicated.js";
import { decodeBatch, encodeBatch, pendingBatches, recordSeal, signBatch, stageBatch } from "../src/replicated-batch.js";
import { mergeSibling, mergeTablesOf } from "../src/replicated-frame.js";
import { applyRow, confirmSeat, createEntity, ensureReplica, startSession, type Rows } from "../src/replicated-rows.js";
import { SESSION_ID_FUNCTION, sessionIdOf } from "../src/session-id.js";
// @ts-ignore the chess fixture is plain JavaScript, with no types
import { Store } from "./fixture/chess/store.js";

/**
 * The attacks that broke the first seat model (cold review of identity step 5).
 *
 * Each test is an attack a joiner can make with rows alone, and asserts what a
 * sound seat model must answer. Bo is the joiner and holds the open seat
 * honestly; everything he does beyond that is the attack. Ada is the creator.
 *
 * `honestRoster` is the one part of this file that follows the seat model: it
 * builds the session every attack starts from, the way the kit would. The
 * attack rows and the assertions do not depend on the model.
 */

const SCHEMA = `-- dai:profile session max_parties=2 close=creator
-- dai:replicated
CREATE TABLE games (
  title TEXT NOT NULL
);
-- dai:replicated seat=seat
CREATE TABLE moves (
  seat BLOB,
  san TEXT NOT NULL
);
`;

function openWith(schema: string): Rows & { close(): void } {
  const db = new DatabaseSync(":memory:");
  db.function(SESSION_ID_FUNCTION, { deterministic: true }, (author, nonce) => sessionIdOf(author, nonce));
  db.exec(rewriteReplicated(schema).sql);
  return {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
}

const bytes = (byte: number): Uint8Array => new Uint8Array(16).fill(byte);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ADA = bytes(0xc0); // the creator
const BO = bytes(0x10); // the joiner; his id sorts below Ada's
const NONCE = bytes(0x07); // on Ada's own seat row
const S = sessionIdOf(ADA, NONCE)!; // the session, which commits to Ada
const ADA_SEAT = bytes(0xa1);
const OPEN_SEAT = bytes(0xa2);

let counter = 0;
const nextEntity = (): Uint8Array => {
  counter += 1;
  const e = new Uint8Array(16);
  e[0] = 0x30;
  e[15] = counter;
  return e;
};

function put(
  db: Rows,
  table: string,
  author: Uint8Array,
  seq: number,
  lc: number,
  columns: Record<string, unknown>,
  o: { entity?: Uint8Array; batch?: Uint8Array } = {},
): Uint8Array {
  const entity = o.entity ?? nextEntity();
  applyRow(db, table, {
    _r_replica: author,
    _r_seq: seq,
    _r_lc: lc,
    _r_entity: entity,
    _r_parents: "[]",
    _r_deleted: 0,
    _r_session: S,
    ...(o.batch ? { _r_batch: o.batch } : {}),
    columns,
  });
  return entity;
}

/** A header this copy holds for an author's rows, so they count as signed here. */
function signedBy(db: Rows, author: Uint8Array, id: number): Uint8Array {
  const batch = bytes(id);
  db.run(
    "INSERT INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, 1, x'00', x'00', NULL, 1, ?, '[]')",
    [batch, author, new Uint8Array(32)],
  );
  return batch;
}

/**
 * Ada's session with Bo in the open seat, as the kit leaves it: her own seat
 * carrying the nonce the session id commits to, the open seat, Bo's ask for it,
 * and Ada's confirmation. Returns the entity of Ada's own seat row. Ada's rows
 * use seqs 1–3 and Bo's seq 1. `own` is the copy's own author; the rows are
 * signed only when `sign` says.
 */
function honestRoster(db: Rows, own: Uint8Array | null, sign?: { ada: Uint8Array; bo: Uint8Array }): Uint8Array {
  if (own) {
    db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [own]);
  }
  const adaSeat = put(db, "_dai_seat", ADA, 1, 1, { seat: ADA_SEAT, nonce: NONCE }, { batch: sign?.ada });
  put(db, "_dai_seat", ADA, 2, 2, { seat: OPEN_SEAT, nonce: null }, { batch: sign?.ada });
  put(db, "_dai_binding", BO, 1, 3, { seat: OPEN_SEAT }, { batch: sign?.bo });
  put(db, "_dai_confirm", ADA, 3, 4, { seat: OPEN_SEAT, holder: BO }, { batch: sign?.ada });
  return adaSeat;
}

const admitted = (db: Rows): string[] => db.all("SELECT san FROM moves_current ORDER BY san").map((r) => String(r["san"]));
const creators = (db: Rows): string[] => db.all("SELECT lower(hex(replica)) AS r FROM _dai_creator").map((r) => String(r["r"]));

test.describe("a joiner's binding to the creator's seat takes nothing", () => {
  test("backdated, and merged into the creator's copy: her move stands, his is not admitted, and the merge says so", async () => {
    const ada = openWith(SCHEMA);
    honestRoster(ada, ADA);
    put(ada, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" });

    const bo = openWith(SCHEMA);
    honestRoster(bo, BO);
    // Bo binds Ada's seat at a clock before any of hers, then plays White.
    put(bo, "_dai_binding", BO, 2, 0, { seat: ADA_SEAT });
    put(bo, "moves", BO, 3, 7, { seat: ADA_SEAT, san: "Qh5" });

    const report = await mergeSibling(ada, bo);
    expect(admitted(ada), "Ada's e4 stands and Bo's White move is not admitted").toEqual(["e4"]);
    expect(report.refusedBatches, "the merge names Bo's move as not his seat's").toContainEqual({
      author: showAuthorId(BO),
      reason: "SEAT_NOT_HELD",
    });
    ada.close();
    bo.close();
  });

  test("at the creator's own clock, with an author id that sorts first: her move stands", () => {
    const db = openWith(SCHEMA);
    honestRoster(db, ADA);
    put(db, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" });
    put(db, "_dai_binding", BO, 2, 3, { seat: ADA_SEAT });
    put(db, "moves", BO, 3, 6, { seat: ADA_SEAT, san: "Qh5" });
    expect(admitted(db)).toEqual(["e4"]);
    db.close();
  });
});

test.describe("a joiner's seat row does not make the joiner the creator", () => {
  test("backdated and unsigned: Ada is still the creator, and a move for Bo's own seat is not admitted", () => {
    const db = openWith(SCHEMA);
    honestRoster(db, ADA);
    put(db, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" });
    const MINE = bytes(0xb7);
    put(db, "_dai_seat", BO, 2, -5, { seat: MINE });
    put(db, "_dai_binding", BO, 3, -4, { seat: MINE });
    put(db, "moves", BO, 4, 7, { seat: MINE, san: "Nc6" });
    expect(creators(db), "the creator is Ada").toEqual([hex(ADA)]);
    expect(admitted(db), "Bo's move for a seat he minted is not admitted").toEqual(["e4"]);
    db.close();
  });

  test("backdated with every row signed: Ada is still the creator", () => {
    const db = openWith(SCHEMA);
    const sign = { ada: signedBy(db, ADA, 0xe1), bo: signedBy(db, BO, 0xe2) };
    honestRoster(db, null, sign);
    put(db, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" }, { batch: sign.ada });
    put(db, "_dai_seat", BO, 2, 0, { seat: bytes(0xb7) }, { batch: sign.bo });
    expect(creators(db)).toEqual([hex(ADA)]);
    expect(admitted(db)).toEqual(["e4"]);
    db.close();
  });
});

test("a member's version of the creator's seat entity voids none of her moves", () => {
  const db = openWith(SCHEMA);
  const adaSeat = honestRoster(db, ADA);
  put(db, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" });
  put(db, "moves", ADA, 5, 8, { seat: ADA_SEAT, san: "Nf3" });
  expect(admitted(db)).toEqual(["Nf3", "e4"]);
  // Bo writes a new version of Ada's seat row, same value, at a clock between her moves.
  put(db, "_dai_seat", BO, 2, 6, { seat: ADA_SEAT }, { entity: adaSeat });
  expect(admitted(db), "both of Ada's moves stand").toEqual(["Nf3", "e4"]);
  db.close();
});

/*
 * The second cold review of the seat model (39e35ab..c997bd4). Every row the
 * attacker writes below is signed with the attacker's own key and merged
 * through mergeSibling, so nothing depends on the unsigned legacy rule, except
 * the one test labeled as the unsigned hole. A test marked test.fail is a hole
 * still open; its note names the backlog entry whose fix flips it.
 *
 * The schema is the chess fixture's shape, and a game's moves are read by the
 * chess fixture's own Store (tests/fixture/chess/store.js), not a copy of its
 * SQL: what an attack does to a game is what chess would show.
 */
const DOC = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const GAME_SCHEMA = `-- dai:profile session max_parties=2 close=any
-- dai:replicated
CREATE TABLE games (
  title TEXT NOT NULL
);
-- dai:replicated seat=seat
CREATE TABLE moves (
  seat BLOB,
  game_id TEXT NOT NULL,
  ply INTEGER,
  color TEXT,
  from_sq TEXT,
  to_sq TEXT,
  promotion TEXT,
  san TEXT NOT NULL,
  draw_offer INTEGER
);
`;

type Copy = Rows & { close(): void };
function openGame(): Copy {
  const db = new DatabaseSync(":memory:");
  db.function(SESSION_ID_FUNCTION, { deterministic: true }, (a, n) => sessionIdOf(a, n));
  db.exec(rewriteReplicated(GAME_SCHEMA).sql);
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
  const pub = await rawPublicKey(keys.publicKey);
  const author = await authorIdOf(pub);
  return { keys, author, shown: showAuthorId(author) };
}
type Person = Awaited<ReturnType<typeof person>>;
const rnd = (): Uint8Array => crypto.getRandomValues(new Uint8Array(16));

/** Seal everything this author has not sealed, with their own key: an honest signature. */
async function seal(db: Rows, who: Person): Promise<void> {
  for (const batch of pendingBatches(db, who.author, mergeTablesOf(db))) {
    recordSeal(db, await signBatch(batch, { document: DOC, keys: who.keys }));
  }
}
const merge = (into: Rows, from: Rows, who: Person) => mergeSibling(into, from, { document: DOC, author: who.author });

/**
 * What chess shows for game g1 of a session: the fixture Store's own moves(g),
 * admitted rows only (the copy reading is nobody, so none of its pending rows).
 */
const gameMoves = (db: Rows, session: Uint8Array): string[] => {
  (globalThis as { window?: unknown }).window = { daiKit: { author: () => null } };
  const store = new Store({ selectObjects: (sql: string, bind?: unknown[]) => db.all(sql, bind ?? []) }, null);
  const rows = store.moves({ id: "g1", session: hex(session) }) as Record<string, unknown>[];
  return rows.map((r) => `${r["san"]}@${String(r["seat"]).slice(0, 4)}by${String(r["replica"]).slice(0, 4)}`);
};

/**
 * Ada's game, as the kit leaves it: her session, Bo asked and was confirmed,
 * Ada plays e4 from her seat. Every row signed by its author. Returns both copies,
 * converged.
 */
async function honestGame(ada: Person, bo: Person) {
  const adaCopy = openGame();
  ensureReplica(adaCopy, ada.author);
  const creatorSeat = rnd();
  const openSeat = rnd();
  const session = startSession(adaCopy, { nonce: rnd(), creatorSeat, openSeat, entities: [rnd(), rnd()] });
  createEntity(adaCopy, "games", rnd(), { title: "Ada v Bo" }, session);
  await seal(adaCopy, ada);

  const boCopy = openGame();
  ensureReplica(boCopy, bo.author);
  await merge(boCopy, adaCopy, bo);
  createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  await seal(boCopy, bo);
  await merge(adaCopy, boCopy, ada);
  confirmSeat(adaCopy, session, openSeat, bo.author, rnd());
  const e4 = createEntity(adaCopy, "moves", rnd(), { seat: creatorSeat, game_id: "g1", san: "e4" }, session);
  await seal(adaCopy, ada);
  await merge(boCopy, adaCopy, bo);
  return { adaCopy, boCopy, session, creatorSeat, openSeat, e4 };
}

test.describe("cold review 2: a seat value is not scoped to its session", () => {
  test("a stranger mints a session of his own whose creator seat has the value of Ada's seat, and plays White in her game", async () => {
    const ada = await person();
    const bo = await person();
    const { adaCopy, boCopy, creatorSeat, session } = await honestGame(ada, bo);

    // Mallory never asked for any seat in Ada's session. He holds a copy (a forwarded file).
    const mal = await person();
    const malCopy = openGame();
    ensureReplica(malCopy, mal.author);
    await merge(malCopy, adaCopy, mal);
    // His own session S2 = H(mal || nonce): he is its creator, and he picks his seat's bytes.
    const nonce = rnd();
    const s2 = sessionIdOf(mal.author, nonce)!;
    createEntity(malCopy, "_dai_seat", rnd(), { seat: creatorSeat, nonce }, s2);
    createEntity(malCopy, "moves", rnd(), { seat: creatorSeat, game_id: "g1", san: "Qh5" }, s2);
    await seal(malCopy, mal);

    const report = await merge(adaCopy, malCopy, ada);
    console.log("cross-session report:", JSON.stringify(report));
    console.log("Ada's game g1 after the merge:", JSON.stringify(gameMoves(adaCopy, session)));
    console.log("Ada's creator seat:", hex(creatorSeat).slice(0, 4), "mal:", hex(mal.author).slice(0, 4));
    // What a sound seat model must answer: only Ada's e4 acts for Ada's seat in g1.
    expect(gameMoves(adaCopy, session), "only Ada's move acts for Ada's seat").toEqual([
      `e4@${hex(creatorSeat).slice(0, 4)}by${hex(ada.author).slice(0, 4)}`,
    ]);
    // His move is admitted, in his own session: a game of his, which is his to play.
    expect(gameMoves(adaCopy, s2)).toEqual([`Qh5@${hex(creatorSeat).slice(0, 4)}by${hex(mal.author).slice(0, 4)}`]);
    adaCopy.close();
    boCopy.close();
    malCopy.close();
  });

  test("a stranger with no seat anywhere in Ada's session supersedes her move from a session of his own", async () => {
    const ada = await person();
    const bo = await person();
    const { adaCopy, boCopy, e4, session } = await honestGame(ada, bo);
    const mal = await person();
    const malCopy = openGame();
    ensureReplica(malCopy, mal.author);
    await merge(malCopy, adaCopy, mal);
    const nonce = rnd();
    const s2 = sessionIdOf(mal.author, nonce)!;
    const malSeat = rnd();
    createEntity(malCopy, "_dai_seat", rnd(), { seat: malSeat, nonce }, s2);
    // A new version of Ada's e4 entity, naming her row as its parent, in Mallory's session, deleted.
    const st = malCopy.all("SELECT seq, lc FROM _dai_replica")[0]!;
    applyRow(malCopy, "moves", {
      _r_replica: mal.author,
      _r_seq: Number(st["seq"]) + 1,
      _r_lc: Number(st["lc"]) + 1,
      _r_entity: e4._r_entity,
      _r_parents: JSON.stringify([`${hex(ada.author)}:${e4._r_seq}`]),
      _r_deleted: 1,
      _r_session: s2,
      columns: { seat: malSeat, game_id: "g1", san: "e4" },
    });
    malCopy.run("UPDATE _dai_replica SET seq = seq + 1, lc = lc + 1");
    await seal(malCopy, mal);

    const report = await merge(adaCopy, malCopy, ada);
    console.log("supersede report:", JSON.stringify(report));
    console.log("Ada's game g1 after the merge:", JSON.stringify(gameMoves(adaCopy, session)));
    expect(gameMoves(adaCopy, session), "Ada's e4 stands").toHaveLength(1);
    expect(report.refusedBatches, "the merge names the version from another session").toContainEqual({
      author: mal.shown,
      reason: "ENTITY_OTHER_SESSION",
    });
    adaCopy.close();
    boCopy.close();
    malCopy.close();
  });
});

test.describe("cold review 2: the same attacks as a mailbox batch (encode, decode, stage, merge, as applyBatch does)", () => {
  test("Bo's signed batch of rows in his own session, carrying a White move for Ada's game, arrives by mailbox and is admitted", async () => {
    const ada = await person();
    const bo = await person();
    const { adaCopy, boCopy, creatorSeat, session } = await honestGame(ada, bo);
    const nonce = rnd();
    const s2 = sessionIdOf(bo.author, nonce)!;
    createEntity(boCopy, "_dai_seat", rnd(), { seat: creatorSeat, nonce }, s2);
    createEntity(boCopy, "moves", rnd(), { seat: creatorSeat, game_id: "g1", san: "Qh5" }, s2);
    const tables = mergeTablesOf(boCopy);
    const batches = pendingBatches(boCopy, bo.author, tables);
    let last: unknown = null;
    for (const batch of batches) {
      const bytes = encodeBatch(await signBatch(batch, { document: DOC, keys: bo.keys }));
      const staged = openGame();
      stageBatch(staged, decodeBatch(bytes), tables);
      last = await merge(adaCopy, staged, ada);
      staged.close();
    }
    console.log("mailbox batches:", batches.length, "report:", JSON.stringify(last));
    console.log("mailbox: Ada's game g1:", JSON.stringify(gameMoves(adaCopy, session)));
    expect(gameMoves(adaCopy, session).filter((m) => m.startsWith("Qh5")), "no White move by Bo").toEqual([]);
    adaCopy.close();
    boCopy.close();
  });
});

test.describe("cold review 2: a seated joiner and the creator's rows", () => {
  test("Bo, seated in the open seat, deletes Ada's e4 with a version naming his own seat", async () => {
    test.fail(true, "D132 flips this: in a seated table a row supersedes only rows of its own seat and session");
    const ada = await person();
    const bo = await person();
    const { adaCopy, boCopy, openSeat, e4, session } = await honestGame(ada, bo);
    const st = boCopy.all("SELECT seq, lc FROM _dai_replica")[0]!;
    applyRow(boCopy, "moves", {
      _r_replica: bo.author,
      _r_seq: Number(st["seq"]) + 1,
      _r_lc: Number(st["lc"]) + 1,
      _r_entity: e4._r_entity,
      _r_parents: JSON.stringify([`${hex(ada.author)}:${e4._r_seq}`]),
      _r_deleted: 1,
      _r_session: session,
      columns: { seat: openSeat, game_id: "g1", san: "e4" },
    });
    boCopy.run("UPDATE _dai_replica SET seq = seq + 1, lc = lc + 1");
    await seal(boCopy, bo);
    const report = await merge(adaCopy, boCopy, ada);
    console.log("joiner-delete report:", JSON.stringify(report));
    console.log("Ada's game g1 after the merge:", JSON.stringify(gameMoves(adaCopy, session)));
    expect(gameMoves(adaCopy, session), "Ada's e4 stands").toHaveLength(1);
    adaCopy.close();
    boCopy.close();
  });
});

test.describe("cold review 2: an unsigned row in the seat tables (D133)", () => {
  test("an unsigned confirm under Ada's id, merged before she confirms, seats nobody and is refused", async () => {
    const ada = await person();
    const adaCopy = openGame();
    ensureReplica(adaCopy, ada.author);
    const creatorSeat = rnd();
    const openSeat = rnd();
    const session = startSession(adaCopy, { nonce: rnd(), creatorSeat, openSeat, entities: [rnd(), rnd()] });
    await seal(adaCopy, ada);
    const bo = await person();
    const boCopy = openGame();
    const before = "(no confirm yet)";

    const mal = await person();
    const malCopy = openGame();
    ensureReplica(malCopy, mal.author);
    await merge(malCopy, adaCopy, mal);
    applyRow(malCopy, "_dai_confirm", {
      _r_replica: ada.author,
      _r_seq: 100,
      _r_lc: 100,
      _r_entity: rnd(),
      _r_parents: "[]",
      _r_deleted: 0,
      _r_session: session,
      columns: { seat: openSeat, holder: mal.author },
    });
    const report = await merge(adaCopy, malCopy, ada);
    const holder = adaCopy.all("SELECT lower(hex(replica)) AS r, since FROM _dai_holder WHERE seat = ?", [openSeat]);
    console.log("unsigned-confirm report:", JSON.stringify(report));
    console.log("before:", JSON.stringify(before), "after:", JSON.stringify(gameMoves(adaCopy, session)));
    console.log("open seat holder now:", JSON.stringify(holder), "bo:", hex(bo.author), "mal:", hex(mal.author));
    expect(holder.map((h) => h["r"]), "nobody holds the open seat but by Ada's signed confirm").toEqual([]);
    expect(report.refusedBatches, "the merge names the unsigned row by the id it claims").toContainEqual({ author: ada.shown, reason: "BATCH_UNSIGNED" });
    adaCopy.close();
    boCopy.close();
    malCopy.close();
  });
});

test.describe("cold review 2: Q2, a confirm replayed from session A into session B", () => {
  test("Bo copies Ada's signed confirm for A into B, keeping and then dropping its batch", async () => {
    const ada = await person();
    const bo = await person();
    const adaCopy = openGame();
    ensureReplica(adaCopy, ada.author);
    const seatsA = { creatorSeat: rnd(), openSeat: rnd() };
    const a = startSession(adaCopy, { nonce: rnd(), ...seatsA, entities: [rnd(), rnd()] });
    const openB = rnd();
    const b = startSession(adaCopy, { nonce: rnd(), creatorSeat: rnd(), openSeat: openB, entities: [rnd(), rnd()] });
    const confirmRow = createEntity(adaCopy, "_dai_confirm", rnd(), { seat: seatsA.openSeat, holder: bo.author }, a);
    await seal(adaCopy, ada);

    for (const keepBatch of [true, false]) {
      // The sibling: every row Ada's copy holds, but her A confirm rewritten into session B.
      const sib = openGame();
      ensureReplica(sib, bo.author);
      await merge(sib, adaCopy, bo);
      const stored = sib.all("SELECT _r_batch FROM _dai_confirm WHERE _r_replica = ? AND _r_seq = ?", [ada.author, confirmRow._r_seq])[0]!;
      sib.run("DROP TRIGGER _dai_confirm__no_update");
      sib.run("DROP TRIGGER _dai_confirm__sealed_once");
      sib.run("UPDATE _dai_confirm SET _r_session = ?, seat = ?, _r_batch = ? WHERE _r_replica = ? AND _r_seq = ?", [
        b,
        seatsA.openSeat,
        keepBatch ? stored["_r_batch"] : null,
        ada.author,
        confirmRow._r_seq,
      ]);
      if (!keepBatch) {
        for (const t of mergeTablesOf(sib)) {
          sib.run(`DROP TRIGGER IF EXISTS "${t}__sealed_once"`);
          sib.run(`UPDATE "${t}" SET _r_batch = NULL`);
        }
        sib.run("DELETE FROM _dai_batch");
      }
      // Carol's copy of B only: B's two seat rows, nothing of A.
      const carol = openGame();
      ensureReplica(carol, rnd());
      const report = await merge(carol, sib, bo);
      const heldInB = carol.all("SELECT lower(hex(seat)) AS s, lower(hex(replica)) AS r FROM _dai_holder WHERE session = ? AND replica = ?", [b, bo.author]);
      console.log(`replay keepBatch=${keepBatch}:`, JSON.stringify(report.refusedBatches), "Bo holds in B:", JSON.stringify(heldInB));
      expect(heldInB, "a confirm carried into another session seats nobody there").toEqual([]);
      expect(report.refusedBatches, "and the merge says why").toContainEqual({
        author: ada.shown,
        reason: keepBatch ? "BATCH_DIGEST_MISMATCH" : "BATCH_UNSIGNED",
      });
      sib.close();
      carol.close();
    }
    adaCopy.close();
  });
});

test.describe("cold review 2: Q1, schema tricks", () => {
  for (const [name, extra] of [
    ["an author table named _dai_confirm", "-- dai:replicated\nCREATE TABLE _dai_confirm (seat BLOB, holder BLOB);\n"],
    ["an author table marked seat= naming a column called _r_replica", "-- dai:replicated seat=_r_replica\nCREATE TABLE t2 (x TEXT);\n"],
    ["a plain view named _dai_holder ahead of the kit's", "CREATE VIEW _dai_holder AS SELECT 1 AS session, 1 AS seat, 1 AS replica, 0 AS since;\n"],
  ] as const) {
    test(name, () => {
      let outcome: string;
      try {
        const sql = rewriteReplicated(GAME_SCHEMA.replace("-- dai:replicated\nCREATE TABLE games", `${extra}-- dai:replicated\nCREATE TABLE games`)).sql;
        const db = new DatabaseSync(":memory:");
        db.function(SESSION_ID_FUNCTION, { deterministic: true }, (a, n) => sessionIdOf(a, n));
        db.exec(sql);
        const holderSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = '_dai_holder'").get() as { sql: string } | undefined;
        const confirmSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = '_dai_confirm'").get() as { sql: string } | undefined;
        const n = (db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE sql LIKE '%CREATE TABLE%_dai_confirm%'").get() as { n: number }).n;
        outcome = `built; _dai_holder is ${holderSql?.sql.includes("_dai_confirm f") ? "the kit's" : "NOT the kit's"}; _dai_confirm tables ${n}; holder NOT NULL CHECK kept: ${/holder BLOB NOT NULL CHECK/.test(confirmSql?.sql ?? "")}`;
      } catch (error) {
        outcome = `refused: ${String((error as Error).message).slice(0, 160)}`;
      }
      console.log(`schema trick (${name}):`, outcome);
      expect(outcome.startsWith("refused") || outcome.includes("is the kit's;")).toBe(true);
    });
  }
});

test.describe("cold review 2: Q2, a confirm and its binding", () => {
  test("a confirm with no binding and for a seat Ada never minted still seats its holder", async () => {
    const ada = await person();
    const adaCopy = openGame();
    ensureReplica(adaCopy, ada.author);
    const creatorSeat = rnd();
    const openSeat = rnd();
    const session = startSession(adaCopy, { nonce: rnd(), creatorSeat, openSeat, entities: [rnd(), rnd()] });
    const cara = rnd();
    const nowhere = rnd();
    confirmSeat(adaCopy, session, nowhere, cara, rnd());
    const holders = adaCopy.all("SELECT lower(hex(seat)) AS s, lower(hex(replica)) AS r FROM _dai_holder WHERE lower(hex(seat)) = ?", [hex(nowhere)]);
    const open_ = adaCopy.all("SELECT 1 FROM _dai_open_seat WHERE seat = ?", [nowhere]);
    console.log("holder of an unminted seat:", JSON.stringify(holders), "is it an open seat:", open_.length);
    expect(holders).toHaveLength(1);
    adaCopy.close();
  });
});

test.describe("cold review 2: Q3, what a waiting joiner and an offline creator read", () => {
  // The kit's reads (src/kit.ts mySeat, amCreator, seats, pendingSeat), their SQL verbatim, on the host id.
  const mySeat = (db: Rows, s: string, id: string) =>
    db.all("SELECT lower(hex(seat)) AS seat FROM _dai_holder WHERE lower(hex(session)) = ? AND lower(hex(replica)) = ? ORDER BY since LIMIT 1", [s, id])[0]?.["seat"] ?? null;
  const amCreator = (db: Rows, s: string, id: string) =>
    db.all("SELECT 1 AS x FROM _dai_creator WHERE lower(hex(session)) = ? AND lower(hex(replica)) = ?", [s, id]).length > 0;
  const pendingSeat = (db: Rows, s: string, id: string) =>
    mySeat(db, s, id)
      ? null
      : (db.all(
          "SELECT lower(hex(b.seat)) AS seat FROM _dai_binding_current b JOIN _dai_open_seat s ON s.session = b._r_session AND s.seat = b.seat " +
            "WHERE lower(hex(b._r_session)) = ? AND lower(hex(b._r_replica)) = ? " +
            "AND NOT EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = s.session AND h.seat = s.seat) LIMIT 1",
          [s, id],
        )[0]?.["seat"] ?? null);
  const seats = (db: Rows, s: string) => [
    ...db.all("SELECT DISTINCT lower(hex(seat)) AS seat, lower(hex(replica)) AS holder, 1 AS creator FROM _dai_creator WHERE lower(hex(session)) = ?", [s]),
    ...db.all(
      "SELECT lower(hex(s.seat)) AS seat, lower(hex(h.replica)) AS holder, 0 AS creator FROM _dai_open_seat s LEFT JOIN _dai_holder h ON h.session = s.session AND h.seat = s.seat WHERE lower(hex(s.session)) = ?",
      [s],
    ),
  ];

  test("a joiner offline after asking, and the creator offline after inviting", async () => {
    const ada = await person();
    const bo = await person();
    const adaCopy = openGame();
    ensureReplica(adaCopy, ada.author);
    const creatorSeat = rnd();
    const openSeat = rnd();
    const session = startSession(adaCopy, { nonce: rnd(), creatorSeat, openSeat, entities: [rnd(), rnd()] });
    createEntity(adaCopy, "moves", rnd(), { seat: creatorSeat, game_id: "g1", san: "e4" }, session);
    await seal(adaCopy, ada);
    const s = hex(session);
    const a = hex(ada.author);
    const b = hex(bo.author);
    console.log("CREATOR offline:", JSON.stringify({ mySeat: mySeat(adaCopy, s, a), pendingSeat: pendingSeat(adaCopy, s, a), amCreator: amCreator(adaCopy, s, a), seats: seats(adaCopy, s), shown: gameMoves(adaCopy, session) }));

    const boCopy = openGame();
    ensureReplica(boCopy, bo.author);
    await merge(boCopy, adaCopy, bo);
    createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
    createEntity(boCopy, "moves", rnd(), { seat: openSeat, game_id: "g1", san: "e5" }, session);
    // A move for Ada's seat while waiting, too.
    createEntity(boCopy, "moves", rnd(), { seat: creatorSeat, game_id: "g1", san: "Nf6" }, session);
    await seal(boCopy, bo);
    const pending = boCopy.all("SELECT san FROM moves_pending").map((r) => r["san"]);
    const unseated = boCopy.all("SELECT lower(hex(_r_replica)) AS r FROM moves_unseated").length;
    console.log("JOINER waiting:", JSON.stringify({ mySeat: mySeat(boCopy, s, b), pendingSeat: pendingSeat(boCopy, s, b), amCreator: amCreator(boCopy, s, b), seats: seats(boCopy, s), current: gameMoves(boCopy, session), pending, unseated }));
    expect(pendingSeat(boCopy, s, b)).toBe(hex(openSeat));
    adaCopy.close();
    boCopy.close();
  });
});
