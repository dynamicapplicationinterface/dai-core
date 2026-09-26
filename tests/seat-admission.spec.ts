import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { showAuthorId } from "../src/identity.js";
import { ReplicationError, rewriteReplicated } from "../src/replicated.js";
import { mergeSibling } from "../src/replicated-frame.js";
import { applyRow, type Rows } from "../src/replicated-rows.js";
import { sessionIdOf } from "../src/session-id.js";
import { withSessionId } from "./session-db.js";

/**
 * A seat says whether an author may (docs/identity.md, binding rule 5; step 5).
 *
 * A signature answers who wrote a row; a seat answers whether they may. A
 * table marked `-- dai:replicated seat=<column>` names, in that column, the
 * seat each row acts for, and a row is admitted only when its author holds that
 * seat: the creator's seat is the creator's (the session id commits to her),
 * and an open seat is held by whoever her rows confirm in it. A joiner's
 * binding only asks. No clock is read anywhere, and a hold never moves once
 * made, so a move written while its author waited is admitted once they are
 * seated. A row that names no seat, or a seat nobody holds, is not admitted.
 * The admission is the runtime's compiled view, not the application's, and a
 * merge reports a row it took as SEAT_NOT_HELD, with its author, when it names
 * no seat or a seat someone else holds; a row still waiting on a confirmation
 * is neither admitted nor reported.
 *
 * Every row here goes straight through the choke point with an explicit author,
 * which is what a copy whose application enforced nothing would send.
 */

const SCHEMA = `-- dai:profile session max_parties=2
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
  const db = withSessionId(new DatabaseSync(":memory:"));
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
const C = bytes(0xc0); // Ada, the creator: she mints the seats
const NONCE = bytes(0x07); // on Ada's own seat row
const S = sessionIdOf(C, NONCE)!; // the session, which commits to Ada
const OTHER = bytes(0x5f); // another session
const J = bytes(0x10); // Bo, the joiner
const K = bytes(0x20); // Cy, a second opener of the same invite
const SEATC = bytes(0xa1); // Ada's seat
const SEATJ = bytes(0xa2); // the open seat
const FOREIGN = bytes(0xa9); // a seat of another session

let counter = 0;
const nextEntity = (): Uint8Array => {
  counter += 1;
  const e = new Uint8Array(16);
  e[0] = 0x30;
  e[14] = counter >> 8;
  e[15] = counter & 0xff;
  return e;
};

/** One row, applied straight through the choke point, with an explicit author. */
function put(
  db: Rows,
  table: string,
  replica: Uint8Array,
  seq: number,
  lc: number,
  columns: Record<string, unknown>,
  options: { entity?: Uint8Array; parents?: string; session?: Uint8Array; batch?: Uint8Array } = {},
): Uint8Array {
  const entity = options.entity ?? nextEntity();
  applyRow(db, table, {
    _r_replica: replica,
    _r_seq: seq,
    _r_lc: lc,
    _r_entity: entity,
    _r_parents: options.parents ?? "[]",
    _r_deleted: 0,
    _r_session: options.session ?? S,
    ...(options.batch ? { _r_batch: options.batch } : {}),
    columns,
  });
  return entity;
}

/** A header in this copy's `_dai_batch`, so a row may name it: what a verified merge leaves behind. */
function signedBy(db: Rows, author: Uint8Array, id: number): Uint8Array {
  const batch = bytes(id);
  db.run(
    "INSERT INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, 1, x'00', x'00', NULL, 1, ?, '[]')",
    [batch, author, new Uint8Array(32)],
  );
  return batch;
}

/** Ada's session: her own seat, carrying the nonce its id commits to, and the open one. Returns the open seat's entity. */
function roster(db: Rows): Uint8Array {
  const openSeat = nextEntity();
  put(db, "_dai_seat", C, 1, 1, { seat: SEATC, nonce: NONCE });
  put(db, "_dai_seat", C, 2, 2, { seat: SEATJ, nonce: null }, { entity: openSeat });
  return openSeat;
}
/** Bo asks for the open seat (his seq 1) and Ada seats him in it (her seq 3). */
function seatBo(db: Rows): void {
  put(db, "_dai_binding", J, 1, 3, { seat: SEATJ });
  put(db, "_dai_confirm", C, 3, 4, { seat: SEATJ, holder: J });
}

const admitted = (db: Rows): string[] => db.all("SELECT san FROM moves_current ORDER BY san").map((r) => String(r["san"]));
const stored = (db: Rows): string[] => db.all("SELECT san FROM moves ORDER BY san").map((r) => String(r["san"]));
const members = (db: Rows): string[] =>
  db.all("SELECT lower(hex(replica)) AS r FROM _dai_member WHERE session = ? ORDER BY r", [S]).map((r) => String(r["r"]));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test.describe("a seat column is part of the document's contract", () => {
  test("seat=<column> is recorded, and the rules view names it", () => {
    const rewritten = rewriteReplicated(SCHEMA);
    expect(rewritten.seats).toEqual({ moves: "seat" });
    expect(rewritten.sql).toContain("_dai_seat_rules");
  });

  test("a seat column in a document with no session is refused, because there are no seats", () => {
    expect(() =>
      rewriteReplicated(`-- dai:replicated seat=seat
CREATE TABLE moves (
  seat BLOB,
  san TEXT NOT NULL
);
`),
    ).toThrow(ReplicationError);
  });

  test("a seat column the table does not have is refused", () => {
    expect(() =>
      rewriteReplicated(`-- dai:profile session max_parties=2
-- dai:replicated seat=chair
CREATE TABLE moves (
  seat BLOB,
  san TEXT NOT NULL
);
`),
    ).toThrow(/chair/);
  });
});

test.describe("a row is admitted only when its author holds the seat it names", () => {
  test("the holder's own move is admitted; the strongest forgery, the other player naming that seat, is stored and never admitted", () => {
    const db = openWith(SCHEMA);
    roster(db);
    seatBo(db);
    put(db, "moves", C, 4, 5, { seat: SEATC, san: "e4" });
    put(db, "moves", J, 2, 6, { seat: SEATJ, san: "e5" });
    // Bo, a member, writes a move for Ada's seat.
    put(db, "moves", J, 3, 7, { seat: SEATC, san: "d4" });
    expect(stored(db)).toEqual(["d4", "e4", "e5"]);
    expect(admitted(db), "Ada's seat is Ada's: Bo's d4 is not admitted").toEqual(["e4", "e5"]);
    db.close();
  });

  test("a row that names no seat is stored and never admitted, even from a member", () => {
    const db = openWith(SCHEMA);
    roster(db);
    seatBo(db);
    put(db, "moves", J, 2, 5, { seat: null, san: "d4" });
    put(db, "moves", C, 4, 6, { seat: SEATC, san: "e4" });
    expect(stored(db)).toEqual(["d4", "e4"]);
    expect(admitted(db)).toEqual(["e4"]);
    db.close();
  });

  test("a row that names a seat outside its session is never admitted", () => {
    const db = openWith(SCHEMA);
    roster(db);
    seatBo(db);
    put(db, "_dai_seat", J, 2, 1, { seat: FOREIGN, nonce: null }, { session: OTHER });
    put(db, "moves", J, 3, 5, { seat: FOREIGN, san: "d4" });
    expect(admitted(db)).toEqual([]);
    db.close();
  });

  test("a move written while its author waited to be seated is admitted once the creator confirms them", () => {
    const db = openWith(SCHEMA);
    roster(db);
    put(db, "_dai_binding", J, 1, 4, { seat: SEATJ });
    put(db, "moves", J, 2, 5, { seat: SEATJ, san: "e5" });
    // A move for a seat he did not ask for is not waiting on anything.
    put(db, "moves", J, 3, 5, { seat: SEATC, san: "d4" });
    const waiting = () => db.all("SELECT san FROM moves_pending ORDER BY san").map((r) => String(r["san"]));
    expect(admitted(db), "pending: not admitted yet").toEqual([]);
    expect(waiting(), "and waiting in moves_pending").toEqual(["e5"]);
    put(db, "_dai_confirm", C, 3, 6, { seat: SEATJ, holder: J });
    expect(admitted(db)).toEqual(["e5"]);
    expect(waiting(), "seated: nothing waits").toEqual([]);
    db.close();
  });

  test("no clock is read: the confirmed holder's moves are his seat's whenever they were written, in any arrival order", () => {
    const db = openWith(SCHEMA);
    roster(db);
    put(db, "moves", J, 1, -50, { seat: SEATJ, san: "early" });
    put(db, "_dai_confirm", C, 3, 1, { seat: SEATJ, holder: J });
    put(db, "_dai_binding", J, 2, 99, { seat: SEATJ });
    expect(admitted(db)).toEqual(["early"]);
    db.close();
  });

  test("a reseated seat: moves for the old value, never confirmed, stay refused; the new value's holder plays", () => {
    const db = openWith(SCHEMA);
    const openSeat = roster(db);
    // Cy and Bo both open the invite before Ada's copy confirms anyone: a contest.
    put(db, "_dai_binding", K, 1, 4, { seat: SEATJ });
    put(db, "_dai_binding", J, 1, 5, { seat: SEATJ });
    put(db, "moves", J, 2, 6, { seat: SEATJ, san: "old" });
    // Ada repairs it with a fresh value, and seats Bo in that.
    const SEATJ2 = bytes(0xa3);
    put(db, "_dai_seat", C, 3, 7, { seat: SEATJ2, nonce: null }, { entity: openSeat, parents: JSON.stringify([`${hex(C)}:2`]) });
    put(db, "_dai_binding", J, 3, 8, { seat: SEATJ2 });
    put(db, "_dai_confirm", C, 4, 9, { seat: SEATJ2, holder: J });
    put(db, "moves", J, 4, 10, { seat: SEATJ2, san: "new" });
    expect(members(db)).toEqual([hex(J), hex(C)].sort());
    expect(admitted(db)).toEqual(["new"]);
    db.close();
  });

  test("a confirmation written by anyone but the creator seats nobody", () => {
    const db = openWith(SCHEMA);
    roster(db);
    put(db, "_dai_binding", J, 1, 4, { seat: SEATJ });
    put(db, "_dai_confirm", J, 2, 5, { seat: SEATJ, holder: J });
    put(db, "moves", J, 3, 6, { seat: SEATJ, san: "e5" });
    expect(members(db)).toEqual([hex(C)]);
    expect(admitted(db)).toEqual([]);
    db.close();
  });

  test("the creator's seat is hers even when her rows confirm someone else in it", () => {
    const db = openWith(SCHEMA);
    roster(db);
    put(db, "_dai_confirm", C, 3, 4, { seat: SEATC, holder: J });
    put(db, "moves", J, 1, 5, { seat: SEATC, san: "d4" });
    put(db, "moves", C, 4, 6, { seat: SEATC, san: "e4" });
    expect(admitted(db)).toEqual(["e4"]);
    db.close();
  });

  test("a member's version of the open seat's row changes nothing: the seat stays the one the creator minted", () => {
    const db = openWith(SCHEMA);
    const openSeat = roster(db);
    // Bo writes a new version of the open seat's row, naming Ada's as its parent,
    // with a value of his own: a reseat only the creator may make.
    put(db, "_dai_seat", J, 1, 3, { seat: bytes(0xb9), nonce: null }, { entity: openSeat, parents: JSON.stringify([`${hex(C)}:2`]) });
    const open = db.all("SELECT lower(hex(seat)) AS s FROM _dai_open_seat WHERE session = ?", [S]).map((r) => r["s"]);
    expect(open, "the open seat is still the one Ada minted").toEqual([hex(SEATJ)]);
    db.close();
  });

  test("when the creator's rows confirm one seat twice, the first by her own seq holds", () => {
    const db = openWith(SCHEMA);
    roster(db);
    put(db, "_dai_confirm", C, 5, 4, { seat: SEATJ, holder: K });
    put(db, "_dai_confirm", C, 3, 9, { seat: SEATJ, holder: J });
    put(db, "moves", J, 1, 5, { seat: SEATJ, san: "bo" });
    put(db, "moves", K, 1, 6, { seat: SEATJ, san: "cy" });
    expect(admitted(db), "seq 3 is first, whatever the clocks say").toEqual(["bo"]);
    db.close();
  });
});

test.describe("a contested seat: two asks, nobody seated until the creator acts", () => {
  test("two bindings to the open seat and no confirmation: neither is a member, and neither's move is admitted", () => {
    const db = openWith(SCHEMA);
    roster(db);
    put(db, "_dai_binding", J, 1, 5, { seat: SEATJ });
    put(db, "_dai_binding", K, 1, 4, { seat: SEATJ });
    put(db, "moves", K, 2, 6, { seat: SEATJ, san: "cy" });
    put(db, "moves", J, 2, 7, { seat: SEATJ, san: "bo" });
    expect(members(db)).toEqual([hex(C)]);
    expect(admitted(db)).toEqual([]);
    db.close();
  });
});

test.describe("the merge says what it took and did not admit", () => {
  test("a forged move for someone else's seat is reported as SEAT_NOT_HELD with its author, and kept", async () => {
    const ada = openWith(SCHEMA);
    roster(ada);
    seatBo(ada);
    const bo = openWith(SCHEMA);
    roster(bo);
    seatBo(bo);
    put(bo, "moves", J, 2, 7, { seat: SEATC, san: "d4" });

    const report = await mergeSibling(ada, bo);
    expect(report.refused).toBeUndefined();
    expect(stored(ada), "stored: signed or not, it is Bo's row").toEqual(["d4"]);
    expect(admitted(ada)).toEqual([]);
    expect(report.refusedBatches).toEqual([{ author: showAuthorId(J), reason: "SEAT_NOT_HELD" }]);
    ada.close();
    bo.close();
  });

  test("a move with no seat is reported the same way", async () => {
    const ada = openWith(SCHEMA);
    roster(ada);
    const bo = openWith(SCHEMA);
    roster(bo);
    // Bo's ask reached Ada's copy before (a merge refuses an unsigned one, D133).
    put(ada, "_dai_binding", J, 1, 4, { seat: SEATJ }, { entity: put(bo, "_dai_binding", J, 1, 4, { seat: SEATJ }) });
    put(bo, "moves", J, 2, 5, { seat: null, san: "d4" });
    const report = await mergeSibling(ada, bo);
    expect(report.refusedBatches).toEqual([{ author: showAuthorId(J), reason: "SEAT_NOT_HELD" }]);
    ada.close();
    bo.close();
  });

  test("a move waiting on the creator's confirmation is neither admitted nor reported", async () => {
    const ada = openWith(SCHEMA);
    roster(ada);
    const bo = openWith(SCHEMA);
    roster(bo);
    // Bo's ask reached Ada's copy before (a merge refuses an unsigned one, D133).
    put(ada, "_dai_binding", J, 1, 4, { seat: SEATJ }, { entity: put(bo, "_dai_binding", J, 1, 4, { seat: SEATJ }) });
    put(bo, "moves", J, 2, 5, { seat: SEATJ, san: "e5" });
    const report = await mergeSibling(ada, bo);
    expect(stored(ada)).toEqual(["e5"]);
    expect(admitted(ada)).toEqual([]);
    expect(report.refusedBatches, "pending, not refused").toEqual([]);
    ada.close();
    bo.close();
  });
});
