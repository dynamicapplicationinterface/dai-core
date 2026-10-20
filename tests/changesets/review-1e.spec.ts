import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../../src/compile.js";
import { buildContainer } from "../../src/core.js";
import { breaking, lintFiles } from "../../src/lint.js";
import { Copy, openBytes, person } from "./copy.js";
import { base } from "./scenarios.js";

/**
 * The review of Build 1e (`handoff-2026-10-19.md`, "Code review — PR #9,
 * Build 1e"), its mediums and lows that R-W did not close by refusing the
 * application's DDL, each named by its id.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APP = { "index.html": '<!doctype html><title>Plain</title><script type="module" src="app.js"></script>', "app.js": "const db = await window.dai.openDatabase();\n" };

/** What the lint, the compiler and the paste box's build say of a schema. */
async function doors(schema: string): Promise<{ check: string[]; build: string; pasteBox: string }> {
  const files = { ...APP, "schema.sql": schema };
  const thrown = (p: Promise<unknown>): Promise<string> => p.then(() => "built", (e: Error) => String(e?.message ?? e));
  const src = join(mkdtempSync(join(tmpdir(), "dai-cs-1e-")), "src");
  mkdirSync(src, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(src, name), text);
  return {
    check: breaking(lintFiles(files)).map((f) => f.id),
    build: await thrown(compileDirectory({ sourceDir: src, root: repo, appName: "Plain" })),
    pasteBox: await thrown(
      buildContainer({
        files: Object.fromEntries(Object.entries(files).map(([n, t]) => [n, new TextEncoder().encode(t)])),
        appName: "Plain",
        template: readFileSync(join(repo, "dist/template.html"), "utf8"),
        runtime: readFileSync(join(repo, "dist/dai-runtime.js"), "utf8"),
      }),
    ),
  };
}

test("1e-M1/1e-M2: a name that folds to a reserved prefix is refused where the schema is made, at every door", async () => {
  const names = ["ſqlite_notes", "ＳＱＬＩＴＥ_notes", "_ｃｓ_x", "＿cs_x", "_cſ_x", "_DAİ_x", "_Dai_x", "_CS_x"];
  for (const name of names) {
    for (const schema of [
      `CREATE TABLE IF NOT EXISTS "${name}" (id INTEGER PRIMARY KEY, v TEXT);\n`,
      `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, v TEXT);\nCREATE INDEX IF NOT EXISTS "${name}" ON notes (v);\n`,
      `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, v TEXT);\nCREATE VIEW IF NOT EXISTS "${name}" AS SELECT v FROM notes;\n`,
    ]) {
      const said = await doors(schema);
      expect(said.check, `${name}: dai check`).toContain("reserved-name");
      expect(said.build, `${name}: the compiler`).toMatch(/^DAI: .*reserves/);
      expect(said.pasteBox, `${name}: the paste box`).toMatch(/^DAI: .*reserves/);
    }
  }
  // A name that only contains a reserved run, or reads like one only in a comment, is the application's.
  const fine = await doors("-- not CREATE TABLE _cs_x\nCREATE TABLE IF NOT EXISTS my_cs_notes (id INTEGER PRIMARY KEY, v TEXT);\n");
  expect([fine.check, fine.build, fine.pasteBox]).toEqual([[], "built", "built"]);
});

test("1e-M2: at runtime only SQLite's own spelling of sqlite_ is SQLite's; a table a document built elsewhere named ſqlite_notes is captured", async () => {
  const { a, b } = await base();
  const raw = await openBytes(await a.bytes());
  raw.db.exec(`CREATE TABLE "ſqlite_notes" (id INTEGER PRIMARY KEY, v TEXT)`);
  const bytes = raw.sqlite3.capi.sqlite3_js_db_export(raw.db.pointer) as Uint8Array;
  raw.db.close();
  const c = await Copy.open(a.author, bytes);
  expect(c.rows.all("SELECT kind FROM _cs_keys WHERE tbl = 'ſqlite_notes'"), "adopted").toEqual([{ kind: "ranged" }]);
  c.db.exec("INSERT INTO \"ſqlite_notes\" (v) VALUES ('kept')");
  expect(c.save()?.ops, "logged, never dropped as SQLite's").toBe(1);
  for (const x of [a, b, c]) x.close();
});

test("1e-M2: NOCASE folds ASCII only, as SQLite's does: keys that differ past ASCII are two rows on every copy", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE people (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT)"] });
  a.db.exec("INSERT INTO people (email, name) VALUES ('sam', 'A')");
  b.db.exec("INSERT INTO people (email, name) VALUES ('ſam', 'B')");
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  for (const c of [a, b]) {
    expect(c.db.selectValues("SELECT email FROM people ORDER BY email"), "two keys").toEqual(["sam", "ſam"]);
    expect(c.flags()).toEqual([]);
  }
  a.close();
  b.close();
});

test("M15: a value's storage class is kept through the baseline, the alternatives and a reprojection", async () => {
  const { a, b } = await base({ extra: ["CREATE TABLE vals (id INTEGER PRIMARY KEY, v)", "INSERT INTO vals (id, v) VALUES (1, 1.0)"] });
  a.db.exec("UPDATE vals SET v = 2.0 WHERE id = 1");
  b.db.exec("UPDATE vals SET v = 2 WHERE id = 1");
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  const classes = (c: Copy): unknown => c.rows.all("SELECT typeof(val) AS t FROM _cs_cell WHERE tbl = 'vals' AND col = 'v' ORDER BY t").map((r) => r["t"]);
  for (const c of [a, b]) {
    expect(classes(c), "the alternatives, each in its class").toEqual(["integer", "real", "real"]);
    expect(c.flags().map((f: Any) => f.kind)).toEqual(["pending"]);
  }
  const shown = a.db.selectValue("SELECT typeof(v) FROM vals");
  expect(b.db.selectValue("SELECT typeof(v) FROM vals"), "shown in one class on both").toBe(shown);
  // Writing the value shown back changes no byte: an echo, which logs nothing and leaves the class as it was (R-X).
  a.db.exec("UPDATE vals SET v = v WHERE id = 1");
  expect(a.save()).toBeNull();
  await b.mergeFrom(await a.bytes());
  for (const c of [a, b]) {
    expect(c.db.selectValue("SELECT typeof(v) FROM vals"), "the class kept").toBe(shown);
    expect(c.flags().map((f: Any) => f.kind), "still pending").toEqual(["pending"]);
  }
  // A copy made from the log alone.
  const c = await Copy.open(await person(), await b.bytes());
  expect(c.db.selectValue("SELECT typeof(v) FROM vals"), "reprojected, the class kept").toBe(shown);
  for (const x of [a, b, c]) x.close();
});

test("1e-L2: ATTACH '' is refused with every other ATTACH, through exec and prepare; VACUUM still runs", async () => {
  const { a, b } = await base();
  for (const sql of ["ATTACH '' AS t", "ATTACH DATABASE '' AS t", "attach ':memory:' as m"]) {
    expect(() => a.db.exec(sql), `exec: ${sql}`).toThrow(/^CHANGES_REFUSED: Keep data in the document's own database/);
    expect(() => a.db.prepare(sql).step(), `prepare: ${sql}`).toThrow(/^CHANGES_REFUSED: Keep data in the document's own database/);
  }
  expect(a.db.selectValues("SELECT name FROM pragma_database_list ORDER BY name")).toEqual(["main", "temp"]);
  a.db.exec("VACUUM");
  a.db.exec("UPDATE items SET qty = 3 WHERE title = 'Map'");
  expect(a.save()?.ops).toBe(1);
  a.close();
  b.close();
});
