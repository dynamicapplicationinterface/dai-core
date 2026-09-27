import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import ts from "typescript";
import { flagReadProblems } from "../src/flag-check.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * "Current" is derived from admission, never from the stored _r_superseded
 * flag (D140); outside src/replicated.ts no code reads a raw seat or close
 * table, and whether a session is closed is _dai_closed (D146). The check
 * reads tokens, not lines (D150). scripts/check-flag.mjs holds the tree to
 * it; these hold the check itself, seen to fire as well as to stay quiet, and
 * its one stated limit.
 */
function checkFlag(dir: string) {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "check-flag.mjs"), "--scan", dir], { cwd: repo, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

/** One file in a fresh folder, beside a clean one so "no files" never decides the status. */
function scanOne(name: string, source: string) {
  const dir = mkdtempSync(join(tmpdir(), "dai-flag-"));
  const at = join(dir, name);
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, source, "utf8");
  writeFileSync(join(dir, "filler.ts"), "export const x = 1;\n", "utf8");
  return checkFlag(dir);
}

const READ = "db.all(`SELECT * FROM moves WHERE _r_superseded = 0`);\n";

test("check-flag fails the plain read of the flag, and of a raw seat or close table, naming each line", () => {
  const source = [
    "const heads = `SELECT * FROM ${q} WHERE _r_superseded = 0`;",
    "db.all(\"SELECT 1 FROM _dai_binding b WHERE b.seat = ?\");",
    "// a comment naming _r_superseded is prose",
    "db.run(\"SELECT 1 FROM _dai_close_current WHERE _r_session = ?\");",
    "",
  ].join("\n");
  const { status, output } = scanOne("reads.ts", source);
  expect(status, output).toBe(1);
  expect(output).toContain("reads.ts:1 reads the stored _r_superseded flag");
  expect(output).toContain("reads.ts:2 reads a raw seat or close table");
  expect(output, "a comment is not a read").not.toContain("reads.ts:3");
  expect(output, "closedness is _dai_closed").toContain("reads.ts:4 reads a raw seat or close table");
});

test("check-flag passes the cache's own upkeep and reads through the admission views", () => {
  const source = [
    "db.run(`UPDATE t SET _r_superseded = 1 WHERE _r_seq = ?`);",
    "const col = \"  _r_superseded INTEGER NOT NULL DEFAULT 0 CHECK (_r_superseded IN (0,1)),\";",
    "const trig = `CREATE TRIGGER t__m BEFORE UPDATE OF _r_superseded ON t\n  WHEN OLD._r_superseded = 1 AND NEW._r_superseded = 0\n  BEGIN SELECT 1; END;`;",
    "db.all(\"SELECT 1 FROM _dai_binding_current b JOIN _dai_open_seat s ON s.seat = b.seat\");",
    "db.all(\"SELECT 1 FROM _dai_closed WHERE session = ?\");",
    "",
  ].join("\n");
  const { status, output } = scanOne("upkeep.ts", source);
  expect(status, output).toBe(0);
});

/** Constructions of a real read that the line scanner missed (the fifth cold review); each is caught now. */
const MISSED: Record<string, { name: string; source: string }> = {
  "the column in upper case (SQLite identifiers ignore case)": { name: "a.ts", source: "db.all(`SELECT * FROM moves WHERE _R_SUPERSEDED = 0`);\n" },
  "a SQL line that begins with *": { name: "a.ts", source: "db.all(`SELECT\n  * FROM moves WHERE _r_superseded = 0`);\n" },
  "a JS line that begins with --": { name: "a.ts", source: "let n = 1;\n--n, rows.filter((r) => !r._r_superseded);\n" },
  "a line that opens with a block comment": { name: "a.ts", source: "/* heads */ const heads = db.all(`SELECT * FROM moves WHERE _r_superseded = 0`);\n" },
  "the name built by concatenation": { name: "a.ts", source: "const f = \"_r_\" + \"superseded\";\ndb.all(`SELECT * FROM moves WHERE ${f} = 0`);\n" },
  "a table aliased OLD": { name: "a.ts", source: "db.all(`SELECT OLD.san FROM moves AS OLD WHERE OLD._r_superseded = 0`);\n" },
  "a raw seat table with a schema prefix": { name: "a.ts", source: "db.all(`SELECT seat FROM main._dai_binding WHERE _r_replica = ?`);\n" },
  "a raw seat table in a comma join": { name: "a.ts", source: "db.all(`SELECT b.seat FROM _dai_open_seat s, _dai_binding b WHERE b.seat = s.seat`);\n" },
  "a raw seat table on the line after FROM": { name: "a.ts", source: "db.all(`SELECT seat FROM\n  _dai_binding WHERE _r_replica = ?`);\n" },
  "a .tsx file": { name: "a.tsx", source: READ },
  "a .cjs file": { name: "a.cjs", source: READ },
  "an .html file's inline script": { name: "index.html", source: `<script>${READ}</script>\n` },
  "a file under a folder named public": { name: "public/app.js", source: READ },
};

for (const [what, { name, source }] of Object.entries(MISSED)) {
  test(`check-flag sees ${what}`, () => {
    const { status, output } = scanOne(name, source);
    expect(status, `the check should fail this read; it said: ${output.trim()}`).toBe(1);
  });
}

test("the reads it now sees are real: SQLite takes the upper-case name and the OLD alias", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE moves (san TEXT, _r_superseded INTEGER NOT NULL DEFAULT 0); INSERT INTO moves VALUES ('e4', 1), ('e5', 0);");
  expect(db.prepare("SELECT san FROM moves WHERE _R_SUPERSEDED = 0").all()).toEqual([{ san: "e5" }]);
  expect(db.prepare("SELECT OLD.san FROM moves AS OLD WHERE OLD._r_superseded = 0").all()).toEqual([{ san: "e5" }]);
  db.close();
});

test("its limit, stated at its top: a table name in a variable is invisible here", () => {
  const { status } = scanOne("a.ts", "const t = \"_dai_binding\";\ndb.all(`SELECT seat FROM ${t}`);\n");
  expect(status, "no static scan sees the table behind a variable").toBe(0);
  const script = readFileSync(join(repo, "scripts", "check-flag.mjs"), "utf8");
  expect(script).toContain("A static scan catches honest mistakes; admission is the enforcement; a table\n * name in a variable is invisible here.");
});

test("only the file that defines admission may read the raw seat tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "dai-flag-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "replicated.ts"), "const v = `SELECT 1 FROM _dai_seat s`;\n", "utf8");
  expect(checkFlag(dir).status).toBe(0);
  writeFileSync(join(dir, "src", "replicated.ts"), "const v = `SELECT 1 FROM _dai_seat s WHERE _r_superseded = 0`;\n", "utf8");
  expect(checkFlag(dir).output, "but not the flag").toContain("reads the stored _r_superseded flag");
});

test("an exception excuses one read of its kind on its exact line, and fails once it excuses nothing", () => {
  const line = 'db.all("SELECT 1 FROM _dai_seat");';
  const files = [{ path: "src/a.ts", source: `${line}\n` }];
  const key = `src/a.ts: raw-seat-table: ${line}`;
  expect(flagReadProblems(ts, files, { [key]: "a list of sessions" })).toEqual([]);
  // Of another kind on the same line: the flag read added to an excused line is still reported.
  const both = [{ path: "src/a.ts", source: 'db.all("SELECT 1 FROM _dai_seat WHERE _r_superseded = 0");\n' }];
  expect(flagReadProblems(ts, both, { [`src/a.ts: raw-seat-table: ${both[0]!.source.trim()}`]: "why" })).toEqual([
    `src/a.ts:1 reads the stored _r_superseded flag; derive "current" from the admission views: ${both[0]!.source.trim()}`,
  ]);
  // A second read in the same file, even one that ends the same way, is not excused by the first's key.
  const two = [{ path: "src/a.ts", source: `${line}\nconst other = rows.all("SELECT _r_replica FROM _dai_seat");\n` }];
  expect(flagReadProblems(ts, two, { [key]: "a list of sessions" })).toHaveLength(1);
  // A key that excuses nothing is itself the problem.
  expect(flagReadProblems(ts, files, { [key]: "a list of sessions", "src/a.ts: flag: nothing": "none" })).toEqual([
    'the exception "src/a.ts: flag: nothing" excuses nothing; remove it',
  ]);
});

test("the repository's own source passes, with every exception still earning its place", () => {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "check-flag.mjs")], { cwd: repo, encoding: "utf8" });
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
});
