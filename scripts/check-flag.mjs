#!/usr/bin/env node
/**
 * A static scan catches honest mistakes; admission is the enforcement; a table
 * name in a variable is invisible here.
 *
 * No code derives "current" from the stored _r_superseded flag, or reads a raw
 * seat or close table outside the file that defines admission, or reads
 * whether a session is closed from anything but _dai_closed (D140, D146, D150).
 * It is not airtight and is not meant to be: a person set on reading the flag
 * can hide the read from any scanner, and what stops the harm is that
 * admission never reads it.
 *
 * The same family as check-names and check-seats: a scan with named
 * exceptions, each with its reason, where an exception that excuses nothing
 * fails. Each exception names one kind of read on one exact line and excuses
 * that one read. The detector is src/flag-check.ts, which the test uses too.
 *
 *   node scripts/check-flag.mjs            what git tracks under src/, apps/, examples/ and tests/fixture/
 *   node scripts/check-flag.mjs --scan D   only the folder D, with no exceptions (for tests)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild-wasm";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(join(repo, "package.json"))("typescript");

async function load(rel) {
  const source = readFileSync(join(repo, rel), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { flagReadProblems } = await load("src/flag-check.ts");

/** Mentions that decide nothing about "current", each keyed to its kind and its exact line. */
const EXCEPTIONS = {
  'src/replicated-rows.ts: flag: "_r_replica", "_r_seq", "_r_lc", "_r_entity", "_r_parents", "_r_deleted", "_r_superseded", "_r_batch",':
    "the columns a stored row is inserted with: the cache is written here, from the row set, not read",
  'src/replicated-rows.ts: flag: _r_superseded: "derived local supersession flag, recomputed by merge (T1-D11)",':
    "names the one _r_ column that does not travel, so the round-trip test can tell it from a dropped field",
  'src/replicated.ts: flag: (column) => column !== "_r_superseded" && !named.has(column),':
    "the immutability check: the cache is the one column the append-only trigger must let a write change",
  'src/rules.ts: flag: why: "That prefix is replication\'s; the rewrite adds _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_superseded, _r_batch and, in a session document, _r_session.",':
    "prose in a rule's reason, listing the columns replication adds",
  'src/rules.ts: flag: anchor: { file: "src/replicated.ts", contains: "_r_superseded INTEGER NOT NULL DEFAULT 0" },':
    "a rule's anchor, the text it pins in the column's declaration",
  "src/kit.ts: raw-seat-table: 'SELECT DISTINCT lower(hex(v.seat)) AS v FROM _dai_seat v JOIN _dai_creator c ON c.session = v._r_session AND c.replica = v._r_replica ' +":
    "every value the creator ever gave a seat, in its session: history the seat's rows may act for, not its current value",
  'src/runtime/bootloader.ts: raw-seat-table: : "SELECT DISTINCT lower(hex(_r_session)) AS s FROM _dai_close_current",':
    "a document built before _dai_closed existed reads its close table as it always did; a current document takes the view",
  'src/runtime/bootloader.ts: raw-seat-table: : rows.all("SELECT 1 FROM _dai_seat WHERE _r_session = ? AND lower(hex(_r_replica)) = ? LIMIT 1", [session, me]).length > 0;':
    "the creator test for a document built before _dai_creator existed; a current document takes the view",
};

/**
 * Reads of a seat or close table through a table name held in a variable,
 * which no static scan can see. Each is named with its reason, and anchored
 * to its text, so the note fails when the read it describes moves or goes.
 */
const VARIABLE_TABLE_READS = [
  {
    path: "src/replicated-rows.ts",
    contains: "WHERE n._r_entity = r._r_entity AND n._r_session = r._r_session AND n._r_replica = r._r_replica",
    why: "writeTargetOf's roster branch: this copy's own versions of a roster row, in its session, the partition the roster's _heads view uses (D140)",
  },
  {
    path: "src/runtime/bootloader.ts",
    contains: "`SELECT lower(hex(_r_replica)) AS rep, max(_r_seq) AS m FROM \"${table}\" WHERE _r_session = ? GROUP BY _r_replica`",
    why: "close()'s frontier: the highest seq each author wrote in the session, over every session table, the seen set a close records",
  },
];

/** Generated copies and build output, never source: each named, not every folder that shares a name. */
const SKIP = new Set(["apps/runner/public/hosts", "apps/desktop/src-tauri/target", "src/flag-check.ts"]);
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx|html?)$/i;

/** Every script file and html page, never a built document or a bundle. */
function sourcesUnder(dir, base) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const rel = relative(base, path).split("\\").join("/");
      if (name === "node_modules" || name === "dist" || name.startsWith(".") || SKIP.has(rel)) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (SCRIPT.test(name) && !/\.d\.ts$/i.test(name) && !/\.dai\.html?$/i.test(name)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const scanAt = process.argv.indexOf("--scan");
const base = scanAt >= 0 ? resolve(process.argv[scanAt + 1]) : repo;
/** The repository's own files: what git tracks under the roots, as CI sees them, less the named skips. */
function trackedUnder(dirs) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--", ...dirs], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean)
    .filter((rel) => SCRIPT.test(rel) && !/\.d\.ts$/i.test(rel) && !/\.dai\.html?$/i.test(rel))
    .filter((rel) => ![...SKIP].some((skip) => rel === skip || rel.startsWith(`${skip}/`)))
    .filter((rel) => existsSync(join(repo, rel)));
}
const paths =
  scanAt >= 0
    ? sourcesUnder(base, base).map((path) => relative(base, path).split("\\").join("/"))
    : trackedUnder(["src", "apps", "examples", "tests/fixture"]);
const files = paths.map((path) => ({ path, source: readFileSync(join(base, path), "utf8") }));
const exceptions = scanAt >= 0 ? {} : EXCEPTIONS;
const problems = flagReadProblems(ts, files, exceptions);
if (scanAt < 0) {
  for (const note of VARIABLE_TABLE_READS) {
    const file = files.find((f) => f.path === note.path);
    if (!file || !file.source.includes(note.contains)) {
      problems.push(`the variable-table note for ${note.path} no longer matches its read; find it again or remove the note`);
    }
  }
}
if (files.length === 0) problems.push("no source files found to scan; refusing to call that clean");
if (problems.length > 0) {
  for (const problem of problems) console.error(`flag: ${problem}`);
  process.exit(1);
}
console.log(
  `flag: ${files.length} files derive "current" from admission, not the stored flag ` +
    `(${Object.keys(exceptions).length} named exception${scanAt < 0 ? `, ${VARIABLE_TABLE_READS.length} variable-table reads named` : ""})`,
);
