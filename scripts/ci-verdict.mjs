/**
 * The per-job pass/fail verdict of a CI run, read from the run itself.
 *
 * This exists because the project has now three times acted on a CI reading
 * that did not hold — a count gate believed, a cancellation missed, and a
 * "chromium 917 green" that was never true on CI. Each came from reading one
 * run's *summary* and inferring the rest. This does not infer: it reads each
 * browser job's own final tally — the line Playwright prints at the end,
 * "N passed", "N failed", "N flaky" — and prints one row per job.
 *
 *   node scripts/ci-verdict.mjs            # newest run on the current branch
 *   node scripts/ci-verdict.mjs <runId>    # a specific run
 *   node scripts/ci-verdict.mjs <sha>      # newest run for a commit (7+ hex)
 *
 * A job that reports no tally at all (cancelled, timed out, crashed before the
 * summary) is shown as NO TALLY — which is itself the finding: no verdict.
 * Requires the `gh` CLI, authenticated.
 */
import { execFileSync } from "node:child_process";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Resolve the argument (run id, commit sha, or nothing) to a run id. */
function resolveRun(arg) {
  if (arg && /^\d+$/.test(arg)) return arg;

  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--workflow",
      "test.yml",
      "--limit",
      "40",
      "--json",
      "databaseId,headSha,headBranch,createdAt",
    ]),
  );
  if (runs.length === 0) throw new Error("no runs found for workflow test.yml");

  if (arg && /^[0-9a-f]{7,40}$/i.test(arg)) {
    const hit = runs.find((r) => r.headSha.startsWith(arg.toLowerCase()));
    if (!hit) throw new Error(`no run found for commit ${arg}`);
    return String(hit.databaseId);
  }

  const branch = gh(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const onBranch = runs.filter((r) => r.headBranch === branch);
  const pick = (onBranch[0] ?? runs[0]);
  return String(pick.databaseId);
}

/**
 * Playwright's end-of-run tally, taken from the last lines of a job's log.
 *
 * The line reporter closes with a block like "  12 passed", "  3 failed",
 * "  1 flaky" — each on its own line. We read the whole log for the job and
 * take the LAST occurrence of each, because the numbers only mean the final
 * tally when they are the ones the run printed as it exited.
 */
function tallyFrom(log) {
  const last = (word) => {
    const matches = [...log.matchAll(new RegExp(`(\\d+)\\s+${word}\\b`, "g"))];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  };
  return { passed: last("passed"), failed: last("failed"), flaky: last("flaky") };
}

function main(argv) {
  const runId = resolveRun(argv[0]);

  const run = JSON.parse(
    gh([
      "run",
      "view",
      runId,
      "--json",
      "headSha,headBranch,status,conclusion,jobs,createdAt,url",
    ]),
  );

  const browserJobs = run.jobs.filter((j) => j.name.startsWith("browser ("));
  const otherJobs = run.jobs.filter((j) => !j.name.startsWith("browser ("));

  // One log fetch for the whole run; split per job by the name prefix gh puts
  // at the start of every log line.
  const fullLog = gh(["run", "view", runId, "--log"]);
  const perJob = new Map();
  for (const line of fullLog.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const jobName = line.slice(0, tab);
    if (!perJob.has(jobName)) perJob.set(jobName, []);
    perJob.get(jobName).push(line);
  }

  console.log(`run ${runId}  ${run.headSha.slice(0, 7)}  ${run.headBranch}  ${run.conclusion ?? run.status}`);
  console.log(run.url);
  console.log("");

  let anyMissing = false;
  for (const job of browserJobs) {
    const log = (perJob.get(job.name) ?? []).join("\n");
    const t = tallyFrom(log);
    const hasTally = t.passed !== null || t.failed !== null;
    if (!hasTally) anyMissing = true;
    const cells = hasTally
      ? `${t.passed ?? 0} passed, ${t.failed ?? 0} failed` + (t.flaky ? `, ${t.flaky} flaky` : "")
      : "NO TALLY (cancelled / timed out / crashed before summary)";
    const mark = job.conclusion === "success" ? "PASS" : job.conclusion === "failure" ? "FAIL" : (job.conclusion ?? "?").toUpperCase();
    console.log(`  ${mark.padEnd(6)} ${job.name.padEnd(28)} ${cells}`);
  }

  for (const job of otherJobs) {
    const mark = job.conclusion === "success" ? "PASS" : job.conclusion === "failure" ? "FAIL" : (job.conclusion ?? "?").toUpperCase();
    console.log(`  ${mark.padEnd(6)} ${job.name}`);
  }

  if (anyMissing) {
    console.log("");
    console.log("A job with NO TALLY produced no verdict — do not read its absence of failures as a pass.");
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(1);
}
