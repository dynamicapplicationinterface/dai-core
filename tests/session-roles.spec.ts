import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { ReplicationError, rewriteReplicated } from "../src/replicated.js";
import { mergeSibling } from "../src/replicated-frame.js";
import { applyRow, type Rows } from "../src/replicated-rows.js";

/**
 * Asymmetric roles inside a session (backlog D15).
 *
 * One party writes, the other answers, and neither can write the other's rows.
 * No new authority model: the roster already has two roles — the **creator**
 * authored the session's seat rows, the **joiner** is a member who authored
 * none — and the author of a row is its key. A table's marker line names which
 * of the two may author it, and that is enforced in two places.
 *
 * **Here: the merge.** This is the property that matters, because a row that
 * arrives from somebody else's copy carries only that copy's word that its own
 * write surface refused anything. So every row below is applied straight
 * through the choke point with an explicit author — exactly what a copy whose
 * application enforced nothing would send — and the question is only whether
 * the receiving copy admits it.
 *
 * The write-surface refusal, which needs the real runtime, is proven separately
 * in `mailbox-link-e2e.spec.ts`.
 */

const SCHEMA = `-- dai:profile session max_parties=2
-- dai:replicated author=creator
CREATE TABLE advice (
  note TEXT NOT NULL
);
-- dai:replicated author=joiner
CREATE TABLE answers (
  note TEXT NOT NULL
);
-- dai:replicated
CREATE TABLE notes (
  note TEXT NOT NULL
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
const S = bytes(0x5e);
const C = bytes(0xc0); // the creator: it mints the seats
const J = bytes(0x10); // the joiner: it binds the open seat
const SEATC = bytes(0xa1);
const SEATJ = bytes(0xa2);

let counter = 0;
const nextEntity = (): Uint8Array => bytes(0x30 + counter++);

/** One row, applied straight through the choke point, with an explicit author. */
function put(
  db: Rows,
  table: string,
  replica: Uint8Array,
  seq: number,
  lc: number,
  columns: Record<string, unknown>,
  entity = nextEntity(),
  parents = "[]",
): Uint8Array {
  applyRow(db, table, {
    _r_replica: replica,
    _r_seq: seq,
    _r_lc: lc,
    _r_entity: entity,
    _r_parents: parents,
    _r_deleted: 0,
    _r_session: S,
    columns,
  });
  return entity;
}

/** The roster both copies share: the creator's two seats, and one binding each. */
function seat(db: Rows): void {
  put(db, "_dai_seat", C, 1, 1, { seat: SEATC });
  put(db, "_dai_seat", C, 2, 2, { seat: SEATJ });
  put(db, "_dai_binding", C, 3, 3, { seat: SEATC });
  put(db, "_dai_binding", J, 1, 4, { seat: SEATJ });
}

const current = (db: Rows, table: string): string[] =>
  db.all(`SELECT note FROM ${table}_current ORDER BY note`).map((r) => String(r["note"]));
const stored = (db: Rows, table: string): string[] =>
  db.all(`SELECT note FROM ${table} ORDER BY note`).map((r) => String(r["note"]));

test.describe("a role is checked when the document is built", () => {
  test("each table's role is recorded, and a schema with none rewrites without the rules view", () => {
    expect(rewriteReplicated(SCHEMA).authors).toEqual({ advice: "creator", answers: "joiner" });

    const plain = rewriteReplicated(`-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE notes (
  note TEXT NOT NULL
);
`);
    expect(plain.authors, "no role declared, none recorded").toBeUndefined();
    expect(plain.sql, "and nothing emitted for one").not.toContain("_dai_author_rules");
  });

  test("a role that is neither creator nor joiner is refused", () => {
    expect(() =>
      rewriteReplicated(`-- dai:profile session max_parties=2
-- dai:replicated author=owner
CREATE TABLE advice (
  note TEXT NOT NULL
);
`),
    ).toThrow(ReplicationError);
  });

  test("a role in a document with no session is refused, because it names nobody", () => {
    expect(() =>
      rewriteReplicated(`-- dai:replicated author=creator
CREATE TABLE advice (
  note TEXT NOT NULL
);
`),
    ).toThrow(/no session profile/);
  });

  test("a marker that almost parses is refused rather than leaving its table quietly local", () => {
    // It used to compare for exact equality, so this was not a marker at all, and
    // the table was built as a plain local table that never merged.
    expect(() =>
      rewriteReplicated(`-- dai:profile session max_parties=2
-- dai:replicated sometimes
CREATE TABLE advice (
  note TEXT NOT NULL
);
`),
    ).toThrow(/not one this build understands/);
  });
});

test.describe("the merge: a row from the wrong party is not admitted, whichever copy it came from (D15)", () => {
  test("the joiner's row in a creator-only table arrives and is dropped; the creator's stands", () => {
    counter = 0;
    const creatorCopy = openWith(SCHEMA);
    const joinerCopy = openWith(SCHEMA);
    seat(creatorCopy);
    seat(joinerCopy);

    // The creator's legitimate advice.
    put(creatorCopy, "advice", C, 4, 5, { note: "first note" });
    // The joiner writes advice it has no right to — on a copy whose application
    // enforced nothing, so the row exists and travels.
    put(joinerCopy, "advice", J, 2, 6, { note: "forged by the joiner" });

    expect(mergeSibling(creatorCopy, joinerCopy).refused).toBeUndefined();

    // The forged row reached the creator's copy — the merge carried it — and is
    // not admitted. That it is stored and absent is what shows the admission
    // rule dropped it, rather than the merge declining to copy it.
    expect(stored(creatorCopy, "advice")).toContain("forged by the joiner");
    expect(current(creatorCopy, "advice")).toEqual(["first note"]);

    creatorCopy.close();
    joinerCopy.close();
  });

  test("the creator's row in a joiner-only table arrives and is dropped; the joiner's stands", () => {
    counter = 0;
    const creatorCopy = openWith(SCHEMA);
    const joinerCopy = openWith(SCHEMA);
    seat(creatorCopy);
    seat(joinerCopy);

    put(joinerCopy, "answers", J, 2, 5, { note: "a reply" });
    put(creatorCopy, "answers", C, 4, 6, { note: "forged by the creator" });

    expect(mergeSibling(joinerCopy, creatorCopy).refused).toBeUndefined();

    expect(stored(joinerCopy, "answers")).toContain("forged by the creator");
    expect(current(joinerCopy, "answers")).toEqual(["a reply"]);

    joinerCopy.close();
    creatorCopy.close();
  });

  test("legitimate rows are admitted on both copies, and an unroled table admits both parties", () => {
    // The guard staying silent: nothing here is refused, and both copies agree.
    counter = 0;
    const creatorCopy = openWith(SCHEMA);
    const joinerCopy = openWith(SCHEMA);
    seat(creatorCopy);
    seat(joinerCopy);

    put(creatorCopy, "advice", C, 4, 5, { note: "first note" });
    put(creatorCopy, "notes", C, 5, 6, { note: "from the creator" });
    put(joinerCopy, "answers", J, 2, 7, { note: "a reply" });
    put(joinerCopy, "notes", J, 3, 8, { note: "from the joiner" });

    expect(mergeSibling(creatorCopy, joinerCopy).refused).toBeUndefined();
    expect(mergeSibling(joinerCopy, creatorCopy).refused).toBeUndefined();

    for (const copy of [creatorCopy, joinerCopy]) {
      expect(current(copy, "advice")).toEqual(["first note"]);
      expect(current(copy, "answers")).toEqual(["a reply"]);
      expect(current(copy, "notes")).toEqual(["from the creator", "from the joiner"]);
    }

    creatorCopy.close();
    joinerCopy.close();
  });

  test("a wrong-party change that names a right-party row as its parent does not bury it", () => {
    // The supersession hazard: if the forged row were merely hidden but still
    // counted as superseding, the creator's advice would vanish with it. The
    // admission rule gates the superseding row too, so the original stands.
    counter = 0;
    const copy = openWith(SCHEMA);
    seat(copy);
    const advice = put(copy, "advice", C, 4, 5, { note: "first note" });
    put(
      copy,
      "advice",
      J,
      2,
      6,
      { note: "an overwrite" },
      advice,
      JSON.stringify([`${Buffer.from(C).toString("hex")}:4`]),
    );

    expect(current(copy, "advice")).toEqual(["first note"]);
    copy.close();
  });
});
