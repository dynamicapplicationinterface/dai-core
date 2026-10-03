import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import {
  ReplicationError,
  checkTriggerCoverage,
  rewriteReplicated,
  triggerColumns,
} from "../src/replicated.js";
import { mergeCoverageGap, mergeSibling, mergeTablesOf, replicatedSchemaOf } from "../src/replicated-frame.js";
import { adoptReplica, confirmSeat, ensureReplica, startSession } from "../src/replicated-rows.js";
import { sessionIdOf } from "../src/session-id.js";
import { withSessionId } from "./session-db.js";
import { mergeFromSigned, mergeSigned, person, sealAs } from "./signed-people.js";
import {
  applyRow,
  canonicalDump,
  changeEntity,
  createEntity,
  deleteEntity,
  encodeValue,
  filterToSession,
  mergeFrom,
  RowRejected,
  SessionExportIncomplete,
  type ReplicatedRow,
  type Rows,
} from "../src/replicated-rows.js";

/**
 * The claim T1-D2 makes, tested as a property rather than as examples.
 *
 * D5 replaced Draft 1's `T_heads` view — which recomputed from every row's
 * parents on every read — with a flag maintained at write. That is only sound
 * if the flag ends up a function of the *row set* and not of the order the
 * rows arrived in. Merge delivers rows in whatever order a sibling happens to
 * hold them: a child before its parent, a tombstone before the change it
 * buries, the same row twice.
 *
 * So the harness comes first. A fixed row set is applied in many orders to a
 * fresh table each time, and every resulting canonical dump must be identical.
 * That is `merge-commutative` generalised, and it is the exact property the
 * flag optimisation has to satisfy to be equivalent to the view it replaced.
 *
 * Orders are drawn from a seed so a failure names the permutation that caused
 * it, rather than being a shuffle nobody can reproduce.
 */

const SCHEMA = `-- dai:replicated
CREATE TABLE cases (
  title  TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  weight REAL
);
`;

/** `node:sqlite` behind the small interface the write rules ask for. */
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

const open = (): Rows & { close(): void } => openWith(SCHEMA);

const bytes = (byte: number): Uint8Array => new Uint8Array(16).fill(byte);
const A = bytes(0xaa);
const B = bytes(0xbb);
const E1 = bytes(0x11);
const E2 = bytes(0x22);

const row = (
  replica: Uint8Array,
  seq: number,
  lc: number,
  entity: Uint8Array,
  parents: string[],
  columns: Record<string, unknown>,
  deleted = 0,
): ReplicatedRow => ({
  _r_replica: replica,
  _r_seq: seq,
  _r_lc: lc,
  _r_entity: entity,
  _r_parents: JSON.stringify([...parents].sort()),
  _r_deleted: deleted,
  columns,
});

const AA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/**
 * A row set with every shape that makes ordering matter: a chain, a fork that
 * conflicts, a resolution naming both heads, a tombstone, and a second entity
 * that shares nothing with the first.
 */
const SET: ReplicatedRow[] = [
  row(A, 1, 1, E1, [], { title: "one", status: "open", weight: 1.5 }),
  row(A, 2, 2, E1, [`${AA}:1`], { title: "one.a", status: "open", weight: 2 }),
  row(B, 1, 2, E1, [`${AA}:1`], { title: "one.b", status: "open", weight: null }),
  row(A, 3, 4, E1, [`${AA}:2`, `${BB}:1`], { title: "one.merged", status: "open", weight: 3 }),
  row(B, 2, 1, E2, [], { title: "two", status: "open", weight: null }),
  row(B, 3, 3, E2, [`${BB}:2`], { title: "two", status: "open", weight: null }, 1),
];

/** A reproducible shuffle: the same seed gives the same order, everywhere. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    // xorshift32 — small, deterministic, and identical in any language that
    // has 32-bit integers, which matters if Python ever runs this harness.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = next() % (index + 1);
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

function applyAll(order: readonly ReplicatedRow[]): string {
  const db = open();
  try {
    db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    for (const item of order) applyRow(db, "cases", item);
    return canonicalDump(db, ["cases"]);
  } finally {
    db.close();
  }
}

/**
 * The orders that must be covered, named rather than hoped for.
 *
 * A random shuffle usually reaches each of these. "Usually" is the word the
 * harness exists to remove, so they are enumerated: if a seeded order stops
 * producing one of them after an edit to the row set, the property is still
 * checked against it here.
 *
 * The duplicate is deliberately mid-sequence rather than appended: a re-insert
 * that lands between a row and its child is the shape a real exchange makes.
 */
const NAMED_ORDERS: ReadonlyArray<{ what: string; order: ReplicatedRow[] }> = [
  { what: "as written", order: [...SET] },
  { what: "reversed", order: [...SET].reverse() },
  // aa:2 names aa:1; delivering the child first is the case D2 exists for.
  { what: "child before parent", order: [SET[1]!, SET[0]!, SET[2]!, SET[3]!, SET[4]!, SET[5]!] },
  // bb:3 buries bb:2; the tombstone arrives before what it buries.
  { what: "tombstone before change", order: [SET[5]!, SET[4]!, SET[0]!, SET[1]!, SET[2]!, SET[3]!] },
  // aa:3 names both heads; the resolution arrives before either of them.
  { what: "resolution before its heads", order: [SET[3]!, SET[1]!, SET[2]!, SET[0]!, SET[4]!, SET[5]!] },
  // Every exchange re-sends everything, so this is the common case, not an edge.
  { what: "same row twice, mid-sequence", order: [SET[0]!, SET[1]!, SET[0]!, SET[2]!, SET[3]!, SET[4]!, SET[5]!] },
];

test.describe("the flag is a function of the row set, not of arrival order", () => {
  test("the adversarial orders, each named", () => {
    const reference = applyAll(SET);
    for (const { what, order } of NAMED_ORDERS) {
      expect(applyAll(order), what).toBe(reference);
    }
  });

  test("every order of the same rows produces the same table", () => {
    const reference = applyAll(SET);
    const failures: string[] = [];
    // Enough seeds to reach every shape that matters many times over; each one
    // names itself, so a failure is a line to paste back rather than a hunt.
    for (let seed = 1; seed <= 200; seed += 1) {
      const order = shuffled(SET, seed);
      const dump = applyAll(order);
      if (dump !== reference) {
        failures.push(`seed ${seed}: ${order.map((r) => `${r._r_seq}@${r._r_replica[0]!.toString(16)}`).join(" ")}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("child before parent leaves the parent superseded, which is the case D2 exists for", () => {
    /*
     * The half of D2 that looks redundant. Marking a row's parents superseded
     * is obvious; marking the row itself when something already names it is
     * what covers a merge that delivers a child first. Without it the parent
     * sits as a head forever on this host and on no other.
     */
    const db = open();
    db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);

    applyRow(db, "cases", SET[1]!); // the child, naming aa:1
    applyRow(db, "cases", SET[0]!); // the parent, arriving second

    const heads = db.all("SELECT _r_seq FROM cases_heads ORDER BY _r_seq");
    expect(heads.map((h) => Number(h["_r_seq"]))).toEqual([2]);
    db.close();
  });

  test("the flag matches what a full parents scan would say", () => {
    // The equivalence D2 claims: the flag is the optimisation, and Draft 1's
    // recompute-from-scratch view is the definition it must agree with.
    for (const seed of [1, 7, 42, 99]) {
      const db = open();
      db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
      db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
      for (const item of shuffled(SET, seed)) applyRow(db, "cases", item);

      const byFlag = db
        .all("SELECT hex(_r_replica) r, _r_seq s FROM cases WHERE _r_superseded = 0 ORDER BY r, s")
        .map((x) => `${x["r"]}:${x["s"]}`);
      const byScan = db
        .all(
          `SELECT hex(_r_replica) r, _r_seq s FROM cases c
            WHERE NOT EXISTS (
              SELECT 1 FROM cases o, json_each(o._r_parents) p
               WHERE p.value = lower(hex(c._r_replica)) || ':' || c._r_seq)
            ORDER BY r, s`,
        )
        .map((x) => `${x["r"]}:${x["s"]}`);
      expect(byFlag, `seed ${seed}`).toEqual(byScan);
      db.close();
    }
  });
});

test.describe("the same row twice", () => {
  test("is a no-op, because every exchange re-sends everything", () => {
    const db = open();
    db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);

    expect(applyRow(db, "cases", SET[0]!)).toBe("added");
    expect(applyRow(db, "cases", SET[0]!)).toBe("duplicate");
    expect(db.all("SELECT count(*) c FROM cases")[0]!["c"]).toBe(1);
    db.close();
  });

  test("but different content under the same id is refused, which is the tampering signature", () => {
    // A row id is (replica, seq) and a replica issues each seq once, so two
    // contents under one id cannot both be honest.
    const db = open();
    db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    applyRow(db, "cases", SET[0]!);

    const forged = row(A, 1, 1, E1, [], { title: "not one", status: "open", weight: 1.5 });
    let caught: unknown;
    try {
      applyRow(db, "cases", forged);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RowRejected);
    expect((caught as RowRejected).code).toBe("ROW_REJECTED");
    db.close();
  });

  test("a row whose only difference is the superseded flag is still the same row", () => {
    // The flag is derived local state, never trusted from a sender (T1-D11):
    // theirs says what they have seen, which is none of our business.
    const db = open();
    db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    applyRow(db, "cases", SET[0]!);
    applyRow(db, "cases", SET[1]!); // supersedes it locally
    expect(applyRow(db, "cases", SET[0]!)).toBe("duplicate");
    db.close();
  });
});

test.describe("canonical-dump-real-edge-cases", () => {
  test("the four values a language will otherwise print its own way", () => {
    /*
     * Runs before merge-commutative, deliberately. Python's repr and
     * JavaScript's toString both give shortest round-trip digits and disagree
     * on all four of these, so without a fixed spelling the first document
     * with a float column fails the commutativity vector and a correct merge
     * takes the blame for the printer.
     */
    expect(encodeValue(-0)).toBe("-0.0");
    expect(encodeValue(Number.NaN)).toBe("nan");
    expect(encodeValue(Number.POSITIVE_INFINITY)).toBe("inf");
    expect(encodeValue(Number.NEGATIVE_INFINITY)).toBe("-inf");
  });

  test("a float that needs all seventeen digits survives the round trip", () => {
    const awkward = 0.1 + 0.2;
    expect(Number(encodeValue(awkward))).toBe(awkward);
    expect(encodeValue(awkward)).toBe("0.30000000000000004");
  });

  test("nulls, blobs and awkward text", () => {
    expect(encodeValue(null)).toBe("nil");
    expect(encodeValue(new Uint8Array([0, 0xab, 0xff]))).toBe("00abff");
    expect(encodeValue(new Uint8Array())).toBe("");
    // Tabs separate columns and newlines separate rows, so both are escaped —
    // otherwise one cell of user text reshapes the whole dump.
    expect(encodeValue("a\tb\nc\\d")).toBe("a\\tb\\nc\\\\d");
  });
});

test.describe("the trigger's column list is checked against the engine", () => {
  test("every column the engine reports is named, or the build fails", () => {
    /*
     * The parser that produces the trigger's list is trust-relevant: a column
     * it fails to see is a column that can be edited in place, in a table
     * whose whole contract is that it cannot. So the parse is not trusted —
     * the schema is loaded into a real engine, the columns are read back from
     * it, and anything the trigger does not name is a build failure.
     *
     * This is what makes the earlier hole unrepeatable rather than something
     * to remember.
     */
    const { sql } = rewriteReplicated(SCHEMA);
    const db = new DatabaseSync(":memory:");
    db.exec(sql);
    const fromEngine = (db.prepare("SELECT name FROM pragma_table_info('cases')").all() as { name: string }[])
      .map((row) => row.name);
    db.close();

    expect(fromEngine).toContain("weight");
    expect(() => checkTriggerCoverage("cases", fromEngine, triggerColumns(sql, "cases"))).not.toThrow();
  });

  test("a column the parser missed is a refused build, not a quiet hole", () => {
    const { sql } = rewriteReplicated(SCHEMA);
    // As if the parser had skipped `weight` — the exact shape of the bug that
    // got through the text tests and was caught only by running the schema.
    const short = triggerColumns(sql, "cases").filter((name) => name !== "weight");
    let caught: unknown;
    try {
      checkTriggerCoverage("cases", ["title", "status", "weight", "_r_superseded"], short);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReplicationError);
    expect((caught as ReplicationError).message).toContain("weight");
    expect((caught as ReplicationError).message).toMatch(/edited in place/);
  });

  test("_r_superseded is the one column that must not be named", () => {
    // Naming it would forbid the write that maintaining it requires, which is
    // the trap T1-D10 was written against.
    const { sql } = rewriteReplicated(SCHEMA);
    expect(triggerColumns(sql, "cases")).not.toContain("_r_superseded");
  });
});

test.describe("merge", () => {
  /**
   * Two independent copies of the same schema, each written by a person with a
   * key: at batch format version 2 a row crosses a merge only signed, so every
   * exchange below seals what the sender wrote and verifies it on arrival
   * (`mergeFromSigned`).
   */
  async function pair() {
    const ada = await person();
    const bo = await person();
    const a = open();
    const b = open();
    ensureReplica(a, ada.author);
    ensureReplica(b, bo.author);
    return { a, b, ada, bo };
  }

  test("merge-disjoint", async () => {
    const { a, b, bo } = await pair();
    createEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
    createEntity(b, "cases", E2, { title: "yours", status: "open", weight: null });

    const result = await mergeFromSigned(a, b, bo, ["cases"]);
    expect(result.applied).toBe(1);
    expect(result.duplicate).toBe(0);
    expect(result.rejected).toEqual([]);
    expect(result.refusedBatches).toEqual([]);
    expect(a.all("SELECT count(*) c FROM cases_current")[0]!["c"]).toBe(2);
    a.close();
    b.close();
  });

  test("merge-idempotent", async () => {
    const { a, b, bo } = await pair();
    createEntity(b, "cases", E2, { title: "yours", status: "open", weight: null });

    expect((await mergeFromSigned(a, b, bo, ["cases"])).applied).toBe(1);
    const second = await mergeFromSigned(a, b, bo, ["cases"]);
    expect(second.applied).toBe(0);
    expect(second.duplicate).toBe(1);
    a.close();
    b.close();
  });

  test("merge-commutative", async () => {
    // A←B then A←C against A←C then A←B, by the dump of T1-D9.
    const build = async (order: "bc" | "cb"): Promise<string> => {
      const [ada, bo, cy] = [await person(), await person(), await person()];
      const a = open();
      const b = open();
      const c = open();
      for (const [db, who] of [[a, ada], [b, bo], [c, cy]] as const) ensureReplica(db, who.author);
      createEntity(a, "cases", E1, { title: "a", status: "open", weight: 1 });
      createEntity(b, "cases", E2, { title: "b", status: "open", weight: 2 });
      createEntity(c, "cases", bytes(0x33), { title: "c", status: "open", weight: null });
      if (order === "bc") {
        await mergeFromSigned(a, b, bo, ["cases"]);
        await mergeFromSigned(a, c, cy, ["cases"]);
      } else {
        await mergeFromSigned(a, c, cy, ["cases"]);
        await mergeFromSigned(a, b, bo, ["cases"]);
      }
      // The authors differ between the two builds, so the dump is read without them.
      const dump = JSON.stringify(a.all("SELECT title, weight FROM cases_current ORDER BY title"));
      a.close();
      b.close();
      c.close();
      return dump;
    };
    const bc = await build("bc");
    expect(JSON.parse(bc), "all three rows merged").toHaveLength(3);
    expect(bc).toBe(await build("cb"));
  });

  test("merge-conflict, and current shows the pick with the flag up", async () => {
    const { a, b, ada, bo } = await pair();
    const base = createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
    await mergeFromSigned(b, a, ada, ["cases"]); // both hold the base row
    changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
    changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });

    await mergeFromSigned(a, b, bo, ["cases"]);
    expect(a.all("SELECT count(*) c FROM cases_conflicts")[0]!["c"]).toBe(1);
    expect(a.all("SELECT count(*) c FROM cases_heads")[0]!["c"]).toBe(2);
    const current = a.all("SELECT title, _r_conflicted FROM cases_current");
    // Never omitted, always flagged.
    expect(current).toHaveLength(1);
    expect(Number(current[0]!["_r_conflicted"])).toBe(1);
    expect(base._r_seq).toBe(1);
    a.close();
    b.close();
  });

  test("merge-tombstone-conflict shows the change, not the delete (T1-D3)", async () => {
    const { a, b, ada, bo } = await pair();
    createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
    await mergeFromSigned(b, a, ada, ["cases"]);
    changeEntity(a, "cases", E1, { title: "edited", status: "open", weight: null });
    deleteEntity(b, "cases", E1);

    await mergeFromSigned(a, b, bo, ["cases"]);
    const current = a.all("SELECT title, _r_conflicted FROM cases_current");
    expect(current).toHaveLength(1);
    expect(current[0]!["title"]).toBe("edited");
    // And the person is told somebody deleted it, rather than finding their
    // edit quietly resurrected.
    expect(Number(current[0]!["_r_conflicted"])).toBe(1);
    a.close();
    b.close();
  });

  test("merge-resolve clears the conflict", async () => {
    const { a, b, ada, bo } = await pair();
    createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
    await mergeFromSigned(b, a, ada, ["cases"]);
    changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
    changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });
    await mergeFromSigned(a, b, bo, ["cases"]);

    // A change written while a conflict is open names every head, which is
    // what makes it a resolution; there is no separate operation.
    changeEntity(a, "cases", E1, { title: "settled", status: "open", weight: null });
    expect(a.all("SELECT count(*) c FROM cases_conflicts")[0]!["c"]).toBe(0);
    const current = a.all("SELECT title, _r_conflicted FROM cases_current");
    expect(current[0]!["title"]).toBe("settled");
    expect(Number(current[0]!["_r_conflicted"])).toBe(0);
    a.close();
    b.close();
  });

  test("the clock is above everything the merge brought in, before the next write", async () => {
    /*
     * A local row written after a merge must outrank what the merge delivered.
     * `_current` picks the highest `_r_lc`, so a row written with a stale clock
     * would lose to its own ancestors and the person's newest edit would
     * disappear behind an older one.
     */
    const { a, b, bo } = await pair();
    for (let n = 0; n < 5; n += 1) {
      createEntity(b, "cases", bytes(0x40 + n), { title: `b${n}`, status: "open", weight: null });
    }
    const theirs = Number(b.all("SELECT max(_r_lc) m FROM cases")[0]!["m"]);
    expect((await mergeFromSigned(a, b, bo, ["cases"])).applied).toBe(5);
    expect(Number(a.all("SELECT lc FROM _dai_replica")[0]!["lc"])).toBeGreaterThanOrEqual(theirs);

    const mine = createEntity(a, "cases", E1, { title: "after", status: "open", weight: null });
    expect(mine._r_lc).toBeGreaterThan(theirs);
    a.close();
    b.close();
  });

  test("one refused row does not deny the good ones", async () => {
    // Refusing the whole exchange would make one forged row cheaper than
    // forging anything real.
    const { a, b, bo } = await pair();
    createEntity(b, "cases", E1, { title: "honest", status: "open", weight: null });
    createEntity(b, "cases", E2, { title: "also honest", status: "open", weight: null });
    await sealAs(b, bo);
    // A row nobody signed, under a third id, carried in the same copy.
    const mal = await person();
    applyRow(b, "cases", row(mal.author, 1, 1, bytes(0x33), [], { title: "nobody's", status: "open", weight: null }));

    const result = await mergeFromSigned(a, b, bo, ["cases"]);
    expect(result.refusedBatches, "the unsigned row is refused by name").toEqual([{ author: mal.shown, reason: "BATCH_UNSIGNED" }]);
    expect(result.applied, "and both honest rows are taken").toBe(2);
    expect(a.all("SELECT count(*) c FROM cases")[0]!["c"]).toBe(2);
    a.close();
    b.close();
  });
});

test.describe("the frame's side of a merge", () => {
  const rowsFor = (db: ReturnType<typeof open>) => db;

  test("a sibling with the same tables merges and reports the conflict count", async () => {
    const [ada, bo] = [await person(), await person()];
    const a = open();
    const b = open();
    ensureReplica(a, ada.author);
    ensureReplica(b, bo.author);

    createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
    await sealAs(a, ada);
    await mergeSigned(rowsFor(b), rowsFor(a));
    changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
    changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });
    await sealAs(b, bo);

    const report = await mergeSigned(rowsFor(a), rowsFor(b));
    expect(report.refused).toBeUndefined();
    expect(report.applied).toBe(1);
    // The one number a person is shown, and not derivable from the other four.
    expect(report.conflicts).toBe(1);
    a.close();
    b.close();
  });

  test("a sibling whose replicated schema differs is refused, not merged", async () => {
    /*
     * T1-D14, at the point it actually bites. Refusing loudly is safe to
     * tighten now and loosen later: the migration chain turns some of these
     * into merges and never turns a merge into a refusal.
     */
    const a = open();
    const b = openWith(`-- dai:replicated
CREATE TABLE cases (
  title  TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  weight REAL,
  extra  TEXT
);
`);
    a.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    a.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    b.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [B]);
    b.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [B]);
    createEntity(b, "cases", E2, { title: "theirs", status: "open", weight: null, extra: "x" });

    const report = await mergeSibling(rowsFor(a), rowsFor(b));
    expect(report.refused).toBe("SCHEMA_MISMATCH");
    expect(report.applied).toBe(0);
    // Refused means nothing happened, not that some of it happened.
    expect(a.all("SELECT count(*) c FROM cases")[0]!["c"]).toBe(0);
    a.close();
    b.close();
  });

  test("a second compiler's rewrite is still a sibling (T1-D21)", async () => {
    /*
     * The distinction the schema digest depends on, asserted rather than
     * assumed.
     *
     * There are two digests over a schema and they answer different questions.
     * `runtime/schema.json` digests the SQL this compiler *executed* — the
     * rewrite, because that is what shapes the stored database, and a change
     * to the rewrite has to demand a migration. That digest is lineage-
     * internal: one document, one migration chain, one tool.
     *
     * The sibling test digests what the *author declared* — `pragma_table_info`
     * over the author's columns, `_r_*` excluded. Two conforming compilers may
     * emit the rewrite differently and both be right: different column order
     * among the replication columns, different whitespace, a different way of
     * spelling the same constraint. Comparing what was executed would make two
     * copies of one document, built by two tools, refuse each other as
     * SCHEMA_MISMATCH — a disagreement about mergeability rather than about a
     * merge, which is worse, because the rows never get far enough to disagree.
     *
     * So this stands in for that second compiler: the same declared schema,
     * written differently, and the merge must go through.
     */
    const a = open();
    const b = openWith(
      // Same columns, same types, same defaults — different spelling
      // throughout. A formatter, a different case convention, extra blank
      // lines: none of it is a difference of schema.
      "-- dai:replicated\nCREATE TABLE cases (\n\n  title text  NOT NULL,\n  status   TEXT   NOT NULL DEFAULT 'open',\n\n  weight real\n);\n",
    );

    const bo = await person();
    ensureReplica(a, A);
    ensureReplica(b, bo.author);
    createEntity(b, "cases", E2, { title: "theirs", status: "open", weight: 1.5 });
    await sealAs(b, bo);

    const report = await mergeSigned(rowsFor(a), rowsFor(b));
    expect(report.refused).toBeUndefined();
    expect(report.applied).toBe(1);
    expect(a.all("SELECT title FROM cases_current")[0]!["title"]).toBe("theirs");

    /*
     * And the reason it worked: the two copies' *declared* shapes are equal
     * while the SQL that produced them is not. If this ever fails because the
     * two strings became equal, the test has stopped testing anything.
     */
    expect(replicatedSchemaOf(rowsFor(a))).toBe(replicatedSchemaOf(rowsFor(b)));

    a.close();
    b.close();
  });

  test("a level this frame does not implement is refused rather than treated as Level 1", async () => {
    // A Level 2 sibling merged as Level 1 would have its signatures unchecked
    // while the person was told the merge succeeded.
    const a = open();
    const b = open();
    a.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    b.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [B]);
    const report = await mergeSibling(rowsFor(a), rowsFor(b), 2);
    expect(report.refused).toBe("UNSUPPORTED_LEVEL");
    a.close();
    b.close();
  });

  test("a local table on one side only does not stop the merge", async () => {
    // Local tables never travel and never merge, so a difference in them says
    // nothing about whether these two copies can exchange rows.
    const a = openWith(`${SCHEMA}\nCREATE TABLE notes_local (body TEXT);\n`);
    const b = open();
    const bo = await person();
    ensureReplica(a, A);
    ensureReplica(b, bo.author);
    createEntity(b, "cases", E2, { title: "theirs", status: "open", weight: null });
    await sealAs(b, bo);

    const report = await mergeSigned(rowsFor(a), rowsFor(b));
    expect(report.refused).toBeUndefined();
    expect(report.applied).toBe(1);
    a.close();
    b.close();
  });
});

test.describe("a copy that arrived from somebody else", () => {
  /** The file, opened on another device: same rows, same headers, same _dai_replica. */
  function received(from: Rows & { close(): void }): Rows & { close(): void } {
    const to = open();
    for (const header of from.all("SELECT * FROM _dai_batch")) {
      const names = Object.keys(header);
      to.run(`INSERT INTO _dai_batch (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => header[n]));
    }
    for (const row of from.all("SELECT * FROM cases")) {
      to.run(
        "INSERT INTO cases (title,status,weight,_r_replica,_r_seq,_r_lc,_r_entity,_r_parents,_r_deleted,_r_superseded,_r_batch)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          row["title"], row["status"], row["weight"], row["_r_replica"], row["_r_seq"],
          row["_r_lc"], row["_r_entity"], row["_r_parents"], row["_r_deleted"], row["_r_superseded"], row["_r_batch"],
        ],
      );
    }
    const theirs = from.all("SELECT id, seq, lc FROM _dai_replica")[0]!;
    to.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, ?, ?)", [
      theirs["id"], theirs["seq"], theirs["lc"],
    ]);
    to.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [theirs["id"]]);
    return to;
  }

  test("writes under its own identity, not the sender's", async () => {
    /*
     * The bug this exists for, found by an application author writing a
     * fixture for two people playing correspondence chess.
     *
     * `ensureReplica` leaves an existing `_dai_replica` alone, which is right
     * for reopening your own copy and wrong for opening somebody else's file:
     * the recipient wrote rows stamped with the sender's id. Both then
     * allocated the same (replica, seq) pairs, and the next exchange refused
     * one of them as ROW_REJECTED — the code meaning a row id was claimed
     * twice with different contents. Two people using the document exactly as
     * intended produced a row rejected as tampering.
     */
    const [ada, bo] = [await person(), await person()];
    const alice = open();
    ensureReplica(alice, ada.author);
    createEntity(alice, "cases", E1, { title: "e4", status: "open", weight: null });
    await sealAs(alice, ada);

    const bob = received(alice);
    expect(adoptReplica(bob, bo.author)).toBe(true);

    // Bob writes as Bob.
    createEntity(bob, "cases", E2, { title: "e5", status: "open", weight: null });
    // By entity, not by sequence: Bob's counter restarted at 1, so both his
    // row and Alice's carry seq 1 and ordering by it picks arbitrarily. That
    // the two share a sequence number is exactly right — they are different
    // replicas now, which is the whole point.
    const written = bob.all("SELECT lower(hex(_r_replica)) r FROM cases WHERE _r_entity = ?", [E2])[0]!;
    expect(String(written["r"])).toBe(Buffer.from(bo.author).toString("hex"));
    await sealAs(bob, bo);

    // And Alice's next move does not collide with it.
    changeEntity(alice, "cases", E1, { title: "Nf3", status: "open", weight: null });
    const report = await mergeSigned(alice, bob);
    expect(report.refused).toBeUndefined();
    expect(report.rejected).toEqual([]);
    expect(report.applied).toBe(1);

    alice.close();
    bob.close();
  });

  test("the sender keeps authorship of what they wrote", () => {
    // Their rows stay theirs. Adopting a new identity is about what this copy
    // writes next, and says nothing about what is already in the file.
    const alice = open();
    alice.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    alice.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    createEntity(alice, "cases", E1, { title: "e4", status: "open", weight: null });

    const bob = received(alice);
    adoptReplica(bob, B);

    const author = bob.all("SELECT hex(_r_replica) r FROM cases")[0]!;
    expect(String(author["r"]).toLowerCase()).toBe("aa".repeat(16));
    // And the sender is among the replicas this copy knows.
    const known = bob.all("SELECT hex(id) h FROM _dai_replicas").map((x) => String(x["h"]).toLowerCase());
    expect(known).toContain("aa".repeat(16));
    expect(known).toContain("bb".repeat(16));
    bob.close();
    alice.close();
  });

  test("a file that comes back carrying this id's rows resumes its seq above them", async () => {
    /*
     * An author id is a device's key, the same for every copy the device holds
     * (docs/identity.md). So a file can come back to the device that wrote
     * some of it: sent out, answered, and received again as a fresh copy.
     * Adopting there must not restart at seq 0, or the next row reissues a
     * (replica, seq) this device already issued, and the exchange with the
     * device's other copy refuses one as ROW_REJECTED.
     */
    const [ada, bo] = [await person(), await person()];
    const alice = open();
    ensureReplica(alice, ada.author);
    createEntity(alice, "cases", E1, { title: "e4", status: "open", weight: null });
    createEntity(alice, "cases", E2, { title: "d4", status: "open", weight: null });
    await sealAs(alice, ada);

    const bob = received(alice);
    adoptReplica(bob, bo.author);
    createEntity(bob, "cases", bytes(0x61), { title: "e5", status: "open", weight: null });
    await sealAs(bob, bo);

    // Alice's device forgot its copy; Bob's comes back and is opened there as a new one.
    const back = received(bob);
    adoptReplica(back, ada.author);
    expect(Number(back.all("SELECT seq FROM _dai_replica")[0]!["seq"]), "resumes at Alice's highest").toBe(2);
    createEntity(back, "cases", bytes(0x62), { title: "Nf3", status: "open", weight: null });
    const issued = back.all("SELECT _r_seq s FROM cases WHERE _r_replica = ? ORDER BY _r_seq", [ada.author]).map((r) => Number(r["s"]));
    expect(issued, "Alice's new row takes the next seq, not one she already issued").toEqual([1, 2, 3]);
    await sealAs(back, ada);

    // And Bob, who holds Alice's first two rows, takes the new one without a refusal.
    const report = await mergeSigned(bob, back);
    expect(report.rejected, "no (replica, seq) was issued twice").toEqual([]);
    expect(report.applied).toBe(1);

    alice.close();
    bob.close();
    back.close();
  });

  test("a merge that brings back this author's own rows raises its seq above them", async () => {
    /*
     * The lost save (cold review of step 2, #3): this copy wrote rows 1..4 and
     * they reached the mailbox, but its save of rows 3 and 4 never landed, so
     * the copy reopens holding only 1 and 2 with its counter at 2. Pulling its
     * own rows 3 and 4 back from the mailbox must raise the counter past them,
     * or its next row is a second, different (A, 3).
     */
    const ada = await person();
    const alice = open();
    ensureReplica(alice, ada.author);
    createEntity(alice, "cases", E1, { title: "e4", status: "open", weight: null });
    createEntity(alice, "cases", E2, { title: "d4", status: "open", weight: null });
    await sealAs(alice, ada); // sealed by the save that landed
    const reopened = received(alice); // the copy as its last landed save left it
    createEntity(alice, "cases", bytes(0x71), { title: "c4", status: "open", weight: null });
    createEntity(alice, "cases", bytes(0x72), { title: "Nf3", status: "open", weight: null });
    await sealAs(alice, ada); // sealed as they left for the mailbox

    const report = await mergeSigned(reopened, alice, ada); // its own rows, back from the mailbox
    expect(report.rejected).toEqual([]);
    expect(report.applied, "rows 3 and 4 came back").toBe(2);
    expect(Number(reopened.all("SELECT seq FROM _dai_replica")[0]!["seq"]), "raised to the highest it brought in").toBe(4);
    createEntity(reopened, "cases", bytes(0x73), { title: "g3", status: "open", weight: null });
    const issued = reopened.all("SELECT _r_seq s FROM cases WHERE _r_replica = ? ORDER BY _r_seq", [ada.author]).map((r) => Number(r["s"]));
    expect(issued, "the next row takes 5, not a second 3").toEqual([1, 2, 3, 4, 5]);

    alice.close();
    reopened.close();
  });

  test("the clock does not restart, or the first row written sorts below what it followed", () => {
    /*
     * `seq` restarts because sequence numbers are per replica. The clock must
     * not: this copy has seen everything in the file, so a row it writes now
     * happened after all of them, and a clock reset would make it sort below
     * rows it was written in response to — which `_current` picks by.
     */
    const alice = open();
    alice.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    alice.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    for (let n = 0; n < 4; n += 1) {
      createEntity(alice, "cases", bytes(0x50 + n), { title: `m${n}`, status: "open", weight: null });
    }
    const theirHighest = Number(alice.all("SELECT max(_r_lc) m FROM cases")[0]!["m"]);

    const bob = received(alice);
    adoptReplica(bob, B);
    expect(Number(bob.all("SELECT seq FROM _dai_replica")[0]!["seq"])).toBe(0);

    const mine = createEntity(bob, "cases", E2, { title: "next", status: "open", weight: null });
    expect(mine._r_lc).toBeGreaterThan(theirHighest);
    bob.close();
    alice.close();
  });

  test("reopening your own copy changes nothing", () => {
    // The other half: adopting is for a copy that arrived, and calling it with
    // the identity already held is a no-op rather than a new replica each open.
    const mine = open();
    mine.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 3, 7)", [A]);
    mine.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    expect(adoptReplica(mine, A)).toBe(false);
    const state = mine.all("SELECT hex(id) h, seq, lc FROM _dai_replica")[0]!;
    expect(String(state["h"]).toLowerCase()).toBe("aa".repeat(16));
    expect(Number(state["seq"])).toBe(3);
    mine.close();
  });
});

test.describe("a session document threads the session onto every row (T1-D26)", () => {
  const SESSION_SCHEMA = `-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
`;
  const openSession = (): Rows & { close(): void } => openWith(SESSION_SCHEMA);
  const S1 = bytes(0x51);
  const S2 = bytes(0x52);
  const hx = (u: unknown): string => (u instanceof Uint8Array ? Buffer.from(u).toString("hex") : "");

  test("create, change and delete all carry the session, delete taking it from the head", () => {
    const db = openSession();
    ensureReplica(db, A);
    // A session A created, so A writes in it: a writer versions only heads of a
    // session it is a member of or waits in (D135).
    const s = startSession(db, { creatorSeat: bytes(0x62), openSeat: bytes(0x63), entities: [bytes(0x64), bytes(0x65)] });
    createEntity(db, "moves", E1, { ply: 1, san: "e4" }, s);
    // Change and delete name the session with the entity (D134): a row is
    // (session, entity), and the version stays in it.
    changeEntity(db, "moves", E1, { ply: 1, san: "e4!" }, s);
    deleteEntity(db, "moves", E1, s);

    const sessions = db.all(`SELECT _r_session FROM moves`).map((r) => hx(r["_r_session"]));
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions)).toEqual(new Set([hx(s)]));
    db.close();
  });

  test("a write with no session is refused, because every row belongs to one", () => {
    const db = openSession();
    ensureReplica(db, A);
    expect(() => createEntity(db, "moves", E1, { ply: 1, san: "e4" })).toThrow(RowRejected);
    db.close();
  });

  test("the session is immutable: an in-place edit is refused like any other _r_ column", () => {
    const db = openSession();
    ensureReplica(db, A);
    createEntity(db, "moves", E1, { ply: 1, san: "e4" }, S1);
    expect(() => db.run(`UPDATE moves SET _r_session = ? WHERE _r_seq = 1`, [S2])).toThrow(
      /REPLICATED_TABLE_IMMUTABLE/,
    );
    db.close();
  });

  test("one table holds rows from many sessions, and they converge across a merge", async () => {
    // The whole point of a per-row session: a games list is many games in one
    // table. Two copies each write a different session; a merge carries both.
    const [ada, bo] = [await person(), await person()];
    const a = openSession();
    ensureReplica(a, ada.author);
    createEntity(a, "moves", E1, { ply: 1, san: "e4" }, S1);

    const b = openSession();
    ensureReplica(b, bo.author);
    createEntity(b, "moves", E2, { ply: 1, san: "d4" }, S2);

    await sealAs(a, ada);
    expect((await mergeFromSigned(a, b, bo, ["moves"])).applied).toBe(1);
    expect((await mergeFromSigned(b, a, ada, ["moves"])).applied).toBe(1);

    // Convergent, and the session travelled with each row rather than being lost.
    expect(canonicalDump(a, ["moves"])).toBe(canonicalDump(b, ["moves"]));
    const sessions = new Set(a.all(`SELECT _r_session FROM moves`).map((r) => hx(r["_r_session"])));
    expect(sessions).toEqual(new Set([hx(S1), hx(S2)]));

    a.close();
    b.close();
  });

  test("a merged row missing its session is rejected, not written half-formed", () => {
    // The merge path enforces the same rule as the write path: an incoming row
    // for a session table with no _r_session is refused.
    const local = openSession();
    ensureReplica(local, A);
    const sibling = openSession();
    ensureReplica(sibling, B);
    // A hand-made incoming row with no session, applied through the merge choke
    // point. mergeFrom records it as rejected rather than throwing the exchange.
    const orphan: ReplicatedRow = row(B, 1, 1, E2, [], { ply: 1, san: "d4" });
    expect(() => applyRow(local, "moves", orphan)).toThrow(RowRejected);
    local.close();
    sibling.close();
  });
});

test.describe("the invite carrier filters to one session (T1-D28)", () => {
  const FILTER_SCHEMA = `-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
CREATE TABLE prefs (
  k TEXT,
  v TEXT
);
`;
  const openFilter = (): Rows & { close(): void } => openWith(FILTER_SCHEMA);
  const S1 = bytes(0x51);
  const S2 = bytes(0x52);
  const hx = (u: unknown): string => (u instanceof Uint8Array ? Buffer.from(u).toString("hex") : "");

  test("no other session's rows travel — in the author tables OR the roster tables", () => {
    // The leak this exists to prevent: filterToSession once took a caller's list
    // of author tables and left _dai_seat / _dai_binding untouched, so every
    // other session's seats and bindings — the membership of every group this
    // person is in — travelled in a two-person invite. This asserts what a
    // SECOND session's rows do, in EVERY table, which the earlier tests never did.
    const db = openFilter();
    let seq = 0;
    const putRow = (table: string, session: Uint8Array, columns: Record<string, unknown>): void =>
      applyRow(db, table, {
        _r_replica: A,
        _r_seq: (seq += 1),
        _r_lc: seq,
        _r_entity: bytes(0x60 + seq),
        _r_parents: "[]",
        _r_deleted: 0,
        _r_session: session,
        columns,
      });

    // Two sessions, each with a seat, a binding and a move.
    for (const s of [S1, S2]) {
      putRow("_dai_seat", s, { seat: s });
      putRow("_dai_binding", s, { seat: s });
      putRow("moves", s, { ply: 1, san: "e4" });
    }

    filterToSession(db, S1);

    // Not one row of S2 survives, in any table — author or system.
    for (const table of ["moves", "_dai_seat", "_dai_binding"]) {
      const sessions = new Set(db.all(`SELECT _r_session FROM "${table}"`).map((r) => hx(r["_r_session"])));
      expect([...sessions], `${table} carried another session's rows`).toEqual([hx(S1)]);
    }
    db.close();
  });

  test("keeps only the chosen session's rows, empties local tables, keeps _dai_replica", () => {
    const db = openFilter();
    ensureReplica(db, A);
    createEntity(db, "moves", E1, { ply: 1, san: "e4" }, S1);
    createEntity(db, "moves", E2, { ply: 1, san: "d4" }, S2);
    // A local (non-replicated) table with this device's own state.
    db.run(`INSERT INTO prefs (k, v) VALUES ('theme', 'dark')`);

    filterToSession(db, S1);

    const kept = db.all(`SELECT _r_session FROM moves`).map((r) => hx(r["_r_session"]));
    expect(kept).toEqual([hx(S1)]); // only S1; S2's game is gone

    // The local table stays as schema, emptied — §4: local never leaves except
    // in a full export, and an invite is not one.
    expect(db.all(`SELECT count(*) AS n FROM prefs`)[0]!["n"]).toBe(0);
    expect(db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name='prefs'`)).toHaveLength(1);

    // The replica identity travels; the opener adopts a fresh id at mount.
    expect(db.all(`SELECT hex(id) h FROM _dai_replica`)[0]).toBeTruthy();
    db.close();
  });

  test("the kept session is a complete document: it still converges into a fresh copy", async () => {
    // What the invite is for. Filter A's copy to S1, then merge it into an empty
    // copy — the game arrives whole.
    const ada = await person();
    const a = openFilter();
    ensureReplica(a, ada.author);
    // A game A created, so A's change finds its head there (D135).
    const s1 = startSession(a, { creatorSeat: bytes(0x62), openSeat: bytes(0x63), entities: [bytes(0x64), bytes(0x65)] });
    createEntity(a, "moves", E1, { ply: 1, san: "e4" }, s1);
    changeEntity(a, "moves", E1, { ply: 1, san: "e4!" }, s1);
    createEntity(a, "moves", E2, { ply: 1, san: "d4" }, S2);
    // Sealed as the copy saves, long before an invite is cut from it.
    await sealAs(a, ada);
    filterToSession(a, s1);

    const fresh = openFilter();
    ensureReplica(fresh, B);
    // Every table the copy replicates, as mergeSibling passes them: the seat rows are in the same header.
    const report = await mergeFromSigned(fresh, a, ada, mergeTablesOf(a));
    expect(report.refusedBatches).toEqual([]);
    // E1's two rows crossed; E2 (the other session) never left A's invite.
    const entities = new Set(fresh.all(`SELECT hex(_r_entity) e FROM moves`).map((r) => String(r["e"]).toLowerCase()));
    expect(entities).toEqual(new Set([hx(E1)]));
    a.close();
    fresh.close();
  });

  test("D4: a crossed-session row delivered by a sibling is refused at export", () => {
    // The honest write rules cannot cross sessions (change and delete inherit the
    // entity's session), so the crossing can only arrive the way §10 says a
    // sibling can send anything: through the merge. Here a sibling's change names
    // the S1 create as its parent but claims S2 — applied through the merge choke
    // point, then caught at the export boundary.
    const db = openFilter();
    ensureReplica(db, A);
    createEntity(db, "moves", E1, { ply: 1, san: "e4" }, S1);

    const parentId = `${Buffer.from(A).toString("hex")}:1`;
    const crossed: ReplicatedRow = {
      _r_replica: B,
      _r_seq: 1,
      _r_lc: 5,
      _r_entity: E1,
      _r_parents: JSON.stringify([parentId]),
      _r_deleted: 0,
      _r_session: S2,
      columns: { ply: 1, san: "e4?" },
    };
    applyRow(db, "moves", crossed);

    expect(() => filterToSession(db, S2)).toThrow(SessionExportIncomplete);
    db.close();
  });

  test("not a session document: filtering refuses rather than shipping the wrong thing", () => {
    const db = open(); // the plain (non-session) schema from the top of the file
    ensureReplica(db, A);
    createEntity(db, "cases", E1, { title: "x", status: "open", weight: null });
    expect(() => filterToSession(db, S1)).toThrow(SessionExportIncomplete);
    db.close();
  });
});

test.describe("admission is enforced through the views (T1-D29, identity step 5)", () => {
  const SCHEMA = `-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
`;
  const open3 = (): Rows & { close(): void } => openWith(SCHEMA);
  const C = bytes(0xc0); // creator
  const S = sessionIdOf(C, 1)!; // the session commits to its creator
  const O = bytes(0x0b); // opener
  const N = bytes(0x0e); // never invited
  const F = bytes(0xff); // forwarded copy
  const SEATC = bytes(0xa1);
  const SEATO = bytes(0xa2);
  let e = 0;
  const ent = (): Uint8Array => bytes(0xe0 + e++);

  /** Apply one row straight through the choke point, with an explicit author. */
  function put(
    db: Rows,
    table: string,
    replica: Uint8Array,
    seq: number,
    lc: number,
    columns: Record<string, unknown>,
    entity = ent(),
  ): void {
    applyRow(db, table, {
      _r_replica: replica,
      _r_seq: seq,
      _r_lc: lc,
      _r_entity: entity,
      _r_parents: "[]",
      _r_deleted: 0,
      _r_session: S,
      columns,
    });
  }

  const currentMoves = (db: Rows): string[] =>
    db.all(`SELECT san FROM moves_current ORDER BY san`).map((r) => String(r["san"]));

  /**
   * The creator's session with the opener seated: her own seat, the row the
   * session id names by its seq (1), the open seat, the opener's ask for it,
   * and her confirmation. The creator's rows are seqs 1–3, the opener's seq 1.
   */
  function seated(db: Rows): void {
    put(db, "_dai_seat", C, 1, 1, { seat: SEATC });
    put(db, "_dai_seat", C, 2, 2, { seat: SEATO });
    put(db, "_dai_binding", O, 1, 3, { seat: SEATO });
    put(db, "_dai_confirm", C, 3, 4, { seat: SEATO, holder: O });
  }

  test("a member's rows show; a non-member's do not", () => {
    const db = open3();
    e = 0;
    seated(db);

    // Two members author a move each; a stranger with no binding authors one too.
    put(db, "moves", C, 4, 5, { ply: 1, san: "e4" });
    put(db, "moves", O, 2, 6, { ply: 1, san: "e5" });
    put(db, "moves", N, 1, 7, { ply: 1, san: "??" });

    // The stranger's move is not in the game; the members' are.
    expect(currentMoves(db)).toEqual(["e4", "e5"]);
    db.close();
  });

  test("a seat the creator confirmed stays its holder's: a later binding neither drops the holder's rows nor admits its own", () => {
    const db = open3();
    e = 0;
    // The opener is seated and plays. It is a member; its move shows.
    seated(db);
    put(db, "moves", O, 2, 5, { ply: 1, san: "e5" });
    expect(currentMoves(db)).toEqual(["e5"]);

    // A forwarded copy opens the same invite and asks for the same seat, even
    // at an earlier clock. The creator seated the opener, and a hold never
    // moves (identity step 5): the opener stays a member and keeps its move.
    put(db, "_dai_binding", F, 1, 0, { seat: SEATO });
    expect(currentMoves(db)).toEqual(["e5"]);

    // And the forwarded copy does not enter.
    put(db, "moves", F, 2, 5, { ply: 1, san: "e6" });
    expect(currentMoves(db)).toEqual(["e5"]);
    db.close();
  });

  test("a non-member row that superseded a member's row does not bury it", () => {
    // The DAG hazard: a stranger's change names a member's row as parent. If the
    // stranger's row is merely hidden but still counts as superseding, the
    // member's row vanishes too. Heads are recomputed over admitted rows, so the
    // member's row re-emerges.
    const db = open3();
    e = 0;
    const move = bytes(0x30);
    seated(db);
    put(db, "moves", O, 2, 5, { ply: 1, san: "e5" }, move);

    // A stranger (no binding) supersedes the member's move.
    applyRow(db, "moves", {
      _r_replica: N,
      _r_seq: 1,
      _r_lc: 4,
      _r_entity: move,
      _r_parents: JSON.stringify([`${Buffer.from(O).toString("hex")}:2`]),
      _r_deleted: 0,
      _r_session: S,
      columns: { ply: 1, san: "e5??" },
    });

    // The member's move stands; the stranger's supersession does not count.
    expect(currentMoves(db)).toEqual(["e5"]);
    db.close();
  });

  test("every replicated table is covered by the merge, and one that is not is a named refusal", async () => {
    // mergeTablesOf decides what converges; a replicated table it omits never
    // merges, silently. The negative case proves the guard has teeth: a rogue
    // replicated system table — a future _dai_* table added without extending
    // SESSION_SYSTEM_TABLES (as _dai_close was correctly added in Step 5) — is
    // caught, and comes back as the MERGE_COVERAGE refusal from mergeSibling, in
    // the same register as every other reason a merge does not run.
    const ok = open3();
    expect(mergeCoverageGap(ok)).toEqual([]);

    ok.run("CREATE TABLE _dai_future (x TEXT, _r_replica BLOB NOT NULL, _r_seq INTEGER NOT NULL)");
    expect(mergeCoverageGap(ok)).toContain("_dai_future");

    const other = open3();
    expect((await mergeSibling(ok, other)).refused).toBe("MERGE_COVERAGE");
    ok.close();
    other.close();
  });

  test("the frame merge unions the roster tables, and admission holds after it", async () => {
    // The wiring: mergeSibling includes _dai_seat and _dai_binding in the union,
    // so a fresh copy that merges the game gets the seats and bindings, and its
    // admission view resolves the same members. A merge refuses an unsigned
    // seat row (BATCH_UNSIGNED, D133), so every row here is sealed under its
    // author's own key, as a copy seals it.
    const [ada, bo] = await Promise.all([person(), person()]);
    e = 0;
    const a = open3();
    ensureReplica(a, ada.author);
    const session = startSession(a, { creatorSeat: SEATC, openSeat: SEATO, entities: [ent(), ent()] });
    await sealAs(a, ada);
    const boCopy = open3();
    ensureReplica(boCopy, bo.author);
    await mergeSigned(boCopy, a, bo);
    createEntity(boCopy, "_dai_binding", ent(), { seat: SEATO }, session);
    createEntity(boCopy, "moves", ent(), { ply: 1, san: "e5" }, session);
    await sealAs(boCopy, bo);
    await mergeSigned(a, boCopy, ada);
    confirmSeat(a, session, SEATO, bo.author, ent());
    await sealAs(a, ada);
    boCopy.close();

    const b = open3();
    const report = await mergeSigned(b, a);
    expect(report.refused).toBeUndefined();
    expect(report.refusedBatches).toEqual([]);

    // The seats and bindings crossed, so b resolves O as a member and shows its
    // move — admission is not something the merge carried, it is recomputed.
    expect(currentMoves(b)).toEqual(["e5"]);
    // And the two copies converged over every replicated table, roster included.
    const tables = ["moves", "_dai_seat", "_dai_binding", "_dai_confirm"];
    expect(canonicalDump(b, tables)).toBe(canonicalDump(a, tables));
    a.close();
    b.close();
  });

  test("session-closed-drops-late-rows: the closer's own row after their close is dropped, one before it kept", () => {
    // The member plays, closes, and plays again. The row after the close is
    // late and drops; the one before stays. Late is the closer's own seq, not a
    // clock (T1-D31, amended by D151), and the close's frontier columns are not
    // read: this one names O at seq 0, which under the frontier would have
    // dropped both.
    const db = open3();
    e = 0;
    seated(db);
    put(db, "moves", O, 2, 5, { ply: 1, san: "e5" }); // seq 2
    put(db, "_dai_close", O, 3, 6, {}); // seq 3
    put(db, "moves", O, 4, 7, { ply: 2, san: "Nf3" }); // seq 4
    // Recomputed on read: the drop is a fact about the rows, whatever order they came in.
    expect(currentMoves(db)).toEqual(["e5"]);
    db.close();
  });

  test("a close binds only its author: another member's moves stay, before and after it", () => {
    // D151: the frontier named the replicas the closer saw, and a member it did
    // not mention was late in whole, so one member's signed close removed the
    // other's moves. A close now binds only its author.
    const db = open3();
    e = 0;
    seated(db);
    put(db, "moves", C, 4, 5, { ply: 1, san: "e4" });
    put(db, "moves", O, 2, 6, { ply: 1, san: "e5" });
    put(db, "_dai_close", C, 5, 7, {}); // names only C
    put(db, "moves", O, 3, 8, { ply: 2, san: "Nf3" });
    put(db, "moves", C, 6, 9, { ply: 2, san: "Nc3" });
    expect(currentMoves(db), "O's rows stay; C's after her close is late").toEqual(["Nf3", "e4", "e5"]);
    db.close();
  });
});

test.describe("close=creator honors only the creator's close (T1-D32)", () => {
  const SCHEMA = `-- dai:profile session max_parties=2 close=creator
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
`;
  const open = (): Rows & { close(): void } => openWith(SCHEMA);
  const C = bytes(0xc0); // creator — the session id commits to her
  const S = sessionIdOf(C, 1)!;
  const O = bytes(0x0b); // opener — a member, not the creator
  const SEATC = bytes(0xa1);
  const SEATO = bytes(0xa2);
  let e = 0;
  const put = (db: Rows, table: string, replica: Uint8Array, seq: number, lc: number, columns: Record<string, unknown>): void =>
    applyRow(db, table, {
      _r_replica: replica, _r_seq: seq, _r_lc: lc, _r_entity: bytes(0x70 + e++),
      _r_parents: "[]", _r_deleted: 0, _r_session: S, columns,
    });
  const moves = (db: Rows): string[] => db.all(`SELECT san FROM moves_current`).map((r) => String(r["san"]));

  test("a non-creator's close is ignored; the creator's closes and drops her own late row", () => {
    const db = open();
    e = 0;
    const closed = (): number => db.all("SELECT 1 FROM _dai_closed").length;
    // The session id commits to C, so C is the creator; C seats O. Both are members.
    put(db, "_dai_seat", C, 1, 1, { seat: SEATC });
    put(db, "_dai_seat", C, 2, 2, { seat: SEATO });
    put(db, "_dai_binding", O, 1, 3, { seat: SEATO });
    put(db, "_dai_confirm", C, 3, 4, { seat: SEATO, holder: O });
    put(db, "moves", O, 2, 5, { ply: 1, san: "e5" });
    expect(moves(db)).toEqual(["e5"]);

    // O, a member but NOT the creator, closes and plays on. Under close=creator
    // the close is not honored: the session is not closed and O's later move
    // is not late.
    put(db, "_dai_close", O, 3, 6, {});
    put(db, "moves", O, 4, 7, { ply: 2, san: "Nf3" });
    expect(moves(db).sort()).toEqual(["Nf3", "e5"]);
    expect(closed()).toBe(0);

    // C, the creator, closes. Honored: the session is closed and her own later
    // row is late. It binds only her (D151): O's moves stay.
    put(db, "_dai_close", C, 4, 8, {});
    put(db, "moves", C, 5, 9, { ply: 3, san: "Nc3" });
    expect(moves(db).sort()).toEqual(["Nf3", "e5"]);
    expect(closed()).toBe(1);
    db.close();
  });
});
