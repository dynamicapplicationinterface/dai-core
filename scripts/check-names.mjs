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
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

const { nameProblems, bridgeValue, frameValue, literalProblems } = await load("src/names-check.ts");
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

/*
 * No message name spelled by hand outside its owner (docs/identity.md, rule 8).
 *
 * The tree by default; `--scan <dir>` points it at one folder instead, which is
 * how the test holds the check itself rather than the tree's state on the day.
 */

/** Literals that must stay as literals, and why. Checked to still be needed. */
const worker = await load("src/worker.ts");
const LITERAL_EXCEPTIONS = {
  "src/kit.ts: dai:used":
    "the kit's source travels inside documents and runs there, where src/frame.ts cannot be imported; the value is wire format",
  // The service worker is a classic script and cannot import src/worker.ts, so
  // it spells the owner's values; exactly those, and tests/worker-names.spec.ts
  // holds the two lists to each other in both directions.
  ...Object.fromEntries(
    Object.values(worker.WORKER).map((value) => [
      `apps/runner/public/sw.js: ${value}`,
      "a classic worker cannot import src/worker.ts; it spells the owner's value",
    ]),
  ),
};
const OWNERS = new Set(["src/bridge.ts", "src/frame.ts"]);

function sourcesUnder(root, dir) {
  const found = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") found.push(...sourcesUnder(root, rel));
    } else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !OWNERS.has(rel)) {
      found.push({ path: rel, text: readFileSync(join(root, rel), "utf8") });
    }
  }
  return found;
}

const at = process.argv.indexOf("--scan");
const scanned =
  at > 0
    ? { files: sourcesUnder(resolve(process.argv[at + 1]), ""), exceptions: {}, what: process.argv[at + 1] }
    : {
        files: [
          ...["src", "apps/runner/src", "apps/desktop/src"].flatMap((dir) => sourcesUnder(repo, dir)),
          { path: "apps/runner/public/sw.js", text: readFileSync(join(repo, "apps/runner/public/sw.js"), "utf8") },
        ],
        exceptions: LITERAL_EXCEPTIONS,
        what: "src, apps and the service worker",
      };
const literals = literalProblems(scanned.files, scanned.exceptions);
if (literals.length) {
  failed = true;
  for (const p of literals) console.error(`names: ${p}`);
} else {
  console.log(
    `names: ${scanned.files.length} files in ${scanned.what} spell no message name by hand (${Object.keys(scanned.exceptions).length} named exception)`,
  );
}
process.exit(failed ? 1 : 0);
