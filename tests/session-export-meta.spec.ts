import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { rewriteReplicated } from "../src/replicated.js";
import { createEntity, ensureReplica, filterToSession, type Rows } from "../src/replicated-rows.js";

/**
 * The filter on a database shaped like one an application has opened.
 *
 * The invite filter's first run in the real host refused: the runtime keeps a
 * `_dai_meta` table in every document it opens (the schema digest the data was
 * made under), and the filter's tests had only ever built databases directly,
 * so they had never met one. It is document-level — it describes the data, not
 * a session — so it travels whole. This pins that, beside the rule it sits in:
 * any other unclassified system table is still refused.
 */
const SCHEMA = "-- dai:profile session max_parties=2\n-- dai:replicated\nCREATE TABLE moves (ply INTEGER NOT NULL);\n";

function opened(): Rows & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(rewriteReplicated(SCHEMA).sql);
  // What the runtime's reconcileSchema writes on every open.
  db.exec("CREATE TABLE IF NOT EXISTS _dai_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("INSERT INTO _dai_meta (key, value) VALUES ('schema', 'digest-of-the-schema')");
  return {
    db,
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
  };
}

const S1 = new Uint8Array(16).fill(0x51);
const S2 = new Uint8Array(16).fill(0x52);

test("an opened document's _dai_meta travels whole in an invite", () => {
  const rows = opened();
  ensureReplica(rows, new Uint8Array(16).fill(0xaa));
  createEntity(rows, "moves", new Uint8Array(16).fill(0x11), { ply: 1 }, S1);
  createEntity(rows, "moves", new Uint8Array(16).fill(0x22), { ply: 1 }, S2);

  filterToSession(rows, S1);

  expect(rows.all("SELECT key, value FROM _dai_meta")).toEqual([{ key: "schema", value: "digest-of-the-schema" }]);
  expect(rows.all("SELECT count(*) AS n FROM moves")).toEqual([{ n: 1 }]);
});

test("any other unclassified system table is still refused, not guessed at", () => {
  const rows = opened();
  rows.db.exec("CREATE TABLE _dai_something_new (x TEXT)");
  expect(() => filterToSession(rows, S1)).toThrow(/fits neither the replicated nor the local path/);
});
