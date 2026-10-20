import { expect, test } from "@playwright/test";
import { Copy, person } from "./copy.js";
import { base, item } from "./scenarios.js";
import { lastSeq, opsAfter, pendingCols, pendingOf, rx } from "./rx.js";

/**
 * R-X: authorship records changes and explicit decisions, not touches
 * (`docs/backlog.md`). A write authors a unit (a column, or a coupled group as
 * one tuple) only where its committed value differs from the projection it
 * was made against; an echo authors nothing, clears nothing, supersedes
 * nothing. The review of Build 1f, 1f-H1.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const FORMS: Record<string, string> = {
  UPDATE: "UPDATE items SET qty = 3, unit = 'kg', note = 'packed' WHERE id = 7",
  REPLACE: "REPLACE INTO items (id, qty, unit, note) VALUES (7, 3, 'kg', 'packed')",
  UPSERT:
    "INSERT INTO items (id, qty, unit, note) VALUES (7, 3, 'kg', 'packed') ON CONFLICT (id) DO UPDATE SET qty = excluded.qty, unit = excluded.unit, note = excluded.note",
};

for (const [form, sql] of Object.entries(FORMS)) {
  test(`R-X red test, first assertion (${form}): a full-form save that changes only the note authors the note alone`, async () => {
    const { a, b, c } = await rx();
    const seq = lastSeq(a);
    a.db.exec(sql);
    expect(a.save(), "the note is something to save").not.toBeNull();
    const ops = opsAfter(a, seq);
    expect(ops.map((o) => [o.table, o.key, o.code, o.wrote]), "A's new operation authors note, and no qty/unit version").toEqual([["items", [7], "U", ["note"]]]);
    expect(ops[0]!.op[7], "it carries no resolution of qty/unit").toBeUndefined();
    expect(pendingOf(a), "the original tuple alternatives remain pending").toEqual({ qty: [2, 3], unit: ["kg", "kg"] });
    await b.mergeFrom(await a.bytes());
    expect(pendingOf(b), "on the other copy too").toEqual({ qty: [2, 3], unit: ["kg", "kg"] });
    expect(b.db.selectObject("SELECT qty, unit, note FROM items WHERE id = 7")).toEqual({ qty: 3, unit: "kg", note: "packed" });
    for (const x of [a, b, c]) x.close();
  });
}

test("1f-H1 (a): a form save over a row pending on another column signs only the column it changed", async () => {
  const { a, b } = await base();
  const tent = item(a, "Tent");
  b.db.exec({ sql: "UPDATE items SET qty = 9, note = 'B packed it' WHERE id = ?", bind: [tent] });
  b.db.exec({ sql: "UPDATE items SET title = 'Tent (4p)' WHERE id = ?", bind: [tent] });
  a.db.exec({ sql: "UPDATE items SET title = 'Tent (2p)' WHERE id = ?", bind: [tent] });
  await a.mergeFrom(await b.bytes());
  expect(pendingCols(a, "items", JSON.stringify([tent])), "pending on title only").toEqual(["title"]);
  const row = a.db.selectObject("SELECT category_id, title, qty, note FROM items WHERE id = ?", [tent]) as Any;
  const seq = lastSeq(a);
  a.db.exec({
    sql: "UPDATE items SET category_id = ?, title = ?, qty = ?, note = ?, done = 1 WHERE id = ?",
    bind: [row.category_id, row.title, row.qty, row.note, tent],
  });
  a.save();
  expect(opsAfter(a, seq).map((o) => [o.table, o.code, o.wrote]), "done alone, never B's qty and note as A's").toEqual([["items", "U", ["done"]]]);
  const signed = a.rows.all("SELECT count(*) AS n FROM _cs_cell WHERE tbl = 'items' AND pk = ? AND col IN ('qty', 'note')", [JSON.stringify([tent])])[0]!["n"];
  expect(signed, "qty and note each hold B's version, and the base's, and no copy of them by A").toBe(4);
  expect(pendingCols(a, "items", JSON.stringify([tent])), "the title conflict stands").toEqual(["title"]);
  a.close();
  b.close();
});

test("1f-H1 (b): SET qty = qty on a pending row authors nothing, and a third copy's edit of qty stands", async () => {
  const { a, b } = await base();
  const tent = item(a, "Tent");
  const third = await Copy.open(await person(), await a.bytes(), a.schema);
  third.db.exec({ sql: "UPDATE items SET qty = 5 WHERE id = ?", bind: [tent] });
  a.db.exec({ sql: "UPDATE items SET title = 'Tent (2p)' WHERE id = ?", bind: [tent] });
  b.db.exec({ sql: "UPDATE items SET title = 'Tent (4p)' WHERE id = ?", bind: [tent] });
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  const seq = lastSeq(a);
  a.db.exec({ sql: "UPDATE items SET qty = qty WHERE id = ?", bind: [tent] });
  expect(a.changes.dirty, "an echo is nothing to save").toBe(false);
  expect(a.save()).toBeNull();
  expect(lastSeq(a), "nothing logged").toBe(seq);
  const all = [a, b, third];
  for (const x of all) for (const y of all) if (x !== y) await x.mergeFrom(await y.bytes());
  for (const x of all) {
    expect(x.db.selectValue("SELECT qty FROM items WHERE id = ?", [tent]), "the third copy's 5").toBe(5);
    expect(pendingCols(x, "items", JSON.stringify([tent])), "only the title is pending").toEqual(["title"]);
  }
  expect(new Set(all.map((x) => x.state())).size, "converged").toBe(1);
  for (const x of all) x.close();
});
