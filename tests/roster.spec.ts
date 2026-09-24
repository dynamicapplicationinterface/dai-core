import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { rewriteReplicated } from "../src/replicated.js";
import { createEntity, ensureReplica, mergeFrom, type Rows } from "../src/replicated-rows.js";

/**
 * The stated roster, through the view that enforces it (T1-D29).
 *
 * Admission is creator-authored seats and joiner-authored bindings, and
 * membership is a pure function of them — which is what lets two copies agree
 * without a clock. These write those rows the way the runtime does, each party
 * in its own copy under its own replica id, merge the copies, and read
 * `_dai_member`: the view every admission decision reads. They used to test a
 * TypeScript statement of the same rule that nothing on the real path called;
 * a second implementation of a rule is the thing that drifts, so the test is
 * on the one that runs.
 *
 * The property the whole correction rests on is here too: the answer does not
 * depend on the order the copies are merged in.
 *
 * Not here: more seats than `max_parties`. The TypeScript statement flagged it,
 * and no view or write path does (backlog D6) — so there is nothing real to
 * test until the cap is enforced.
 */

const SCHEMA = `-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL
);
`;
const ROSTER = ["_dai_seat", "_dai_binding"];

const bytes = (b: number): Uint8Array => new Uint8Array(16).fill(b);
const SESSION = bytes(0x5e);
const CREATOR = bytes(0xc0);
const OPENER = bytes(0x0b);
const FORWARDED = bytes(0xff);
const SEAT1 = bytes(0x01);
const SEAT2 = bytes(0x02);
const hx = (u: Uint8Array): string => Buffer.from(u).toString("hex");

type Copy = Rows & { close(): void };

/** One party's copy of the document, writing under its own replica id. */
function copy(replica: Uint8Array): Copy {
  const db = new DatabaseSync(":memory:");
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
const mint = (db: Rows, seat: Uint8Array) => createEntity(db, "_dai_seat", entity(), { seat }, SESSION);
const bind = (db: Rows, seat: Uint8Array) => createEntity(db, "_dai_binding", entity(), { seat }, SESSION);

const members = (db: Rows): string[] =>
  db
    .all("SELECT lower(hex(replica)) AS r FROM _dai_member WHERE session = ?", [SESSION])
    .map((row) => String(row["r"]))
    .sort();
const binders = (db: Rows, seat: Uint8Array): number =>
  Number(
    db.all("SELECT count(DISTINCT hex(_r_replica)) AS n FROM _dai_binding_current WHERE _r_session = ? AND seat = ?", [
      SESSION,
      seat,
    ])[0]!["n"],
  );

/** Every party's rows merged into one fresh copy, in the order given — what each copy converges on. */
function merged(order: readonly Copy[]): Copy {
  const into = copy(bytes(0x77));
  for (const from of order) mergeFrom(into, from, ROSTER);
  return into;
}

/** The creator's copy: two seats minted, the first bound to itself. */
function creatorsCopy(): Copy {
  const db = copy(CREATOR);
  mint(db, SEAT1);
  mint(db, SEAT2);
  bind(db, SEAT1);
  return db;
}
function binderOf(replica: Uint8Array, seat: Uint8Array): Copy {
  const db = copy(replica);
  bind(db, seat);
  return db;
}

test.describe("the stated roster, through _dai_member (T1-D29)", () => {
  test("a bound seat makes its replica a member; an open seat makes no one one", () => {
    const db = creatorsCopy();
    expect(members(db)).toEqual([hx(CREATOR)]);
  });

  test("both seats bound is a full roster of two", () => {
    const db = merged([creatorsCopy(), binderOf(OPENER, SEAT2)]);
    expect(members(db)).toEqual([hx(CREATOR), hx(OPENER)].sort());
  });

  test("a contested seat is held by the first verified signer, and the other binder is not a member", () => {
    // The opener bound seat 2; a forwarded copy opened the same invite and bound
    // it too. The seat is contested. It used to admit neither (T1-D29); since
    // identity step 5 the first verified signer holds it (rules.ts
    // IDENTITY-FIRST-SIGNER): signed before unsigned, then the lowest clock, then
    // the lowest author id. Both bound at the same clock here, unsigned, so the
    // lower author id (the opener's) holds it, on every copy, in any merge order.
    const db = merged([creatorsCopy(), binderOf(OPENER, SEAT2), binderOf(FORWARDED, SEAT2)]);
    expect(members(db)).toEqual([hx(CREATOR), hx(OPENER)].sort());
    expect(binders(db, SEAT2), "the contest is still visible, for the creator to repair").toBe(2);
  });

  test("a binding to a seat the session never minted is not membership", () => {
    // The forgery the two-row model refuses: a replica cannot admit itself by
    // binding a seat the creator never stated.
    const db = merged([creatorsCopy(), binderOf(FORWARDED, bytes(0x99))]);
    expect(members(db)).toEqual([hx(CREATOR)]);
  });

  test("the answer does not depend on the order the copies are merged in", () => {
    // Convergence, stated as a property: any order of merging the same copies
    // yields the identical roster. A clock or a tiebreak would fail this.
    const parties = (): Copy[] => [creatorsCopy(), binderOf(OPENER, SEAT2), binderOf(FORWARDED, SEAT2)];
    const answer = (db: Copy): string => JSON.stringify([members(db), binders(db, SEAT2)]);
    const base = answer(merged(parties()));
    for (const order of [
      [2, 1, 0],
      [1, 2, 0],
      [0, 2, 1],
    ]) {
      const p = parties();
      expect(answer(merged(order.map((i) => p[i]!)))).toBe(base);
    }
  });
});
