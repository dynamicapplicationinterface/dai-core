import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import {
  ReplicationError,
  checkTriggerCoverage,
  rewriteReplicated,
  triggerColumns,
} from "../src/replicated.js";
import { mergeSibling } from "../src/replicated-frame.js";
import { adoptReplica } from "../src/replicated-rows.js";
import {
  applyRow,
  canonicalDump,
  changeEntity,
  createEntity,
  deleteEntity,
  encodeValue,
  mergeFrom,
  RowRejected,
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
  /** Two independent copies of the same schema. */
  function pair() {
    const a = open();
    const b = open();
    a.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    a.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    b.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [B]);
    b.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [B]);
    return { a, b };
  }

  test("merge-disjoint", () => {
    const { a, b } = pair();
    createEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
    createEntity(b, "cases", E2, { title: "yours", status: "open", weight: null });

    const result = mergeFrom(a, b, ["cases"]);
    expect(result.applied).toBe(1);
    expect(result.duplicate).toBe(0);
    expect(result.rejected).toEqual([]);
    expect(a.all("SELECT count(*) c FROM cases_current")[0]!["c"]).toBe(2);
    a.close();
    b.close();
  });

  test("merge-idempotent", () => {
    const { a, b } = pair();
    createEntity(b, "cases", E2, { title: "yours", status: "open", weight: null });

    expect(mergeFrom(a, b, ["cases"]).applied).toBe(1);
    const second = mergeFrom(a, b, ["cases"]);
    expect(second.applied).toBe(0);
    expect(second.duplicate).toBe(1);
    a.close();
    b.close();
  });

  test("merge-commutative", () => {
    // A←B then A←C against A←C then A←B, by the dump of T1-D9.
    const build = (order: "bc" | "cb"): string => {
      const a = open();
      const b = open();
      const c = open();
      for (const [db, id] of [[a, A], [b, B], [c, bytes(0xcc)]] as const) {
        db.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [id]);
        db.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [id]);
      }
      createEntity(a, "cases", E1, { title: "a", status: "open", weight: 1 });
      createEntity(b, "cases", E2, { title: "b", status: "open", weight: 2 });
      createEntity(c, "cases", bytes(0x33), { title: "c", status: "open", weight: null });
      if (order === "bc") {
        mergeFrom(a, b, ["cases"]);
        mergeFrom(a, c, ["cases"]);
      } else {
        mergeFrom(a, c, ["cases"]);
        mergeFrom(a, b, ["cases"]);
      }
      const dump = canonicalDump(a, ["cases"]);
      a.close();
      b.close();
      c.close();
      return dump;
    };
    expect(build("bc")).toBe(build("cb"));
  });

  test("merge-conflict, and current shows the pick with the flag up", () => {
    const { a, b } = pair();
    const base = createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
    mergeFrom(b, a, ["cases"]);          // both hold the base row
    changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
    changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });

    mergeFrom(a, b, ["cases"]);
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

  test("merge-tombstone-conflict shows the change, not the delete (T1-D3)", () => {
    const { a, b } = pair();
    createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
    mergeFrom(b, a, ["cases"]);
    changeEntity(a, "cases", E1, { title: "edited", status: "open", weight: null });
    deleteEntity(b, "cases", E1);

    mergeFrom(a, b, ["cases"]);
    const current = a.all("SELECT title, _r_conflicted FROM cases_current");
    expect(current).toHaveLength(1);
    expect(current[0]!["title"]).toBe("edited");
    // And the person is told somebody deleted it, rather than finding their
    // edit quietly resurrected.
    expect(Number(current[0]!["_r_conflicted"])).toBe(1);
    a.close();
    b.close();
  });

  test("merge-resolve clears the conflict", () => {
    const { a, b } = pair();
    createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
    mergeFrom(b, a, ["cases"]);
    changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
    changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });
    mergeFrom(a, b, ["cases"]);

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

  test("the clock is above everything the merge brought in, before the next write", () => {
    /*
     * A local row written after a merge must outrank what the merge delivered.
     * `_current` picks the highest `_r_lc`, so a row written with a stale clock
     * would lose to its own ancestors and the person's newest edit would
     * disappear behind an older one.
     */
    const { a, b } = pair();
    for (let n = 0; n < 5; n += 1) {
      createEntity(b, "cases", bytes(0x40 + n), { title: `b${n}`, status: "open", weight: null });
    }
    const theirs = Number(b.all("SELECT max(_r_lc) m FROM cases")[0]!["m"]);
    mergeFrom(a, b, ["cases"]);
    expect(Number(a.all("SELECT lc FROM _dai_replica")[0]!["lc"])).toBeGreaterThanOrEqual(theirs);

    const mine = createEntity(a, "cases", E1, { title: "after", status: "open", weight: null });
    expect(mine._r_lc).toBeGreaterThan(theirs);
    a.close();
    b.close();
  });

  test("one refused row does not deny the good ones", () => {
    // Refusing the whole exchange would make one forged row cheaper than
    // forging anything real.
    const { a, b } = pair();
    createEntity(b, "cases", E1, { title: "honest", status: "open", weight: null });
    createEntity(b, "cases", E2, { title: "also honest", status: "open", weight: null });
    // A row this copy already holds under that id, with different content.
    applyRow(a, "cases", row(B, 1, 1, E1, [], { title: "not what B wrote", status: "open", weight: null }));

    const result = mergeFrom(a, b, ["cases"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.applied).toBe(1);
    expect(a.all("SELECT count(*) c FROM cases")[0]!["c"]).toBe(2);
    a.close();
    b.close();
  });
});

test.describe("the frame's side of a merge", () => {
  const rowsFor = (db: ReturnType<typeof open>) => db;

  test("a sibling with the same tables merges and reports the conflict count", () => {
    const a = open();
    const b = open();
    a.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    a.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    b.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [B]);
    b.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [B]);

    createEntity(a, "cases", E1, { title: "base", status: "open", weight: null });
    mergeSibling(rowsFor(b), rowsFor(a));
    changeEntity(a, "cases", E1, { title: "mine", status: "open", weight: null });
    changeEntity(b, "cases", E1, { title: "yours", status: "open", weight: null });

    const report = mergeSibling(rowsFor(a), rowsFor(b));
    expect(report.refused).toBeUndefined();
    expect(report.applied).toBe(1);
    // The one number a person is shown, and not derivable from the other four.
    expect(report.conflicts).toBe(1);
    a.close();
    b.close();
  });

  test("a sibling whose replicated schema differs is refused, not merged", () => {
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

    const report = mergeSibling(rowsFor(a), rowsFor(b));
    expect(report.refused).toBe("SCHEMA_MISMATCH");
    expect(report.applied).toBe(0);
    // Refused means nothing happened, not that some of it happened.
    expect(a.all("SELECT count(*) c FROM cases")[0]!["c"]).toBe(0);
    a.close();
    b.close();
  });

  test("a level this frame does not implement is refused rather than treated as Level 1", () => {
    // A Level 2 sibling merged as Level 1 would have its signatures unchecked
    // while the person was told the merge succeeded.
    const a = open();
    const b = open();
    a.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    b.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [B]);
    const report = mergeSibling(rowsFor(a), rowsFor(b), 2);
    expect(report.refused).toBe("UNSUPPORTED_LEVEL");
    a.close();
    b.close();
  });

  test("a local table on one side only does not stop the merge", () => {
    // Local tables never travel and never merge, so a difference in them says
    // nothing about whether these two copies can exchange rows.
    const a = openWith(`${SCHEMA}\nCREATE TABLE notes_local (body TEXT);\n`);
    const b = open();
    a.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    a.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    b.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [B]);
    b.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [B]);
    createEntity(b, "cases", E2, { title: "theirs", status: "open", weight: null });

    const report = mergeSibling(rowsFor(a), rowsFor(b));
    expect(report.refused).toBeUndefined();
    expect(report.applied).toBe(1);
    a.close();
    b.close();
  });
});

test.describe("a copy that arrived from somebody else", () => {
  /** The file, opened on another device: same rows, same _dai_replica. */
  function received(from: Rows & { close(): void }): Rows & { close(): void } {
    const to = open();
    for (const row of from.all("SELECT * FROM cases")) {
      to.run(
        "INSERT INTO cases (title,status,weight,_r_replica,_r_seq,_r_lc,_r_entity,_r_parents,_r_deleted,_r_superseded)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
          row["title"], row["status"], row["weight"], row["_r_replica"], row["_r_seq"],
          row["_r_lc"], row["_r_entity"], row["_r_parents"], row["_r_deleted"], row["_r_superseded"],
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

  test("writes under its own identity, not the sender's", () => {
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
    const alice = open();
    alice.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [A]);
    alice.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [A]);
    createEntity(alice, "cases", E1, { title: "e4", status: "open", weight: null });

    const bob = received(alice);
    expect(adoptReplica(bob, B)).toBe(true);

    // Bob writes as Bob.
    createEntity(bob, "cases", E2, { title: "e5", status: "open", weight: null });
    // By entity, not by sequence: Bob's counter restarted at 1, so both his
    // row and Alice's carry seq 1 and ordering by it picks arbitrarily. That
    // the two share a sequence number is exactly right — they are different
    // replicas now, which is the whole point.
    const written = bob.all("SELECT hex(_r_replica) r FROM cases WHERE _r_entity = ?", [E2])[0]!;
    expect(String(written["r"]).toLowerCase()).toBe("bb".repeat(16));

    // And Alice's next move does not collide with it.
    changeEntity(alice, "cases", E1, { title: "Nf3", status: "open", weight: null });
    const report = mergeSibling(alice, bob);
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
