/**
 * A building block nobody calls is not done (backlog D9).
 *
 *     node scripts/check-callers.mjs
 *
 * Three times in one pass a block was written, reviewed and tested and then
 * shipped with nothing on the real path calling it: `filterToSession` and
 * `exportSession` (the per-session invite), and `deriveSessionMailbox` (the
 * per-session mailbox). Each gap was invisible for the same reason — the tests
 * exercised the block, and the tests were its only caller.
 *
 * So: every exported function and class in `src/` must be used by something
 * that is not its own file and not a test — another part of the library, the
 * opener, the relay, the desktop host, a build script, the website, an example.
 * Constants, types and error classes are left out (see `exportedBlocks`).
 *
 * What the package publishes is exempt, because its callers are outside this
 * repository. That is read from the package itself rather than listed here, so
 * it cannot drift: every module `package.json` exports (or runs as a `bin`), and
 * every name `src/index.ts` re-exports.
 *
 * The search is textual — a word-boundary match with comments removed — which
 * is what makes it cheap and is also its limit: a name that appears in another
 * file for an unrelated reason counts as a caller. It errs toward passing, so a
 * failure here is always worth reading.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (path) => relative(repo, path).split(sep).join("/");

/**
 * Exports that are allowed to have no caller in this repository, each with the
 * reason. Keep it short: an entry here is a claim that something outside the
 * repository calls it, or that it is on its way to a caller named in the reason.
 */
const ALLOWED = [
  {
    file: "src/mailbox-fs.ts",
    name: "fsMailbox",
    why: "the file-backed relay the end-to-end tests stand up, and the reference adapter for a self-hosted relay; its callers are tests by design",
  },
  {
    file: "src/host-profile.ts",
    name: "verifyClaim",
    why: "the judge of the isolation conformance run: host-profile.spec mounts the probe in the real runner and holds the runner's own handshake claim against what the probe found; its caller is that run, by design",
  },
];

const SKIP_DIRS = new Set(["node_modules", "dist", "hosts", "test-results", "target", ".git", "generated"]);

/**
 * Staged bundles are compiled copies of `src/` (the website's and the opener's
 * `public/runtime/`): every name in them would look called. Skipped, with the
 * build output, so a caller is always hand-written source.
 */
const SKIP_PATHS = [`${sep}public${sep}runtime`, `${sep}.vercel`];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (SKIP_PATHS.some((skip) => path.includes(skip))) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    // Vue components and VitePress pages import code too: the website's build
    // and walkthrough pages are the callers of the in-browser helpers. Leaving
    // them out reported two live exports as uncalled.
    else if (/\.(ts|tsx|mts|js|mjs|cjs|html|vue|md)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Comments out, so a name mentioned in prose is not a caller. Strings are left alone. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/**
 * The building blocks a module exports: functions, and classes that are not
 * errors. Not constants, types or error classes — exporting a byte size or an
 * error so a test can check against it ships no unfinished behavior, and a check
 * that reports them is a check somebody turns off (see check-symbols.mjs).
 */
function exportedBlocks(text) {
  const names = new Set();
  for (const match of text.matchAll(/^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  // `export const name = (…) =>`, `= async (…) =>`, `= x =>`, `= function`.
  for (const match of text.matchAll(
    /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/gm,
  )) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(\s+extends\s+([A-Za-z_$][\w$]*))?/gm)) {
    if (match[3] && /Error$/.test(match[3])) continue;
    names.add(match[1]);
  }
  names.delete("default");
  return names;
}

/** Modules the package publishes: its `exports` map and its `bin`, mapped back from dist to src. */
function publishedModules() {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const targets = [];
  const collect = (value) => {
    if (typeof value === "string") targets.push(value);
    else if (value && typeof value === "object") for (const inner of Object.values(value)) collect(inner);
  };
  collect(pkg.exports);
  collect(pkg.bin);
  const modules = new Set();
  for (const target of targets) {
    const match = /dist\/(.+?)\.(?:c?js|d\.ts)$/.exec(target);
    if (!match) continue;
    const source = join(repo, "src", `${match[1]}.ts`);
    if (existsSync(source)) modules.add(rel(source));
  }
  return modules;
}

/** Names `src/index.ts` re-exports: the package's front door. */
function reexportedFromIndex() {
  const text = readFileSync(join(repo, "src", "index.ts"), "utf8");
  const names = new Set();
  for (const match of text.matchAll(/export\s+\{([^}]*)\}\s+from\s+["'][^"']+["']/g)) {
    for (const part of match[1].split(",")) {
      const item = part.trim();
      if (!item || item.startsWith("type ")) continue;
      const [name, as] = item.split(/\s+as\s+/);
      names.add(name.trim());
      if (as) names.add(as.trim());
    }
  }
  return names;
}

const published = publishedModules();
const front = reexportedFromIndex();

const sources = walk(join(repo, "src")).filter((path) => path.endsWith(".ts"));
// Where a caller may live. Not `tests/`: a block whose only caller is its test
// is exactly what this exists to catch.
const callerFiles = [
  ...sources,
  // The hosts, the relay, the website and its edge functions, the build
  // scripts, the examples — everything a person's action can reach. Not this
  // script: its allow-list names every export on it, and would count as their
  // caller.
  ...["apps", "website", "scripts", "examples"]
    .flatMap((dir) => walk(join(repo, dir)))
    .filter((path) => path !== fileURLToPath(import.meta.url)),
];
const bodies = new Map(callerFiles.map((path) => [path, withoutComments(readFileSync(path, "utf8"))]));

const uncalled = [];
const allowedUsed = new Set();
for (const path of sources) {
  const file = rel(path);
  if (published.has(file)) continue;
  for (const name of exportedBlocks(readFileSync(path, "utf8"))) {
    if (front.has(name)) continue;
    const escaped = name.replace(/\$/g, "\\$");
    const word = new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`);
    const called = callerFiles.some((other) => other !== path && word.test(bodies.get(other)));
    if (called) continue;
    // Used by its own module beyond its definition: it is on the path whenever
    // that module is — exported so a test can reach one step of it, which is
    // ordinary. A module nothing calls still shows up, through its entry point.
    const own = withoutComments(readFileSync(path, "utf8")).match(new RegExp(`(^|[^\\w$])${escaped}(?=[^\\w$]|$)`, "g"));
    if (own && own.length > 1) continue;
    const allowed = ALLOWED.find((entry) => entry.file === file && entry.name === name);
    if (allowed) {
      allowedUsed.add(allowed);
      continue;
    }
    uncalled.push(`${file}: ${name}`);
  }
}

const stale = ALLOWED.filter((entry) => !allowedUsed.has(entry));

if (uncalled.length > 0 || stale.length > 0) {
  if (uncalled.length > 0) {
    console.error("Exported from src/, and called by nothing but its own file and the tests:\n");
    for (const line of uncalled) console.error(`  ${line}`);
    console.error(
      "\nEither wire it to the path a person takes (and test through that path), " +
        "stop exporting it, or add it to ALLOWED in scripts/check-callers.mjs with the reason it has no caller here.",
    );
  }
  if (stale.length > 0) {
    console.error("\nOn the allow-list but called now — take them off:\n");
    for (const entry of stale) console.error(`  ${entry.file}: ${entry.name}`);
  }
  process.exit(1);
}

console.log(`callers: every export of src/ outside the published API has a caller (${published.size} published modules exempt)`);
