import { expect, test } from "@playwright/test";
import { base, exchange, item, SCENARIOS, type Outcome } from "./scenarios.js";
import { Copy, DOC, openBytes, person } from "./copy.js";
import * as merge from "../../src/replicated-frame.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const m = merge as any;

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

/**
 * PR9-H1, the review's own run (P2): the frame captures, then awaits the
 * batches' verification, then admits and projects. An application write that
 * lands inside that await was captured by no save, so projection must not
 * replace it: it survives as the person's change, or as one side of a flagged
 * conflict, and never as a copy of the remote value signed in their name.
 */
test("PR9-H1: a local write during the merge's verify wait survives, as the person's change or a flagged conflict", async () => {
  const { a, b } = await base();
  const tent = item(a, "Tent");
  a.db.exec({ sql: "UPDATE items SET title = 'A-remote' WHERE id = ?", bind: [tent] });
  const aBytes = await a.bytes();

  // B, step by step as the frame merges (bootloader.ts, mergeSibling).
  b.save();
  const sib = await openBytes(aBytes);
  const verifying = m.verifyBatches(sib.rows, m.mergeTablesOf(sib.rows), DOC);
  b.db.exec({ sql: "UPDATE items SET title = 'B-local' WHERE id = ?", bind: [tent] });
  const verdicts = await verifying;
  m.mergeVerified(b.rows, sib.rows, { document: DOC, author: b.author.author, verdicts });
  sib.db.close();
  b.changes.projectAdmitted();
  b.save();

  const kept = (c: typeof a): boolean => [...c.everyValue()].some((v) => JSON.parse(v)[4] === "B-local");
  const shownOrPending = (c: typeof a): void => {
    const title = c.db.selectValue("SELECT title FROM items WHERE id = ?", [tent]);
    const pending = c.flags().find((f) => f.kind === "pending");
    const values = pending ? JSON.parse(pending.detail).flatMap((p: { values: { val: unknown }[] }) => p.values.map((v) => v.val)) : [];
    expect(title === "B-local" || (values.includes("B-local") && values.includes("A-remote")), `shown ${title}, pending ${JSON.stringify(values)}`).toBe(true);
  };
  expect(kept(b), "B-local is in B's cells").toBe(true);
  shownOrPending(b);
  // B's log names the remote value only if B wrote it: a resolution is the person's, never the projection's.
  const bWrote = b.written().map((w) => JSON.parse(w)[4]);
  expect(bWrote, "B's log carries what B wrote").toContain("B-local");
  expect(bWrote, "B's log never re-signs the remote value as its own").not.toContain("A-remote");

  await a.mergeFrom(await b.bytes());
  expect(kept(a), "B-local reached A").toBe(true);
  shownOrPending(a);
  expect(a.state()).toBe(b.state());
  a.close();
  b.close();
});

/**
 * PR9-H3, the review's own run (P1): hidden rowids start at 1 in every table,
 * so a slot keyed by the real last rowid alone answered the integer-keyed
 * table's ranged id for the text-keyed table's row inserted after it.
 */
test("PR9-H3: last_insert_rowid() after inserts into an integer-keyed then a text-keyed table returns the second row's key", async () => {
  const c = await Copy.open(await person());
  c.db.exec("CREATE TABLE lists (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE tags (k TEXT PRIMARY KEY, label TEXT);");
  c.db.exec("BEGIN; INSERT INTO lists (name) VALUES ('one');");
  const listId = c.db.selectValue("SELECT last_insert_rowid()");
  c.db.exec("INSERT INTO tags (k, label) VALUES ('red', 'Red')");
  const afterTag = c.db.selectValue("SELECT last_insert_rowid()");
  const tagRowid = c.db.selectValue("SELECT rowid FROM tags WHERE k = 'red'");
  c.db.exec("COMMIT");
  expect(listId).toBe(c.db.selectValue("SELECT id FROM lists WHERE name = 'one'"));
  expect(afterTag, "the tag's own rowid, as SQLite answers it for a text-keyed table").toBe(tagRowid);
  expect(afterTag).not.toBe(listId);
  c.close();
});

test("PR9-H3: an app trigger inserting into another table leaves last_insert_rowid() on the row the statement inserted", async () => {
  const c = await Copy.open(await person());
  c.db.exec(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE notes (k TEXT PRIMARY KEY, what TEXT);" +
      "CREATE TRIGGER items_note AFTER INSERT ON items BEGIN INSERT INTO notes (what) VALUES ('added ' || NEW.title); END;",
  );
  c.db.exec("INSERT INTO items (title) VALUES ('Lamp')");
  expect(c.db.selectValue("SELECT last_insert_rowid()")).toBe(c.db.selectValue("SELECT id FROM items WHERE title = 'Lamp'"));
  c.db.exec("INSERT INTO notes (what) VALUES ('by hand')");
  expect(c.db.selectValue("SELECT last_insert_rowid()")).toBe(c.db.selectValue("SELECT rowid FROM notes WHERE what = 'by hand'"));
  c.close();
});

test("PR9-H3: a merged row does not become the application's last insert", async () => {
  const o = await exchange((a) => {
    a.db.exec("INSERT INTO items (title) VALUES ('Lamp')");
  });
  // B's merge was its last write: it projected A's Lamp. B's next insert, into a text-keyed table, lands
  // on the hidden rowid Lamp holds in items, and must answer its own rowid, not Lamp's id.
  const lampRowid = o.b.db.selectValue("SELECT rowid FROM items WHERE title = 'Lamp'");
  o.b.db.exec("CREATE TABLE IF NOT EXISTS tags (k TEXT PRIMARY KEY)");
  o.b.db.exec({ sql: "INSERT INTO tags (rowid, k) VALUES (?, 'seen')", bind: [lampRowid] });
  expect(o.b.db.selectValue("SELECT last_insert_rowid()")).toBe(lampRowid);
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
