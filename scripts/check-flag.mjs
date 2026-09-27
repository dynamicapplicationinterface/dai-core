#!/usr/bin/env node
/**
 * No code derives "current" from the stored _r_superseded flag, or from a raw
 * seat or close table outside the file that defines admission (D140).
 *
 * The same family as check-names and check-seats: a scan of source with named
 * exceptions, each with its reason, where an exception that excuses nothing
 * fails. The detector is src/flag-check.ts, which the test uses too.
 *
 *   node scripts/check-flag.mjs            src/ and the applications' own source under apps/
 *   node scripts/check-flag.mjs --scan D   only the folder D, with no exceptions (for tests)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild-wasm";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function load(rel) {
  const source = readFileSync(join(repo, rel), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { flagReadProblems } = await load("src/flag-check.ts");

/** Mentions that read nothing to decide "current". Each names the text on its line. */
const EXCEPTIONS = {
  "src/replicated-rows.ts: \"_r_deleted\", \"_r_superseded\", \"_r_batch\"":
    "the columns a stored row is inserted with: the cache is written here, from the row set, not read",
  "src/replicated-rows.ts: _r_superseded: \"derived local supersession flag":
    "names the one _r_ column that does not travel, so the round-trip test can tell it from a dropped field",
  "src/replicated.ts: column !== \"_r_superseded\"":
    "the immutability check: the cache is the one column the append-only trigger must let a write change",
  "src/rules.ts: _r_superseded, _r_batch and, in a session document, _r_session":
    "prose in a rule's reason, listing the columns replication adds",
  "src/rules.ts: contains: \"_r_superseded INTEGER NOT NULL DEFAULT 0\"":
    "a rule's anchor, the text it pins in the column's declaration",
  "src/kit.ts: FROM _dai_seat v JOIN _dai_creator":
    "every value the creator ever gave a seat, in its session: history the seat's rows may act for, not its current value",
  "src/runtime/bootloader.ts: \"SELECT DISTINCT lower(hex(_r_session)) AS s FROM _dai_close_current\",":
    "a document built before _dai_closed existed reads its close table as it always did; a current document takes the view",
  "src/runtime/bootloader.ts: FROM _dai_seat WHERE _r_session = ?":
    "the creator test for a document built before _dai_creator existed; a current document takes the view",
};

/** Source: .ts, .js and .mjs, never a built bundle or a copied host shell. */
function sourcesUnder(dir) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      if (name === "node_modules" || name === "dist" || name === "public" || name === "src-tauri" || name.startsWith(".")) continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:m?js|ts)$/i.test(name) && !/\.d\.ts$/i.test(name)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const scanAt = process.argv.indexOf("--scan");
const roots = scanAt >= 0 ? [resolve(process.argv[scanAt + 1])] : [join(repo, "src"), join(repo, "apps")];
// The detector spells the patterns it looks for, so it is the one file never scanned.
const files = roots
  .flatMap(sourcesUnder)
  .map((path) => ({ path: relative(scanAt >= 0 ? roots[0] : repo, path).split("\\").join("/"), source: readFileSync(path, "utf8") }))
  .filter((file) => scanAt >= 0 || file.path !== "src/flag-check.ts");
const exceptions = scanAt >= 0 ? {} : EXCEPTIONS;
const problems = flagReadProblems(files, exceptions);
if (files.length === 0) problems.push("no source files found to scan; refusing to call that clean");
if (problems.length > 0) {
  for (const problem of problems) console.error(`flag: ${problem}`);
  process.exit(1);
}
console.log(`flag: ${files.length} files derive "current" from admission, not the stored flag (${Object.keys(exceptions).length} named exception)`);
