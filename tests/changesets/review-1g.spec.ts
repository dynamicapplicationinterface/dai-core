import { expect, test } from "@playwright/test";
import { Copy, boot, person, statementsOf } from "./copy.js";
import { SCENARIOS, SCHEMA, base, exchange, item, unreceived } from "./scenarios.js";
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

const rejected = (c: Copy): [string, string][] => c.changes.refusedChanges().map((r: Any) => [r.ver, r.reason]);

test("1g-M1: the honest control: F's title, made without A's, is pending against A's on both copies", async () => {
  const o = await exchange((a, b) => unreceived(a, b));
  expect(o.converged).toBe(true);
  for (const c of [o.a, o.b]) {
    expect(rejected(c)).toEqual([]);
    expect(pendingOf(c, "items", JSON.stringify([item(c, "Tent (A)") ?? item(c, "Tent (F)")])).title).toEqual(["Tent (A)", "Tent (F)"]);
  }
  o.a.close();
  o.b.close();
});

for (const name of ["1g-M1 unreceived basis", "1g-M1 unreceived resolves", "1g-M1 unreceived seen"]) {
  test(`${name}: a version the signer never received, named with a lower clock, is refused by the runtime whichever way the copies meet`, async () => {
    const o = await exchange(SCENARIOS[name]!.write);
    expect(o.converged, "converged").toBe(true);
    const forger = rejected(o.a);
    expect(forger.map(([, r]) => r), "F's title batch refused, for its basis").toEqual(["basis-forged"]);
    expect(rejected(o.b), "the same on the copy that carried it").toEqual(forger);
    for (const c of [o.a, o.b]) {
      expect(c.db.selectValue("SELECT title FROM items WHERE title LIKE 'Tent%'"), "A's edit stands").toBe("Tent (A)");
      expect(c.rows.all("SELECT 1 FROM _cs_cell WHERE ver = ?", [forger[0]![0]]), "F's is kept in no cell").toEqual([]);
      expect(c.db.selectValue("SELECT note FROM items WHERE title = 'Rope'"), "F's honest notes stand").toBe("f4");
    }
    o.a.close();
    o.b.close();
  });
}

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

const databases = (db: Any): string[] => db.selectValues("SELECT name FROM pragma_database_list ORDER BY name");
const CHAIN = "ATTACH '' AS t; CREATE TABLE t.x (y); INSERT INTO t.x VALUES ('in window')";
/** Runs `f`, keeping any error it throws: what the application saw, if anything. */
const tried = (f: () => unknown): unknown => {
  try {
    return f();
  } catch (e) {
    return e;
  }
};

test("1g-M2: the VACUUM allowance is the VACUUM statement's alone; application code inside the exec gets none, by three routes", async () => {
  const { a, b } = await base();
  const proto = Object.getPrototypeOf(a.db).exec;
  const inner = (): unknown => tried(() => proto.call(a.db, CHAIN));
  let n = 0;
  a.db.createFunction("app_f", () => (inner(), 1), { arity: 0 });
  const routes: [string, () => unknown][] = [
    ["a {sql} getter read twice", () => a.db.exec({ get sql() { return n++ === 0 ? "VACUUM" : CHAIN; } })],
    ["a row callback", () => a.db.exec({ sql: "VACUUM; SELECT 1", callback: () => void inner() })],
    ["an application function", () => a.db.exec("SELECT app_f(); VACUUM")],
    ["an application function VACUUM INTO evaluates", () => a.db.exec("VACUUM INTO app_f() || ''")],
  ];
  for (const [route, run] of routes) {
    tried(run);
    expect(databases(a.db), `${route}: nothing attached`).toEqual(["main", "temp"]);
    expect(() => a.db.exec("INSERT INTO t.x VALUES ('after')"), `${route}: no table outside the document`).toThrow();
  }
  // VACUUM itself still runs, alone and in a script, by exec and by a prepared statement.
  a.db.exec("VACUUM");
  a.db.exec("UPDATE items SET qty = 2 WHERE title = 'Map'; VACUUM; UPDATE items SET qty = 3 WHERE title = 'Map'");
  const s = a.db.prepare("VACUUM");
  s.step();
  s.finalize();
  expect(a.db.selectValue("SELECT qty FROM items WHERE title = 'Map'")).toBe(3);
  expect(a.save()?.ops, "the script's writes are saved").toBe(1);
  expect(databases(a.db)).toEqual(["main", "temp"]);
  a.close();
  b.close();
});

test("1g-M3: an admitted CREATE ... IF NOT EXISTS admits its own statement, as the type the release declares; no trigger is made in main, and the copies converge", async () => {
  const { a, b } = await base();
  const categories = statementsOf(await boot(), SCHEMA).find((x) => /CREATE TABLE IF NOT EXISTS categories/.test(x))!;
  const trigger = "CREATE TRIGGER categories AFTER INSERT ON audit BEGIN UPDATE items SET note = 'by app trigger'; END";
  const proto = Object.getPrototypeOf(a.db).exec;
  let n = 0;
  const routes: [string, () => unknown][] = [
    ["a {sql} getter read twice", () => a.db.exec({ get sql() { return n++ === 0 ? categories : trigger; } })],
    ["a row callback", () => a.db.exec({ sql: `${categories} SELECT 1`, callback: () => void tried(() => proto.call(a.db, trigger)) })],
  ];
  for (const [route, run] of routes) {
    tried(run);
    expect(a.db.selectValues("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'categories'"), `${route}: no trigger made`).toEqual([]);
  }
  // The admitted no-op itself still runs.
  a.db.exec(categories);
  b.db.exec("INSERT INTO audit (item_id, what) SELECT id, 'checked' FROM items WHERE title = 'Map'");
  await a.mergeFrom(await b.bytes());
  await b.mergeFrom(await a.bytes());
  expect(a.db.selectValues("SELECT DISTINCT note FROM items"), "no application trigger fired under the apply").toEqual([null]);
  expect(a.changes.dirty).toBe(false);
  expect(a.state(), "converged").toBe(b.state());
  a.close();
  b.close();
});
