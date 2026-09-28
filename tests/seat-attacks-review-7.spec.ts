import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { authorIdOf, mintPersonKey, rawPublicKey, showAuthorId } from "../src/identity.js";
import { rewriteReplicated } from "../src/replicated.js";
import { pendingBatches, recordSeal, signBatch } from "../src/replicated-batch.js";
import { mergeSibling, mergeTablesOf } from "../src/replicated-frame.js";
import { applyRow, changeEntity, confirmSeat, createEntity, ensureReplica, sessionsOf, startSession, type Rows } from "../src/replicated-rows.js";
import { SESSION_ID_FUNCTION, sessionIdOf } from "../src/session-id.js";
// @ts-ignore the chess fixture is plain JavaScript, with no types
import { Store } from "./fixture/chess/store.js";

/**
 * Cold review 7: probes of the invariant "no row by one author makes a row by
 * another author late, hidden, superseded or unadmitted". Every row an attacker
 * writes is signed with the attacker's own key and merged through mergeSibling.
 * Each test asserts what the invariant requires. A test marked test.fail is a
 * hole still open (D158 and D160, filed and ruled 27 September; D159 is fixed);
 * its note names the entry whose fix flips it. Both are fixed in step 6's
 * format bump, D160 on signed covers (D161). Kept apart from seat-attacks.spec.ts
 * because its helpers share names there; node-only, like that file.
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
function openGameWith(close: "any" | "creator", extra = ""): Copy {
  const db = new DatabaseSync(":memory:");
  db.function(SESSION_ID_FUNCTION, { deterministic: true }, (a, n) => sessionIdOf(a, n));
  db.exec(rewriteReplicated(GAME_SCHEMA.replace("close=any", `close=${close}`) + extra).sql);
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
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function seal(db: Rows, who: Person): Promise<void> {
  for (const batch of pendingBatches(db, who.author, mergeTablesOf(db))) {
    recordSeal(db, await signBatch(batch, { document: DOC, keys: who.keys }));
  }
}
const merge = (into: Rows, from: Rows, who: Person) => mergeSibling(into, from, { document: DOC, author: who.author });

/** What chess shows for game g1 of a session, read by the fixture Store (admitted rows only). */
const sans = (db: Rows, session: Uint8Array): string[] => {
  (globalThis as { window?: unknown }).window = { daiKit: { author: () => null } };
  const store = new Store({ selectObjects: (sql: string, bind?: unknown[]) => db.all(sql, bind ?? []) }, null);
  const rows = store.moves({ id: "g1", session: hex(session) }) as Record<string, unknown>[];
  return rows.map((r) => String(r["san"]));
};
/**
 * A row this copy's own author writes with parents of its choosing, at its next
 * seq and clock, pending until `seal` signs it with that author's key: what a
 * copy that skips the writers (and their advisory checks) can sign.
 */
function raw(
  db: Rows,
  table: string,
  entity: Uint8Array,
  columns: Record<string, unknown>,
  session: Uint8Array,
  o: { parents?: string[]; parentsText?: string; deleted?: number; seq?: number } = {},
): { _r_replica: Uint8Array; _r_seq: number } {
  const st = db.all("SELECT id, seq, lc FROM _dai_replica")[0]!;
  const seq = o.seq ?? Number(st["seq"]) + 1;
  const lc = Number(st["lc"]) + 1;
  db.run("UPDATE _dai_replica SET seq = max(seq, ?), lc = ?", [seq, lc]);
  applyRow(db, table, {
    _r_replica: st["id"] as Uint8Array,
    _r_seq: seq,
    _r_lc: lc,
    _r_entity: entity,
    _r_parents: o.parentsText ?? JSON.stringify([...(o.parents ?? [])].sort()),
    _r_deleted: o.deleted ?? 0,
    _r_session: session,
    columns,
  });
  return { _r_replica: st["id"] as Uint8Array, _r_seq: seq };
}
const idOf = (r: { _r_replica: Uint8Array; _r_seq: number }) => `${hex(r._r_replica)}:${r._r_seq}`;
const holders =(db: Rows, session: Uint8Array, seat: Uint8Array): string[] =>
  db.all("SELECT lower(hex(replica)) AS r FROM _dai_holder WHERE session = ? AND seat = ?", [session, seat]).map((r) => String(r["r"]));

/** Ada's game, Bo seated, e4 and e5 played and merged both ways, every row signed. */
async function playedGame(ada: Person, bo: Person, close: "any" | "creator" = "any", extra = "") {
  const adaCopy = openGameWith(close, extra);
  ensureReplica(adaCopy, ada.author);
  const creatorSeat = rnd();
  const openSeat = rnd();
  const seatEntities: [Uint8Array, Uint8Array] = [rnd(), rnd()];
  const session = startSession(adaCopy, { creatorSeat, openSeat, entities: seatEntities });
  createEntity(adaCopy, "games", rnd(), { title: "Ada v Bo" }, session);
  await seal(adaCopy, ada);
  const boCopy = openGameWith(close, extra);
  ensureReplica(boCopy, bo.author);
  await merge(boCopy, adaCopy, bo);
  createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  await seal(boCopy, bo);
  await merge(adaCopy, boCopy, ada);
  confirmSeat(adaCopy, session, openSeat, bo.author, rnd());
  createEntity(adaCopy, "moves", rnd(), { seat: creatorSeat, game_id: "g1", ply: 1, san: "e4" }, session);
  await seal(adaCopy, ada);
  await merge(boCopy, adaCopy, bo);
  const e5 = createEntity(boCopy, "moves", rnd(), { seat: openSeat, game_id: "g1", ply: 2, san: "e5" }, session);
  await seal(boCopy, bo);
  await merge(adaCopy, boCopy, ada);
  const close2 = () => [adaCopy, boCopy].forEach((c) => c.close());
  return { adaCopy, boCopy, session, creatorSeat, openSeat, seatEntities, e5, close: close2 };
}

test("F1: the creator's signed second seat row naming the open seat neither unseats the confirmed joiner nor takes his side", async () => {
  const ada = await person();
  const bo = await person();
  const g = await playedGame(ada, bo);
  expect(holders(g.boCopy, g.session, g.openSeat)).toEqual([hex(bo.author)]);
  // Ada, signed with her own key: another seat row in the session, whose seat is
  // the open seat Bo was confirmed in. No writer is involved; the merge takes it.
  // At step 5 a row carrying the session's nonce counted as hers (D158); the
  // session id now names one row by (author, seq), and this is not that row.
  createEntity(g.adaCopy, "_dai_seat", rnd(), { seat: g.openSeat }, g.session);
  // And she answers Bo's e5 as Black, from the seat now counted as hers.
  raw(g.adaCopy, "moves", g.e5._r_entity, { seat: g.openSeat, game_id: "g1", ply: 2, san: "c5" }, g.session, { parents: [idOf(g.e5)] });
  await seal(g.adaCopy, ada);
  const report = await merge(g.boCopy, g.adaCopy, bo);
  expect.soft(report.refusedBatches, "her move for the seat Bo holds is refused, in her name").toEqual([{ author: ada.shown, reason: "SEAT_NOT_HELD" }]);
  expect.soft(holders(g.boCopy, g.session, g.openSeat), "a hold never moves once made: Bo still holds the open seat").toEqual([hex(bo.author)]);
  expect.soft(sans(g.boCopy, g.session), "Bo's admitted e5 is still what chess shows").toEqual(["e4", "e5"]);
  g.close();
});

/** What chess shows for g1 to the copy whose author is me: the Store unions its own pending rows. */
const sansAs = (db: Rows, session: Uint8Array, me: Uint8Array): string[] => {
  (globalThis as { window?: unknown }).window = { daiKit: { author: () => hex(me) } };
  const store = new Store({ selectObjects: (sql: string, bind?: unknown[]) => db.all(sql, bind ?? []) }, null);
  return (store.moves({ id: "g1", session: hex(session) }) as Record<string, unknown>[]).map((r) => String(r["san"]));
};
const tryRead = (f: () => unknown): string => {
  try {
    return JSON.stringify(f());
  } catch (e) {
    return "THROWS: " + String(e);
  }
};

/** Parents text JavaScript parses (so applyRow takes it) and SQLite's json_each refuses (depth over 1000). */
const TOO_DEEP = "[".repeat(1100) + "]".repeat(1100);

const CONFIRM_SQL =
  "SELECT lower(hex(s.session)) AS session, lower(hex(s.seat)) AS seat, min(lower(hex(b._r_replica))) AS who, " +
  "count(DISTINCT b._r_replica) AS n FROM _dai_open_seat s " +
  "JOIN _dai_creator c ON c.session = s.session AND lower(hex(c.replica)) = ? " +
  "JOIN _dai_binding_current b ON b._r_session = s.session AND b.seat = s.seat " +
  "WHERE NOT EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = s.session AND h.seat = s.seat) " +
  "GROUP BY s.session, s.seat";
const RESEAT_SQL =
  "SELECT s.entity AS ent FROM _dai_open_seat s WHERE s.session = ? " +
  "AND NOT EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = s.session AND h.seat = s.seat) " +
  "AND (SELECT count(DISTINCT lower(hex(b._r_replica))) FROM _dai_binding_current b " +
  "WHERE b._r_session = s.session AND b.seat = s.seat) > 1 LIMIT 1";

/** Ada's session with Bo asking for the open seat and not yet confirmed (Ada's copy was offline). */
async function waitingGame(ada: Person, bo: Person) {
  const adaCopy = openGameWith("any");
  ensureReplica(adaCopy, ada.author);
  const creatorSeat = rnd();
  const openSeat = rnd();
  const session = startSession(adaCopy, { creatorSeat, openSeat, entities: [rnd(), rnd()] });
  createEntity(adaCopy, "moves", rnd(), { seat: creatorSeat, game_id: "g1", ply: 1, san: "e4" }, session);
  await seal(adaCopy, ada);
  const boCopy = openGameWith("any");
  ensureReplica(boCopy, bo.author);
  await merge(boCopy, adaCopy, bo);
  createEntity(boCopy, "_dai_binding", rnd(), { seat: openSeat }, session);
  createEntity(boCopy, "moves", rnd(), { seat: openSeat, game_id: "g1", ply: 2, san: "e5" }, session);
  await seal(boCopy, bo);
  return { adaCopy, boCopy, session, creatorSeat, openSeat, close: () => [adaCopy, boCopy].forEach((c) => c.close()) };
}

test("holds: a stranger's signed ask for a seat nobody minted, with parents SQLite cannot parse, does not stop the creator's copy seating the one real asker", async () => {
  const ada = await person();
  const bo = await person();
  const cy = await person(); // a stranger: holds a copy, never a seat
  const g = await waitingGame(ada, bo);
  const cyCopy = openGameWith("any");
  ensureReplica(cyCopy, cy.author);
  await merge(cyCopy, g.adaCopy, cy);
  // Not an ask for the open seat, so no contest by the rules: a seat value nobody minted.
  raw(cyCopy, "_dai_binding", rnd(), { seat: rnd() }, g.session, { parentsText: TOO_DEEP });
  await seal(cyCopy, cy);
  // Both arrive at Ada's copy (a file or two mailbox batches, in either order).
  await merge(g.adaCopy, cyCopy, ada);
  let boMerge = "";
  try {
    boMerge = JSON.stringify((await merge(g.adaCopy, g.boCopy, ada)).refusedBatches);
  } catch (e) {
    boMerge = "THROWS: " + String(e);
  }
  expect.soft(boMerge, "the merges complete, so the runtime commits the stranger's row").toBe("[]");
  // What the kit's confirmSeats reads on the creator's copy: one asker, Bo, to be confirmed.
  expect.soft(tryRead(() => g.adaCopy.all(CONFIRM_SQL, [hex(ada.author)]).map((r) => [r["who"], Number(r["n"])])), "the kit sees exactly one asker, Bo").toBe(
    JSON.stringify([[hex(bo.author), 1]]),
  );
  // What the runtime's reseat reads, the creator's only repair.
  expect.soft(tryRead(() => g.adaCopy.all(RESEAT_SQL, [g.session]).length), "the reseat read runs (and finds no contest)").toBe("0");
  // Bo's own copy, once it has Ada's rows: what chess shows him while he waits.
  await merge(g.boCopy, g.adaCopy, bo);
  expect.soft(tryRead(() => sansAs(g.boCopy, g.session, bo.author)), "Bo's chess shows e4 and his waiting e5").toBe(JSON.stringify(["e4", "e5"]));
  cyCopy.close();
  g.close();
});

test("F2: a stranger's signed ask for the open seat, with parents SQLite cannot parse, is refused as malformed, and every seat read still runs", async () => {
  // D159, ruled 27 September: `_r_parents` is a flat array of row ids, capped,
  // or the row is refused at merge as ROW_MALFORMED, in its signer's name.
  const ada = await person();
  const bo = await person();
  const cy = await person(); // a stranger who asks for the open seat
  const g = await waitingGame(ada, bo);
  const cyCopy = openGameWith("any");
  ensureReplica(cyCopy, cy.author);
  await merge(cyCopy, g.adaCopy, cy);
  raw(cyCopy, "_dai_binding", rnd(), { seat: g.openSeat }, g.session, { parentsText: TOO_DEEP });
  await seal(cyCopy, cy);
  await merge(g.adaCopy, g.boCopy, ada);
  const fromCy = await merge(g.adaCopy, cyCopy, ada);
  expect.soft(fromCy.refusedBatches, "Cy's ask is refused, in Cy's name").toEqual([{ author: cy.shown, reason: "ROW_MALFORMED" }]);
  expect.soft(g.adaCopy.all("SELECT 1 FROM _dai_binding WHERE _r_replica = ?", [cy.author]).length, "and not stored").toBe(0);
  expect.soft(tryRead(() => g.adaCopy.all(CONFIRM_SQL, [hex(ada.author)]).map((r) => [r["who"], Number(r["n"])])), "the kit sees exactly one asker, Bo").toBe(
    JSON.stringify([[hex(bo.author), 1]]),
  );
  expect.soft(tryRead(() => g.adaCopy.all(RESEAT_SQL, [g.session]).length), "the reseat read runs, and finds no contest").toBe("0");
  await merge(g.boCopy, g.adaCopy, bo);
  // The Store's seat picture for Bo's copy (the contested query chess runs).
  const contested =
    "SELECT lower(hex(b.seat)) AS seat FROM _dai_binding_current b JOIN _dai_open_seat s ON s.session = b._r_session AND s.seat = b.seat WHERE lower(hex(b._r_session)) = ? AND NOT EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = s.session AND h.seat = s.seat) GROUP BY b.seat HAVING count(DISTINCT lower(hex(b._r_replica))) > 1";
  expect.soft(tryRead(() => g.boCopy.all(contested, [hex(g.session)]).length), "Bo's chess reads his seat, uncontested").toBe("0");
  expect.soft(tryRead(() => sansAs(g.boCopy, g.session, bo.author)), "Bo's chess shows e4 and his waiting e5").toBe(JSON.stringify(["e4", "e5"]));
  cyCopy.close();
  g.close();
});

/**
 * The creator signs two confirms at one row id, one naming Bo and one Cy, and
 * sends one to each (D160). Ruled 27 September: void both and report. Picking
 * either would trust arrival order; once a copy holds both of Ada's headers,
 * neither confirm counts, nobody holds the open seat on either copy, and the
 * merge that brings the second header reports AUTHOR_EQUIVOCATED with Ada.
 */
async function equivocatedConfirms() {
  const ada = await person();
  const bo = await person();
  const cy = await person();
  const g = await waitingGame(ada, bo);
  await merge(g.adaCopy, g.boCopy, ada);
  // Ada's second copy of the same state (what a hostile creator's client can hold).
  const ada2 = openGameWith("any");
  ensureReplica(ada2, ada.author);
  await merge(ada2, g.adaCopy, ada);
  const seq = Number(g.adaCopy.all("SELECT seq FROM _dai_replica")[0]!["seq"]) + 1;
  raw(g.adaCopy, "_dai_confirm", rnd(), { seat: g.openSeat, holder: bo.author }, g.session, { seq });
  await seal(g.adaCopy, ada);
  raw(ada2, "_dai_confirm", rnd(), { seat: g.openSeat, holder: cy.author }, g.session, { seq });
  await seal(ada2, ada);
  const cyCopy = openGameWith("any");
  ensureReplica(cyCopy, cy.author);
  // Bo's copy takes the first confirm; Cy's copy the second.
  await merge(g.boCopy, g.adaCopy, bo);
  await merge(cyCopy, ada2, cy);
  return { ada, bo, cy, g, ada2, cyCopy, close: () => [cyCopy, ada2].forEach((c) => c.close()) };
}

test("F3: the creator signs two confirms at one row id, one per asker: once a copy holds both, neither counts, and every copy says so", async () => {
  const { ada, bo, cy, g, cyCopy, close } = await equivocatedConfirms();
  const r1 = await merge(g.boCopy, cyCopy, bo);
  const r2 = await merge(cyCopy, g.boCopy, cy);
  expect.soft(r1.refusedBatches, "Bo's copy learns Ada signed two rows at one id").toEqual([{ author: ada.shown, reason: "AUTHOR_EQUIVOCATED" }]);
  expect.soft(r2.refusedBatches, "and so does Cy's").toEqual([{ author: ada.shown, reason: "AUTHOR_EQUIVOCATED" }]);
  expect.soft(holders(g.boCopy, g.session, g.openSeat), "on Bo's copy nobody holds the open seat").toEqual([]);
  expect.soft(holders(cyCopy, g.session, g.openSeat), "nor on Cy's: the copies agree").toEqual([]);
  close();
  g.close();
});

test("F3, a third copy: merging from one side alone still sees both confirms, because the evidence travels with the headers", async () => {
  const { ada, bo, g, cyCopy, close } = await equivocatedConfirms();
  await merge(g.boCopy, cyCopy, bo);
  const dee = await person();
  const deeCopy = openGameWith("any");
  ensureReplica(deeCopy, dee.author);
  const report = await merge(deeCopy, g.boCopy, dee);
  expect.soft(report.refusedBatches, "Dee's copy, from Bo's alone, reports it too").toEqual([{ author: ada.shown, reason: "AUTHOR_EQUIVOCATED" }]);
  expect.soft(holders(deeCopy, g.session, g.openSeat), "and seats nobody").toEqual([]);
  deeCopy.close();
  close();
  g.close();
});

test("holds: an author=creator table admits only the creator's versions, and a member's child supersedes nothing", async () => {
  const ada = await person();
  const bo = await person();
  const extra = "-- dai:replicated author=creator\nCREATE TABLE notes (body TEXT);\n";
  const g = await playedGame(ada, bo, "any", extra);
  const n = createEntity(g.adaCopy, "notes", rnd(), { body: "v1" }, g.session);
  changeEntity(g.adaCopy, "notes", n._r_entity, { body: "v2" });
  await seal(g.adaCopy, ada);
  await merge(g.boCopy, g.adaCopy, bo);
  raw(g.boCopy, "notes", n._r_entity, { body: "bo" }, g.session, { parents: [`${hex(ada.author)}:${n._r_seq + 1}`] });
  await seal(g.boCopy, bo);
  await merge(g.adaCopy, g.boCopy, ada);
  expect(g.adaCopy.all("SELECT body FROM notes_current").map((r) => r["body"])).toEqual(["v2"]);
  g.close();
});
