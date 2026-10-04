import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { authorIdOf, mintPersonKey, rawPublicKey, showAuthorId } from "../src/identity.js";
import { rewriteReplicated } from "../src/replicated.js";
import { decodeBatch, encodeBatch, pendingBatches, recordSeal, signBatch, stageBatch } from "../src/replicated-batch.js";
import { mergeSibling, mergeTablesOf } from "../src/replicated-frame.js";
import {
  applyRow,
  changeEntity,
  confirmSeat,
  createEntity,
  deleteEntity,
  ensureReplica,
  sessionsOf,
  startSession,
  type ReplicatedRow,
  type Rows,
} from "../src/replicated-rows.js";
import * as replicatedRows from "../src/replicated-rows.js";
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
 *
 * The attacks on the runtime's write gates, which need a document frame, are
 * in `tests/seat-gate-*.spec.ts`. They are kept apart so this file runs on node
 * alone: the project a spec runs in is chosen by the words in it (D110).
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
  db.function(SESSION_ID_FUNCTION, { deterministic: true }, (author, seq, seat, seats, close) => sessionIdOf(author, seq, seat, seats, close));
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
/** The seq this copy stamps its next row with: a creator's seat row is named by it (D158). */
const nextSeq = (db: Rows): number => Number(db.all("SELECT seq FROM _dai_replica")[0]!["seq"]) + 1;

const ADA_SEAT = bytes(0xa1);
const OPEN_SEAT = bytes(0xa2);
// The session, which names Ada's seat row (her seq 1) and the roster it declares (R15).
const S = sessionIdOf(ADA, 1, ADA_SEAT, OPEN_SEAT, "creator")!;
/** The same session under close=any: the close rule is the creator's seat row's, and the id hashes it (R14, R15). */
const S_ANY = sessionIdOf(ADA, 1, ADA_SEAT, OPEN_SEAT, "any")!;
/** Each copy's session, when its roster declares close=any; S otherwise. */
const sessionOn = new WeakMap<object, Uint8Array>();

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
    _r_session: sessionOn.get(db) ?? S,
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
 * Ada's session with Bo in the open seat: her creator's seat row, which the
 * session id names by its seq (1), declaring her seat and the open seat (R14);
 * Bo's ask for it, and Ada's confirmation. Her seq 2 is a seat row that counts
 * for nothing. Returns the entity of Ada's own seat row. Ada's rows use seqs
 * 1–3 and Bo's seq 1. `own` is the copy's own author; the rows are
 * signed only when `sign` says.
 */
function honestRoster(db: Rows, own: Uint8Array | null, sign?: { ada: Uint8Array; bo: Uint8Array }, close: "any" | "creator" = "creator"): Uint8Array {
  if (own) {
    db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [own]);
  }
  if (close === "any") sessionOn.set(db, S_ANY);
  const adaSeat = put(db, "_dai_seat", ADA, 1, 1, { seat: ADA_SEAT, seats: OPEN_SEAT, close }, { batch: sign?.ada });
  put(db, "_dai_seat", ADA, 2, 2, { seat: OPEN_SEAT }, { batch: sign?.ada });
  put(db, "_dai_binding", BO, 1, 3, { seat: OPEN_SEAT }, { batch: sign?.bo });
  put(db, "_dai_confirm", ADA, 3, 4, { seat: OPEN_SEAT, holder: BO }, { batch: sign?.ada });
  return adaSeat;
}

const admitted = (db: Rows): string[] => db.all("SELECT san FROM moves_current ORDER BY san").map((r) => String(r["san"]));
const creators = (db: Rows): string[] => db.all("SELECT lower(hex(replica)) AS r FROM _dai_creator").map((r) => String(r["r"]));

test.describe("a joiner's binding to the creator's seat takes nothing", () => {
  test("backdated, and merged into the creator's copy: her move stands, his is not admitted, and the merge says so", async () => {
    // Signed with Bo's own key: at batch format version 2 an unsigned row is
    // refused before admission is asked (BATCH_UNSIGNED), and this is about
    // what admission does with a joiner's honest signature on a hostile row.
    const ada = await person();
    const bo = await person();
    const { adaCopy, boCopy, session, creatorSeat } = await honestGame(ada, bo);
    // Bo binds Ada's seat at a clock before any of hers, then plays White.
    raw(boCopy, bo, "_dai_binding", { entity: rnd(), lc: 0, session, columns: { seat: creatorSeat } });
    raw(boCopy, bo, "moves", { entity: rnd(), lc: 7, session, columns: { seat: creatorSeat, game_id: "g1", san: "Qh5" } });
    await seal(boCopy, bo);

    const report = await merge(adaCopy, boCopy, ada);
    expect(admitted(adaCopy), "Ada's e4 stands and Bo's White move is not admitted").toEqual(["e4"]);
    expect(report.refusedBatches, "the merge names Bo's move as not his seat's").toContainEqual({
      author: bo.shown,
      reason: "SEAT_NOT_HELD",
    });
    adaCopy.close();
    boCopy.close();
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
function openGame(schema = GAME_SCHEMA): Copy {
  const db = new DatabaseSync(":memory:");
  db.function(SESSION_ID_FUNCTION, { deterministic: true }, (a, n, seat, seats, close) => sessionIdOf(a, n, seat, seats, close));
  db.exec(rewriteReplicated(schema).sql);
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
  const seatEntities: [Uint8Array, Uint8Array] = [rnd(), rnd()];
  const session = startSession(adaCopy, { creatorSeat, openSeats: [openSeat], close: "any", entity: seatEntities[0] });
  const game = createEntity(adaCopy, "games", rnd(), { title: "Ada v Bo" }, session);
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
  return { adaCopy, boCopy, session, creatorSeat, openSeat, e4, game, seatEntities };
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
    // His own session S2 = H(mal || the seq of his seat row): he is its creator, and he picks his seat's bytes.
    const s2 = startSession(malCopy, { creatorSeat: creatorSeat, openSeats: [rnd()], close: "any", entity: rnd() });
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
    const malSeat = rnd();
    const s2 = startSession(malCopy, { creatorSeat: malSeat, openSeats: [rnd()], close: "any", entity: rnd() });
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
    const s2 = startSession(boCopy, { creatorSeat: creatorSeat, openSeats: [rnd()], close: "any", entity: rnd() });
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
    expect(report.refusedBatches, "the merge names Bo's version as not his seat's").toContainEqual({
      author: bo.shown,
      reason: "SEAT_NOT_HELD",
    });
    adaCopy.close();
    boCopy.close();
  });

  test("Ada's own version of her move, in her seat and session, still replaces it (D132's other half)", async () => {
    const ada = await person();
    const bo = await person();
    const { adaCopy, boCopy, e4, session } = await honestGame(ada, bo);
    deleteEntity(adaCopy, "moves", e4._r_entity, e4._r_session);
    await seal(adaCopy, ada);
    expect(gameMoves(adaCopy, session), "her own delete takes her move back").toEqual([]);
    const report = await merge(boCopy, adaCopy, bo);
    expect(report.refusedBatches).toEqual([]);
    expect(gameMoves(boCopy, session), "and every copy agrees").toEqual([]);
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
    const session = startSession(adaCopy, { creatorSeat, openSeats: [openSeat], close: "any", entity: rnd() });
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
    const a = startSession(adaCopy, { creatorSeat: seatsA.creatorSeat, openSeats: [seatsA.openSeat], close: "any", entity: rnd() });
    const openB = rnd();
    const b = startSession(adaCopy, { creatorSeat: rnd(), openSeats: [openB], close: "any", entity: rnd() });
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
    // D165's views: an author's own would decide which seats are void.
    ["a plain view named _dai_confirmed ahead of the kit's", "CREATE VIEW _dai_confirmed AS SELECT 1 AS session, 1 AS seat, 1 AS holder, 1 AS seq, 1 AS creator;\n"],
    ["a plain view named _dai_voided ahead of the kit's", "CREATE VIEW _dai_voided AS SELECT 1 AS session, 1 AS seat, 1 AS creator WHERE 0;\n"],
    ["a plain view named _dai_contested ahead of the kit's", "CREATE VIEW _dai_contested AS SELECT 1 AS session, 1 AS seat, 0 AS voided WHERE 0;\n"],
  ] as const) {
    test(name, () => {
      let outcome: string;
      try {
        const sql = rewriteReplicated(GAME_SCHEMA.replace("-- dai:replicated\nCREATE TABLE games", `${extra}-- dai:replicated\nCREATE TABLE games`)).sql;
        const db = new DatabaseSync(":memory:");
        db.function(SESSION_ID_FUNCTION, { deterministic: true }, (a, n, seat, seats, close) => sessionIdOf(a, n, seat, seats, close));
        db.exec(sql);
        const holderSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = '_dai_holder'").get() as { sql: string } | undefined;
        const confirmSql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = '_dai_confirm'").get() as { sql: string } | undefined;
        const n = (db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE sql LIKE '%CREATE TABLE%_dai_confirm%'").get() as { n: number }).n;
        // The kit's holder reads the kit's confirms, and those read the kit's table (D165 put a step between,
        // and R18 a first pass that the close rules read). The steps are the roster chain's, inside the view.
        const kits = Boolean(
          holderSql?.sql.includes("FROM confirmed f") && holderSql.sql.includes("FROM confirmed0 f") && holderSql.sql.includes("FROM _dai_confirm f"),
        );
        outcome = `built; _dai_holder is ${kits ? "the kit's" : "NOT the kit's"}; _dai_confirm tables ${n}; holder NOT NULL CHECK kept: ${/holder BLOB NOT NULL CHECK/.test(confirmSql?.sql ?? "")}`;
      } catch (error) {
        outcome = `refused: ${String((error as Error).message).slice(0, 160)}`;
      }
      console.log(`schema trick (${name}):`, outcome);
      expect(outcome.startsWith("refused") || outcome.includes("is the kit's;")).toBe(true);
    });
  }
});

test.describe("cold review 2: Q2, a confirm and its binding", () => {
  // R11 (the eighth attack review): a confirm counts only for a seat the
  // creator minted, so this hole, recorded here as found, is closed.
  test("a confirm with no binding and for a seat Ada never minted seats nobody", async () => {
    const ada = await person();
    const adaCopy = openGame();
    ensureReplica(adaCopy, ada.author);
    const creatorSeat = rnd();
    const openSeat = rnd();
    const session = startSession(adaCopy, { creatorSeat, openSeats: [openSeat], close: "any", entity: rnd() });
    const cara = rnd();
    const nowhere = rnd();
    confirmSeat(adaCopy, session, nowhere, cara, rnd());
    const holders = adaCopy.all("SELECT lower(hex(seat)) AS s, lower(hex(replica)) AS r FROM _dai_holder WHERE lower(hex(seat)) = ?", [hex(nowhere)]);
    const open_ = adaCopy.all("SELECT 1 FROM _dai_open_seat WHERE seat = ?", [nowhere]);
    console.log("holder of an unminted seat:", JSON.stringify(holders), "is it an open seat:", open_.length);
    expect(holders).toHaveLength(0);
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
            "AND NOT EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = s.session AND h.seat = s.seat) " +
            "AND NOT EXISTS (SELECT 1 FROM _dai_voided v WHERE v.session = s.session AND v.seat = s.seat) LIMIT 1",
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
    const session = startSession(adaCopy, { creatorSeat, openSeats: [openSeat], close: "any", entity: rnd() });
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

/*
 * The third cold review, at the seams of D131 to D133: admission partitions an
 * entity by (session, entity), and in a seated table by seat too, while the
 * honest writers (changeEntity, deleteEntity, reseat) and t_pending found an
 * entity's heads by its id alone, through the stored _r_superseded flag. One
 * legitimate row reusing an id in another partition then turned an honest
 * write into a row every copy refuses. A test marked test.fail is a hole still
 * open; its note names the entry whose fix flips it.
 */

/** A row under this copy's own author with a chosen clock and parents, signed later by seal: honestly signed, dishonestly shaped. */
function raw(
  db: Rows,
  who: Person,
  table: string,
  o: { entity: Uint8Array; lc: number; parents?: string[]; deleted?: number; session: Uint8Array; columns: Record<string, unknown> },
): ReplicatedRow {
  const st = db.all("SELECT seq, lc FROM _dai_replica")[0]!;
  const row: ReplicatedRow = {
    _r_replica: who.author,
    _r_seq: Number(st["seq"]) + 1,
    _r_lc: o.lc,
    _r_entity: o.entity,
    _r_parents: JSON.stringify(o.parents ?? []),
    _r_deleted: o.deleted ?? 0,
    _r_session: o.session,
    columns: o.columns,
  };
  applyRow(db, table, row);
  db.run("UPDATE _dai_replica SET seq = seq + 1, lc = max(lc, ?)", [o.lc]);
  return row;
}

const titles = (db: Rows, session: Uint8Array) =>
  db.all("SELECT title FROM games_current WHERE _r_session = ? ORDER BY title", [session]).map((r) => String(r["title"]));

/** The kit's contest read: a contested open seat, not voided (`_dai_contested`, D165), which it sets aside for a new session (R14). */
const contestedSeats = (db: Rows, session: Uint8Array) =>
  db.all(
    "SELECT s.seat AS seat FROM _dai_open_seat s JOIN _dai_contested c ON c.session = s.session AND c.seat = s.seat " +
      "WHERE s.session = ? AND c.voided = 0 LIMIT 1",
    [session],
  );

test.describe("cold review 3: a stranger's row in his own session reusing a game's entity id", () => {
  for (const lc of [1, 1_000_000]) {
    test(`at lc ${lc}, Ada's honest rename of her game is admitted and nothing of hers is reported`, async () => {
      const ada = await person();
      const bo = await person();
      const { adaCopy, boCopy, session, game } = await honestGame(ada, bo);
      const mal = await person();
      const malCopy = openGame();
      ensureReplica(malCopy, mal.author);
      await merge(malCopy, adaCopy, mal);
      const s2 = startSession(malCopy, { creatorSeat: rnd(), openSeats: [rnd()], close: "any", entity: rnd() });
      // A new entity in his own session that carries Ada's game's id (D134's parentless reuse).
      raw(malCopy, mal, "games", { entity: game._r_entity, lc, session: s2, columns: { title: "Mallory's game" } });
      await seal(malCopy, mal);
      await merge(adaCopy, malCopy, ada);

      // Ada renames her game through the ordinary write path (chess: store.rename, then change).
      changeEntity(adaCopy, "games", game._r_entity, { title: "Ada v Bo, renamed" }, game._r_session);
      await seal(adaCopy, ada);
      const report = await merge(boCopy, adaCopy, bo);
      // And again, as a person would retry.
      changeEntity(adaCopy, "games", game._r_entity, { title: "Ada v Bo, again" }, game._r_session);

      expect(titles(adaCopy, session), "Ada's rename of her own game is admitted").toEqual(["Ada v Bo, again"]);
      expect(titles(boCopy, session), "and Bo sees her first rename").toEqual(["Ada v Bo, renamed"]);
      expect(report.refusedBatches.filter((r) => r.author === ada.shown), "nothing of Ada's is reported").toEqual([]);
      adaCopy.close();
      boCopy.close();
      malCopy.close();
    });
  }

  test("merged in either order across three copies, the game converges", async () => {
    const ada = await person();
    const bo = await person();
    const { adaCopy, boCopy, game } = await honestGame(ada, bo);
    const mal = await person();
    const malCopy = openGame();
    ensureReplica(malCopy, mal.author);
    await merge(malCopy, adaCopy, mal);
    raw(malCopy, mal, "games", { entity: game._r_entity, lc: 5, session: rnd(), columns: { title: "M" } });
    await seal(malCopy, mal);
    await merge(adaCopy, malCopy, ada);
    changeEntity(adaCopy, "games", game._r_entity, { title: "renamed" }, game._r_session);
    await seal(adaCopy, ada);
    // Bo takes Ada's copy first, then Mallory's; a fresh copy takes Mallory's first, then Ada's.
    await merge(boCopy, adaCopy, bo);
    await merge(boCopy, malCopy, bo);
    const other = openGame();
    ensureReplica(other, (await person()).author);
    await merge(other, malCopy, mal);
    await merge(other, adaCopy, ada);
    const dump = (db: Rows) => JSON.stringify(db.all("SELECT hex(_r_session) AS s, title FROM games_current ORDER BY s, title"));
    expect(dump(boCopy)).toBe(dump(adaCopy));
    expect(dump(other)).toBe(dump(adaCopy));
    adaCopy.close();
    boCopy.close();
    malCopy.close();
    other.close();
  });
});

test("cold review 3: a row of another session reusing the creator's seat row's entity id changes nothing in her session", async () => {
  const ada = await person();
  const bo = await person();
  const cy = await person();
  const adaCopy = openGame();
  ensureReplica(adaCopy, ada.author);
  const openSeat = rnd();
  const seatEntities: [Uint8Array, Uint8Array] = [rnd(), rnd()];
  const session = startSession(adaCopy, { creatorSeat: rnd(), openSeats: [openSeat], close: "any", entity: seatEntities[0] });
  await seal(adaCopy, ada);
  // The invite reaches Bo and Cy: a contested seat. Cy is also the attacker.
  const boCopy = openGame();
  ensureReplica(boCopy, bo.author);
  await merge(boCopy, adaCopy, bo);
  createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  await seal(boCopy, bo);
  const cyCopy = openGame();
  ensureReplica(cyCopy, cy.author);
  await merge(cyCopy, adaCopy, cy);
  createEntity(cyCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  // Signed with her own key: a seat row in some other session reusing the creator's seat row's entity id, far ahead in clock.
  raw(cyCopy, cy, "_dai_seat", { entity: seatEntities[0], lc: 1_000_000, session: rnd(), columns: { seat: rnd() } });
  await seal(cyCopy, cy);
  await merge(adaCopy, boCopy, ada);
  await merge(adaCopy, cyCopy, ada);

  // No seat is reseated (R14): the session's open seats are the ones its
  // creator's seat row declares, whatever another row reusing its id says.
  const contested = contestedSeats(adaCopy, session);
  expect(contested.length, "the seat is contested").toBe(1);
  const open = adaCopy.all("SELECT lower(hex(seat)) AS s FROM _dai_open_seat WHERE session = ?", [session]).map((r) => r["s"]);
  expect(open, "Ada's session has the open seat her creator's seat row declares, and only it").toEqual([hex(openSeat)]);
  adaCopy.close();
  boCopy.close();
  cyCopy.close();
});

test.describe("cold review 3: a seated player's row in his own seat reusing the other seat's entity id", () => {
  for (const lc of [1, 1_000_000]) {
    test(`at lc ${lc}, Ada's delete of her own e4 takes it back and nothing of hers is reported`, async () => {
      const ada = await person();
      const bo = await person();
      const { adaCopy, boCopy, session, openSeat, e4 } = await honestGame(ada, bo);
      // Bo, seated honestly, writes a move for his own seat: a new entity that carries e4's id.
      raw(boCopy, bo, "moves", { entity: e4._r_entity, lc, session, columns: { seat: openSeat, game_id: "g1", san: "e5" } });
      await seal(boCopy, bo);
      await merge(adaCopy, boCopy, ada);

      deleteEntity(adaCopy, "moves", e4._r_entity, e4._r_session);
      await seal(adaCopy, ada);
      const report = await merge(boCopy, adaCopy, bo);
      const sans = (db: Rows) => db.all("SELECT san FROM moves_current ORDER BY san").map((r) => String(r["san"]));
      expect(sans(adaCopy), "Ada's e4 is gone by her own delete, and Bo's row stands").toEqual(["e5"]);
      expect(sans(boCopy), "on Bo's copy too").toEqual(["e5"]);
      expect(report.refusedBatches.filter((r) => r.author === ada.shown), "nothing of Ada's is reported").toEqual([]);
      adaCopy.close();
      boCopy.close();
    });
  }
});

test("cold review 3: the creator's row in her own seat naming a waiting joiner's move leaves it on his screen", async () => {
  const ada = await person();
  const bo = await person();
  const adaCopy = openGame();
  ensureReplica(adaCopy, ada.author);
  const creatorSeat = rnd();
  const openSeat = rnd();
  const session = startSession(adaCopy, { creatorSeat, openSeats: [openSeat], close: "any", entity: rnd() });
  await seal(adaCopy, ada);
  const boCopy = openGame();
  ensureReplica(boCopy, bo.author);
  await merge(boCopy, adaCopy, bo);
  createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  const m = createEntity(boCopy, "moves", rnd(), { seat: openSeat, game_id: "g1", san: "e5" }, session);
  await seal(boCopy, bo);
  await merge(adaCopy, boCopy, ada);
  // Ada, not confirming yet, writes a tombstone in her own seat naming Bo's waiting move.
  raw(adaCopy, ada, "moves", {
    entity: m._r_entity,
    lc: 50,
    parents: [`${hex(bo.author)}:${m._r_seq}`],
    deleted: 1,
    session,
    columns: { seat: creatorSeat, game_id: "g1", san: "e5" },
  });
  await seal(adaCopy, ada);
  await merge(boCopy, adaCopy, bo);
  const pending = boCopy.all("SELECT san FROM moves_pending").map((r) => String(r["san"]));
  expect(pending, "Bo's waiting move is still on his own screen").toEqual(["e5"]);
  adaCopy.close();
  boCopy.close();
});

test("cold review 3: a waiting joiner's change of his own waiting move versions it, and it is admitted once he is confirmed", async () => {
  const ada = await person();
  const bo = await person();
  const adaCopy = openGame();
  ensureReplica(adaCopy, ada.author);
  const openSeat = rnd();
  const session = startSession(adaCopy, { creatorSeat: rnd(), openSeats: [openSeat], close: "any", entity: rnd() });
  await seal(adaCopy, ada);
  const boCopy = openGame();
  ensureReplica(boCopy, bo.author);
  await merge(boCopy, adaCopy, bo);
  createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  const m = createEntity(boCopy, "moves", rnd(), { seat: openSeat, game_id: "g1", san: "e5" }, session);
  // Bo's heads come from moves_pending, his own waiting rows: nothing admits them yet.
  const changed = changeEntity(boCopy, "moves", m._r_entity, { seat: openSeat, game_id: "g1", san: "e6" }, m._r_session);
  expect(hex(changed._r_session!), "the change stays in the game's session").toBe(hex(session));
  expect(boCopy.all("SELECT san FROM moves_pending").map((r) => String(r["san"])), "his screen shows the new version only").toEqual(["e6"]);
  await seal(boCopy, bo);
  await merge(adaCopy, boCopy, ada);
  confirmSeat(adaCopy, session, openSeat, bo.author, rnd());
  expect(adaCopy.all("SELECT san FROM moves_current").map((r) => String(r["san"])), "once confirmed, the new version is the move").toEqual(["e6"]);
  adaCopy.close();
  boCopy.close();
});

test("cold review 3: a waiting joiner's rename of the creator's game waits with him, and stands once he is confirmed", async () => {
  const ada = await person();
  const bo = await person();
  const adaCopy = openGame();
  ensureReplica(adaCopy, ada.author);
  const openSeat = rnd();
  const session = startSession(adaCopy, { creatorSeat: rnd(), openSeats: [openSeat], close: "any", entity: rnd() });
  const game = createEntity(adaCopy, "games", rnd(), { title: "Ada v Bo" }, session);
  await seal(adaCopy, ada);
  const boCopy = openGame();
  ensureReplica(boCopy, bo.author);
  await merge(boCopy, adaCopy, bo);
  createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  // Bo waits in the session, not yet a member: the game's head is Ada's, admitted, in a session he waits in.
  const renamed = changeEntity(boCopy, "games", game._r_entity, { title: "Ada v Bo, renamed" }, game._r_session);
  expect(hex(renamed._r_session!), "the rename stays in the game's session").toBe(hex(session));
  expect(boCopy.all("SELECT title FROM games_pending").map((r) => String(r["title"])), "it waits on his screen").toEqual(["Ada v Bo, renamed"]);
  await seal(boCopy, bo);
  await merge(adaCopy, boCopy, ada);
  confirmSeat(adaCopy, session, openSeat, bo.author, rnd());
  expect(titles(adaCopy, session), "once he is confirmed, the rename is the game's name").toEqual(["Ada v Bo, renamed"]);
  adaCopy.close();
  boCopy.close();
});

test("cold review 3, as ruled (D134): an id named with a session it has no row in is refused, never moved there", async () => {
  const ada = await person();
  const adaCopy = openGame();
  ensureReplica(adaCopy, ada.author);
  const s1 = startSession(adaCopy, { creatorSeat: rnd(), openSeats: [rnd()], close: "any", entity: rnd() });
  const s2 = startSession(adaCopy, { creatorSeat: rnd(), openSeats: [rnd()], close: "any", entity: rnd() });
  const game = createEntity(adaCopy, "games", rnd(), { title: "first" }, s1);
  expect(() => changeEntity(adaCopy, "games", game._r_entity, { title: "moved" }, s2), "a rename in the other session").toThrow(/nothing to change/);
  expect(() => deleteEntity(adaCopy, "games", game._r_entity, s2), "nor a delete").toThrow(/nothing to change/);
  expect(titles(adaCopy, s1)).toEqual(["first"]);
  expect(titles(adaCopy, s2)).toEqual([]);
  adaCopy.close();
});

test("batch format version 2 (D134): a row's key is (session, entity), so a write names its session and nothing is guessed", async () => {
  const ada = await person();
  const adaCopy = openGame();
  ensureReplica(adaCopy, ada.author);
  const s1 = startSession(adaCopy, { creatorSeat: rnd(), openSeats: [rnd()], close: "any", entity: rnd() });
  const s2 = startSession(adaCopy, { creatorSeat: rnd(), openSeats: [rnd()], close: "any", entity: rnd() });
  const game = createEntity(adaCopy, "games", rnd(), { title: "first" }, s1);
  createEntity(adaCopy, "games", game._r_entity, { title: "second" }, s2);
  const change = changeEntity as (...args: unknown[]) => unknown;
  const remove = deleteEntity;
  change(adaCopy, "games", game._r_entity, { title: "first, renamed" }, s1);
  expect(titles(adaCopy, s1), "the write went to the session it named").toEqual(["first, renamed"]);
  expect(titles(adaCopy, s2)).toEqual(["second"]);
  remove(adaCopy, "games", game._r_entity, s2);
  expect(titles(adaCopy, s2), "and the delete to its").toEqual([]);
  expect(titles(adaCopy, s1)).toEqual(["first, renamed"]);
  expect(() => change(adaCopy, "games", game._r_entity, { title: "which?" }), "an id alone names no row in a session table").toThrow(/session/i);
  adaCopy.close();
});

test("batch format version 2 (D134): chess finds a game by its session and its id, so a stranger's game reusing the id is never the one shown", async () => {
  // Chess's own games table, and the local one its game list reads beside it.
  const chess =
    "-- dai:profile session max_parties=2 close=any\n-- dai:replicated\n" +
    "CREATE TABLE games (white_name TEXT NOT NULL, black_name TEXT NOT NULL, creator_color TEXT NOT NULL, initial_fen TEXT NOT NULL);\n" +
    "CREATE TABLE local_games (game_id TEXT, is_demo INTEGER, hidden INTEGER);\n";
  const names = (white: string) => ({ white_name: white, black_name: "", creator_color: "w", initial_fen: "" });
  const ada = await person();
  const adaCopy = openGame(chess);
  ensureReplica(adaCopy, ada.author);
  const session = startSession(adaCopy, { creatorSeat: rnd(), openSeats: [rnd()], close: "any", entity: rnd() });
  const game = createEntity(adaCopy, "games", rnd(), names("Ada"), session);
  await seal(adaCopy, ada);
  const mal = await person();
  const malCopy = openGame(chess);
  ensureReplica(malCopy, mal.author);
  await merge(malCopy, adaCopy, mal);
  const s2 = startSession(malCopy, { creatorSeat: rnd(), openSeats: [rnd()], close: "any", entity: rnd() });
  // A new entity in his own session that carries Ada's game's id (D134's parentless reuse).
  raw(malCopy, mal, "games", { entity: game._r_entity, lc: 1, session: s2, columns: names("Mallory") });
  await seal(malCopy, mal);
  await merge(adaCopy, malCopy, ada);
  (globalThis as { window?: unknown }).window = { daiKit: { author: () => hex(ada.author) } };
  const store = new Store({ selectObjects: (sql: string, bind?: unknown[]) => adaCopy.all(sql, bind ?? []) }, null);
  const games = store.games() as { id: string; key: string; session: string; white_name: string }[];
  expect(games.map((g) => g.white_name).sort(), "two games share one id, in two sessions").toEqual(["Ada", "Mallory"]);
  expect(new Set(games.map((g) => g.id)).size).toBe(1);
  for (const g of games) {
    expect(store.gameById(g.key)?.white_name, `the game keyed ${g.key} is its own`).toBe(g.white_name);
  }
  adaCopy.close();
  malCopy.close();
});

/*
 * The fourth cold review, of D135's fix: what a waiting joiner's writes version.
 * Two faces of one class, the stored _r_superseded flag still read as truth
 * (D140, D141), and three writer seams (D142 to D144). A test marked test.fail
 * is a hole still open; its note names the entry whose fix flips it.
 */

const pendingSans = (db: Rows) => db.all("SELECT san FROM moves_pending ORDER BY san").map((r) => String(r["san"]));
const currentSans = (db: Rows) => db.all("SELECT san FROM moves_current ORDER BY san").map((r) => String(r["san"]));
const rowId = (r: ReplicatedRow) => `${hex(r._r_replica)}:${r._r_seq}`;
const gameHeads = (db: Rows, session: Uint8Array) =>
  Number(db.all("SELECT count(*) AS n FROM games_heads WHERE _r_session = ?", [session])[0]!["n"]);
const writeError = (write: () => unknown): string => {
  try {
    write();
    return "";
  } catch (e) {
    return String(e);
  }
};

/** Ada's session, her game and her e4; Bo (and Cy, when asked) ask for the open seat and wait. */
async function waitingGame(o: { cy?: boolean } = {}) {
  const ada = await person();
  const bo = await person();
  const cy = await person();
  const adaCopy = openGame();
  ensureReplica(adaCopy, ada.author);
  const creatorSeat = rnd();
  const openSeat = rnd();
  const session = startSession(adaCopy, { creatorSeat, openSeats: [openSeat], close: "any", entity: rnd() });
  const game = createEntity(adaCopy, "games", rnd(), { title: "Ada v Bo" }, session);
  createEntity(adaCopy, "moves", rnd(), { seat: creatorSeat, game_id: "g1", san: "e4" }, session);
  await seal(adaCopy, ada);
  const boCopy = openGame();
  ensureReplica(boCopy, bo.author);
  await merge(boCopy, adaCopy, bo);
  const boBinding = createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  await seal(boCopy, bo);
  const cyCopy = openGame();
  ensureReplica(cyCopy, cy.author);
  if (o.cy) {
    await merge(cyCopy, adaCopy, cy);
    createEntity(cyCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
    await seal(cyCopy, cy);
  }
  const close = () => [adaCopy, boCopy, cyCopy].forEach((c) => c.close());
  return { ada, bo, cy, adaCopy, boCopy, cyCopy, session, creatorSeat, openSeat, game, boBinding, close };
}

/** A binding row in a session the writer mints for itself, reusing the id of Bo's binding and naming it as the earlier version. */
async function bindingInOwnSession(db: Copy, who: Person, boBinding: ReplicatedRow): Promise<void> {
  const own = startSession(db, { creatorSeat: rnd(), openSeats: [rnd()], close: "any", entity: rnd() });
  raw(db, who, "_dai_binding", { entity: boBinding._r_entity, lc: 5, parents: [rowId(boBinding)], session: own, columns: { seat: rnd() } });
  await seal(db, who);
}

test("cold review 4: a rival asker's binding in her own session, naming Bo's, does not make the contested seat hers", async () => {
  const w = await waitingGame({ cy: true });
  await merge(w.cyCopy, w.boCopy, w.cy);
  await bindingInOwnSession(w.cyCopy, w.cy, w.boBinding);
  await merge(w.adaCopy, w.boCopy, w.ada);
  await merge(w.adaCopy, w.cyCopy, w.ada);
  // The kit's confirmSeats query (src/kit.ts): it confirms an open seat exactly one author asked for.
  const asked = w.adaCopy.all(
    "SELECT min(lower(hex(b._r_replica))) AS who, count(DISTINCT b._r_replica) AS n FROM _dai_open_seat s " +
      "JOIN _dai_creator c ON c.session = s.session AND lower(hex(c.replica)) = ? " +
      "JOIN _dai_binding_current b ON b._r_session = s.session AND b.seat = s.seat " +
      "WHERE NOT EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = s.session AND h.seat = s.seat) " +
      "AND NOT EXISTS (SELECT 1 FROM _dai_voided v WHERE v.session = s.session AND v.seat = s.seat) " +
      "GROUP BY s.session, s.seat",
    [hex(w.ada.author)],
  );
  expect(asked.map((r) => Number(r["n"])), "two asked for the seat: it is contested, and the kit seats nobody").toEqual([2]);
  expect(contestedSeats(w.adaCopy, w.session), "and Ada's copy sets it aside for a new session").toHaveLength(1);
  w.close();
});

test("cold review 4: a stranger's binding in her own session, naming Bo's, leaves Bo waiting", async () => {
  const w = await waitingGame();
  const m = createEntity(w.boCopy, "moves", rnd(), { seat: w.openSeat, game_id: "g1", san: "e5" }, w.session);
  await seal(w.boCopy, w.bo);
  const mal = await person();
  const malCopy = openGame();
  ensureReplica(malCopy, mal.author);
  await merge(malCopy, w.boCopy, mal);
  await bindingInOwnSession(malCopy, mal, w.boBinding);
  await merge(w.boCopy, malCopy, w.bo);
  expect.soft(pendingSans(w.boCopy), "Bo's waiting move is still on his screen").toEqual(["e5"]);
  const err = writeError(() => changeEntity(w.boCopy, "moves", m._r_entity, { seat: w.openSeat, game_id: "g1", san: "e6" }, m._r_session));
  expect.soft(err, "and he can still change it").toBe("");
  malCopy.close();
  w.close();
});

test("cold review 4: a rival asker's tombstone of Bo's waiting move leaves it on his screen, and his to change", async () => {
  const w = await waitingGame({ cy: true });
  const m = createEntity(w.boCopy, "moves", rnd(), { seat: w.openSeat, game_id: "g1", san: "e5" }, w.session);
  await seal(w.boCopy, w.bo);
  await merge(w.cyCopy, w.boCopy, w.cy);
  raw(w.cyCopy, w.cy, "moves", {
    entity: m._r_entity,
    lc: 50,
    parents: [rowId(m)],
    deleted: 1,
    session: w.session,
    columns: { seat: w.openSeat, game_id: "g1", san: "e5" },
  });
  await seal(w.cyCopy, w.cy);
  await merge(w.boCopy, w.cyCopy, w.bo);
  expect.soft(pendingSans(w.boCopy), "Bo's waiting move is still on his screen").toEqual(["e5"]);
  const err = writeError(() => changeEntity(w.boCopy, "moves", m._r_entity, { seat: w.openSeat, game_id: "g1", san: "e6" }, m._r_session));
  expect.soft(err, "and he can change it, as he can once seated").toBe("");
  w.close();
});

test("cold review 4: a rival asker's row naming Bo's waiting rename does not fork his next one", async () => {
  const w = await waitingGame({ cy: true });
  const first = changeEntity(w.boCopy, "games", w.game._r_entity, { title: "Bo one" }, w.game._r_session);
  await seal(w.boCopy, w.bo);
  await merge(w.cyCopy, w.boCopy, w.cy);
  raw(w.cyCopy, w.cy, "games", { entity: w.game._r_entity, lc: 50, parents: [rowId(first)], session: w.session, columns: { title: "Cy" } });
  await seal(w.cyCopy, w.cy);
  await merge(w.boCopy, w.cyCopy, w.bo);
  const second = changeEntity(w.boCopy, "games", w.game._r_entity, { title: "Bo two" }, w.game._r_session);
  await seal(w.boCopy, w.bo);
  await merge(w.adaCopy, w.boCopy, w.ada);
  confirmSeat(w.adaCopy, w.session, w.openSeat, w.bo.author, rnd());
  expect.soft(JSON.parse(second._r_parents as string), "his second rename versions his first").toEqual([rowId(first)]);
  expect.soft(gameHeads(w.adaCopy, w.session), "once he is confirmed, the game has one head").toBe(1);
  expect.soft(titles(w.adaCopy, w.session)).toEqual(["Bo two"]);
  w.close();
});

test("cold review 4: a waiting delete then rename chains as it does seated", async () => {
  const w = await waitingGame();
  const tombstone = deleteEntity(w.boCopy, "games", w.game._r_entity, w.game._r_session);
  const renamed = changeEntity(w.boCopy, "games", w.game._r_entity, { title: "back, by Bo" }, w.game._r_session);
  await seal(w.boCopy, w.bo);
  await merge(w.adaCopy, w.boCopy, w.ada);
  confirmSeat(w.adaCopy, w.session, w.openSeat, w.bo.author, rnd());
  expect.soft(JSON.parse(renamed._r_parents as string), "the rename versions his tombstone").toEqual([rowId(tombstone)]);
  expect.soft(gameHeads(w.adaCopy, w.session), "once he is confirmed, the game has one head").toBe(1);
  w.close();
});

test("cold review 4: a change naming a seat other than its head's is refused, not silently dropped", async () => {
  const w = await waitingGame();
  await merge(w.adaCopy, w.boCopy, w.ada);
  confirmSeat(w.adaCopy, w.session, w.openSeat, w.bo.author, rnd());
  await seal(w.adaCopy, w.ada);
  await merge(w.boCopy, w.adaCopy, w.bo);
  const m = createEntity(w.boCopy, "moves", rnd(), { seat: w.openSeat, game_id: "g1", san: "e5" }, w.session);
  const err = writeError(() => changeEntity(w.boCopy, "moves", m._r_entity, { seat: w.creatorSeat, game_id: "g1", san: "e6" }, m._r_session));
  expect(err, "Bo's change naming Ada's seat is refused by name").toMatch(/SEAT_NOT_HELD/);
  expect(currentSans(w.boCopy)).toEqual(["e4", "e5"]);
  w.close();
});

/*
 * The fifth cold review, of D140 to D144: the close table is the roster
 * sibling that never got the seat treatment. Who may end a session is the
 * same question as who may move (D145 to D147), and two small ones beside it
 * (D148, D149). A test marked test.fail is a hole still open; its note names
 * the entry whose fix flips it.
 */

const closeSchema = (close: "any" | "creator") => SCHEMA.replace("close=creator", `close=${close}`);
const CY = bytes(0x20); // a stranger: holds a copy, never a seat

/** Ada and Bo seated, one move each, both admitted, under the given close rule. */
function closeGame(close: "any" | "creator") {
  const db = openWith(closeSchema(close));
  honestRoster(db, ADA, undefined, close);
  put(db, "moves", ADA, 4, 5, { seat: ADA_SEAT, san: "e4" });
  put(db, "moves", BO, 2, 6, { seat: OPEN_SEAT, san: "e5" });
  return db;
}

/** The sessions this copy calls closed, as the host and the apps read it (`_dai_closed`). */
const closedSessions = (db: Rows): string[] => db.all("SELECT lower(hex(session)) AS s FROM _dai_closed").map((r) => String(r["s"]));

test.describe("cold review 5: a close counts only from an author the session's rule permits", () => {
  test("close=any: a stranger's close row in the session makes nobody's move late", () => {
    const db = closeGame("any");
    put(db, "_dai_close", CY, 1, 9, {});
    expect(admitted(db), "a non-member's close decides nothing").toEqual(["e4", "e5"]);
    expect(closedSessions(db), "and the session is not closed").toEqual([]);
    db.close();
  });

  test("close=any: the stranger's close, signed with his own key and merged, decides nothing", async () => {
    const ada = await person();
    const bo = await person();
    const cy = await person();
    const g = await honestGame(ada, bo);
    const cyCopy = openGame();
    ensureReplica(cyCopy, cy.author);
    await merge(cyCopy, g.adaCopy, cy);
    createEntity(cyCopy, "_dai_close", rnd(), {}, g.session);
    await seal(cyCopy, cy);
    await merge(g.adaCopy, cyCopy, ada);
    expect(gameMoves(g.adaCopy, g.session).map((m) => m.split("@")[0]), "a merged non-member close decides nothing").toEqual(["e4"]);
    g.adaCopy.close();
    g.boCopy.close();
    cyCopy.close();
  });

  test("close=any: a member's close closes the session, and a row of his after it is his signing twice (R18)", () => {
    const db = closeGame("any");
    put(db, "_dai_close", BO, 3, 9, {});
    expect(admitted(db), "what the closer had seen stays").toEqual(["e4", "e5"]);
    expect(closedSessions(db)).toEqual([hex(S_ANY)]);
    put(db, "moves", ADA, 5, 10, { seat: ADA_SEAT, san: "Nf3" });
    expect(admitted(db), "the close binds only him (D151)").toEqual(["Nf3", "e4", "e5"]);
    put(db, "moves", BO, 5, 11, { seat: OPEN_SEAT, san: "Nf6" });
    expect(admitted(db), "a close is final: none of an equivocator's rows is admitted (R17)").toEqual(["Nf3", "e4"]);
    expect(closedSessions(db), "and his close closes nothing").toEqual([]);
    db.close();
  });

  test("close=creator: the joiner's close, which admission ignores, does not close the session for the host or the apps", () => {
    const db = closeGame("creator");
    put(db, "_dai_close", BO, 3, 9, {});
    expect(admitted(db), "admission ignores the joiner's close").toEqual(["e4", "e5"]);
    expect(closedSessions(db), "the session is not closed").toEqual([]);
    db.close();
  });

  test("close=creator: an unsigned close under the creator's id is refused at the merge", async () => {
    const bo = closeGame("creator");
    const cy = openWith(closeSchema("creator"));
    cy.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 1, 9)", [CY]);
    put(cy, "_dai_close", ADA, 50, 9, {});
    const report = await mergeSibling(bo, cy);
    expect(report.refusedBatches, "refused as unsigned, under the id it names").toContainEqual({
      author: showAuthorId(ADA),
      reason: "BATCH_UNSIGNED",
    });
    expect(admitted(bo), "and it decides nothing").toEqual(["e4", "e5"]);
    bo.close();
    cy.close();
  });
});

test("cold review 5: a creator who also waits in her own open seat sees each of her rows once", () => {
  const db = openWith(SCHEMA);
  db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 3, 3)", [ADA]);
  put(db, "_dai_seat", ADA, 1, 1, { seat: ADA_SEAT, seats: OPEN_SEAT, close: "creator" });
  // newSession({ solo: true }) asks for its own open seat before the kit confirms it.
  put(db, "_dai_binding", ADA, 3, 3, { seat: OPEN_SEAT });
  createEntity(db, "games", nextEntity(), { title: "solo" }, S);
  expect(db.all("SELECT title FROM games_current").map((r) => String(r["title"])), "admitted as the creator's").toEqual(["solo"]);
  expect(db.all("SELECT title FROM games_pending").map((r) => String(r["title"])), "and not also waiting").toEqual([]);
  db.close();
});

test("cold review 5: the host opens mailboxes only for sessions this copy is a member of or waits in", () => {
  const db = closeGame("any");
  // A stranger's own session, arriving in a whole file: his seat rows there.
  const T = sessionIdOf(CY, 5, bytes(0xb1), bytes(0xb2), "any")!; // his seat row below is his seq 5
  applyRow(db, "_dai_seat", {
    _r_replica: CY,
    _r_seq: 5,
    _r_lc: 20,
    _r_entity: nextEntity(),
    _r_parents: "[]",
    _r_deleted: 0,
    _r_session: T,
    columns: { seat: bytes(0xb1), seats: bytes(0xb2), close: "any" },
  });
  expect(sessionsOf(db, ADA), "only the session Ada is in").toEqual([hex(S_ANY)]);
  db.close();
});

/*
 * The sixth cold review, of D145 to D150: what a permitted closer can do with
 * close rows. Ruled: a close binds only its author (D151), only an author's
 * first close counts (D152), and a close cannot be revoked (D153). A test
 * marked test.fail is a hole still open; its note names the entry whose fix
 * flips it.
 */

function openGameWith(close: "any" | "creator"): Copy {
  const db = new DatabaseSync(":memory:");
  db.function(SESSION_ID_FUNCTION, { deterministic: true }, (a, n, seat, seats, close) => sessionIdOf(a, n, seat, seats, close));
  db.exec(rewriteReplicated(GAME_SCHEMA.replace("close=any", `close=${close}`)).sql);
  return {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
}

/** Ada's game under a close rule, Bo seated, e4 and e5 played and merged both ways, every row signed. */
async function playedGame(ada: Person, bo: Person, close: "any" | "creator") {
  const adaCopy = openGameWith(close);
  ensureReplica(adaCopy, ada.author);
  const creatorSeat = rnd();
  const openSeat = rnd();
  const session = startSession(adaCopy, { creatorSeat, openSeats: [openSeat], close, entity: rnd() });
  createEntity(adaCopy, "games", rnd(), { title: "Ada v Bo" }, session);
  await seal(adaCopy, ada);
  const boCopy = openGameWith(close);
  ensureReplica(boCopy, bo.author);
  await merge(boCopy, adaCopy, bo);
  createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  await seal(boCopy, bo);
  await merge(adaCopy, boCopy, ada);
  confirmSeat(adaCopy, session, openSeat, bo.author, rnd());
  createEntity(adaCopy, "moves", rnd(), { seat: creatorSeat, game_id: "g1", san: "e4" }, session);
  await seal(adaCopy, ada);
  await merge(boCopy, adaCopy, bo);
  createEntity(boCopy, "moves", rnd(), { seat: openSeat, game_id: "g1", san: "e5" }, session);
  await seal(boCopy, bo);
  await merge(adaCopy, boCopy, ada);
  const close2 = () => [adaCopy, boCopy].forEach((c) => c.close());
  return { adaCopy, boCopy, session, creatorSeat, openSeat, close: close2 };
}

/** The sans chess shows for g1. */
const sans = (db: Rows, session: Uint8Array) => gameMoves(db, session).map((m) => m.split("@")[0]!);
const closedOf = (db: Rows): string[] => db.all("SELECT lower(hex(session)) AS s FROM _dai_closed").map((r) => String(r["s"]));

/** The bootloader's close() without its gate: one `_dai_close` row, carrying its session. */
function closeLikeTheHost(db: Rows, session: Uint8Array): Uint8Array[] {
  const e = rnd();
  createEntity(db, "_dai_close", e, {}, session);
  return [e];
}

test("cold review 6: close=any, a member's signed close naming only himself leaves the other member's moves admitted", async () => {
  const ada = await person();
  const bo = await person();
  const g = await playedGame(ada, bo, "any");
  expect(sans(g.boCopy, g.session), "Bo's copy holds and shows e4").toEqual(["e4", "e5"]);
  const boSeq = Number(g.boCopy.all("SELECT seq FROM _dai_replica")[0]!["seq"]);
  createEntity(g.boCopy, "_dai_close", rnd(), {}, g.session);
  await seal(g.boCopy, bo);
  await merge(g.adaCopy, g.boCopy, ada);
  expect(sans(g.adaCopy, g.session), "no signed row of Bo's removes Ada's move").toEqual(["e4", "e5"]);
  g.close();
});

test("D151's residual: close=creator, the creator's close leaves the joiner's later move admitted, and the session closed", async () => {
  // The accepted residual: a close binds only its author, so a member who plays
  // on after seeing the other's close is held only by the advisory write gate,
  // and every copy shows the session closed.
  const ada = await person();
  const bo = await person();
  const g = await playedGame(ada, bo, "creator");
  closeLikeTheHost(g.adaCopy, g.session);
  await seal(g.adaCopy, ada);
  await merge(g.boCopy, g.adaCopy, bo);
  createEntity(g.boCopy, "moves", rnd(), { seat: g.openSeat, game_id: "g1", san: "Nf6" }, g.session);
  await seal(g.boCopy, bo);
  await merge(g.adaCopy, g.boCopy, ada);
  for (const copy of [g.adaCopy, g.boCopy]) {
    expect(sans(copy, g.session), "her close does not bind his rows").toEqual(["e4", "e5", "Nf6"]);
    expect(closedOf(copy), "and the session reads closed").toEqual([hex(g.session)]);
  }
  g.close();
});

test.describe("cold review 6: a close is final", () => {
  test("close=any: a move of Bo's after his own close is his signing twice, on his copy and every copy (R18)", async () => {
    const ada = await person();
    const bo = await person();
    const g = await playedGame(ada, bo, "any");
    closeLikeTheHost(g.boCopy, g.session);
    expect(closedOf(g.boCopy)).toEqual([hex(g.session)]);
    createEntity(g.boCopy, "moves", rnd(), { seat: g.openSeat, game_id: "g1", san: "Nf6" }, g.session);
    expect(sans(g.boCopy, g.session), "an equivocator holds no seat and none of his moves is admitted (R17)").toEqual(["e4"]);
    await seal(g.boCopy, bo);
    const report = await merge(g.adaCopy, g.boCopy, ada);
    expect(report.refusedBatches.filter((r) => r.reason === "AUTHOR_EQUIVOCATED").map((r) => r.author), "the merge that brings it says so").toEqual([bo.shown]);
    expect(sans(g.adaCopy, g.session)).toEqual(["e4"]);
    expect(closedOf(g.adaCopy), "and his close closes nothing").toEqual([]);
    g.close();
  });

  test("close=creator: a row of the creator's after her close is her signing twice, and her session is void (R18)", async () => {
    const ada = await person();
    const bo = await person();
    const g = await playedGame(ada, bo, "creator");
    closeLikeTheHost(g.adaCopy, g.session);
    createEntity(g.adaCopy, "moves", rnd(), { seat: g.creatorSeat, game_id: "g1", san: "AMEND" }, g.session);
    expect(sans(g.adaCopy, g.session), "a void session admits nothing").toEqual([]);
    await seal(g.adaCopy, ada);
    await merge(g.boCopy, g.adaCopy, bo);
    expect(sans(g.boCopy, g.session)).toEqual([]);
    expect(g.boCopy.all("SELECT lower(hex(session)) AS s FROM _dai_void_session").map((r) => r["s"])).toEqual([hex(g.session)]);
    g.close();
  });

  test("close=creator: a delete of the creator's close revokes nothing: it is a row of hers after her close (D153, R18)", async () => {
    const ada = await person();
    const bo = await person();
    const g = await playedGame(ada, bo, "creator");
    const rows = closeLikeTheHost(g.adaCopy, g.session);
    expect(closedOf(g.adaCopy)).toEqual([hex(g.session)]);
    expect(sans(g.adaCopy, g.session)).toEqual(["e4", "e5"]);
    for (const e of rows) deleteEntity(g.adaCopy, "_dai_close", e, g.session);
    await seal(g.adaCopy, ada);
    await merge(g.boCopy, g.adaCopy, bo);
    for (const copy of [g.adaCopy, g.boCopy]) {
      expect(closedOf(copy), "not reopened: void").toEqual([]);
      expect(sans(copy, g.session), "and nothing in it is admitted").toEqual([]);
      expect(copy.all("SELECT lower(hex(session)) AS s FROM _dai_void_session").map((r) => r["s"])).toEqual([hex(g.session)]);
    }
    g.close();
  });
});

test("cold review 6: close=creator, a document built before _dai_closed calls closed only what its rule permits", async () => {
  const ada = await person();
  const bo = await person();
  const g = await playedGame(ada, bo, "creator");
  const boSeq = Number(g.boCopy.all("SELECT seq FROM _dai_replica")[0]!["seq"]);
  createEntity(g.boCopy, "_dai_close", rnd(), {}, g.session);
  await seal(g.boCopy, bo);
  await merge(g.adaCopy, g.boCopy, ada);
  expect(sans(g.adaCopy, g.session), "admission ignores the joiner's close").toEqual(["e4", "e5"]);
  g.adaCopy.run("DROP VIEW _dai_closed");
  // The host's read for such a document; exported for this test once it takes the rule.
  const closedSessionsOf = (replicatedRows as Record<string, unknown>)["closedSessionsOf"] as
    | ((db: Rows, policy: "any" | "creator") => string[])
    | undefined;
  const fallback = closedSessionsOf
    ? closedSessionsOf(g.adaCopy, "creator")
    : g.adaCopy.all("SELECT DISTINCT lower(hex(_r_session)) AS s FROM _dai_close_current").map((r) => String(r["s"]));
  expect(fallback, "the host calls closed only what admission does").toEqual([]);
  g.close();
});

test("cold review 6: close=any, a waiting asker's close counts in _dai_closed only once he is confirmed", async () => {
  const ada = await person();
  const bo = await person();
  const adaCopy = openGameWith("any");
  ensureReplica(adaCopy, ada.author);
  const creatorSeat = rnd();
  const openSeat = rnd();
  const session = startSession(adaCopy, { creatorSeat, openSeats: [openSeat], close: "any", entity: rnd() });
  await seal(adaCopy, ada);
  const boCopy = openGameWith("any");
  ensureReplica(boCopy, bo.author);
  await merge(boCopy, adaCopy, bo);
  createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  createEntity(boCopy, "_dai_close", rnd(), {}, session);
  await seal(boCopy, bo);
  await merge(adaCopy, boCopy, ada);
  expect(closedOf(adaCopy), "a waiting asker is no member").toEqual([]);
  confirmSeat(adaCopy, session, openSeat, bo.author, rnd());
  expect(closedOf(adaCopy), "confirmed, his close counts").toEqual([hex(session)]);
  adaCopy.close();
  boCopy.close();
});

test("cold review 6: an unsigned close under the creator's id, as a mailbox batch, is refused", async () => {
  const ada = await person();
  const bo = await person();
  const g = await playedGame(ada, bo, "creator");
  const mal = openGameWith("creator");
  ensureReplica(mal, rnd());
  await mergeSibling(mal, g.adaCopy, { document: DOC, author: rnd() });
  applyRow(mal, "_dai_close", {
    _r_replica: ada.author,
    _r_seq: 900,
    _r_lc: 900,
    _r_entity: rnd(),
    _r_parents: "[]",
    _r_deleted: 0,
    _r_session: g.session,
    columns: { replica: ada.author, seq: 1 },
  });
  const tables = mergeTablesOf(mal);
  const [batch] = pendingBatches(mal, ada.author, tables);
  expect(batch, "one unsigned batch of the forged row").toBeTruthy();
  const staged = openGameWith("creator");
  stageBatch(staged, decodeBatch(encodeBatch(batch!)), tables);
  const report = await merge(g.boCopy, staged, bo);
  expect(report.refusedBatches).toContainEqual({ author: ada.shown, reason: "BATCH_UNSIGNED" });
  expect(closedOf(g.boCopy), "and nothing is closed").toEqual([]);
  expect(sans(g.boCopy, g.session)).toEqual(["e4", "e5"]);
  g.close();
  mal.close();
  staged.close();
});
