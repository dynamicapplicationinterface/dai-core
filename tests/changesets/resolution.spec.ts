import { expect, test } from "@playwright/test";
import { Copy, person } from "./copy.js";
import { base, item } from "./scenarios.js";
import { RX_SCHEMA, lastSeq, opsAfter, pendingCols, pendingOf, rx, verOf } from "./rx.js";

/**
 * R-X §4: a resolution is an explicit, observation-bound operation. The kit's
 * call keeps or chooses one of the alternatives an observation token
 * presented; the resolution and its log entry commit together, though no byte
 * changes; the token never expands to an alternative that arrives later; and a
 * coupled group is resolved whole or not at all. RW-12's outcome, by the call
 * that replaces its mechanism; 1f-M2.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const mapOf = (m: Map<string, string[]> | undefined): Record<string, string[]> =>
  Object.fromEntries([...(m ?? new Map()).entries()].map(([c, v]) => [c, [...v].sort()]));

/** Every order of a list. */
function orders<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

/** The tuple versions of row 7 on a copy: its qty heads, as `ver` → value. */
function tupleHeads(c: Copy): Record<string, unknown> {
  const rows = c.rows.all(
    "SELECT ver, val FROM _cs_cell x WHERE tbl = 'items' AND pk = '[7]' AND col = 'qty' AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = x.tbl AND s.pk = x.pk AND s.col = x.col AND s.ver = x.ver)",
  );
  return Object.fromEntries(rows.map((r) => [String(r["ver"]), r["val"]]));
}

test("R-X red test, second assertion: explicitly keeping the shown tuple logs a resolution, which binds exactly what it was shown", async () => {
  test.setTimeout(240_000);
  const { a, b, c, cBytes, baseBytes } = await rx();
  // The first assertion: a full-form save that changes only the note.
  a.db.exec("UPDATE items SET qty = 3, unit = 'kg', note = 'packed' WHERE id = 7");
  a.save();
  expect(pendingOf(a)).toEqual({ qty: [2, 3], unit: ["kg", "kg"] });
  const aPre = await a.bytes();
  const aVer = Object.keys(tupleHeads(a)).find((v) => tupleHeads(a)[v] === 2)!;
  const bVer = Object.keys(tupleHeads(a)).find((v) => tupleHeads(a)[v] === 3)!;
  expect(aVer.startsWith(verOf(a, 0).split(":")[0]!)).toBe(true);

  // Before C's batch is delivered: the observation names A's (2, "kg") and B's (3, "kg").
  const seen = a.changes.observe("items", [7], ["qty", "unit"]);
  expect(seen.alternatives.map((x: Any) => [x.ver, x.values]).sort(), "the alternatives presented").toEqual(
    [[aVer, { qty: 2, unit: "kg" }], [bVer, { qty: 3, unit: "kg" }]].sort(),
  );
  expect(seen.shown, "what it shows came from B's version").toBe(bVer);
  const seq = lastSeq(a);
  expect(a.changes.resolve(seen.token, bVer), "logged as it is made").not.toBeNull();
  const ops = opsAfter(a, seq);
  expect(ops.length, "one new operation").toBe(1);
  const [table, key, code, n, , bases, , resolves] = ops[0]!.op;
  expect([table, key, code], "on the logical row").toEqual(["items", [7], "U"]);
  expect(Object.fromEntries(n), "its chosen value is the complete tuple, though no byte changed").toEqual({ qty: 3, unit: "kg" });
  expect(mapOf(bases), "it binds the observed basis").toEqual({ qty: [bVer], unit: [bVer] });
  expect(mapOf(resolves), "and resolves precisely A's and B's alternatives").toEqual({ qty: [aVer, bVer].sort(), unit: [aVer, bVer].sort() });
  expect(a.flags(), "resolved here").toEqual([]);
  const resVer = verOf(a, seq + 1);
  const aFinal = await a.bytes();
  const bBytes = await b.bytes();

  // Every delivery order, to fresh readers: C before and after the resolution, with and without A's earlier file.
  const reader = await person();
  const files: Record<string, Uint8Array> = { aPre, aFinal, b: bBytes, c: cBytes };
  const states = new Set<string>();
  const want = { qty: [3, 4], unit: ["kg", "kg"] };
  for (const order of [...orders(["aPre", "b", "c", "aFinal"]), ["c", "aFinal"], ["aFinal", "c"]]) {
    const r = await Copy.open(reader, baseBytes, RX_SCHEMA);
    for (const f of order) await r.mergeFrom(files[f]!);
    // The later of the two by (lc, author) shows: the resolution, made after C's edit was.
    expect(r.db.selectObject("SELECT qty, unit, note FROM items WHERE id = 7"), order.join(" ")).toEqual({ qty: 3, unit: "kg", note: "packed" });
    expect(pendingOf(r), `${order.join(" ")}: the resolution and C's tuple, unresolved`).toEqual(want);
    expect(Object.keys(tupleHeads(r)).sort(), order.join(" ")).toEqual([resVer, verOf(c, lastSeq(c))].sort());
    states.add(r.state());
    r.close();
  }
  // And the copies themselves.
  await a.mergeFrom(cBytes);
  await b.mergeFrom(aFinal);
  await b.mergeFrom(cBytes);
  await c.mergeFrom(aFinal);
  for (const x of [a, b, c]) {
    expect(pendingOf(x), "C's alternative stays pending").toEqual(want);
    states.add(x.state());
  }
  expect(states.size, "every reader agrees on state, pending alternatives and display").toBe(1);
  for (const x of [a, b, c]) x.close();
});

test("R-X: the token never expands to an alternative that arrived after it", async () => {
  const { a, b, c, cBytes } = await rx();
  const seen = a.changes.observe("items", [7], ["qty", "unit"]);
  // C's batch lands between the observation and the decision.
  await a.mergeFrom(cBytes);
  expect(pendingOf(a).qty, "three alternatives now").toEqual([2, 3, 4]);
  const keep = seen.alternatives.find((x: Any) => x.values.qty === 3).ver;
  a.changes.resolve(seen.token, keep);
  expect(pendingOf(a), "C's, never presented, is still pending, against the resolution").toEqual({ qty: [3, 4], unit: ["kg", "kg"] });
  expect(() => a.changes.resolve(seen.token, keep), "a token is used once").toThrow(/^CHANGES_REFUSED: This conflict is no longer the one shown/);
  for (const x of [a, b, c]) x.close();
});

test("R-X §5: a coupled group is resolved whole; one column of it is refused", async () => {
  const { a, b, c } = await rx();
  for (const unit of [["qty"], ["unit"], ["qty", "note"], ["nope"], ["id"]]) {
    expect(() => a.changes.observe("items", [7], unit), unit.join(",")).toThrow(/^CHANGES_REFUSED: A resolution names one whole unit/);
  }
  const seen = a.changes.observe("items", [7], ["unit", "qty"]);
  expect(seen.alternatives.length, "the group, in either order").toBe(2);
  expect(() => a.changes.resolve(seen.token, "nobody:1"), "only what was presented").toThrow(/^CHANGES_REFUSED: Choose one of the values the conflict showed/);
  expect(a.changes.observe("items", [7], ["note"]), "a unit with nothing to resolve").toBeNull();
  for (const x of [a, b, c]) x.close();
});

test("R-X: a resolution through REPLACE is not a resolution: the shown tuple is an echo, another is an edit", async () => {
  const { a, b, c } = await rx();
  let seq = lastSeq(a);
  a.db.exec("REPLACE INTO items (id, qty, unit, note) VALUES (7, 3, 'kg', '')");
  expect(a.save(), "the shown tuple, replaced: an echo").toBeNull();
  expect(lastSeq(a)).toBe(seq);
  expect(pendingCols(a)).toEqual(["qty", "unit"]);
  seq = lastSeq(a);
  a.db.exec("REPLACE INTO items (id, qty, unit, note) VALUES (7, 5, 'kg', '')");
  a.save();
  const ops = opsAfter(a, seq);
  expect(ops.map((o) => [o.code, o.wrote]), "another tuple: one complete tuple edit").toEqual([["U", ["qty", "unit"]]]);
  expect(ops[0]!.op[7], "never a resolution").toBeUndefined();
  for (const x of [a, b, c]) x.close();
});

test("1f-M2: a kept key spelling is a resolution of the logical row; a respelling is an edit", async () => {
  const extra = ["CREATE TABLE people (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT)", "INSERT INTO people (email, name) VALUES ('bob@x.com', 'Bob')"];
  const { a, b } = await base({ extra });
  a.db.exec("UPDATE people SET email = 'Bob@X.com' WHERE email = 'bob@x.com'");
  b.db.exec("UPDATE people SET email = 'BOB@X.COM' WHERE email = 'bob@x.com'");
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  const spelled = a.db.selectValue("SELECT email FROM people");
  expect(pendingCols(a, "people", '["bob@x.com"]'), "pending on the spelling").toEqual(["email"]);
  // Writing the spelling it sees: an echo.
  a.db.exec({ sql: "UPDATE people SET email = ? WHERE email = ?", bind: [spelled, spelled] });
  expect(a.changes.dirty, "the shown spelling, written back: nothing to save").toBe(false);
  expect(a.save()).toBeNull();
  // Keeping it: a resolution of the logical row, under any spelling of its key.
  const seq = lastSeq(a);
  const seen = a.changes.observe("people", ["BOB@x.COM"], ["email"]);
  const keep = seen.alternatives.find((x: Any) => x.values.email === spelled).ver;
  a.changes.resolve(seen.token, keep);
  const ops = opsAfter(a, seq);
  expect(ops.map((o) => [o.table, o.code, o.wrote]), "one resolution of the row, no new entity").toEqual([["people", "U", ["email"]]]);
  expect([...(ops[0]!.op[7] as Map<string, string[]>).keys()]).toEqual(["email"]);
  await b.mergeFrom(await a.bytes());
  for (const x of [a, b]) {
    expect(x.db.selectValues("SELECT email FROM people"), "one row, the kept spelling").toEqual([spelled]);
    expect(x.flags(), "resolved on both").toEqual([]);
  }
  // A respelling is an edit: it carries no resolution.
  const seq2 = lastSeq(b);
  b.db.exec("UPDATE people SET email = 'bob@X.com'");
  b.save();
  const edit = opsAfter(b, seq2);
  expect(edit.map((o) => [o.code, o.wrote])).toEqual([["U", ["email"]]]);
  expect(edit[0]!.op[7]).toBeUndefined();
  a.close();
  b.close();
});

test("RW-12's outcome, by the resolution call: recorded though no byte changed, and a third copy's alternative it never saw stays pending", async () => {
  const { a, b } = await base();
  const tent = item(a, "Tent");
  const third = await Copy.open(await person(), await a.bytes(), a.schema);
  a.db.exec({ sql: "UPDATE items SET title = 'Tent (2p)' WHERE id = ?", bind: [tent] });
  b.db.exec({ sql: "UPDATE items SET title = 'Tent (4p)' WHERE id = ?", bind: [tent] });
  third.db.exec({ sql: "UPDATE items SET title = 'Tent (6p)' WHERE id = ?", bind: [tent] });
  await a.mergeFrom(await b.bytes());
  const shown = a.db.selectValue("SELECT title FROM items WHERE id = ?", [tent]);
  const seen = a.changes.observe("items", [tent], ["title"]);
  const seq = lastSeq(a);
  a.changes.resolve(seen.token, seen.shown);
  expect(opsAfter(a, seq).map((o) => [o.code, o.wrote]), "logged as a resolution of the title").toEqual([["U", ["title"]]]);
  expect(a.flags(), "A resolved what it saw").toEqual([]);
  await b.mergeFrom(await a.bytes());
  expect(b.flags(), "and on the other copy").toEqual([]);
  expect(b.db.selectValue("SELECT title FROM items WHERE id = ?", [tent])).toBe(shown);
  await a.mergeFrom(await third.bytes());
  expect(pendingOf(a, "items", JSON.stringify([tent])).title, "the third copy's title, unseen, is pending against A's resolution").toEqual([shown, "Tent (6p)"].sort());
  for (const c of [a, b, third]) c.close();
});

test("M15, by the resolution call: keeping the shown value keeps its storage class, here, there and from the log", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE vals (id INTEGER PRIMARY KEY, v)", "INSERT INTO vals (id, v) VALUES (1, 1.0)"] });
  a.db.exec("UPDATE vals SET v = 2.0 WHERE id = 1");
  b.db.exec("UPDATE vals SET v = 2 WHERE id = 1");
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  const shown = a.db.selectValue("SELECT typeof(v) FROM vals");
  const seen = a.changes.observe("vals", [1], ["v"]);
  a.changes.resolve(seen.token, seen.shown);
  await b.mergeFrom(await a.bytes());
  for (const c of [a, b]) {
    expect(c.db.selectValue("SELECT typeof(v) FROM vals"), "resolved, the class kept").toBe(shown);
    expect(c.flags()).toEqual([]);
  }
  const c = await Copy.open(await person(), await b.bytes());
  expect(c.db.selectValue("SELECT typeof(v) FROM vals"), "reprojected, the class kept").toBe(shown);
  for (const x of [a, b, c]) x.close();
});

test("R-X: a row a delete contested is kept, or deleted, by the resolution of its existence", async () => {
  for (const choose of ["keep", "delete"] as const) {
    const { a, b } = await base();
    const map = item(a, "Map");
    a.db.exec({ sql: "DELETE FROM items WHERE id = ?", bind: [map] });
    b.db.exec({ sql: "UPDATE items SET qty = 7 WHERE id = ?", bind: [map] });
    const [ab, bb] = [await a.bytes(), await b.bytes()];
    await a.mergeFrom(bb);
    await b.mergeFrom(ab);
    expect(a.flags().map((f: Any) => f.kind), "contested").toEqual(["delete-conflict"]);
    const seen = a.changes.observe("items", [map], []);
    const pick = seen.alternatives.find((x: Any) => x.values[""] === (choose === "keep" ? 1 : 0)).ver;
    a.changes.resolve(seen.token, pick);
    await b.mergeFrom(await a.bytes());
    for (const c of [a, b]) {
      expect(c.flags(), `${choose}: resolved on both`).toEqual([]);
      expect(c.db.selectValue("SELECT qty FROM items WHERE id = ?", [map]), choose).toBe(choose === "keep" ? 7 : undefined);
    }
    expect(a.state()).toBe(b.state());
    a.close();
    b.close();
  }
});

test("a resolution waits for no transaction: it is refused inside one", async () => {
  const { a, b, c } = await rx();
  const seen = a.changes.observe("items", [7], ["qty", "unit"]);
  a.db.exec("BEGIN");
  expect(() => a.changes.resolve(seen.token, seen.shown)).toThrow(/^CHANGES_REFUSED: Resolve a conflict outside a transaction/);
  a.db.exec("ROLLBACK");
  expect(pendingCols(a)).toEqual(["qty", "unit"]);
  for (const x of [a, b, c]) x.close();
});
