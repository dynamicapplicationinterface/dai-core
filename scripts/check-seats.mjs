#!/usr/bin/env node
/**
 * This repository's applications write no seat table around the kit
 * (docs/identity.md, step 5; IDENTITY-KIT-SEATS in src/rules.ts).
 *
 * The same family as check-names: a scan of source with named exceptions, each
 * with its reason, where an exception that excuses nothing fails. The
 * detector is src/seat-check.ts, which the authoring lint uses too.
 *
 *   node scripts/check-seats.mjs            the applications under examples/ and tests/fixture/
 *   node scripts/check-seats.mjs --scan D   only the folder D, with no exceptions (for tests)
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
const { seatWriteProblems } = await load("src/seat-check.ts");

/**
 * Applications that predate the kit's seats. Both are rebuilt on the kit at
 * step 7 of the identity sitting (docs/identity.md, "Migration"), which removes
 * these lines; an entry that no longer excuses anything fails the check.
 */
const EXCEPTIONS = {
  "examples/request/app.js: create": "rebuilt on the kit's seats at identity step 7",
  "examples/request/app.js: join": "rebuilt on the kit's seats at identity step 7",
  "examples/request/app.js: reseat": "rebuilt on the kit's seats at identity step 7",
  "examples/tic-tac-toe/app.js: create": "rebuilt on the kit's seats at identity step 7",
  "examples/tic-tac-toe/app.js: join": "rebuilt on the kit's seats at identity step 7",
  "examples/tic-tac-toe/app.js: reseat": "rebuilt on the kit's seats at identity step 7",
};

/** Application source: .js, .mjs, .ts and .html, never a built document or a bundle. */
function sourcesUnder(dir) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:m?js|ts|html?)$/i.test(name) && !/\.dai\.html?$/i.test(name)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const scanAt = process.argv.indexOf("--scan");
const roots = scanAt >= 0 ? [resolve(process.argv[scanAt + 1])] : [join(repo, "examples"), join(repo, "tests", "fixture")];
const files = roots.flatMap(sourcesUnder).map((path) => ({
  path: relative(scanAt >= 0 ? roots[0] : repo, path).split("\\").join("/"),
  source: readFileSync(path, "utf8"),
}));
const problems = seatWriteProblems(files, scanAt >= 0 ? {} : EXCEPTIONS);
if (problems.length > 0) {
  for (const problem of problems) console.error(`seats: ${problem}`);
  process.exit(1);
}
console.log(`seats: ${files.length} application files write no seat table around the kit (${Object.keys(scanAt >= 0 ? {} : EXCEPTIONS).length} named exception)`);
