/**
 * The test loop, in tiers.
 *
 *     npm run test:iterate -- tests/sender.spec.ts   # the specs you are touching
 *     npm run test:commit                             # what the change can affect
 *     npm run test:push                               # everything, one engine, gated
 *
 * CI is the fourth tier: every engine, on every push (.github/workflows/test.yml).
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

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = join(repo, "test-results", "count-gate.json");
const PROJECTS = ["--project=chromium", "--project=node"];

const [tier, ...rest] = process.argv.slice(2);

function playwright(args, env = {}) {
  const run = spawnSync("npx", ["playwright", "test", ...PROJECTS, ...args], {
    cwd: repo,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  return run.status ?? 1;
}

const floorNotChecked = () =>
  console.log("\ntest-tier: a subset ran, so the count floor was NOT checked. `npm run test:push` checks it.");

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
  if (picked.includes("ALL")) {
    console.log("test-tier commit: the change reaches everything; running the push tier.");
    process.argv = [process.argv[0], process.argv[1], "push"];
  } else if (picked.length === 0) {
    console.log("test-tier commit: no spec reaches what changed.");
    floorNotChecked();
    process.exit(0);
  } else {
    const status = playwright(picked);
    floorNotChecked();
    process.exit(status);
  }
}

if (tier === "push" || process.argv[2] === "push") {
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
    console.error(
      `test-tier push: refusing ${refused.join(" ")} — the push tier is the whole suite through the config's reporters, ` +
        "or its count means nothing. Use test:iterate for a subset.",
    );
    process.exit(2);
  }
  /*
   * What CI's checks job checks, before any browser starts. Without this the
   * push tier ran green on a tree CI then failed: a runtime change moved the
   * shell every conformance case carries, and only CI ran the check that
   * holds the suite to its build. The library is built first, since each of
   * these reads dist/.
   */
  const checks = [
    ["npm", ["run", "build"]],
    [process.execPath, [join(repo, "scripts", "build-conformance.mjs"), "--check"]],
    [process.execPath, [join(repo, "scripts", "build-dictionary.mjs"), "--check"]],
    [process.execPath, [join(repo, "scripts", "build-confusables.mjs"), "--check"]],
    ["npm", ["run", "fixtures:check"]],
  ];
  for (const [command, args] of checks) {
    // A shell only for npm, which is npm.cmd on Windows. Node itself is spawned
    // directly: through a shell its path ("C:\Program Files\...") is split at
    // the space, node never starts, and every tree is refused.
    const run = spawnSync(command, args, { cwd: repo, stdio: "inherit", shell: command === "npm" && process.platform === "win32" });
    if (run.status !== 0) {
      console.error(`test-tier push: ${[command, ...args].join(" ")} failed — CI's checks job would refuse this too.`);
      process.exit(1);
    }
  }

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
  const reasons = whyFailed({ status, report, projects: ["chromium", "node"] });
  if (reasons.length > 0) {
    /*
     * A failure's evidence, kept before anything else can run (D47). The next
     * run clears test-results/, and a rerun that passes is exactly what erased
     * every earlier static-opener failure unread.
     */
    let commit = "unknown";
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    } catch {
      /* Not a repository; the run is still worth keeping. */
    }
    const { kept, error } = keepEvidenceSafely({
      results: join(repo, "test-results"),
      into: join(repo, "test-runs"),
      reasons,
      commit,
      note: "tier: push",
    });
    if (kept) console.error(`\ntest-tier push: this run failed; its results are kept in ${kept}. Read them before rerunning.`);
    if (error) console.error(`\ntest-tier push: this run failed, and its results could NOT be kept (${error}). Copy test-results/ by hand before rerunning.`);
    if (!kept && !error) console.error("\ntest-tier push: this run failed, and there was no test-results/ to keep.");
    for (const reason of reasons) console.error(`test-tier push: failed: ${reason}`);
    process.exit(status !== 0 ? status : 1);
  }
  console.log(`\ntest-tier push: whole run, count gate checked: ${JSON.stringify(report.passed)}`);
  process.exit(0);
}

console.error("usage: node scripts/test-tier.mjs iterate <specs…> | commit | push");
process.exit(2);
