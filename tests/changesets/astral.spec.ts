import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../../src/compile.js";
import { rewriteReplicated } from "../../src/replicated.js";

/**
 * D289: a character outside the Basic Multilingual Plane in schema.sql. The
 * schema scanner reads the text by UTF-16 unit, and the copy it searched for
 * keywords was built by code point, so an emoji before a table moved every
 * later index by one and the build refused a valid application. Found by
 * Build 2a's cold run (the chore chart's `DEFAULT '🙂'`).
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SCHEMA = `CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🙂'
);
CREATE TABLE IF NOT EXISTS chores (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  every TEXT NOT NULL DEFAULT 'day' CHECK (every IN ('day', 'week'))
);
`;

test("D289: a two-table schema with an emoji default is read whole: both tables, the bracket where it is", () => {
  const read = rewriteReplicated(SCHEMA);
  expect(read.sql).toContain("DEFAULT '🙂'");
  expect(read.sql).toContain("CHECK (every IN ('day', 'week'))");
});

test("D289: an application whose schema has an emoji default builds", async () => {
  const src = mkdtempSync(join(tmpdir(), "dai-astral-"));
  writeFileSync(join(src, "schema.sql"), SCHEMA);
  writeFileSync(join(src, "index.html"), '<!doctype html><meta charset="utf-8"><title>Chores</title><p>chores</p>');
  const built = await compileDirectory({ sourceDir: src, root: repo, appName: "Chores" });
  expect(built.html.length).toBeGreaterThan(0);
});
