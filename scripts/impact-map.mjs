/**
 * Which specs a change can affect, worked out from the specs themselves.
 *
 *     node scripts/impact-map.mjs --write   # regenerate tests/impact-map.json
 *     node scripts/impact-map.mjs --check   # fail if it is stale, or a source file has no spec
 *
 * The map is what lets the inner tiers run less: a commit runs the specs that
 * claim what it touched, not all of them. The rule it serves is the one the
 * whole test loop is built on:
 *
 *     Run less must not become check less. If any tier can be satisfied
 *     without the thing it is meant to catch actually being checked, it is
 *     the wrong tier.
 *
 * So the map only ever errs wide. A spec claims a file when it reaches it in
 * any of the ways the suite actually does:
 *
 *   - imports, followed through every file they reach (a `.vue` or `.md`
 *     script block, an html `<script src>`, `new URL(…, import.meta.url)`);
 *   - a repo path written in the spec as a string, or as the arguments of
 *     `join(repo, …)` / `resolve(repo, …)` — source read as text, an example
 *     built, a conformance vector, a crate driven through cargo;
 *   - a server it opens (the opener, the website, the studio), which claims
 *     everything that server is built from;
 *   - anything under `dist/`, which is built from all of `src/`.
 *
 * A path that does not exist claims its nearest existing parent, never a bare
 * top-level directory — `"src/app.js"` inside a temporary app claims nothing,
 * `tests/fixture/fixture.dai.html` (generated) claims the fixture.
 *
 * What it cannot see, it cannot claim: a module loaded by a computed
 * specifier. That is why the map only chooses subsets for the inner tiers. The
 * push tier runs everything and CI runs everything on three engines; neither
 * reads this file.
 *
 * `--check` fails on three things:
 *
 *   - the checked-in map differs from what the specs say now (stale);
 *   - a source file that no spec claims, that no other CI check reads, and
 *     that is not in ALLOWED with the reason — a file with no check behind it
 *     is where a change goes untested by every tier at once;
 *   - an entry in ALLOWED that is claimed now, or no longer exists.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (path) => relative(repo, path).split(sep).join("/");
const MAP = "tests/impact-map.json";

/**
 * Files whose change can alter what any spec does, or whether the suite's own
 * checks run. A change to one of these is a full run in every tier.
 */
export const GLOBAL = [
  "playwright.config.ts",
  "tests/global-setup.ts",
  "tests/count-gate.ts",
  "tests/count-floor.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.runtime.json",
  "tsconfig.tests.json",
  "tsup.config.ts",
  ".github/workflows/test.yml",
  "scripts/impact-map.mjs",
  "scripts/impact.mjs",
  // How the tiers run: a change to it is a change to what every tier checks.
  "scripts/test-tier.mjs",
];

/**
 * Where source lives. `docs/`, `infra/` and `.github/` are out of scope: the
 * first is prose the site checks read by path where it matters, the other two
 * are configuration applied by hand or by CI itself (the workflow is GLOBAL).
 */
const SCOPE = ["src/", "apps/", "website/", "examples/", "scripts/", "conformance/", "crates/", "eval/", "tests/fixture/"];

/** Top-level names a path written in a spec can start with. */
const ROOTS = ["src", "apps", "website", "examples", "scripts", "conformance", "crates", "eval", "tests", "dist"];

/**
 * Checks outside Playwright that CI runs, and what each one reads. Each entry
 * was read off .github/workflows/test.yml; one that stops running there must
 * come off this list, or the files it covered go unclaimed without a word.
 */
const OTHER_CHECKS = [
  {
    run: "npm run typecheck",
    claims: ["scripts/check-symbols.mjs", "scripts/check-routes.mjs", "scripts/check-callers.mjs"],
  },
  {
    run: "python3 conformance/reference/run.py",
    claims: [
      "conformance/reference/run.py",
      "conformance/reference/dai_read.py",
      "conformance/cases/",
      "conformance/cases.json",
      "conformance/vectors.json",
      "conformance/inline-links.json",
      "conformance/countersign-vectors.json",
      "conformance/trust-vectors.json",
      "conformance/identity-vectors.json",
    ],
  },
  {
    run: "cargo test --manifest-path crates/sectioned/Cargo.toml",
    claims: ["crates/sectioned/"],
  },
];

/**
 * Source files allowed to have no check behind them, each with the reason.
 * Keep it short and specific: an entry is a claim that nothing automatic can
 * check the file, not that nobody got round to it.
 */
const ALLOWED = [];

// ------------------------------------------------------------------ files

function listFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split("\0").filter(Boolean))].filter((file) => existsSync(join(repo, file))).sort();
}

const files = listFiles();
const fileSet = new Set(files);
const isDir = (path) => existsSync(join(repo, path)) && statSync(join(repo, path)).isDirectory();
const under = (prefix) => files.filter((file) => file.startsWith(prefix));
const read = (file) => readFileSync(join(repo, file), "utf8");

// ---------------------------------------------------------------- imports

const CODE = /\.(ts|tsx|mts|js|mjs|cjs|vue|md|html)$/;
const TRY = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".vue", "/index.ts", "/index.js"];

/** A specifier, resolved to a tracked file, or null for a package or a miss. */
function resolveSpecifier(from, specifier, rootRelative = false) {
  const bare = specifier.split(/[?#]/)[0];
  if (!bare) return null;
  let base;
  if (bare.startsWith(".")) base = posix.join(posix.dirname(from), bare);
  else if (bare.startsWith("/") && rootRelative) base = posix.join(posix.dirname(from), bare.slice(1));
  else return null;
  base = posix.normalize(base);
  const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base.replace(/\.mjs$/, ".mts")];
  for (const candidate of candidates) {
    for (const suffix of TRY) {
      if (fileSet.has(candidate + suffix)) return candidate + suffix;
    }
  }
  return null;
}

/** What one file reaches directly: its imports, and html's module scripts. */
function directImports(file) {
  if (!CODE.test(file)) return [];
  const text = read(file);
  const found = [];
  const patterns = [
    /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g,
    /import\(\s*["']([^"'\n]+)["']\s*\)/g,
    /new\s+URL\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const target = resolveSpecifier(file, match[1]);
      if (target) found.push(target);
    }
  }
  if (file.endsWith(".html")) {
    for (const match of text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
      const target = resolveSpecifier(file, match[1].startsWith("/") ? match[1] : `./${match[1]}`, true);
      if (target) found.push(target);
    }
  }
  return found;
}

const closureCache = new Map();

/** Every file reachable from these by import. */
function closure(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!closureCache.has(file)) closureCache.set(file, directImports(file));
    for (const next of closureCache.get(file)) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

// --------------------------------------------------------------- surfaces

/** The runtime a container carries: built from these, staged by every host. */
const RUNTIME = [...closure(["src/runtime/bootloader.ts", "src/replicated-frame.ts"]), "src/template.html"];

const everything = (prefix) => under(prefix).filter((file) => CODE.test(file));

/**
 * What each server is built from. A spec that opens one claims all of it —
 * every file of the app, what those import, and the runtime it stages.
 */
const SURFACES = {
  runner: {
    marker: /localhost:5175|RUNNER_URL/,
    claims: () => ["apps/runner/", ...closure(everything("apps/runner/")), ...RUNTIME],
  },
  website: {
    marker: /localhost:5176/,
    claims: () => ["website/", ...closure(everything("website/")), ...RUNTIME],
  },
  studio: {
    marker: /localhost:5174/,
    claims: () => ["examples/web-studio/", ...closure(everything("examples/web-studio/"))],
  },
};

/** Built output: tsup builds it from `src/`, and the build copies the template. */
const DIST = ["src/", "tsup.config.ts", "scripts/retain-host.mjs"];

/** The fixture container: built in global setup with the plugin from dist. */
const FIXTURE = ["tests/fixture/", "scripts/generate-key.mjs", ...DIST];

// ------------------------------------------------------------ paths named

/**
 * Every repo path a file names in a string: a single literal, or a run of
 * literal arguments (`join(repo, "examples", "tasks")`). Leading `..` parts
 * are dropped, since every spec sits one level below the repo.
 */
function namedPaths(text) {
  const literals = [...text.matchAll(/(["'`])((?:(?!\1)[^\n\\]|\\.)*)\1/g)].map((match) => ({
    value: match[2],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const runs = [];
  for (let i = 0; i < literals.length; i++) {
    const run = [literals[i]];
    while (i + 1 < literals.length && /^\s*,\s*$/.test(text.slice(literals[i].end, literals[i + 1].start))) {
      run.push(literals[++i]);
    }
    runs.push(run.map((item) => item.value));
  }
  const paths = new Set();
  for (const run of runs) {
    // Every word of every literal — a path inside a command or a message
    // ("run: node scripts/build-demo-pair.mjs, then commit it") is still a
    // path — and, where each part is one clean word, the run joined.
    const candidates = run.flatMap((value) =>
      value
        .split(/\$\{[^}]*\}|\s+/)
        .map((token) => token.replace(/[,.;:)'"]+$/, ""))
        .filter(Boolean)
        .map((token) => [token]),
    );
    if (run.length > 1 && run.every((value) => !/[\s$]/.test(value))) candidates.push(run);
    for (const parts of candidates) {
      const cleaned = parts.join("/").split("/").filter((part) => part && part !== "." && part !== "..");
      if (cleaned.length === 0 || !ROOTS.includes(cleaned[0])) continue;
      paths.add(cleaned.join("/"));
    }
  }
  return paths;
}

/** What naming one path claims. Missing paths climb to an existing parent, never a bare root. */
function claimsForPath(path) {
  if (path === "dist" || path.startsWith("dist/")) return DIST;
  if (path === "tests/fixture" || path.startsWith("tests/fixture/")) return FIXTURE;
  if (path.startsWith("apps/runner/dist")) return SURFACES.runner.claims();
  let parts = path.split("/");
  while (parts.length > 1) {
    const candidate = parts.join("/");
    if (fileSet.has(candidate)) return [candidate];
    if (isDir(candidate) && under(`${candidate}/`).length > 0) return [`${candidate}/`];
    parts = parts.slice(0, -1);
  }
  return [];
}

// ----------------------------------------------------------------- build

/** Drops files a directory claim already covers, and sorts. */
function compact(claims) {
  const unique = [...new Set(claims)];
  const dirs = unique.filter((claim) => claim.endsWith("/"));
  return unique
    .filter((claim) => claim.endsWith("/") || !dirs.some((dir) => claim.startsWith(dir)))
    .filter((claim) => !dirs.some((dir) => dir !== claim && claim.startsWith(dir)))
    .sort();
}

/**
 * Scripts the build runs before every test: named by the build's own
 * configuration (tsup's post-build command, global setup), with what they
 * import. A change to one changes what every spec runs against, so each is
 * global. Only exact `scripts/` files — tsup's config also lists its entries in
 * `src/`, and making those global would turn every library change into a full
 * run for no reason the map can state.
 */
function buildSteps() {
  const named = ["tsup.config.ts", "tests/global-setup.ts"]
    .flatMap((config) => [...namedPaths(read(config))])
    .filter((path) => path.startsWith("scripts/") && fileSet.has(path));
  return [...closure(named)].sort();
}

export function build() {
  const specs = files.filter((file) => file.startsWith("tests/") && file.endsWith(".spec.ts"));
  const out = {};
  for (const spec of specs) {
    const reached = closure([spec]);
    const claims = [...reached];
    // Only the spec and its own helpers speak for which servers it opens and
    // which paths it names; the library it imports does not.
    const own = [...reached].filter((file) => file.startsWith("tests/"));
    for (const file of own) {
      const text = read(file);
      for (const surface of Object.values(SURFACES)) if (surface.marker.test(text)) claims.push(...surface.claims());
      for (const path of namedPaths(text)) claims.push(...claimsForPath(path));
      // A spec may name what it reaches in a way none of the above can see.
      for (const match of text.matchAll(/@impact\s+([^\n*]+)/g)) {
        for (const path of match[1].split(/[\s,]+/).filter(Boolean)) claims.push(...claimsForPath(path));
      }
    }
    out[spec] = compact(claims);
  }
  return {
    note: "Generated by scripts/impact-map.mjs --write. Do not edit by hand.",
    global: [...new Set([...GLOBAL, ...buildSteps()])].sort(),
    specs: out,
  };
}

/** Whether a claim list covers a file. */
export const covers = (claims, file) => claims.some((claim) => (claim.endsWith("/") ? file.startsWith(claim) : claim === file));

// ----------------------------------------------------------------- main

// Only when run directly: scripts/impact.mjs imports build() from here.
const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const mode = direct ? process.argv[2] : undefined;
if (mode === "--write" || mode === "--check") {
  const map = build();
  const text = `${JSON.stringify(map, null, 2)}\n`;

  if (mode === "--write") {
    writeFileSync(join(repo, MAP), text, "utf8");
    console.log(`impact map: ${Object.keys(map.specs).length} specs written to ${MAP}`);
    process.exit(0);
  }

  const problems = [];
  const current = existsSync(join(repo, MAP)) ? read(MAP).replace(/\r\n/g, "\n") : "";
  if (current !== text) {
    problems.push(`${MAP} is stale: run \`node scripts/impact-map.mjs --write\` and commit the result.`);
  }

  const claimLists = [...Object.values(map.specs), map.global, ...OTHER_CHECKS.map((check) => check.claims)];
  const inScope = files.filter((file) => SCOPE.some((prefix) => file.startsWith(prefix)));
  const unclaimed = inScope.filter(
    (file) => !claimLists.some((claims) => covers(claims, file)) && !ALLOWED.some((entry) => covers([entry.path], file)),
  );
  if (unclaimed.length > 0) {
    problems.push(
      "No spec claims these, no other CI check reads them, and they are not in ALLOWED:\n" +
        unclaimed.map((file) => `  ${file}`).join("\n") +
        "\nGive each a check (a spec that reaches it, or a CI step listed in OTHER_CHECKS), " +
        "or add it to ALLOWED in scripts/impact-map.mjs with the reason nothing automatic can check it.",
    );
  }

  for (const entry of ALLOWED) {
    if (!files.some((file) => covers([entry.path], file))) problems.push(`ALLOWED names ${entry.path}, which no longer exists.`);
    else if (Object.values(map.specs).some((claims) => under(entry.path.endsWith("/") ? entry.path : "").length === 0 && covers(claims, entry.path))) {
      problems.push(`ALLOWED names ${entry.path}, which a spec claims now: take it off.`);
    }
  }

  if (problems.length > 0) {
    console.error(problems.join("\n\n"));
    process.exit(1);
  }
  console.log(`impact map: current; ${inScope.length} source files, every one claimed or allowed (${ALLOWED.length} allowed)`);
}
