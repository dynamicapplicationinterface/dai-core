import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { rewriteReplicated } from "../src/replicated.js";
import { confirmSeat, createEntity, ensureReplica, mergeFrom, startSession, type Rows } from "../src/replicated-rows.js";
import { withSessionId } from "./session-db.js";

/**
 * The roster, through the view that enforces it (identity step 5).
 *
 * The session id commits to its creator, the creator's seat is the creator's,
 * and the open seat is held by whoever the creator confirms. A joiner's binding
 * asks; it seats nobody. These write those rows the way the runtime does, each
 * party in its own copy under its own author id, merge the copies, and read
 * `_dai_member`: the view every admission decision reads.
 *
 * The property the model rests on is here too: the answer does not depend on
 * the order the copies are merged in, and no clock is read.
 *
 * Not here: more seats than `max_parties`. No view or write path checks it
 * (backlog D6), so there is nothing real to test until the cap is enforced.
 */

const SCHEMA = `-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL
);
`;
const ROSTER = ["_dai_seat", "_dai_binding", "_dai_confirm"];

const bytes = (b: number): Uint8Array => new Uint8Array(16).fill(b);
const CREATOR = bytes(0xc0);
const OPENER = bytes(0x0b);
const FORWARDED = bytes(0xff);
const SEAT1 = bytes(0x01);
const SEAT2 = bytes(0x02);
const hx = (u: Uint8Array): string => Buffer.from(u).toString("hex");

type Copy = Rows & { close(): void };

/** One party's copy of the document, writing under its own author id. */
function copy(replica: Uint8Array): Copy {
  const db = withSessionId(new DatabaseSync(":memory:"));
  db.exec(rewriteReplicated(SCHEMA).sql);
  const rows: Copy = {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
  ensureReplica(rows, replica);
  return rows;
}

let entities = 0;
const entity = (): Uint8Array => {
  entities += 1;
  const id = new Uint8Array(16).fill(0xe0);
  id[15] = entities;
  return id;
};

/** The creator's copy, with a new session: her seat is SEAT1, the open seat SEAT2. */
function creatorsCopy(): { db: Copy; session: Uint8Array } {
  const db = copy(CREATOR);
  const session = startSession(db, { nonce: bytes(0x07), creatorSeat: SEAT1, openSeat: SEAT2, entities: [entity(), entity()] });
  return { db, session };
}
function binderOf(replica: Uint8Array, session: Uint8Array, seat: Uint8Array): Copy {
  const db = copy(replica);
  createEntity(db, "_dai_binding", entity(), { seat }, session);
  return db;
}
const members = (db: Rows, session: Uint8Array): string[] =>
  db
    .all("SELECT lower(hex(replica)) AS r FROM _dai_member WHERE session = ?", [session])
    .map((row) => String(row["r"]))
    .sort();

/** Every party's rows merged into one fresh copy, in the order given: what each copy converges on. */
function merged(order: readonly Copy[]): Copy {
  const into = copy(bytes(0x77));
  for (const from of order) mergeFrom(into, from, ROSTER);
  return into;
}

test.describe("the roster, through _dai_member (identity step 5)", () => {
  test("the creator is a member from the start; the open seat makes no one one", () => {
    const { db, session } = creatorsCopy();
    expect(members(db, session)).toEqual([hx(CREATOR)]);
  });

  test("a binding asks for the open seat and seats nobody until the creator confirms it", () => {
    const creator = creatorsCopy();
    const opener = binderOf(OPENER, creator.session, SEAT2);
    mergeFrom(creator.db, opener, ROSTER);
    expect(members(creator.db, creator.session), "asked, not confirmed").toEqual([hx(CREATOR)]);
    confirmSeat(creator.db, creator.session, SEAT2, OPENER, entity());
    expect(members(creator.db, creator.session), "confirmed").toEqual([hx(CREATOR), hx(OPENER)].sort());
    expect(members(merged([creator.db, opener]), creator.session), "and on a copy that merged both").toEqual(
      [hx(CREATOR), hx(OPENER)].sort(),
    );
  });

  test("once confirmed, a second opener of the same invite is not a member", () => {
    const creator = creatorsCopy();
    mergeFrom(creator.db, binderOf(OPENER, creator.session, SEAT2), ROSTER);
    confirmSeat(creator.db, creator.session, SEAT2, OPENER, entity());
    const db = merged([creator.db, binderOf(FORWARDED, creator.session, SEAT2)]);
    expect(members(db, creator.session)).toEqual([hx(CREATOR), hx(OPENER)].sort());
  });

  test("a confirmation by anyone but the creator seats nobody", () => {
    const creator = creatorsCopy();
    const forwarded = binderOf(FORWARDED, creator.session, SEAT2);
    confirmSeat(forwarded, creator.session, SEAT2, FORWARDED, entity());
    const db = merged([creator.db, forwarded]);
    expect(members(db, creator.session)).toEqual([hx(CREATOR)]);
  });

  test("a copy that writes a seat row of its own does not become the creator", () => {
    const creator = creatorsCopy();
    const forwarded = copy(FORWARDED);
    createEntity(forwarded, "_dai_seat", entity(), { seat: bytes(0x99), nonce: bytes(0x07) }, creator.session);
    const db = merged([forwarded, creator.db]);
    expect(db.all("SELECT lower(hex(replica)) AS r FROM _dai_creator").map((r) => r["r"])).toEqual([hx(CREATOR)]);
  });

  test("the answer does not depend on the order the copies are merged in", () => {
    // Convergence, stated as a property: any order of merging the same copies
    // yields the identical roster.
    const parties = (): { all: Copy[]; session: Uint8Array } => {
      const creator = creatorsCopy();
      const opener = binderOf(OPENER, creator.session, SEAT2);
      mergeFrom(creator.db, opener, ROSTER);
      confirmSeat(creator.db, creator.session, SEAT2, OPENER, entity());
      return { all: [creator.db, opener, binderOf(FORWARDED, creator.session, SEAT2)], session: creator.session };
    };
    const first = parties();
    const base = JSON.stringify(members(merged(first.all), first.session));
    for (const order of [
      [2, 1, 0],
      [1, 2, 0],
      [0, 2, 1],
    ]) {
      const p = parties();
      expect(JSON.stringify(members(merged(order.map((i) => p.all[i]!)), p.session))).toBe(base);
    }
  });
});
