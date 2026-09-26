import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { flagReadProblems } from "../src/flag-check.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * "Current" is derived from admission, never from the stored _r_superseded
 * flag (D140), and outside src/replicated.ts no code reads a raw seat or close
 * table. scripts/check-flag.mjs holds the tree to it; these hold the check
 * itself, seen to fire as well as to stay quiet.
 */
function checkFlag(dir: string) {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "check-flag.mjs"), "--scan", dir], { cwd: repo, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

const READS = [
  "const heads = `SELECT * FROM ${q} WHERE _r_superseded = 0`;",
  "db.all(\"SELECT 1 FROM _dai_binding b WHERE b.seat = ?\");",
  "// a comment naming _r_superseded is prose",
  "db.run(\"SELECT * FROM notes JOIN _dai_close x ON 1\");",
  "",
].join("\n");

const UPKEEP = [
  "db.run(`UPDATE t SET _r_superseded = 1 WHERE _r_seq = ?`);",
  "const col = \"  _r_superseded INTEGER NOT NULL DEFAULT 0 CHECK (_r_superseded IN (0,1)),\";",
  "const trig = `BEFORE UPDATE OF _r_superseded ON t WHEN OLD._r_superseded = 1 AND NEW._r_superseded = 0`;",
  "db.all(\"SELECT 1 FROM _dai_binding_current b JOIN _dai_open_seat s ON s.seat = b.seat\");",
  "",
].join("\n");

test("check-flag fails on a read of the flag or of a raw seat table, and names each line", () => {
  const dir = mkdtempSync(join(tmpdir(), "dai-flag-"));
  writeFileSync(join(dir, "reads.ts"), READS, "utf8");
  const { status, output } = checkFlag(dir);
  expect(status, output).toBe(1);
  expect(output).toContain("reads.ts:1 reads the stored _r_superseded flag");
  expect(output).toContain("reads.ts:2 reads a raw seat or close table");
  expect(output, "a comment is not a read").not.toContain("reads.ts:3");
  expect(output).toContain("reads.ts:4 reads a raw seat or close table");
});

test("check-flag passes the cache's own upkeep and reads through the admission views", () => {
  const dir = mkdtempSync(join(tmpdir(), "dai-flag-"));
  writeFileSync(join(dir, "upkeep.ts"), UPKEEP, "utf8");
  const { status, output } = checkFlag(dir);
  expect(status, output).toBe(0);
});

test("only the file that defines admission may read the raw seat tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "dai-flag-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "replicated.ts"), "const v = `SELECT 1 FROM _dai_seat s`;\n", "utf8");
  expect(checkFlag(dir).status).toBe(0);
  writeFileSync(join(dir, "src", "replicated.ts"), "const v = `SELECT 1 FROM _dai_seat s WHERE _r_superseded = 0`;\n", "utf8");
  expect(checkFlag(dir).output, "but not the flag").toContain("reads the stored _r_superseded flag");
});

test("an exception excuses only its own line, and fails once it excuses nothing", () => {
  const files = [{ path: "src/a.ts", source: "db.all(\"SELECT 1 FROM _dai_seat\");\n" }];
  expect(flagReadProblems(files, { "src/a.ts: FROM _dai_seat": "a list of sessions" })).toEqual([]);
  expect(flagReadProblems(files, { "src/a.ts: FROM _dai_seat": "a list of sessions", "src/a.ts: FROM _dai_confirm": "none" })).toEqual([
    'the exception "src/a.ts: FROM _dai_confirm" excuses nothing; remove it',
  ]);
});

test("the repository's own source passes, with every exception still earning its place", () => {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "check-flag.mjs")], { cwd: repo, encoding: "utf8" });
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
});
