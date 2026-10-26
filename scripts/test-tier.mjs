/**
 * The test loop, in tiers.
 *
 *     npm run test:iterate -- tests/sender.spec.ts   # the specs you are touching
 *     npm run test:commit                             # what the change can affect
 *     npm run test:push                               # the fast gate before a push
 *     npm run test:full                               # everything, one engine, gated
 *
 * CI is the gate: every engine, on every push that changes code
 * (.github/workflows/test.yml). The push tier is the fast tier (D296): the
 * typecheck, drift without the merge fixtures, the node project whole, the
 * changesets suite, and the specs the branch's diff reaches by the impact map,
 * in minutes. It does not repeat what CI runs on the same commit: the engine
 * matrix, the merge-fixture check, the readers and the properties are CI's.
 * The full tier is the old push tier, kept for a deliberate local check.
 *
 * Each tier runs chromium and the node project. Firefox and webkit are CI's;
 * running all three here is what made the loop too slow to use.
 *
 * The rule every tier answers to:
 *
 *     Run less must not become check less. If any tier can be satisfied
 *     without the thing it is meant to catch actually being checked, it is
 *     the wrong tier.
 *
 * So the two subset tiers say out loud that the count floor was not checked,
 * and the push tier refuses anything that would make its count meaningless —
 * a filter, a shard, named specs, a --reporter that replaces the gate — and
 * then fails unless the gate itself reports that it checked the run.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keepEvidenceSafely, whyFailed } from "./lib/keep-evidence.mjs";
import { BROWSER_PARTS, COUNT_JOB } from "./ci-verdict.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = join(repo, "test-results", "count-gate.json");
const PROJECTS = ["--project=chromium", "--project=node"];
/**
 * The CI jobs this tier's suite run stands for (test.yml): Chromium's four
 * shards and the node job, which run here as one whole run, and the count-gate
 * job, which holds the sum of CI's parts to the floor this run is held to.
 */
const CI_SUITE_JOBS = [
  ...BROWSER_PARTS.filter((part) => /^browser \((chromium|node),/.test(part)).map((part) => `${part})`),
  COUNT_JOB,
];

const [tier, ...rest] = process.argv.slice(2);

function playwright(args, env = {}, projects = PROJECTS) {
  const run = spawnSync("npx", ["playwright", "test", ...projects, ...args], {
    cwd: repo,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  return run.status ?? 1;
}

/** An argument as a person reads it: a path under the repository, relative to it. */
const relativeTo = (arg) => (arg.startsWith(repo) ? arg.slice(repo.length + 1).split("\\").join("/") : arg);

const floorNotChecked = () =>
  console.log("\ntest-tier: a subset ran, so the count floor was NOT checked. CI's count-gate checks it, and `npm run test:full` does here.");

/**
 * A failed run's evidence, kept before anything else can run (D47). The next
 * run clears test-results/, and a rerun that passes is exactly what erased
 * every earlier static-opener failure unread.
 */
function keepEvidence(reasons, note) {
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    /* Not a repository; the run is still worth keeping. */
  }
  const { kept, error } = keepEvidenceSafely({ results: join(repo, "test-results"), into: join(repo, "test-runs"), reasons, commit, note });
  if (kept) console.error(`\ntest-tier ${note}: this run failed; its results are kept in ${kept}. Read them before rerunning.`);
  if (error) console.error(`\ntest-tier ${note}: this run failed, and its results could NOT be kept (${error}). Copy test-results/ by hand before rerunning.`);
  if (!kept && !error) console.error(`\ntest-tier ${note}: this run failed, and there was no test-results/ to keep.`);
}

/** Refuses what would make a gated tier's run something other than what it says it is. */
function refuseFilters(name, why) {
  const refused = rest.filter(
    (arg) =>
      arg === "-g" ||
      arg.startsWith("--grep") ||
      arg.startsWith("--reporter") ||
      arg.startsWith("--shard") ||
      arg.startsWith("--project") ||
      !arg.startsWith("-"),
  );
  if (refused.length > 0) {
    console.error(`test-tier ${name}: refusing ${refused.join(" ")} — ${why} Use test:iterate for a subset.`);
    process.exit(2);
  }
}

/** Runs each check, all of them whatever failed, and returns the ones that failed, named by the CI job that runs it. */
function runChecks(name, list) {
  const failed = [];
  for (const [command, args, job] of list) {
    // A shell only for npm, which is npm.cmd on Windows. Node itself is spawned
    // directly: through a shell its path ("C:\Program Files\...") is split at
    // the space, node never starts, and every tree is refused.
    const run = spawnSync(command, args, { cwd: repo, stdio: "inherit", shell: command === "npm" && process.platform === "win32" });
    if (run.status !== 0) {
      const line = `${job}: ${[command, ...args.map((arg) => relativeTo(arg))].join(" ")}`;
      console.error(`test-tier ${name}: ${line} failed — CI's ${job} job would refuse this too.`);
      failed.push(line);
    }
  }
  return failed;
}

/** The suite through the count gate: chromium and node whole, and why it failed, if it did. */
function gatedSuite() {
  rmSync(REPORT, { force: true });
  const status = playwright(rest);
  let report = null;
  try {
    if (existsSync(REPORT)) report = JSON.parse(readFileSync(REPORT, "utf8"));
  } catch {
    /* An unreadable report is no report: whyFailed says so. */
  }
  /*
   * One verdict, read by both the evidence keeper and the exit. The keeper once
   * decided "failed" for itself, from Playwright's exit alone, and so kept
   * nothing when Playwright passed and the count gate refused (review of
   * 454858c..7abb896, item 4).
   */
  return { status, report, reasons: whyFailed({ status, report, projects: ["chromium", "node"] }) };
}

if (tier === "iterate") {
  if (rest.filter((arg) => !arg.startsWith("-")).length === 0) {
    console.error("test-tier iterate: name the specs you are working on, e.g. tests/sender.spec.ts");
    process.exit(2);
  }
  const status = playwright(rest, { DAI_REUSE_BUILD: "1" });
  floorNotChecked();
  process.exit(status);
}

if (tier === "commit") {
  // What this commit changes: staged, unstaged and new files against HEAD.
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" });
  const fresh = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" });
  const changed = `${diff}\n${fresh}`.split(/\r?\n/).filter(Boolean);
  if (changed.length === 0) {
    console.log("test-tier commit: nothing changed against HEAD.");
    process.exit(0);
  }
  const picked = execFileSync(process.execPath, [join(repo, "scripts", "impact.mjs"), "--explain"], {
    cwd: repo,
    input: changed.join("\n"),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const selectedChecks = picked.filter((line) => line.startsWith("check:")).map((line) => line.slice("check:".length));
  const specs = picked.filter((line) => !line.startsWith("check:"));
  if (picked.includes("ALL")) {
    console.log("test-tier commit: the change reaches everything; running the push tier.");
    process.argv = [process.argv[0], process.argv[1], "push"];
  } else if (specs.length === 0 && selectedChecks.length === 0) {
    console.log("test-tier commit: no spec reaches what changed.");
    floorNotChecked();
    process.exit(0);
  } else {
    let failed = false;
    if (selectedChecks.includes("build-conformance")) {
      // It reads dist/, so the library is built first.
      const ok =
        spawnSync("npm", ["run", "build:lib"], { cwd: repo, stdio: "inherit", shell: process.platform === "win32" }).status === 0 &&
        spawnSync(process.execPath, [join(repo, "scripts", "build-conformance.mjs"), "--check"], { cwd: repo, stdio: "inherit" }).status === 0;
      if (!ok) {
        console.error("test-tier commit: build-conformance --check failed (a change under docs/ selects it).");
        failed = true;
      }
    }
    const status = specs.length > 0 ? playwright(specs) : 0;
    floorNotChecked();
    process.exit(failed && status === 0 ? 1 : status);
  }
}

if (tier === "push" || process.argv[2] === "push") {
  refuseFilters("push", "the push tier chooses its own specs from the branch's diff.");
  /*
   * The branch's diff: every commit since it left main, and what is not yet
   * committed. The specs it reaches run on chromium; the node project and the
   * changesets suite run whole whatever changed, since both are quick and the
   * data interface is what most builds touch. A change the impact map says
   * reaches everything runs the whole chromium and node suite through the
   * count gate, as the full tier's suite does.
   */
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  let base = "HEAD";
  for (const main of ["origin/main", "main"]) {
    try {
      base = git(["merge-base", main, "HEAD"]).trim();
      break;
    } catch {
      /* No such ref here; try the next. */
    }
  }
  const changed = [
    ...new Set(
      [git(["diff", "--name-only", base]), git(["ls-files", "--others", "--exclude-standard"])]
        .join("\n")
        .split(/\r?\n/)
        .filter(Boolean),
    ),
  ];
  const picked = changed.length
    ? execFileSync(process.execPath, [join(repo, "scripts", "impact.mjs"), "--explain"], {
        cwd: repo,
        input: changed.join("\n"),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "inherit"],
      })
        .split(/\r?\n/)
        .filter(Boolean)
    : [];
  // A list past what a Windows command line holds runs the whole suite instead.
  const everything = picked.includes("ALL") || picked.join(" ").length > 6000;
  const specs = picked.filter((line) => line !== "ALL" && !line.startsWith("check:"));
  console.log(`test-tier push: ${changed.length} path(s) changed since ${base.slice(0, 8)}; ${everything ? "they reach every spec" : `${specs.length} spec(s) reach them`}.`);

  /*
   * What CI's checks-fast job checks that is quick: drift without the merge
   * fixtures (about twenty minutes, CI's on every commit), the typecheck chain,
   * and the two generated tables. The readers, the hold-outs and the
   * properties are CI's too; `npm run test:full` runs every one of them here.
   */
  const checksFailed = runChecks("push", [
    [process.execPath, [join(repo, "scripts", "drift.mjs"), "--no-fixtures"], "checks-fast"],
    ["npm", ["run", "typecheck"], "checks-fast"],
    [process.execPath, [join(repo, "scripts", "build-dictionary.mjs"), "--check"], "checks-fast"],
    [process.execPath, [join(repo, "scripts", "build-confusables.mjs"), "--check"], "checks-fast"],
  ]);

  const reasons = checksFailed.map((line) => `a check failed: ${line}`);
  if (everything) {
    const suite = gatedSuite();
    reasons.push(...suite.reasons);
    if (reasons.length > 0) keepEvidence(reasons, "push");
    else console.log(`\ntest-tier push: whole run, count gate checked: ${JSON.stringify(suite.report.passed)}`);
  } else {
    // Each run clears test-results/, so a failed one's evidence is kept before the next starts.
    const chromium = playwright(["tests/changesets/", ...specs], {}, ["--project=chromium"]);
    if (chromium !== 0) {
      reasons.push(`chromium: the changesets suite and the specs the diff reaches failed (exit ${chromium})`);
      keepEvidence(reasons, "push");
    }
    const node = playwright([], { DAI_REUSE_BUILD: "1" }, ["--project=node"]);
    if (node !== 0) {
      reasons.push(`node: the node project failed (exit ${node})`);
      keepEvidence(reasons, "push");
    }
    floorNotChecked();
  }
  for (const reason of reasons) console.error(`test-tier push: failed: ${reason}`);
  if (reasons.length === 0) console.log("test-tier push: passed. CI runs the engine matrix, the merge fixtures, the readers and the properties.");
  process.exit(reasons.length > 0 ? 1 : 0);
}

if (tier === "full" || process.argv[2] === "full") {
  refuseFilters("full", "the full tier is the whole suite through the config's reporters, or its count means nothing.");
  /*
   * What CI's checks job checks, before any browser starts. Without this the
   * push tier ran green on a tree CI then failed: a runtime change moved the
   * shell every conformance case carries, and only CI ran the check that
   * holds the suite to its build. The library is built first, since each of
   * these reads dist/.
   */
  /*
   * CI's four checks jobs (test.yml: checks-fast, checks-holdout,
   * checks-properties-node, checks-properties-python), in that order, each
   * check named by the job that runs it there, so a red one here names the
   * job that would be red there. One difference, on purpose: CI's checks-fast
   * runs `npm run build`, which keeps a host, and a test run never keeps one
   * (D77); the library is built by drift's first step instead.
   *
   * The readers and the slow jobs (pass C's M5) need python3 or cargo. A
   * machine without one is told which checks CI will run instead — silence
   * here would read as "checked".
   */
  const python = (file, what, job) => ["python3", [join(repo, ...file)], what, job];
  const checks = [];
  for (const [tool, args, what, job] of [
    // Every committed product rebuilt and compared, first: the library (only:
    // a test run never keeps a host, D77), the site's runtime, the conformance
    // cases, the merge fixtures, the impact map, the hosted request, the
    // model-file budget, the inline-link cap and the count floor, which it
    // regenerates from the last green CI run (scripts/drift.mjs).
    ["npm", ["run", "drift"], "drift", "checks-fast"],
    // Everything the typecheck chain carries: tsc twice, the symbol, route,
    // caller and name checks, and the impact map. Left out once, and CI caught
    // a stale impact map that this tier had just run green over.
    ["npm", ["run", "typecheck"], "the typecheck", "checks-fast"],
    [process.execPath, [join(repo, "scripts", "build-dictionary.mjs"), "--check"], "the dictionary", "checks-fast"],
    [process.execPath, [join(repo, "scripts", "build-confusables.mjs"), "--check"], "the confusables", "checks-fast"],
    python(["conformance", "reference", "run.py"], "the Python reference reader", "checks-fast"),
    python(["conformance", "reference", "dai_merge.py"], "the Python merge reader", "checks-fast"),
    [
      "cargo",
      ["run", "--release", "--quiet", "--manifest-path", join(repo, "conformance", "readers", "rust-merge", "Cargo.toml"), "--", join(repo, "conformance", "merge")],
      "the Rust merge reader",
      "checks-fast",
    ],
    ["cargo", ["test", "--manifest-path", join(repo, "crates", "sectioned", "Cargo.toml")], "cargo test of crates/sectioned", "checks-fast"],
    [
      "cargo",
      ["build", "--quiet", "--example", "replace-data", "--manifest-path", join(repo, "crates", "sectioned", "Cargo.toml")],
      "the replace-data example",
      "checks-fast",
    ],
    python(["scripts", "holdout.py"], "the hold-outs", "checks-holdout"),
    [process.execPath, [join(repo, "scripts", "properties.mjs")], "the properties by the runtime", "checks-properties-node"],
    python(["scripts", "properties.py"], "the properties by the Python reader", "checks-properties-python"),
  ]) {
    const have = tool === "npm" || tool === process.execPath || spawnSync(tool, ["--version"], { cwd: repo, stdio: "ignore", shell: process.platform === "win32" }).status === 0;
    if (have) checks.push([tool, args, job]);
    else console.log(`test-tier full: no ${tool} here, so ${what} (${job}) is left to CI.`);
  }
  /*
   * Every check runs, and the suite after them, whatever failed: CI reports its
   * checks job and its browser jobs side by side, and a gate that stops at the
   * first red check says nothing about the rest. The tier still fails if any
   * check did.
   */
  const checksFailed = runChecks("full", checks);
  const suite = gatedSuite();
  const reasons = [...checksFailed.map((line) => `a check failed: ${line}`), ...suite.reasons];
  if (reasons.length > 0) {
    keepEvidence(reasons, "full");
    for (const reason of reasons) console.error(`test-tier full: failed: ${reason}`);
    if (reasons.length > checksFailed.length) {
      console.error(`test-tier full: the suite stands for CI's ${CI_SUITE_JOBS.join(", ")}; one of them would refuse this too.`);
    }
    process.exit(suite.status !== 0 ? suite.status : 1);
  }
  console.log(`\ntest-tier full: whole run, count gate checked: ${JSON.stringify(suite.report.passed)} (CI: ${CI_SUITE_JOBS.join(", ")})`);
  process.exit(0);
}

console.error("usage: node scripts/test-tier.mjs iterate <specs…> | commit | push | full");
process.exit(2);
