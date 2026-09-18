/**
 * The owned message names are consistent (D68, D69, D70).
 *
 * `src/bridge.ts` owns the host bridge's names and `src/frame.ts` the frame's.
 * Each value must be what its key says (`DAI_HOST_` + key, or `dai:` + key in
 * kebab case) and no value may appear twice. This check once ran as
 * `src/bridge.ts` loaded, inside every document's runtime, where it could never
 * fire. It runs here, in the typecheck chain, where the names can still change.
 * The logic is `src/names-check.ts`, the same module the tests use.
 *
 * Those modules import nothing, so each is transpiled on its own with the
 * TypeScript compiler and loaded from a temporary folder: no build step, any
 * Node.
 *
 * Run: node scripts/check-names.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(join(repo, "package.json"))("typescript");
const out = mkdtempSync(join(tmpdir(), "dai-check-names-"));

async function load(rel) {
  const source = readFileSync(join(repo, rel), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = join(out, rel.replace(/[\\/]/g, "_").replace(/\.ts$/, ".mjs"));
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

const { nameProblems, bridgeValue, frameValue } = await load("src/names-check.ts");
const bridge = await load("src/bridge.ts");
const frame = await load("src/frame.ts");

/** The one value that may differ from its rule, and why. Named, and checked to still be needed. */
const BRIDGE_EXCEPTIONS = {
  "TO_HOST.ISOLATION_REPORT":
    "posted by the isolation probe's own application code, which travels in documents; the value is wire format",
};

const owners = [
  { name: "src/bridge.ts", sets: { TO_HOST: bridge.TO_HOST, TO_DOCUMENT: bridge.TO_DOCUMENT }, rule: bridgeValue, exceptions: BRIDGE_EXCEPTIONS },
  { name: "src/frame.ts", sets: { FRAME_PUBLIC: frame.FRAME_PUBLIC, FRAME_INTERNAL: frame.FRAME_INTERNAL }, rule: frameValue, exceptions: {} },
];

let failed = false;
for (const o of owners) {
  const count = Object.values(o.sets).reduce((n, s) => n + Object.keys(s ?? {}).length, 0);
  if (count === 0) {
    console.error(`names: ${o.name} gave no names to check; refusing to call that consistent.`);
    failed = true;
    continue;
  }
  const problems = nameProblems(o.sets, o.rule, o.exceptions);
  if (problems.length) {
    failed = true;
    for (const p of problems) console.error(`names: ${o.name}: ${p}`);
  } else {
    console.log(`names: ${o.name}: ${count} names checked, consistent (${Object.keys(o.exceptions).length} named exception)`);
  }
}
process.exit(failed ? 1 : 0);
