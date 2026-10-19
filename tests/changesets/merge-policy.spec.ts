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

/**
 * The value a pending column shows, as R-F amended says: the later by (lc,
 * author). Read from the signed log rows of the two versions the flag names,
 * not from the policy's own cells: higher lc first, then the greater author id.
 */
function laterBy(c: Copy, table: string, col: string): unknown {
  const flag = c.flags().find((f) => f.kind === "pending" && f.tbl === table);
  expect(flag, `${table} is pending`).toBeDefined();
  const entry = JSON.parse(flag!.detail).find((p: { col: string }) => p.col === col);
  const ranked = (entry.values as { ver: string; val: unknown }[]).map((v) => {
    const [author, seq] = v.ver.split(":");
    const lc = Number(c.rows.all("SELECT _r_lc AS lc FROM _cs_log WHERE lower(hex(_r_replica)) = ? AND _r_seq = ?", [author, Number(seq)])[0]!["lc"]);
    return { val: v.val, lc, author: author! };
  });
  ranked.sort((x, y) => y.lc - x.lc || (y.author > x.author ? 1 : y.author < x.author ? -1 : 0));
  return ranked[0]!.val;
}

test("S3 later: the shown value is the later by (lc, author), on a clock tie and when the clock and the author disagree", async () => {
  const tie = await exchange(SCENARIOS["S3 same column"]!.write);
  for (const c of [tie.a, tie.b]) expect(c.db.selectValue("SELECT title FROM items WHERE title LIKE 'Tent%'")).toBe(laterBy(c, "items", "title"));
  close(tie);

  // The copy with the smaller author id saves twice first, so its change carries the higher lc.
  const skew = await exchange((a, b) => {
    const [low, high] = [a, b].sort((x, y) => (Buffer.from(x.author.author).toString("hex") < Buffer.from(y.author.author).toString("hex") ? -1 : 1));
    for (const n of [1, 2]) {
      low!.db.exec({ sql: "UPDATE items SET note = ? WHERE id = ?", bind: [`warm-up ${n}`, item(low!, "Map")] });
      low!.save();
    }
    low!.db.exec({ sql: "UPDATE items SET title = 'Tent (low)' WHERE id = ?", bind: [item(low!, "Tent")] });
    high!.db.exec({ sql: "UPDATE items SET title = 'Tent (high)' WHERE id = ?", bind: [item(high!, "Tent")] });
  });
  judged(skew, ["pending"]);
  expect(laterBy(skew.a, "items", "title"), "the clock outranks the author id").toBe("Tent (low)");
  for (const c of [skew.a, skew.b]) expect(c.db.selectValue("SELECT title FROM items WHERE title LIKE 'Tent%'")).toBe("Tent (low)");
  close(skew);
});

test("S5c later: the relative change shown is the later by (lc, author)", async () => {
  const o = await exchange(SCENARIOS["S5c relative, different"]!.write);
  for (const c of [o.a, o.b]) expect(c.db.selectValue("SELECT qty FROM items WHERE title = 'Bread'")).toBe(laterBy(c, "items", "qty"));
  close(o);
});

test("S3 other column: an edit to a different column of the pending row leaves the flag, on every copy", async () => {
  const o = await exchange(SCENARIOS["S3 same column"]!.write);
  const shown = o.a.db.selectValue("SELECT title FROM items WHERE title LIKE 'Tent%'");
  o.a.db.exec("UPDATE items SET qty = 9 WHERE title LIKE 'Tent%'");
  o.a.save();
  expect(o.a.flags().map((f) => f.kind), "still pending on the copy that edited").toContain("pending");
  await o.b.mergeFrom(await o.a.bytes());
  await o.a.mergeFrom(await o.b.bytes());
  for (const c of [o.a, o.b]) {
    expect(c.db.selectObject("SELECT title, qty FROM items WHERE title LIKE 'Tent%'")).toEqual({ title: shown, qty: 9 });
    const pending = c.flags().filter((f) => f.kind === "pending");
    expect(pending.map((f) => JSON.parse(f.detail).map((p: { col: string }) => p.col)), "the title is still undecided").toEqual([["title"]]);
  }
  expect(o.a.state()).toBe(o.b.state());
  close(o);
});

/** Two copies of one document whose schema is `schema`, with one row in `table` both hold. */
async function pair(schema: string, seed: string): Promise<{ a: Copy; b: Copy }> {
  const a = await Copy.open(await person());
  a.db.exec(schema);
  a.db.exec(seed);
  const b = await Copy.open(await person(), await a.bytes());
  return { a, b };
}

async function swap(a: Copy, b: Copy): Promise<void> {
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
}

test("coupled: concurrent changes to different columns of a coupled group are one conflict, shown together; undeclared columns still merge", async () => {
  const { a, b } = await pair(
    `CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT,
       lat REAL NOT NULL, lng REAL NOT NULL -- dai:coupled lat lng
     );
     CREATE TABLE spots (id INTEGER PRIMARY KEY, name TEXT, lat REAL NOT NULL, lng REAL NOT NULL);`,
    "INSERT INTO places (name, lat, lng) VALUES ('camp', 0, 0); INSERT INTO spots (name, lat, lng) VALUES ('camp', 0, 0);",
  );
  // Each table in saves of its own: a save is one effect group (M06), and this is about coupling alone.
  for (const t of ["places", "spots"]) {
    a.db.exec(`UPDATE ${t} SET lat = 1 WHERE name = 'camp'`);
    b.db.exec(`UPDATE ${t} SET lng = 2 WHERE name = 'camp'`);
    a.save();
    b.save();
  }
  await swap(a, b);
  expect(a.state()).toBe(b.state());
  for (const c of [a, b]) {
    expect(c.db.selectObject("SELECT lat, lng FROM spots"), "undeclared: both columns land").toEqual({ lat: 1, lng: 2 });
    expect(c.flags().filter((f) => f.tbl === "spots")).toEqual([]);
    const pending = c.flags().find((f) => f.tbl === "places" && f.kind === "pending");
    expect(pending, "coupled: the row is pending").toBeDefined();
    expect(JSON.parse(pending!.detail).map((p: { col: string }) => p.col).sort()).toEqual(["lat", "lng"]);
    const shown = c.db.selectObject("SELECT lat, lng FROM places");
    expect([{ lat: 1, lng: 0 }, { lat: 0, lng: 2 }], "the pair comes from one change, never mixed").toContainEqual(shown);
    expect(shown.lat).toBe(laterBy(c, "places", "lat"));
  }
  a.close();
  b.close();
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

/**
 * PR9-H4, the review's own run (P3): a mount that rebuilds an arrival copies
 * no application rows and no `_cs_` rows when the arrival carries the log
 * (bootloader.ts, mergedArrival); they come back by projection. The rebuild is
 * reproduced on the bytes: application tables and `_cs_*` emptied, the log
 * kept, opened by the same author.
 */
async function rebuilt(bytes: Uint8Array): Promise<Uint8Array> {
  const { sqlite3, db } = await openBytes(bytes);
  const tables = db.selectValues("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_dai%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cs\\_log%' ESCAPE '\\'");
  for (const t of tables) db.exec(`DELETE FROM "${t}"`);
  const out = sqlite3.capi.sqlite3_js_db_export(db.pointer);
  db.close();
  return out;
}

test("PR9-H4: after a rebuild from an arrival, the author's counter starts above its own highest logged id, and a deleted id is never reused", async () => {
  const a = await Copy.open(await person());
  a.db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
  a.db.exec("INSERT INTO items (title) VALUES ('one'); INSERT INTO items (title) VALUES ('two'); INSERT INTO items (title) VALUES ('three');");
  const ids = a.db.selectValues("SELECT id FROM items ORDER BY id").map(Number);
  // Saved before the delete, as the frame saves after each write: the third id is logged, then deleted.
  a.save();
  a.db.exec({ sql: "DELETE FROM items WHERE id = ?", bind: [ids[2]] });
  const bytes = await rebuilt(await a.bytes());

  const again = await Copy.open(a.author, bytes);
  expect(again.db.selectValues("SELECT id FROM items ORDER BY id").map(Number), "the author's rows came back by projection").toEqual(ids.slice(0, 2));
  again.db.exec("INSERT INTO items (title) VALUES ('four')");
  const four = Number(again.db.selectValue("SELECT id FROM items WHERE title = 'four'"));
  expect(four, "above every id the author logged, the deleted one included").toBeGreaterThan(ids[2]!);
  expect(Math.floor(four / 2 ** 32)).toBe(again.changes.index);
  a.close();
  again.close();
});

/**
 * X1, the review's own run: a table with no primary key was keyed by its
 * rowid, which a trigger moved into the author's range after the insert. The
 * session had recorded the insert under the first rowid, found no row there
 * when the changeset was made, and logged nothing, so the row reached no
 * other copy and no rebuild. Such a table now carries an explicit ranged key.
 */
test("X1: an insert into a table with no primary key reaches the log, the other copy by merge, a rebuild from the log, and the author's counter", async () => {
  const a = await Copy.open(await person());
  a.db.exec("CREATE TABLE marks (body TEXT)");
  const b = await Copy.open(await person(), await a.bytes());
  a.db.exec("INSERT INTO marks (body) VALUES ('m1'); INSERT INTO marks (body) VALUES ('m2');");
  expect(a.save()?.ops, "both inserts are in the log").toBe(2);
  const [m1, m2] = a.db.selectValues("SELECT _dai_id FROM marks ORDER BY body").map(Number);
  expect(Math.floor(m1! / 2 ** 32), "the key is drawn from the author's range").toBe(a.changes.index);

  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValues("SELECT body FROM marks ORDER BY body"), "the copy that existed before the inserts has them").toEqual(["m1", "m2"]);

  a.db.exec({ sql: "DELETE FROM marks WHERE _dai_id = ?", bind: [m2] });
  const again = await Copy.open(a.author, await rebuilt(await a.bytes()));
  expect(again.db.selectValues("SELECT body FROM marks ORDER BY body"), "a rebuild from the log has the row").toEqual(["m1"]);
  again.db.exec("INSERT INTO marks (body) VALUES ('m3')");
  const m3 = Number(again.db.selectValue("SELECT _dai_id FROM marks WHERE body = 'm3'"));
  expect(m3, "the counter counts the keyless table's ids, the deleted one included").toBeGreaterThan(m2!);

  // A table made and written in one exec has its row before the runtime gives it a key: it is logged too.
  again.db.exec("CREATE TABLE pins (at TEXT); INSERT INTO pins (at) VALUES ('first');");
  expect(again.save()?.ops, "the m3 insert and the pin").toBe(2);
  const later = await Copy.open(again.author, await rebuilt(await again.bytes()));
  expect(later.db.selectValues("SELECT at FROM pins"), "a rebuild from the log has the pin").toEqual(["first"]);
  later.close();
  for (const c of [a, b, again]) c.close();
});

/**
 * 1b-H2(a), the review's own run: save() deleted the session before it built
 * the payload, so a save that threw lost everything captured since the last
 * one, in every table. Forced twice: by a coupled group naming something that
 * is not a column (the review's `lat lng: the position`, set past the parser),
 * then by an error in the log write itself.
 */
test("1b-H2(a): a save that fails leaves the capture intact, and the next save logs everything since the last one that succeeded", async () => {
  const a = await Copy.open(await person());
  a.db.exec("CREATE TABLE places (id INTEGER PRIMARY KEY, lat REAL, lng REAL); CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);");
  a.db.exec("INSERT INTO places (lat, lng) VALUES (0, 0)");
  a.save();
  const b = await Copy.open(await person(), await a.bytes());
  const logged = (): number => Number(a.db.selectValue("SELECT count(*) FROM _cs_log WHERE _r_replica = ?", [a.author.author]));
  const before = logged();

  const declaredOf = a.changes.declaredOf.bind(a.changes);
  a.changes.declaredOf = (t: string) => (t === "places" ? { coupled: [["lat", "lng:"]], consequential: [] } : declaredOf(t));
  a.db.exec("UPDATE places SET lat = 1; INSERT INTO notes (body) VALUES ('same save')");
  expect(() => a.save()).toThrow(/no such column/);
  a.changes.declaredOf = declaredOf;
  expect(logged(), "nothing of a failed save is in the log").toBe(before);

  a.db.exec("CREATE TRIGGER refuse_log BEFORE INSERT ON _cs_log BEGIN SELECT RAISE(ABORT, 'forced'); END");
  a.db.exec("INSERT INTO notes (body) VALUES ('second try')");
  expect(() => a.save()).toThrow(/forced/);
  expect(logged(), "nothing of a failed save is in the log").toBe(before);
  a.db.exec("DROP TRIGGER refuse_log");

  expect(a.save()?.ops, "the update and both notes, in one changeset").toBe(3);
  await b.mergeFrom(await a.bytes());
  expect(b.db.selectValue("SELECT lat FROM places"), "the change the failed saves held").toBe(1);
  expect(b.db.selectValues("SELECT body FROM notes ORDER BY body"), "the unrelated writes in the failed saves").toEqual(["same save", "second try"]);
  a.close();
  b.close();
});

/**
 * 1b-H1, against native SQLite as the oracle. The same schema and statements
 * run on a plain database (node:sqlite) and on a copy. After each step the
 * copy's last_insert_rowid() must be native's answer exactly, except where
 * native's names a row of a table whose integer key the runtime rewrote: there
 * it is that row's ranged id. Native SQLite restores the last rowid when a
 * trigger program ends, so an insert a trigger makes is never the answer; the
 * slot the runtime kept was overwritten by it (the review's runs: an UPDATE
 * whose trigger inserts into a text-keyed table answered a hidden rowid, the
 * f661823d probe; into an integer-keyed table, another table's id).
 */
test("1b-H1: last_insert_rowid() equals native SQLite's at every step, but for the ranged id of a rewritten key", async () => {
  const SCHEMA_H1 = `
    CREATE TABLE lists (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE audit (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE settings (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE tags (k TEXT PRIMARY KEY, label TEXT);
    CREATE TABLE log (k TEXT PRIMARY KEY, label TEXT);
    CREATE TABLE marks (label TEXT);
    CREATE TRIGGER items_tag AFTER INSERT ON items BEGIN INSERT INTO tags (k, label) VALUES ('t-' || NEW.label, 'by ' || NEW.label); END;
    CREATE TRIGGER settings_audit AFTER UPDATE OF label ON settings WHEN NEW.label LIKE 'audit%' BEGIN INSERT INTO audit (label) VALUES ('for ' || NEW.label); END;
    CREATE TRIGGER settings_log AFTER UPDATE OF label ON settings WHEN NEW.label LIKE 'log%' BEGIN INSERT INTO log (k, label) VALUES ('l-' || NEW.label, 'for ' || NEW.label); END;
    CREATE TRIGGER lists_mark BEFORE INSERT ON lists WHEN NEW.label = 'L3' BEGIN INSERT INTO marks (label) VALUES ('before L3'); END;`;
  const REWRITTEN = new Set(["lists", "items", "audit", "settings"]);
  const { DatabaseSync } = await import("node:sqlite");

  /** One copy beside its oracle. */
  const pair = async (c: Copy): Promise<{ c: Copy; native: InstanceType<typeof DatabaseSync>; step: (sql: string, at: string, what: string) => void }> => {
    const native = new DatabaseSync(":memory:");
    native.exec(SCHEMA_H1);
    const step = (sql: string, at: string, what: string): void => {
      native.exec(sql);
      c.db.exec(sql);
      const want = Number(native.prepare("SELECT last_insert_rowid() AS v").get()!["v"]);
      const got = Number(c.db.selectValue("SELECT last_insert_rowid()"));
      if (want === 0) {
        expect(got, `${what}: no insert yet`).toBe(0);
        return;
      }
      const named = native.prepare(`SELECT label FROM ${at} WHERE rowid = ?`).get(want)?.["label"];
      expect(named, `${what}: native's answer names a row of ${at}`).toBeDefined();
      if (REWRITTEN.has(at)) {
        expect(c.db.selectValue(`SELECT label FROM ${at} WHERE id = ?`, [got]), `${what}: the ranged id of the row native names`).toBe(named);
      } else {
        expect(got, `${what}: native's answer exactly`).toBe(want);
        expect(c.db.selectValue(`SELECT label FROM ${at} WHERE rowid = ?`, [got]), what).toBe(named);
      }
    };
    return { c, native, step };
  };

  const a = await Copy.open(await person());
  a.db.exec(SCHEMA_H1);
  const b = await Copy.open(await person(), await a.bytes());
  const A = await pair(a);
  A.step("INSERT INTO settings (label) VALUES ('S1')", "settings", "insert");
  A.step("INSERT INTO lists (label) VALUES ('L1')", "lists", "insert into an integer-keyed table");
  A.step("INSERT INTO items (label) VALUES ('I1')", "items", "an insert whose INSERT trigger inserts elsewhere");
  A.step("UPDATE settings SET label = 'audit 1' WHERE label = 'S1'", "items", "inside an UPDATE trigger, into an integer-keyed table");
  A.step("INSERT INTO lists (label) VALUES ('L2')", "lists", "insert");
  A.step("UPDATE settings SET label = 'log 1' WHERE label = 'audit 1'", "lists", "inside an UPDATE trigger, into a text-keyed table (the f661823d probe)");
  A.step("INSERT INTO tags (k, label) VALUES ('red', 'T1')", "tags", "into a text-keyed table");
  A.step("UPDATE settings SET label = 'audit 2' WHERE label = 'log 1'", "tags", "an UPDATE trigger after a text-keyed insert");
  A.step("INSERT INTO marks (label) VALUES ('M1')", "marks", "into a hidden-keyed table");
  A.step("INSERT INTO lists (label) VALUES ('L3')", "lists", "an insert whose BEFORE trigger inserts elsewhere");
  A.step("DELETE FROM tags WHERE k = 'red'", "lists", "a DELETE");
  A.c.save();
  A.step("SELECT 1", "lists", "after a save, which writes the log");

  // B, after merging A's rows into every table, with no insert of its own since: native never saw a merge.
  const B = await pair(b);
  // A ranged id, so a merged row whose hidden rowid happens to equal native's answer cannot pass for it.
  B.step("INSERT INTO lists (label) VALUES ('B1')", "lists", "B's own insert");
  await b.mergeFrom(await a.bytes());
  B.step("SELECT 1", "lists", "after a merge with no application insert");
  B.step("UPDATE settings SET label = 'log B' WHERE label = 'audit 2'", "lists", "an UPDATE trigger on a merged row");
  a.close();
  b.close();
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
