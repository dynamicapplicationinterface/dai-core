import { expect, test } from "@playwright/test";
import { exchange, item, SCENARIOS, type Outcome } from "./scenarios.js";
import { openBytes } from "./copy.js";

/**
 * The spike's fourteen merge scenarios and S8, promoted (`handoff-2026-10-18.md`,
 * "Changeset spike", §3): the literal policy, run by the runtime's own modules.
 */

function judged(o: Outcome, flags: string[]): void {
  expect(o.ab.report.refused ?? null).toBeNull();
  expect(o.ba.report.refused ?? null).toBeNull();
  expect(o.converged, "both copies hold the same tables, flags and held rows").toBe(true);
  expect(o.missing, "every value either author wrote is in both copies").toEqual([]);
  expect(o.vanished, "no row either copy showed is gone unless a delete went unopposed").toEqual([]);
  for (const kind of flags) expect(o.kinds).toContain(kind);
  if (flags.length === 0) expect(o.kinds).toEqual([]);
}

const close = (o: Outcome): void => {
  o.a.close();
  o.b.close();
};

test("S1 inserts: both rows, from two authors' ranges", async () => {
  const o = await exchange(SCENARIOS["S1 inserts"]!.write);
  judged(o, []);
  const rows = o.a.db.selectObjects("SELECT id, title FROM items WHERE title IN ('Lamp', 'Soap') ORDER BY title");
  expect(rows.map((r: { title: string }) => r.title)).toEqual(["Lamp", "Soap"]);
  const [lamp, soap] = rows.map((r: { id: number }) => Number(r.id));
  expect(Math.floor(lamp / 2 ** 32)).toBe(o.a.changes.index);
  expect(Math.floor(soap / 2 ** 32)).toBe(o.b.changes.index);
  close(o);
});

test("S1b UNIQUE: one row holds the slot, the other is held and flagged", async () => {
  const o = await exchange(SCENARIOS["S1b UNIQUE"]!.write);
  judged(o, ["held"]);
  expect(o.a.db.selectValue("SELECT count(*) FROM categories WHERE name = 'Tools'")).toBe(1);
  expect(o.a.held().map((h) => h.reason).join()).toMatch(/UNIQUE/);
  close(o);
});

test("S2 columns: different columns of one row both land", async () => {
  const o = await exchange(SCENARIOS["S2 columns"]!.write);
  judged(o, []);
  expect(o.a.db.selectObject("SELECT qty, note FROM items WHERE title = 'Bread'")).toEqual({ qty: 3, note: "whole wheat" });
  close(o);
});

test("S3 same column: the later shows, both are kept, the row is pending", async () => {
  const o = await exchange(SCENARIOS["S3 same column"]!.write);
  judged(o, ["pending"]);
  const title = o.a.db.selectValue("SELECT title FROM items WHERE title LIKE 'Tent%'");
  expect(["Tent (2p)", "Tent (4p)"]).toContain(title);
  expect(o.b.db.selectValue("SELECT title FROM items WHERE title LIKE 'Tent%'")).toBe(title);
  const pending = JSON.parse(o.a.flags().find((f) => f.kind === "pending")!.detail);
  expect(pending[0].values.map((v: { val: string }) => v.val).sort()).toEqual(["Tent (2p)", "Tent (4p)"]);
  close(o);
});

test("S3 resolved: a later local edit to the pending row clears the flag on every copy", async () => {
  const o = await exchange(SCENARIOS["S3 same column"]!.write);
  o.a.db.exec("UPDATE items SET title = 'Tent (3p)' WHERE title LIKE 'Tent%'");
  o.a.save();
  expect(o.a.flags(), "cleared on the copy that resolved it").toEqual([]);
  await o.b.mergeFrom(await o.a.bytes());
  await o.a.mergeFrom(await o.b.bytes());
  for (const c of [o.a, o.b]) {
    expect(c.db.selectValue("SELECT title FROM items WHERE title LIKE 'Tent%'")).toBe("Tent (3p)");
    expect(c.flags()).toEqual([]);
  }
  expect(o.a.state()).toBe(o.b.state());
  const kept = [...o.a.everyValue()].map((v) => JSON.parse(v)).filter((v) => v[2] === "title" && String(v[4]).startsWith("Tent ("));
  expect(kept.map((v) => v[4]).sort()).toEqual(["Tent (2p)", "Tent (3p)", "Tent (4p)"]);
  close(o);
});

test("S4 delete/update: the row is kept, flagged delete-conflict", async () => {
  const o = await exchange(SCENARIOS["S4 delete/update"]!.write);
  judged(o, ["delete-conflict"]);
  expect(o.a.db.selectObject("SELECT title, qty FROM items WHERE title = 'Map'")).toEqual({ title: "Map", qty: 2 });
  close(o);
});

test("S4b delete/child: a parent a concurrent child references is kept", async () => {
  const o = await exchange(SCENARIOS["S4b delete/child"]!.write);
  judged(o, ["kept-referenced"]);
  expect(o.a.db.selectValues("SELECT a.what FROM audit a JOIN items i ON i.id = a.item_id WHERE i.title = 'Rope'")).toEqual(["checked"]);
  expect(o.a.db.selectObjects("SELECT * FROM pragma_foreign_key_check")).toEqual([]);
  close(o);
});

test("S4c delete/delete: gone on both, nothing flagged", async () => {
  const o = await exchange(SCENARIOS["S4c delete/delete"]!.write);
  judged(o, []);
  expect(o.a.db.selectValue("SELECT count(*) FROM items WHERE title = 'Stove'")).toBe(0);
  close(o);
});

test("S5 transaction: one save, one changeset, and it merges with a concurrent column", async () => {
  const o = await exchange(SCENARIOS["S5 transaction"]!.write);
  judged(o, []);
  expect((o.local as { ops: number }).ops).toBe(4);
  expect(
    o.a.db.selectObject(
      "SELECT i.title, c.name AS category, (SELECT what FROM audit WHERE item_id = i.id) AS audit FROM items i JOIN categories c ON c.id = i.category_id WHERE i.title = 'Pan'",
    ),
  ).toEqual({ title: "Pan", category: "Kitchen", audit: "bought" });
  expect(o.a.db.selectObject("SELECT done, note FROM items WHERE title = 'Stove'")).toEqual({ done: 1, note: "gas" });
  close(o);
});

test("S5b relative, same: two equal increments are flagged, not summed", async () => {
  const o = await exchange(SCENARIOS["S5b relative, same"]!.write);
  judged(o, ["pending"]);
  expect(o.a.db.selectValue("SELECT qty FROM items WHERE title = 'Bread'")).toBe(2);
  close(o);
});

test("S5c relative, different: flagged, the later value shown", async () => {
  const o = await exchange(SCENARIOS["S5c relative, different"]!.write);
  judged(o, ["pending"]);
  expect([2, 3]).toContain(o.a.db.selectValue("SELECT qty FROM items WHERE title = 'Bread'"));
  close(o);
});

test("S6 FK, locally: SQLite refuses a child of a parent that does not exist", async () => {
  const o = await exchange((a) => {
    try {
      a.db.exec("INSERT INTO items (category_id, title) VALUES (999, 'Ghost')");
      return "ok";
    } catch (e) {
      return String((e as Error).message);
    }
  });
  judged(o, []);
  expect(String(o.local)).toMatch(/FOREIGN KEY constraint failed/);
  close(o);
});

/** A forwarding copy rewrites "Cup" to "Cap" inside B's sealed log payload. */
async function tamper(bytes: Uint8Array): Promise<Uint8Array> {
  const { sqlite3, db } = await openBytes(bytes);
  const row = db.selectObject("SELECT _r_replica AS r, _r_seq AS s, payload FROM _cs_log WHERE instr(payload, CAST('Cup' AS BLOB)) > 0");
  const p = new Uint8Array(row.payload);
  p[Buffer.from(p).indexOf(Buffer.from("Cup")) + 1] = "a".charCodeAt(0);
  for (const t of db.selectValues("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = '_cs_log'")) db.exec(`DROP TRIGGER "${t}"`);
  db.exec({ sql: "UPDATE _cs_log SET payload = ? WHERE _r_replica = ? AND _r_seq = ?", bind: [p, row.r, row.s] });
  const out = sqlite3.capi.sqlite3_js_db_export(db.pointer);
  db.close();
  return out;
}

const tampered = (a: { db: { exec(s: string): void } }, b: { db: { exec(s: string): void } }): void => {
  a.db.exec("INSERT INTO items (title) VALUES ('Kettle')");
  b.db.exec("INSERT INTO items (title) VALUES ('Cup')");
};

test("S7 tampered: the altered batch is refused and nothing of it is projected", async () => {
  const o = await exchange(tampered, { tamper });
  expect(o.ab.report.refusedBatches.map((r: { reason: string }) => r.reason)).toEqual(["BATCH_DIGEST_MISMATCH"]);
  expect(o.a.db.selectValues("SELECT title FROM items WHERE title IN ('Kettle', 'Cup', 'Cap') ORDER BY title")).toEqual(["Kettle"]);
  expect(o.missing).toEqual([]);
  close(o);
});

test("S7 honest file: after B's own file arrives, Cup lands and both converge", async () => {
  const o = await exchange(tampered, { tamper });
  await o.a.mergeFrom(await o.b.bytes());
  expect(o.a.db.selectValues("SELECT title FROM items WHERE title IN ('Kettle', 'Cup', 'Cap') ORDER BY title")).toEqual(["Cup", "Kettle"]);
  expect(o.a.state()).toBe(o.b.state());
  close(o);
});

test("S8 app trigger: a trigger does not re-fire on merged rows", async () => {
  const o = await exchange(SCENARIOS["S8 app trigger"]!.write, { trigger: true });
  judged(o, []);
  for (const c of [o.a, o.b]) {
    expect(
      c.db.selectValues("SELECT i.title FROM audit x JOIN items i ON i.id = x.item_id WHERE x.what = 'created' AND i.title IN ('Lamp', 'Soap') ORDER BY 1"),
    ).toEqual(["Lamp", "Soap"]);
  }
  close(o);
});

test("an id the application omits comes from this author's range, and last_insert_rowid() answers it", async () => {
  const o = await exchange((a) => {
    a.db.exec("INSERT INTO categories (name) VALUES ('Bath')");
    return a.db.selectValue("SELECT last_insert_rowid()");
  });
  const id = o.a.db.selectValue("SELECT id FROM categories WHERE name = 'Bath'");
  expect(o.local).toBe(id);
  expect(Math.floor(Number(id) / 2 ** 32)).toBe(o.a.changes.index);
  expect(Number(id)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  void item;
  close(o);
});
