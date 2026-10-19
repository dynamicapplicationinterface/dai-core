import { expect, test } from "@playwright/test";
import { base, exchange, item, SCENARIOS } from "./scenarios.js";
import { Copy, DOC, openBytes } from "./copy.js";
import * as merge from "../../src/replicated-frame.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const m = merge as Any;

/**
 * The data-interface catalog's ten priority vectors (`handoff-2026-10-19.md`,
 * "Data-interface catalog (external review)", section 10), each from the
 * catalog's own scenario and named by its row ids. The rulings they hold the
 * runtime to are R-S (the capture-epoch boundary) and R-T (valid
 * materialization) in docs/backlog.md.
 */

/** Every value one author's log carries for one row, as [column, value], from the signed payloads. */
function wroteFor(c: Copy, table: string, key: unknown): [string, unknown][] {
  return c
    .written()
    .map((w) => JSON.parse(w) as [string, string, string, string, unknown])
    .filter(([t, k]) => t === table && JSON.stringify(JSON.parse(k)[0]) === JSON.stringify(key))
    .map(([, , col, , val]) => [col, val]);
}

/**
 * C07 / Q08. A local edit to column A, a remote edit to column B of the same
 * row, then a local save. The session records a row's current values when it
 * is extracted, so a remote value written into a row the session has already
 * touched becomes part of the local changeset however the session was paused
 * (SQLite documents it; the catalog reproduced it). Only A may be attributed
 * to the local author: in its log, and on the other copy.
 *
 * Twice: as the merge runs (the local edit saved before the apply), and with
 * the application holding a transaction when the apply would run (R-S: the
 * apply waits for the committed boundary, and the epoch is logged first).
 */
test("C07/Q08: a remote edit to another column of a locally edited row is never attributed to the local author", async () => {
  for (const held of [false, true]) {
    const { a, b } = await base();
    const bread = item(a, "Bread");
    b.db.exec({ sql: "UPDATE items SET note = 'B-note' WHERE id = ?", bind: [bread] });
    const bBytes = await b.bytes();

    // A merges step by step, as the frame does (bootloader.ts, mergeSibling):
    // capture, verify (an await), admit, apply. The local edit lands after the
    // frame's capture, so only the runtime's own boundary keeps it out of the apply.
    a.save();
    const sib = await openBytes(bBytes);
    const verifying = m.verifyBatches(sib.rows, m.mergeTablesOf(sib.rows), DOC);
    if (held) a.db.exec("BEGIN");
    a.db.exec({ sql: "UPDATE items SET qty = 7 WHERE id = ?", bind: [bread] });
    const verdicts = await verifying;
    m.mergeVerified(a.rows, sib.rows, { document: DOC, author: a.author.author, verdicts });
    sib.db.close();
    a.changes.projectAdmitted();
    if (held) {
      // Nothing of the remote edit is applied while the transaction is the application's.
      expect(a.db.selectObject("SELECT qty, note FROM items WHERE id = ?", [bread]), `held=${held}: inside the transaction`).toEqual({ qty: 7, note: null });
      a.db.exec("COMMIT");
    }
    a.save();

    const label = held ? "with the application's transaction open" : "as the merge runs";
    expect(a.db.selectObject("SELECT qty, note FROM items WHERE id = ?", [bread]), label).toEqual({ qty: 7, note: "B-note" });
    const aWrote = wroteFor(a, "items", bread);
    expect(aWrote, `${label}: A's log carries A's edit`).toContainEqual(["qty", 7]);
    expect(aWrote, `${label}: A's log never carries B's value`).not.toContainEqual(["note", "B-note"]);
    expect(a.flags(), label).toEqual([]);

    await b.mergeFrom(await a.bytes());
    expect(b.db.selectObject("SELECT qty, note FROM items WHERE id = ?", [bread]), label).toEqual({ qty: 7, note: "B-note" });
    // On the other copy, each column's one current version is its own author's.
    const heads = b.rows.all(
      `SELECT col, author FROM _cs_cell c WHERE tbl = 'items' AND pk = ? AND col IN ('qty', 'note')
        AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = c.tbl AND s.pk = c.pk AND s.col = c.col AND s.ver = c.ver) ORDER BY col`,
      [JSON.stringify([bread])],
    );
    expect(heads, label).toEqual([
      { col: "note", author: b.changes.authorHex },
      { col: "qty", author: a.changes.authorHex },
    ]);
    expect(a.state(), label).toBe(b.state());
    a.close();
    b.close();
  }
});

/**
 * T01. `SQLITE_DBCONFIG_ENABLE_TRIGGER=0` leaves TEMP triggers on, and the
 * runtime's own stand-down (`dai_projecting()`) is written into the triggers
 * of the main schema only. A TEMP trigger on a persistent table, and a trigger
 * in an attached schema, must not run when merged rows are applied (R-S: the
 * apply runs on a connection carrying no application TEMP triggers), and each
 * still runs for the application's own writes after it.
 */
test("T01: neither a TEMP trigger nor an attached schema's trigger fires while merged rows are applied", async () => {
  const { a, b } = await base({ trigger: true });
  a.db.exec(`CREATE TEMP TABLE fired_temp (what TEXT);
    CREATE TEMP TRIGGER items_temp AFTER INSERT ON main.items BEGIN INSERT INTO fired_temp (what) VALUES (NEW.title); END;
    ATTACH ':memory:' AS aux;
    CREATE TABLE aux.items (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE aux.fired (what TEXT);
    CREATE TRIGGER aux.items_aux AFTER INSERT ON items BEGIN INSERT INTO fired (what) VALUES (NEW.title); END;`);
  b.db.exec("INSERT INTO items (title) VALUES ('Soap')");
  await a.mergeFrom(await b.bytes());

  expect(a.db.selectValue("SELECT title FROM main.items WHERE title = 'Soap'"), "the merged row is applied").toBe("Soap");
  expect.soft(a.db.selectValues("SELECT what FROM temp.fired_temp"), "the TEMP trigger").toEqual([]);
  expect.soft(a.db.selectValues("SELECT what FROM aux.fired"), "the attached schema's trigger").toEqual([]);
  // The main schema's trigger ran once, on B, and its row came in B's changeset.
  expect(a.db.selectValue("SELECT count(*) FROM audit x JOIN items i ON i.id = x.item_id WHERE i.title = 'Soap' AND x.what = 'created'")).toBe(1);
  expect(a.db.selectValues("SELECT name FROM temp.sqlite_schema WHERE type = 'trigger'"), "the TEMP trigger is back").toEqual(["items_temp"]);

  a.db.exec("INSERT INTO items (title) VALUES ('Lamp')");
  expect(a.db.selectValues("SELECT what FROM temp.fired_temp"), "the TEMP trigger runs for the application's own write").toEqual(["Lamp"]);
  a.db.exec("DETACH aux");
  a.close();
  b.close();
});

/**
 * Q01 / Q02. A changeset can be extracted from an open transaction and hold
 * changes a ROLLBACK then takes away (the catalog's probe). A save asked while
 * the application holds a transaction or a savepoint publishes nothing; only a
 * committed outer boundary is eligible (R-S, decided by sqlite3_get_autocommit).
 * Run through every shape the catalog names: BEGIN then ROLLBACK, BEGIN then
 * COMMIT, an outer savepoint rolled back, an inner RELEASE under an open outer,
 * ROLLBACK TO a nested savepoint, and a repeated savepoint name.
 */
test("Q01/Q02: a save inside an open transaction or savepoint publishes nothing; only the committed outer boundary is logged", async () => {
  const { a, b } = await base();
  const logged = (): number => Number(a.db.selectValue("SELECT count(*) FROM _cs_log WHERE _r_replica = ?", [a.author.author]));
  const titles = (): string[] => a.written().filter((w) => JSON.parse(w)[2] === "title").map((w) => JSON.parse(w)[4] as string);
  const before = logged();
  let done = 0;
  const nothing = (label: string): void => {
    expect(a.save(), `${label}: the save publishes nothing`).toBeNull();
    expect(logged(), `${label}: the log is unchanged`).toBe(before + done);
  };

  // BEGIN, save, ROLLBACK: nothing, then and after.
  a.db.exec("BEGIN; INSERT INTO items (title) VALUES ('rolled-back');");
  nothing("inside BEGIN");
  a.db.exec("ROLLBACK");
  nothing("after ROLLBACK");

  // BEGIN, save, COMMIT: nothing inside; the save after it proceeds.
  a.db.exec("BEGIN; INSERT INTO items (title) VALUES ('committed');");
  nothing("inside BEGIN before COMMIT");
  a.db.exec("COMMIT");
  expect(a.save(), "after COMMIT the save proceeds").not.toBeNull();
  done += 1;

  // An outer savepoint is a transaction: rolled back to and released, nothing.
  a.db.exec("SAVEPOINT outer_sp; INSERT INTO items (title) VALUES ('savepoint-rolled-back');");
  nothing("inside a savepoint");
  a.db.exec("ROLLBACK TO outer_sp; RELEASE outer_sp;");
  nothing("after ROLLBACK TO and RELEASE of the outer savepoint");

  // An inner RELEASE under an open outer is not a committed boundary; ROLLBACK TO a nested savepoint
  // takes only its own work away.
  a.db.exec("SAVEPOINT outer_sp; INSERT INTO items (title) VALUES ('outer-kept'); SAVEPOINT inner_sp; INSERT INTO items (title) VALUES ('inner-released'); RELEASE inner_sp;");
  nothing("after an inner RELEASE, the outer still open");
  a.db.exec("SAVEPOINT inner_sp; INSERT INTO items (title) VALUES ('inner-rolled-back'); ROLLBACK TO inner_sp; RELEASE inner_sp;");
  nothing("after ROLLBACK TO a nested savepoint");
  a.db.exec("RELEASE outer_sp");
  expect(a.save(), "after the outer RELEASE the save proceeds").not.toBeNull();
  done += 1;

  // A repeated name: ROLLBACK TO and RELEASE name the innermost.
  a.db.exec("SAVEPOINT sp; INSERT INTO items (title) VALUES ('repeated-outer'); SAVEPOINT sp; INSERT INTO items (title) VALUES ('repeated-inner'); ROLLBACK TO sp; RELEASE sp;");
  nothing("after the inner of two savepoints of one name");
  a.db.exec("RELEASE sp");
  expect(a.save(), "after the outer of the two").not.toBeNull();
  done += 1;

  const committed = ["committed", "outer-kept", "inner-released", "repeated-outer"];
  const never = ["rolled-back", "savepoint-rolled-back", "inner-rolled-back", "repeated-inner"];
  expect(titles().filter((t) => [...committed, ...never].includes(t)).sort(), "A's log holds what committed, and nothing else").toEqual([...committed].sort());
  await b.mergeFrom(await a.bytes());
  const shown = b.db.selectValues(`SELECT title FROM items WHERE title IN (${[...committed, ...never].map(() => "?").join(", ")}) ORDER BY title`, [...committed, ...never]);
  expect(shown, "the other copy holds what committed, and nothing else").toEqual([...committed].sort());
  a.close();
  b.close();
});

/**
 * T08 (the catalog's "particularly important" vector). summary.count = 0; A
 * inserts a workout and its trigger writes count = 1; B inserts another and
 * its trigger writes count = 1. Both workouts merge, both captured totals
 * agree on 1, and the true count is 2. Agreement of captured values does not
 * establish an invariant (R-T): the total may be recomputed, or left pending,
 * but never settled at 1.
 *
 * The mechanism is the smallest R-T allows, and the policy already has it:
 * pending on the aggregate row. Two concurrent versions of one column are a
 * conflict even when their values are equal (the spike's S5b), so the summary
 * row is flagged pending, with both versions named; the person, or the
 * application, resolves it by writing the total again. No recompute is
 * declared: the model file teaches totals in queries, not triggers (R-T).
 */
test("T08: a trigger-maintained total two inserts both capture as 1 is pending after the merge, never settled at 1", async () => {
  const s = SCENARIOS["T08 derived total"]!;
  const o = await exchange(s.write, { extra: s.extra });
  const captured = (c: Copy): unknown[] => wroteFor(c, "summary", 1).filter(([col]) => col === "count").map(([, v]) => v);
  expect(captured(o.a), "A captured the total as 1").toContain(1);
  expect(captured(o.b), "B captured the total as 1").toEqual([1]);
  for (const c of [o.a, o.b]) {
    expect(c.db.selectValue("SELECT count(*) FROM workouts"), "both workouts are there").toBe(2);
    const count = c.db.selectValue("SELECT count FROM summary WHERE id = 1");
    const pending = c.flags().find((f: Any) => f.tbl === "summary" && f.kind === "pending");
    expect(count === 2 || pending !== undefined, `the total is ${count}, recomputed or pending, never settled at 1`).toBe(true);
    expect(pending, "the mechanism: the aggregate row is pending").toBeDefined();
    const values = JSON.parse(pending!.detail).find((p: Any) => p.col === "count").values;
    expect(values.map((v: Any) => v.val), "both captured versions are named").toEqual([1, 1]);
  }
  expect(o.converged).toBe(true);
  expect(o.missing).toEqual([]);
  o.a.close();
  o.b.close();
});

/** Every proposal a pending flag names for one row, as "column=value". */
function proposed(c: Copy, table: string, pk: string): string[] {
  const flag = c.flags().find((f: Any) => f.tbl === table && f.pk === pk && f.kind === "pending");
  if (!flag) return [];
  return (JSON.parse(flag.detail) as { col: string; values: { val: unknown }[] }[]).flatMap((p) => p.values.map((v) => `${p.col}=${v.val}`));
}

/**
 * M02. CHECK (start <= finish) over (0, 10); A sets start = 8, B sets
 * finish = 5. Each edit is valid alone; the column merge would make (8, 5).
 * R-T: the combined candidate is validated, and an edit set it refuses is a
 * constraint conflict, pending, never a settled invalid row. Both proposals
 * are kept: every value either author wrote is in both copies' cells, and the
 * row's pending flag names the one not shown.
 *
 * The rule (src/changesets.ts, `place`): the row shows the latest valid
 * candidate, found by setting aside the newest proposals first, each column a
 * proposal wrote going back to the value before it. Here that is one of
 * (8, 10) or (0, 5), whichever edit is the earlier by (lc, author) standing:
 * the earlier keeps, as the earlier-born row keeps a UNIQUE slot. Writing the
 * row again resolves it.
 */
test("M02: two valid edits whose combination fails a CHECK are a pending constraint conflict, never the invalid row", async () => {
  const s = SCENARIOS["M02 check across columns"]!;
  const o = await exchange(s.write, { extra: s.extra });
  expect(o.converged, "both copies agree").toBe(true);
  expect(o.missing, "both proposals are in both copies' cells").toEqual([]);
  for (const c of [o.a, o.b]) {
    const row = c.db.selectObject("SELECT start, finish FROM spans WHERE id = 1") as Any;
    expect(row, "the row is shown, not taken away").toBeDefined();
    expect(row, "never the invalid combination").not.toEqual({ start: 8, finish: 5 });
    expect([JSON.stringify({ start: 8, finish: 10 }), JSON.stringify({ start: 0, finish: 5 })]).toContain(JSON.stringify(row));
    expect(c.flags().map((f: Any) => [f.tbl, f.pk, f.kind]), "pending, and nothing else").toEqual([["spans", "[1]", "pending"]]);
    const named = new Set([...proposed(c, "spans", "[1]"), `start=${row.start}`, `finish=${row.finish}`]);
    expect(named.has("start=8") && named.has("finish=5"), `both proposals are shown or named: ${[...named]}`).toBe(true);
  }

  // Writing the row again resolves it, on both copies.
  o.a.db.exec("UPDATE spans SET start = 8, finish = 12 WHERE id = 1");
  await o.b.mergeFrom(await o.a.bytes());
  await o.a.mergeFrom(await o.b.bytes());
  for (const c of [o.a, o.b]) {
    expect(c.db.selectObject("SELECT start, finish FROM spans WHERE id = 1")).toEqual({ start: 8, finish: 12 });
    expect(c.flags()).toEqual([]);
  }
  o.a.close();
  o.b.close();
});
