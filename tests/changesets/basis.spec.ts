import { expect, test } from "@playwright/test";
import { Copy, openBytes, person } from "./copy.js";
import { SCENARIOS, base, exchange, item } from "./scenarios.js";
import { lastSeq, opsAfter, pendingOf } from "./rx.js";

/**
 * R-X §3: signed operations bind their causal basis. An edit is based on the
 * version its unit showed and supersedes that alone; a resolution names what
 * it resolves. A reader takes both from the signed payload and never from its
 * own projection, arrival order or flags, and refuses an operation whose
 * basis is missing or names a version it could not have seen.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const mapOf = (m: Map<string, string[]>): Record<string, string[]> => Object.fromEntries([...m].map(([c, v]) => [c, [...v].sort()]));
const rejected = (c: Copy): [string, string][] => c.changes.refusedChanges().map((r: Any) => [r.ver, r.reason]);

test("R-X §3: an edit's basis is the version it was shown, and the alternative it was not shown stays pending on every copy", async () => {
  const { a, b } = await base();
  const tent = item(a, "Tent");
  a.db.exec({ sql: "UPDATE items SET title = 'Tent (2p)' WHERE id = ?", bind: [tent] });
  b.db.exec({ sql: "UPDATE items SET title = 'Tent (4p)' WHERE id = ?", bind: [tent] });
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  const key = JSON.stringify([tent]);
  const heads = a.rows.all("SELECT ver, val FROM _cs_cell WHERE tbl = 'items' AND pk = ? AND col = 'title' AND val LIKE 'Tent (%'", [key]);
  const shown = a.db.selectValue("SELECT title FROM items WHERE id = ?", [tent]);
  const shownVer = String(heads.find((h) => h["val"] === shown)!["ver"]);
  const other = heads.find((h) => h["val"] !== shown)!["val"];
  const seq = lastSeq(a);
  a.db.exec({ sql: "UPDATE items SET title = 'Tent (3p)' WHERE id = ?", bind: [tent] });
  a.save();
  const op = opsAfter(a, seq)[0]!.op;
  expect(mapOf(op[5]), "based on the version shown, and no other").toEqual({ title: [shownVer] });
  expect(op[7], "an edit names nothing it resolves").toBeUndefined();
  await b.mergeFrom(await a.bytes());
  for (const c of [a, b]) expect(pendingOf(c, "items", key).title, "the edit, against the alternative it was not shown").toEqual(["Tent (3p)", other].sort());
  expect(a.state()).toBe(b.state());
  a.close();
  b.close();
});

test("R-X §3: an edit of a row a delete contested writes its column, not the row's existence; the delete-conflict stands", async () => {
  const o = await exchange(SCENARIOS["S4 delete/update"]!.write);
  const map = o.b.db.selectValue("SELECT id FROM items WHERE title = 'Map'");
  for (const c of [o.a, o.b]) expect(c.flags().map((f: Any) => f.kind)).toEqual(["delete-conflict"]);
  const seq = lastSeq(o.b);
  o.b.db.exec({ sql: "UPDATE items SET note = 'still here' WHERE id = ?", bind: [map] });
  o.b.save();
  expect(opsAfter(o.b, seq).map((x) => x.wrote), "the note alone").toEqual([["note"]]);
  await o.a.mergeFrom(await o.b.bytes());
  for (const c of [o.a, o.b]) expect(c.flags().map((f: Any) => f.kind), "still contested").toEqual(["delete-conflict"]);
  o.a.close();
  o.b.close();
});

for (const [name, reason, column] of [
  ["R-X forged basis", "basis-forged", "title"],
  ["R-X missing basis", "basis-missing", "qty"],
] as const) {
  test(`R-X §3: ${name.slice(4)} is refused by the runtime, unapplied, whichever way the copies meet`, async () => {
    const o = await exchange(SCENARIOS[name]!.write);
    expect(o.converged, "converged").toBe(true);
    const forger = rejected(o.a);
    expect(forger.map(([, r]) => r), "one changeset refused, for its basis").toEqual([reason]);
    expect(rejected(o.b), "the same on the copy that carried it").toEqual(forger);
    for (const c of [o.a, o.b]) {
      expect(c.db.selectValues(`SELECT ${column} FROM items WHERE ${column} IN ('Tent (9p)', 9)`), "its value is applied nowhere").toEqual([]);
      expect(c.rows.all("SELECT 1 FROM _cs_cell WHERE ver = ?", [forger[0]![0]]), "and kept in no cell").toEqual([]);
    }
    o.a.close();
    o.b.close();
  });
}

test("R-X §3: a changeset whose basis names a version not yet here waits for it, and is applied once it arrives", async () => {
  const { a, b } = await base();
  const tent = item(a, "Tent");
  const c = await Copy.open(await person(), await a.bytes(), a.schema);
  const baseSeq = lastSeq(a);
  a.db.exec({ sql: "UPDATE items SET title = 'Tent (2p)' WHERE id = ?", bind: [tent] });
  const aBytes = await a.bytes();
  await b.mergeFrom(aBytes);
  b.db.exec({ sql: "UPDATE items SET title = 'Tent (5p)' WHERE id = ?", bind: [tent] });
  const bBytes = await b.bytes();
  // B's file without A's new batch: B's edit, based on A's version, arrives at C alone.
  const stripped = await openBytes(bBytes);
  for (const t of stripped.db.selectValues("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = '_cs_log'") as string[]) {
    stripped.db.exec(`DROP TRIGGER "${t}"`);
  }
  stripped.db.exec({ sql: "DELETE FROM _cs_log WHERE _r_replica = ? AND _r_seq > ?", bind: [a.author.author, baseSeq] });
  const alone = stripped.sqlite3.capi.sqlite3_js_db_export(stripped.db.pointer) as Uint8Array;
  stripped.db.close();
  const first = await c.mergeFrom(alone);
  expect(c.rows.all("SELECT 1 FROM _cs_log WHERE _r_replica = ? AND _r_seq = ?", [b.author.author, lastSeq(b)]).length, "B's edit is admitted").toBe(1);
  expect(first.projected.changesets, "and waits: its basis is not here").toBe(0);
  expect(c.db.selectValue("SELECT title FROM items WHERE id = ?", [tent]), "nothing applied").toBe("Tent");
  expect(rejected(c), "and nothing refused").toEqual([]);
  await c.mergeFrom(aBytes);
  expect(c.db.selectValue("SELECT title FROM items WHERE id = ?", [tent]), "applied once its basis is").toBe("Tent (5p)");
  expect(c.flags(), "B's edit supersedes A's, as on B").toEqual([]);
  await b.mergeFrom(await c.bytes());
  expect(c.state()).toBe(b.state());
  for (const x of [a, b, c]) x.close();
});
