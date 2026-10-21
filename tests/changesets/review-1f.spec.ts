import { expect, test } from "@playwright/test";
import { base } from "./scenarios.js";

/**
 * The review of Build 1f (`handoff-2026-10-19.md`, "Code review — PR #9,
 * Build 1f"): its mediums and lows, each red first.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const SCHEMA_SENTENCE = /^CHANGES_REFUSED: This change needs a new version of the app; the current version was left unchanged\./;
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);
const databases = (db: Any): string[] => db.selectValues("SELECT name FROM pragma_database_list ORDER BY name");

test("1f-M1: SQL handed over as anything but a string is refused with R-W's sentence before anything runs", async () => {
  const { a, b } = await base();
  const forms: [string, (s: string) => unknown][] = [
    ["Int8Array", (s) => new Int8Array(bytesOf(s))],
    ["Uint8Array", (s) => bytesOf(s)],
    ["ArrayBuffer", (s) => bytesOf(s).buffer],
    ["array", (s) => [s]],
    ["{sql: bytes}", (s) => ({ sql: new Int8Array(bytesOf(s)) })],
  ];
  for (const [form, as] of forms) {
    expect(() => a.db.exec(as("ATTACH '' AS t")), `exec, ${form}`).toThrow(SCHEMA_SENTENCE);
    expect(() => a.db.prepare(as("ATTACH '' AS t")), `prepare, ${form}`).toThrow(SCHEMA_SENTENCE);
    expect(() => a.db.exec(as("UPDATE items SET qty = 5 WHERE title = 'Map'")), `a write too, ${form}`).toThrow(SCHEMA_SENTENCE);
  }
  expect(databases(a.db), "nothing attached").toEqual(["main", "temp"]);
  expect(() => a.db.exec(new Int8Array(bytesOf("CREATE TABLE t.x (y)")))).toThrow(SCHEMA_SENTENCE);
  expect(a.db.selectValue("SELECT qty FROM items WHERE title = 'Map'"), "nothing ran").toBe(1);
  expect(a.changes.dirty).toBe(false);
  a.close();
  b.close();
});

test("1f-M1: ATTACH is refused in the authorizer for every argument, past the handle's own reading", async () => {
  const { a, b } = await base();
  const raw = Object.getPrototypeOf(a.db).exec;
  for (const sql of ["ATTACH ':memory:' || '' AS m", "ATTACH '' AS e", "ATTACH (SELECT '') AS s", "ATTACH 'x.db' AS x"]) {
    expect(() => raw.call(a.db, sql), sql).toThrow(/not authorized/);
    expect(databases(a.db), sql).toEqual(["main", "temp"]);
  }
  // The handle's own route reads the same refusal as its sentence.
  expect(() => a.db.exec("ATTACH ':memory:' || '' AS m")).toThrow(/^CHANGES_REFUSED: Keep data in the document's own database/);
  // VACUUM, which attaches a database of its own as it runs, still runs, by exec and by a prepared statement.
  a.db.exec("VACUUM");
  const s = a.db.prepare("VACUUM");
  s.step();
  s.finalize();
  expect(databases(a.db)).toEqual(["main", "temp"]);
  a.db.exec("UPDATE items SET qty = 3 WHERE title = 'Map'");
  expect(a.save()?.ops).toBe(1);
  a.close();
  b.close();
});

test("1f-M3: a save that removes a kept row's last reference decides the row again; both copies converge on Food gone", async () => {
  const { a, b } = await base();
  a.db.exec("INSERT INTO items (category_id, title) SELECT id, 'Jam' FROM categories WHERE name = 'Food'");
  b.db.exec("UPDATE items SET category_id = NULL WHERE title = 'Bread'");
  b.db.exec("DELETE FROM categories WHERE name = 'Food'");
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  for (const c of [a, b]) {
    expect(c.db.selectValues("SELECT name FROM categories ORDER BY name"), "Food kept: Jam refers to it").toEqual(["Food", "Gear"]);
    expect(c.flags().filter((f: Any) => f.tbl === "categories").map((f: Any) => f.kind)).toEqual(["kept-referenced"]);
  }
  // B moves Jam out of Food: nothing refers to Food now, and B's own delete stands.
  b.db.exec("UPDATE items SET category_id = (SELECT id FROM categories WHERE name = 'Gear') WHERE title = 'Jam'");
  b.save();
  expect(b.db.selectValues("SELECT name FROM categories ORDER BY name"), "decided again at B's save").toEqual(["Gear"]);
  await a.mergeFrom(await b.bytes());
  for (const c of [a, b]) {
    expect(c.db.selectValues("SELECT name FROM categories ORDER BY name")).toEqual(["Gear"]);
    expect(c.flags().filter((f: Any) => f.tbl === "categories")).toEqual([]);
    expect(c.db.selectValues("SELECT * FROM pragma_foreign_key_check")).toEqual([]);
  }
  expect(a.state(), "converged").toBe(b.state());
  a.close();
  b.close();
});

test("1f-L2: a mismatched CREATE ... IF NOT EXISTS handed over as bytes is refused, not answered by SQLite's no-op", async () => {
  const { a, b } = await base({ extra: ["CREATE INDEX items_by_title ON items (title)"] });
  const before = a.db.selectValue("SELECT sql FROM sqlite_schema WHERE name = 'items_by_title'");
  expect(() => a.db.exec(new Int8Array(bytesOf("CREATE INDEX IF NOT EXISTS items_by_title ON items (note)")))).toThrow(SCHEMA_SENTENCE);
  expect(a.db.selectValue("SELECT sql FROM sqlite_schema WHERE name = 'items_by_title'")).toBe(before);
  a.close();
  b.close();
});
