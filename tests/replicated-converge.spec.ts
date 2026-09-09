import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import {
  ReplicationError,
  checkTriggerCoverage,
  rewriteReplicated,
  triggerColumns,
} from "../src/replicated.js";
import {
  applyRow,
  canonicalDump,
  encodeValue,
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
function open(): Rows & { close(): void } {
  const db = new DatabaseSync(":memory:");
  db.exec(rewriteReplicated(SCHEMA).sql);
  return {
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: () => db.close(),
  };
}

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

test.describe("the flag is a function of the row set, not of arrival order", () => {
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
