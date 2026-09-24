import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { showAuthorId } from "../src/identity.js";
import { ReplicationError, rewriteReplicated } from "../src/replicated.js";
import { mergeSibling } from "../src/replicated-frame.js";
import { applyRow, type Rows } from "../src/replicated-rows.js";

/**
 * A seat says whether an author may (docs/identity.md, binding rule 5; step 5).
 *
 * A signature answers who wrote a row; a seat answers whether they may. A
 * table marked `-- dai:replicated seat=<column>` names, in that column, the
 * seat each row acts for, and a row is admitted only when its author held that
 * seat **when the row was written**: the author's binding to the seat is the
 * one that holds it and was written at or before the row's clock, and the seat
 * had that value at the row's clock (no reseat between). A row that names no
 * seat, or a seat outside its session, is stored and never admitted. The
 * admission is the runtime's compiled view, not the application's, and a merge
 * reports a row it took that is not admitted as SEAT_NOT_HELD with its author.
 *
 * Who holds a seat that two bindings name: the first verified signer, which is
 * the lowest (lc, author id) among signed bindings (a copy's own pending
 * binding counts as signed, since it is sealed when it leaves), and among
 * unsigned ones only when no signed one exists. The same on every copy.
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
  const db = new DatabaseSync(":memory:");
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
const S = bytes(0x5e); // the session
const OTHER = bytes(0x5f); // another session
const C = bytes(0xc0); // Ada, the creator: she mints the seats
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

/** Ada's session: her seat and the open one, and her own binding. */
function roster(db: Rows): Uint8Array {
  const openSeat = nextEntity();
  put(db, "_dai_seat", C, 1, 1, { seat: SEATC });
  put(db, "_dai_seat", C, 2, 2, { seat: SEATJ }, { entity: openSeat });
  put(db, "_dai_binding", C, 3, 3, { seat: SEATC });
  return openSeat;
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

test.describe("a row is admitted only when its author held the seat it names when it was written", () => {
  test("the holder's own move is admitted; the strongest forgery, the other player naming that seat, is stored and never admitted", () => {
    const db = openWith(SCHEMA);
    roster(db);
    put(db, "_dai_binding", J, 1, 4, { seat: SEATJ });
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
    put(db, "_dai_binding", J, 1, 4, { seat: SEATJ });
    put(db, "moves", J, 2, 5, { seat: null, san: "d4" });
    put(db, "moves", C, 4, 6, { seat: SEATC, san: "e4" });
    expect(stored(db)).toEqual(["d4", "e4"]);
    expect(admitted(db)).toEqual(["e4"]);
    db.close();
  });

  test("a row that names a seat outside its session is never admitted", () => {
    const db = openWith(SCHEMA);
    roster(db);
    put(db, "_dai_seat", J, 1, 1, { seat: FOREIGN }, { session: OTHER });
    put(db, "_dai_binding", J, 2, 2, { seat: FOREIGN }, { session: OTHER });
    put(db, "_dai_binding", J, 3, 4, { seat: SEATJ });
    put(db, "moves", J, 4, 5, { seat: FOREIGN, san: "d4" });
    expect(admitted(db)).toEqual([]);
    db.close();
  });

  test("a move written before its author took the seat stays refused after they take it; the next one is admitted", () => {
    const db = openWith(SCHEMA);
    roster(db);
    // Bo writes for the open seat before binding it, then binds it.
    put(db, "moves", J, 1, 4, { seat: SEATJ, san: "early" });
    put(db, "_dai_binding", J, 2, 5, { seat: SEATJ });
    put(db, "moves", J, 3, 6, { seat: SEATJ, san: "after" });
    expect(members(db)).toContain(hex(J));
    expect(admitted(db), "held now is not held then").toEqual(["after"]);
    db.close();
  });

  test("a binding that arrives late still admits the move its author wrote after binding", () => {
    const db = openWith(SCHEMA);
    roster(db);
    // The move lands first, the binding after it, as a merge can deliver them.
    put(db, "moves", J, 2, 6, { seat: SEATJ, san: "e5" });
    expect(admitted(db)).toEqual([]);
    put(db, "_dai_binding", J, 1, 5, { seat: SEATJ });
    expect(admitted(db)).toEqual(["e5"]);
    db.close();
  });

  test("a forged move for a seat, then its author legitimately takes that seat by reseat: the forged move stays refused", () => {
    const db = openWith(SCHEMA);
    const openSeat = roster(db);
    // Cy and Bo both open the invite; Cy is first, and holds the open seat.
    put(db, "_dai_binding", K, 1, 4, { seat: SEATJ });
    put(db, "_dai_binding", J, 1, 5, { seat: SEATJ });
    // Ada repairs the contested seat: a fresh value.
    const SEATJ2 = bytes(0xa3);
    put(db, "_dai_seat", C, 5, 6, { seat: SEATJ2 }, { entity: openSeat, parents: JSON.stringify([`${hex(C)}:2`]) });
    // Bo learns the new value and plays for it before binding it...
    put(db, "moves", J, 2, 7, { seat: SEATJ2, san: "forged" });
    // ...and then opens the new invite and binds it: now he is its holder.
    put(db, "_dai_binding", J, 3, 8, { seat: SEATJ2 });
    put(db, "moves", J, 4, 9, { seat: SEATJ2, san: "honest" });
    expect(members(db)).toContain(hex(J));
    expect(admitted(db), "the forged move stays refused; the one after the binding is admitted").toEqual(["honest"]);
    db.close();
  });

  test("a move written while the seat had its old value is not admitted under the new one", () => {
    const db = openWith(SCHEMA);
    const openSeat = roster(db);
    put(db, "_dai_binding", J, 1, 4, { seat: SEATJ });
    // Ada reseats at lc 6; Bo's move at lc 7 still names the old value.
    put(db, "_dai_seat", C, 5, 6, { seat: bytes(0xa3) }, { entity: openSeat, parents: JSON.stringify([`${hex(C)}:2`]) });
    put(db, "moves", J, 2, 7, { seat: SEATJ, san: "stale" });
    expect(admitted(db)).toEqual([]);
    db.close();
  });
});

test.describe("a contested seat: the first verified signer holds it", () => {
  test("two bindings to the open seat: the lower (lc, author) holds it, the other is not a member", () => {
    const db = openWith(SCHEMA);
    roster(db);
    put(db, "_dai_binding", J, 1, 5, { seat: SEATJ });
    put(db, "_dai_binding", K, 1, 4, { seat: SEATJ });
    put(db, "moves", K, 2, 6, { seat: SEATJ, san: "cy" });
    put(db, "moves", J, 2, 7, { seat: SEATJ, san: "bo" });
    expect(members(db)).toEqual([hex(J), hex(K), hex(C)].filter((r) => r !== hex(J)).sort());
    expect(admitted(db)).toEqual(["cy"]);
    db.close();
  });

  test("a signed binding outranks an unsigned one, whatever the clocks", () => {
    const db = openWith(SCHEMA);
    roster(db);
    const bosBatch = signedBy(db, J, 0xb1);
    put(db, "_dai_binding", K, 1, 4, { seat: SEATJ }); // unsigned, earlier
    put(db, "_dai_binding", J, 1, 5, { seat: SEATJ }, { batch: bosBatch }); // signed, later
    put(db, "moves", J, 2, 6, { seat: SEATJ, san: "bo" }, { batch: bosBatch });
    put(db, "moves", K, 2, 7, { seat: SEATJ, san: "cy" });
    expect(admitted(db)).toEqual(["bo"]);
    db.close();
  });
});

test.describe("the merge says what it took and did not admit", () => {
  test("a forged move for someone else's seat is reported as SEAT_NOT_HELD with its author, and kept", async () => {
    const ada = openWith(SCHEMA);
    roster(ada);
    put(ada, "_dai_binding", J, 1, 4, { seat: SEATJ });
    const bo = openWith(SCHEMA);
    roster(bo);
    put(bo, "_dai_binding", J, 1, 4, { seat: SEATJ });
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
    put(bo, "_dai_binding", J, 1, 4, { seat: SEATJ });
    put(bo, "moves", J, 2, 5, { seat: null, san: "d4" });
    const report = await mergeSibling(ada, bo);
    expect(report.refusedBatches).toEqual([{ author: showAuthorId(J), reason: "SEAT_NOT_HELD" }]);
    ada.close();
    bo.close();
  });
});
