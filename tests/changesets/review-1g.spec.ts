import { expect, test } from "@playwright/test";
import { Copy, person } from "./copy.js";
import { SCENARIOS, base, exchange, item } from "./scenarios.js";
import { lastSeq, opsAfter, pendingOf } from "./rx.js";

/**
 * The review of Build 1g (`handoff-2026-10-19.md`, "Code review — PR #9,
 * Build 1g"): its findings, each red first, under the delete ruling given
 * with it: a delete is an edit of the row unit whose basis is the version
 * each column showed, an alternative it did not see stays pending on the
 * deleted row, and a resolution may include the deletion.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const kindsOf = (c: Copy, table: string, key: string): string[] =>
  c.flags().filter((f: Any) => f.tbl === table && f.pk === key).map((f: Any) => f.kind).sort();

/** The version of a row's cell that holds `val`. */
const verOfValue = (c: Copy, table: string, key: string, col: string, val: unknown): string =>
  String(c.rows.all("SELECT ver FROM _cs_cell WHERE tbl = ? AND pk = ? AND col = ? AND val = ?", [table, key, col, val])[0]!["ver"]);

test("1g-H1: a delete is based on the version each column showed; the title it did not show stays pending and presented on all three copies", async () => {
  const { a, b } = await base();
  const c = await Copy.open(await person(), await a.bytes(), a.schema);
  const tent = item(a, "Tent");
  const key = JSON.stringify([tent]);
  b.db.exec({ sql: "UPDATE items SET title = 'Tent (B)' WHERE id = ?", bind: [tent] });
  c.db.exec({ sql: "UPDATE items SET title = 'Tent (C)' WHERE id = ?", bind: [tent] });
  const [bBytes, cBytes] = [await b.bytes(), await c.bytes()];
  await a.mergeFrom(bBytes);
  await a.mergeFrom(cBytes);
  expect(pendingOf(a, "items", key).title, "both titles pending on A").toEqual(["Tent (B)", "Tent (C)"]);
  const shown = a.db.selectValue("SELECT title FROM items WHERE id = ?", [tent]);
  const loser = shown === "Tent (B)" ? "Tent (C)" : "Tent (B)";
  const loserVer = verOfValue(a, "items", key, "title", loser);
  const shownVer = verOfValue(a, "items", key, "title", shown);

  const seq = lastSeq(a);
  a.db.exec({ sql: "DELETE FROM items WHERE id = ?", bind: [tent] });
  a.save();
  const [op] = opsAfter(a, seq).map((x) => x.op);
  expect(op![2], "a delete").toBe("D");
  expect(op![6], "it saw the title shown").toContain(shownVer);
  expect(op![6], "and not the one it did not show").not.toContain(loserVer);

  const aBytes = await a.bytes();
  await b.mergeFrom(cBytes);
  await b.mergeFrom(aBytes);
  await c.mergeFrom(bBytes);
  await c.mergeFrom(aBytes);
  for (const [name, x] of [["A", a], ["B", b], ["C", c]] as const) {
    expect(kindsOf(x, "items", key), `${name}: the row stays, contested, and the title pending`).toEqual(["delete-conflict", "pending"]);
    expect(pendingOf(x, "items", key).title, `${name}: ${loser} is presented`).toContain(loser);
    const existence = x.changes.observe("items", [tent], []);
    expect(existence.alternatives.map((alt: Any) => alt.ver), `${name}: the existence call presents it beside the delete`).toContain(loserVer);
  }
  expect(b.state(), "B and A agree").toBe(a.state());
  expect(c.state(), "C and A agree").toBe(a.state());

  // A resolution may include the deletion: chosen by the existence call, it settles what that call presented.
  const existence = a.changes.observe("items", [tent], []);
  const del = existence.alternatives.find((alt: Any) => alt.values[""] === 0).ver;
  a.changes.resolve(existence.token, del);
  const resolved = await a.bytes();
  await b.mergeFrom(resolved);
  await c.mergeFrom(resolved);
  for (const x of [a, b, c]) {
    expect(x.db.selectValue("SELECT count(*) FROM items WHERE id = ?", [tent]), "deleted by the resolution").toBe(0);
    expect(kindsOf(x, "items", key)).toEqual([]);
  }
  for (const x of [a, b, c]) x.close();
});

test("1g-H1: a delete does not settle a proposal the CHECK set aside; it stays pending on the kept row, both copies", async () => {
  const s = SCENARIOS["1g-H1 delete over a set-aside proposal"]!;
  const o = await exchange(s.write, { extra: s.extra });
  expect(o.converged, "converged").toBe(true);
  for (const c of [o.a, o.b]) {
    expect(c.db.selectObject("SELECT start, finish FROM spans WHERE id = 1"), "the row stays, never the invalid combination").toEqual({ start: 8, finish: 10 });
    expect(kindsOf(c, "spans", "[1]"), "contested, and pending with the constraint").toEqual(["delete-conflict", "pending"]);
    expect(pendingOf(c, "spans", "[1]").finish, "B's finish is presented").toContain(5);
  }
  o.a.close();
  o.b.close();
});
