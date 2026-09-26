import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { rewriteReplicated } from "../src/replicated.js";
import { confirmSeat, createEntity, ensureReplica, startSession, type Rows } from "../src/replicated-rows.js";
import { withSessionId } from "./session-db.js";
import { mergeSigned, person, sealAs, type Person } from "./signed-people.js";

/**
 * The roster, through the view that enforces it (identity step 5).
 *
 * The session id commits to its creator, the creator's seat is the creator's,
 * and the open seat is held by whoever the creator confirms. A joiner's binding
 * asks; it seats nobody. These write those rows the way the runtime does, each
 * party in its own copy under its own key, sealed, merge the copies, and read
 * `_dai_member`: the view every admission decision reads. Every seat row is
 * signed, because a merge refuses an unsigned one (BATCH_UNSIGNED, D133).
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

const bytes = (b: number): Uint8Array => new Uint8Array(16).fill(b);
let CREATOR: Person;
let OPENER: Person;
let FORWARDED: Person;
let BYSTANDER: Person;
test.beforeAll(async () => {
  [CREATOR, OPENER, FORWARDED, BYSTANDER] = await Promise.all([person(), person(), person(), person()]);
});
const SEAT1 = bytes(0x01);
const SEAT2 = bytes(0x02);
const hx = (who: Person): string => Buffer.from(who.author).toString("hex");

type Copy = Rows & { close(): void };

/** One party's copy of the document, writing under its own author id. */
function copy(who: Person): Copy {
  const db = withSessionId(new DatabaseSync(":memory:"));
  db.exec(rewriteReplicated(SCHEMA).sql);
  const rows: Copy = {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
  ensureReplica(rows, who.author);
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
async function creatorsCopy(): Promise<{ db: Copy; session: Uint8Array }> {
  const db = copy(CREATOR);
  const session = startSession(db, { nonce: bytes(0x07), creatorSeat: SEAT1, openSeat: SEAT2, entities: [entity(), entity()] });
  await sealAs(db, CREATOR);
  return { db, session };
}
async function binderOf(who: Person, session: Uint8Array, seat: Uint8Array): Promise<Copy> {
  const db = copy(who);
  createEntity(db, "_dai_binding", entity(), { seat }, session);
  await sealAs(db, who);
  return db;
}
/** The creator's copy confirms `who` in the open seat, and seals it. */
async function confirm(creator: { db: Copy; session: Uint8Array }, who: Person): Promise<void> {
  confirmSeat(creator.db, creator.session, SEAT2, who.author, entity());
  await sealAs(creator.db, CREATOR);
}
const members = (db: Rows, session: Uint8Array): string[] =>
  db
    .all("SELECT lower(hex(replica)) AS r FROM _dai_member WHERE session = ?", [session])
    .map((row) => String(row["r"]))
    .sort();

/** Every party's rows merged into one fresh copy, in the order given: what each copy converges on. */
async function merged(order: readonly Copy[]): Promise<Copy> {
  const into = copy(BYSTANDER);
  for (const from of order) {
    const report = await mergeSigned(into, from);
    expect(report.refusedBatches, "every seat row here is signed").toEqual([]);
  }
  return into;
}

test.describe("the roster, through _dai_member (identity step 5)", () => {
  test("the creator is a member from the start; the open seat makes no one one", async () => {
    const { db, session } = await creatorsCopy();
    expect(members(db, session)).toEqual([hx(CREATOR)]);
  });

  test("a binding asks for the open seat and seats nobody until the creator confirms it", async () => {
    const creator = await creatorsCopy();
    const opener = await binderOf(OPENER, creator.session, SEAT2);
    await mergeSigned(creator.db, opener, CREATOR);
    expect(members(creator.db, creator.session), "asked, not confirmed").toEqual([hx(CREATOR)]);
    await confirm(creator, OPENER);
    expect(members(creator.db, creator.session), "confirmed").toEqual([hx(CREATOR), hx(OPENER)].sort());
    expect(members(await merged([creator.db, opener]), creator.session), "and on a copy that merged both").toEqual(
      [hx(CREATOR), hx(OPENER)].sort(),
    );
  });

  test("once confirmed, a second opener of the same invite is not a member", async () => {
    const creator = await creatorsCopy();
    await mergeSigned(creator.db, await binderOf(OPENER, creator.session, SEAT2), CREATOR);
    await confirm(creator, OPENER);
    const db = await merged([creator.db, await binderOf(FORWARDED, creator.session, SEAT2)]);
    expect(members(db, creator.session)).toEqual([hx(CREATOR), hx(OPENER)].sort());
  });

  test("a confirmation by anyone but the creator seats nobody", async () => {
    const creator = await creatorsCopy();
    const forwarded = await binderOf(FORWARDED, creator.session, SEAT2);
    confirmSeat(forwarded, creator.session, SEAT2, FORWARDED.author, entity());
    await sealAs(forwarded, FORWARDED);
    const db = await merged([creator.db, forwarded]);
    expect(members(db, creator.session)).toEqual([hx(CREATOR)]);
  });

  test("a copy that writes a seat row of its own does not become the creator", async () => {
    const creator = await creatorsCopy();
    const forwarded = copy(FORWARDED);
    createEntity(forwarded, "_dai_seat", entity(), { seat: bytes(0x99), nonce: bytes(0x07) }, creator.session);
    await sealAs(forwarded, FORWARDED);
    const db = await merged([forwarded, creator.db]);
    expect(db.all("SELECT lower(hex(replica)) AS r FROM _dai_creator").map((r) => r["r"])).toEqual([hx(CREATOR)]);
  });

  test("the answer does not depend on the order the copies are merged in", async () => {
    // Convergence, stated as a property: any order of merging the same copies
    // yields the identical roster.
    const parties = async (): Promise<{ all: Copy[]; session: Uint8Array }> => {
      const creator = await creatorsCopy();
      const opener = await binderOf(OPENER, creator.session, SEAT2);
      await mergeSigned(creator.db, opener, CREATOR);
      await confirm(creator, OPENER);
      return { all: [creator.db, opener, await binderOf(FORWARDED, creator.session, SEAT2)], session: creator.session };
    };
    const first = await parties();
    const base = JSON.stringify(members(await merged(first.all), first.session));
    for (const order of [
      [2, 1, 0],
      [1, 2, 0],
      [0, 2, 1],
    ]) {
      const p = await parties();
      expect(JSON.stringify(members(await merged(order.map((i) => p.all[i]!)), p.session))).toBe(base);
    }
  });

  test("an unsigned binding does not cross a merge, and the merge names it (D133)", async () => {
    const creator = await creatorsCopy();
    const opener = copy(OPENER);
    createEntity(opener, "_dai_binding", entity(), { seat: SEAT2 }, creator.session);
    const report = await mergeSigned(creator.db, opener, CREATOR);
    expect(report.refusedBatches).toEqual([{ author: OPENER.shown, reason: "BATCH_UNSIGNED" }]);
    expect(creator.db.all("SELECT 1 FROM _dai_binding WHERE _r_replica = ?", [OPENER.author])).toEqual([]);
  });
});
