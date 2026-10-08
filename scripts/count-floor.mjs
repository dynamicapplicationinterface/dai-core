/**
 * The count floor, regenerated from the last green CI run (pass C's H1).
 *
 *     node scripts/count-floor.mjs           # regenerate tests/count-floor.json, then check it
 *     node scripts/count-floor.mjs --check   # check only
 *     node scripts/count-floor.mjs --drift   # what drift runs: fails only on a floor above the newest green run
 *
 * The floor is a lower bound. Drift fails only when the committed floor is above
 * what the newest completed green run passes for a project, a floor nobody could
 * meet; a floor below it is printed and passes. Regenerating is a chore, run when
 * you choose and never required to get a run green: on 7 October two runs of the
 * same tests counted WebKit 800 and 801, and a floor that had to equal the newest
 * run flipped with whichever finished last (a checks rerun puts its own run back
 * in progress, so it read the other). What protects the count is the gate
 * (tests/count-gate.ts): a run's actual count at or above the floor.
 *
 * The floor in tests/count-floor.json is what the count gate (tests/count-gate.ts)
 * holds a whole run to. Written by hand, it sat at the figures of 15 September
 * while CI passed 1,422 chromium and node tests against a floor of 997: up to
 * 400 tests could have stopped being collected with the gate still green. A
 * floor is only worth what it was last measured from, so it is measured here,
 * from CI, every time the gate runs: for each project, the newest run on this
 * branch in which every job carrying that project passed, counting the tests
 * that passed in it (a retried test that passed counts, as the gate counts it).
 * CI is where the floor gates, so a floor taken from it can never sit above
 * what CI passes (a Windows run passes more), nor below it.
 *
 * The check fails when the floor is older than the newest spec file CI has
 * already run: a spec committed at or before the newest completed run on this
 * branch, after the commit the floor was taken from. A spec in commits CI has
 * not run yet cannot be in any floor, and is not held against it.
 *
 * Needs the `gh` CLI, authenticated (in CI, GH_TOKEN and `actions: read`).
 * Without it, this says so by name and changes nothing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLOOR = join(repo, "tests", "count-floor.json");
const PROJECTS = ["chromium", "firefox", "webkit", "node"];

/** Which jobs of a run carry each project, by the names test.yml gives them. */
const CARRIERS = {
  chromium: (name) => name.startsWith("browser (chromium"),
  node: (name) => name.startsWith("browser (chromium"),
  firefox: (name) => name.startsWith("browser (firefox"),
  webkit: (name) => name.startsWith("browser (webkit"),
};
/** WebKit runs in four parts and a mailbox job (test.yml, D174): all five, or no count. */
const WEBKIT_JOBS = 5;

/**
 * Passed tests per project in a job log printed by Playwright's list reporter:
 * one line per attempt, "✓ N [project] › file:line › title (time)", a retry
 * marked "(retry #k)". A test counts once, by its last attempt.
 */
export function countsFrom(log) {
  const counts = {};
  for (const { project, passed } of attemptsFrom(log).values()) if (passed) counts[project] = (counts[project] ?? 0) + 1;
  return counts;
}

/** Each test's last attempt, keyed by project and title: the title without its retry mark or its duration. */
export function attemptsFrom(log) {
  const last = new Map();
  const line = /(✓|✘|-)\s+\d+\s+\[([\w-]+)\]\s+›\s+(.*?)(?:\s+\(retry #\d+\))?(?:\s+\(\d[\d.]*(?:ms|s|m)\))?\s*$/;
  for (const raw of log.split("\n")) {
    const match = line.exec(raw);
    if (!match) continue;
    const [, mark, project, title] = match;
    last.set(`${project}\u0000${title}`, { project, title, passed: mark === "✓" });
  }
  return last;
}

/** Whether a floor taken at commit time `floorAt` is older than a spec committed at `specAt` (ISO times). */
export function staleFloor(floorAt, specAt) {
  if (!specAt) return false;
  if (!floorAt) return true;
  return Date.parse(floorAt) < Date.parse(specAt);
}

const gh = (args) => execFileSync("gh", args, { cwd: repo, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function branch() {
  return process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

function haveGh() {
  const run = spawnSync("gh", ["auth", "status"], { cwd: repo, stdio: "ignore", shell: process.platform === "win32" });
  return run.status === 0;
}

function completedRuns() {
  return JSON.parse(
    gh(["run", "list", "--workflow", "test.yml", "--branch", branch(), "--limit", "30", "--json", "databaseId,headSha,status,conclusion"]),
  ).filter((run) => run.status === "completed");
}

/** The commit time of a sha, from the local history, or from GitHub when it is not here. */
function commitTime(sha) {
  try {
    return git(["show", "-s", "--format=%cI", sha]);
  } catch {
    return JSON.parse(gh(["api", `repos/{owner}/{repo}/commits/${sha}`, "-q", "{at: .commit.committer.date}"])).at;
  }
}

function readFloor() {
  try {
    return JSON.parse(readFileSync(FLOOR, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The floor against the newest green run's counts, per project. A floor is a
 * lower bound: one above what the newest green run passes is a floor nobody
 * could meet (`above`, drift); one below it is only a floor not yet raised
 * (`below`, printed, not drift). A project missing from either side is neither.
 */
export function floorDrift(floor, newest) {
  const above = [];
  const below = [];
  for (const project of Object.keys(newest)) {
    const held = floor[project];
    const count = newest[project];
    if (typeof held !== "number" || typeof count !== "number") continue;
    if (held > count) above.push(`${project}: the floor is ${held}, above the ${count} the newest green run passes`);
    else if (held < count) below.push(`${project}: the floor is ${held}, ${count - held} below the ${count} the newest green run passes`);
  }
  return { above, below };
}

/** Per project, the newest completed run on this branch whose every job carrying it passed, and its count. */
function newestGreen() {
  const found = {};
  for (const run of completedRuns()) {
    if (PROJECTS.every((p) => found[p])) break;
    const jobs = JSON.parse(gh(["run", "view", String(run.databaseId), "--json", "jobs"])).jobs;
    const logs = new Map();
    const logOf = (job) => {
      if (!logs.has(job.databaseId)) logs.set(job.databaseId, gh(["run", "view", "--job", String(job.databaseId), "--log"]));
      return logs.get(job.databaseId);
    };
    for (const project of PROJECTS) {
      if (found[project]) continue;
      const carrying = jobs.filter((job) => CARRIERS[project](job.name));
      if (carrying.length === 0 || carrying.some((job) => job.conclusion !== "success")) continue;
      if (project === "webkit" && carrying.length !== WEBKIT_JOBS) continue;
      const count = carrying.reduce((sum, job) => sum + (countsFrom(logOf(job))[project] ?? 0), 0);
      if (count === 0) continue;
      found[project] = { count, run: run.databaseId, sha: run.headSha };
    }
  }
  return found;
}

function regenerate() {
  const held = readFloor();
  const found = newestGreen();
  const floor = {};
  for (const project of PROJECTS) {
    if (found[project]) floor[project] = found[project].count;
    else if (held[project] !== undefined) {
      floor[project] = held[project];
      console.log(`count floor: no green run of ${project} in the last 30 on ${branch()}; kept ${held[project]}`);
    }
  }
  // The oldest commit any project's figure was taken from: the floor is no newer than that.
  const sources = Object.values(found);
  const from = sources.length
    ? sources.map((s) => ({ ...s, at: commitTime(s.sha) })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]
    : held._from;
  const written = { ...floor, _from: from ? { run: from.run, sha: from.sha, at: from.at } : undefined };
  writeFileSync(FLOOR, `${JSON.stringify(written, null, 2)}\n`, "utf8");
  const shown = Object.entries(floor).map(([p, n]) => `${p} ${n}`).join(", ");
  console.log(`count floor: ${shown}, from runs ${[...new Set(sources.map((s) => s.run))].join(", ") || "(none new)"}`);
}

function check() {
  const floor = readFloor();
  const newest = completedRuns()[0];
  if (!newest) {
    console.log(`count floor: no completed run on ${branch()}, so nothing CI ran is newer than the floor.`);
    return true;
  }
  let specAt = "";
  try {
    specAt = git(["log", newest.headSha, "-1", "--diff-filter=A", "--format=%cI", "--", "tests/*.spec.ts"]);
  } catch {
    console.error(`count floor: the commit of run ${newest.databaseId} (${newest.headSha.slice(0, 7)}) is not in this history; fetch it.`);
    return false;
  }
  if (staleFloor(floor._from?.at, specAt)) {
    console.error(
      `count floor: tests/count-floor.json was taken at ${floor._from?.at ?? "(no record)"}, older than a spec committed at ${specAt} ` +
        `that CI has already run (run ${newest.databaseId}). Run node scripts/count-floor.mjs and commit the result.`,
    );
    return false;
  }
  console.log(`count floor: current (taken at ${floor._from?.at}; newest spec CI has run, ${specAt}).`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!haveGh()) {
    console.log("count floor: no authenticated gh here, so the floor is neither regenerated nor checked; CI does both.");
    process.exit(0);
  }
  try {
    if (process.argv.includes("--drift")) {
      const found = newestGreen();
      const newest = Object.fromEntries(Object.entries(found).map(([p, s]) => [p, s.count]));
      const { above, below } = floorDrift(readFloor(), newest);
      const runs = [...new Set(Object.values(found).map((s) => s.run))].join(", ") || "(none)";
      for (const line of below) console.log(`count floor: ${line} (runs ${runs}); not drift, raise it with node scripts/count-floor.mjs when you choose`);
      for (const line of above) console.error(`count floor: ${line} (runs ${runs})`);
      if (above.length === 0 && below.length === 0) console.log(`count floor: at the newest green run's counts (runs ${runs}).`);
      process.exit(above.length === 0 ? 0 : 1);
    }
    if (!process.argv.includes("--check")) regenerate();
    process.exit(check() ? 0 : 1);
  } catch (error) {
    console.error(`count floor: ${error?.message ?? error}`);
    process.exit(1);
  }
}
