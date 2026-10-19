import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { boot, Copy, person } from "./copy.js";

/**
 * R-U, the engine pin. The conformance baseline of the ordinary data
 * interface is one SQLite build: the sqlite-wasm the container packages,
 * recorded in conformance/changesets/engine.json and docs/format.md ("The
 * engine"). What the session extension captures, and what a trigger, a
 * conflict algorithm or a generated column does, are that build's, so the
 * build that runs is held to the record: a new engine is a deliberate change
 * to the record, never a silent one by a version range.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pinned = JSON.parse(readFileSync(join(repo, "conformance", "changesets", "engine.json"), "utf8"));

test("R-U: the engine that runs is the one the conformance baseline records", async () => {
  const sqlite3 = await boot();
  expect(sqlite3.version.libVersion).toBe(pinned.libVersion);
  expect(sqlite3.version.sourceId).toBe(pinned.sourceId);
  const options: string[] = [];
  for (let i = 0; ; i++) {
    const o = sqlite3.capi.sqlite3_compileoption_get(i);
    if (!o) break;
    options.push(o);
  }
  expect(options, "the compile options").toEqual(pinned.compileOptions);
  expect(options, "the session extension and its hook").toEqual(expect.arrayContaining(["ENABLE_SESSION", "ENABLE_PREUPDATE_HOOK"]));

  const require = createRequire(join(repo, "package.json"));
  const entry = require.resolve("@sqlite.org/sqlite-wasm");
  const wasm = readFileSync(join(dirname(entry), "sqlite3.wasm"));
  expect(createHash("sha256").update(wasm).digest("hex"), "the wasm the container packages").toBe(pinned.wasmSha256);
  const version = pinned.package.split("@").pop();
  expect(JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")).version, "the installed package").toBe(version);
  expect(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).dependencies["@sqlite.org/sqlite-wasm"], "the dependency is exact, not a range").toBe(version);
});

/**
 * Two things docs/format.md says this build's session extension does, run
 * rather than read: it captures a table with STORED and VIRTUAL generated
 * columns between ordinary ones (the base values travel, the generated ones
 * are recomputed where they land), and a WITHOUT ROWID table by its declared
 * key tuple, in the key's order.
 */
test("R-U: this build captures generated columns and WITHOUT ROWID tables", async () => {
  const a = await Copy.open(await person());
  a.db.exec(`CREATE TABLE sized (id INTEGER PRIMARY KEY, w INTEGER NOT NULL, area INTEGER GENERATED ALWAYS AS (w * h) STORED, h INTEGER NOT NULL, half INTEGER GENERATED ALWAYS AS (w / 2) VIRTUAL);
    CREATE TABLE pairs (b TEXT NOT NULL, a TEXT NOT NULL, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;`);
  a.db.exec("INSERT INTO sized (w, h) VALUES (4, 5); INSERT INTO pairs (b, a, v) VALUES ('second', 'first', 'x');");
  const saved = a.save();
  expect(saved?.ops, "both inserts are captured").toBe(2);
  const b = await Copy.open(await person(), await a.bytes());
  expect(b.db.selectObject("SELECT w, h, area, half FROM sized")).toEqual({ w: 4, h: 5, area: 20, half: 2 });
  expect(b.db.selectObject("SELECT a, b, v FROM pairs")).toEqual({ a: "first", b: "second", v: "x" });
  const keys = a.rows.all("SELECT DISTINCT tbl, pk FROM _cs_cell WHERE tbl = 'pairs'");
  expect(keys, "the WITHOUT ROWID row's key is its declared tuple, in key order").toEqual([{ tbl: "pairs", pk: JSON.stringify(["first", "second"]) }]);
  a.close();
  b.close();
});
