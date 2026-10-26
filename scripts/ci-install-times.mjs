/**
 * How long each browser job's browser install took in a CI run, and whether
 * its cache hit (D292).
 *
 *     node scripts/ci-install-times.mjs <runId>              # the run's latest attempt
 *     node scripts/ci-install-times.mjs <runId> <attempt>    # one attempt
 *
 * One row per browser job: the "Install the browsers" step's time from the
 * step's own start and end, and the cache read from the job's log (the cache
 * action prints "Cache restored from key: playwright-…" on a hit and "Cache not
 * found for input keys: playwright-…" on a miss; setup-node's npm cache prints
 * the same words for its own key), with how much apt fetched ("Fetched N MB", or "0 B" when the
 * packages came from the cache). A job whose install never ran (a docs-only
 * run, D296) or never finished says so: no time is not a fast time.
 * Requires the `gh` CLI, authenticated.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** What the job's log says about the cache and apt, or nulls when it says nothing. */
export function installFacts(log) {
  const hit = /Cache restored from key: playwright-/.test(log) ? "hit" : /Cache not found for input keys: playwright-/.test(log) ? "miss" : null;
  const fetched = /Fetched ([\d.,]+ [kKMG]?B) in/.exec(log)?.[1] ?? null;
  const needed = /Need to get ([\d.,]+ [kKMG]?B(?:\/[\d.,]+ [kKMG]?B)?) of archives/.exec(log)?.[1] ?? null;
  return { cache: hit, fetched, needed };
}

/** Seconds between two ISO times, or null when either is missing. */
export function seconds(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  return Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000);
}

function main([runId, attemptArg]) {
  if (!/^\d+$/.test(runId ?? "")) {
    console.error("usage: node scripts/ci-install-times.mjs <runId> [attempt]");
    process.exit(2);
  }
  const run = JSON.parse(gh(["api", `repos/{owner}/{repo}/actions/runs/${runId}`]));
  const attempt = attemptArg ?? String(run.run_attempt);
  const jobs = gh(["api", `repos/{owner}/{repo}/actions/runs/${runId}/attempts/${attempt}/jobs`, "--paginate", "-q", ".jobs[] | @json"])
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  // A rerun of failed jobs lists every job; the ones it did not rerun keep their earlier times.
  const began = JSON.parse(gh(["api", `repos/{owner}/{repo}/actions/runs/${runId}/attempts/${attempt}`])).run_started_at;
  console.log(`run ${runId} attempt ${attempt}  ${run.head_sha.slice(0, 8)}  ${run.head_branch}  ${run.conclusion ?? run.status}`);
  const rows = [];
  for (const job of jobs.filter((j) => j.name.startsWith("browser"))) {
    const step = (job.steps ?? []).find((s) => s.name === "Install the browsers");
    const took = step && step.conclusion === "success" ? seconds(step.started_at, step.completed_at) : null;
    let facts = { cache: null, fetched: null, needed: null };
    if (step && step.conclusion) {
      try {
        facts = installFacts(gh(["api", "--allow-escape-sequences", `repos/{owner}/{repo}/actions/jobs/${job.id}/logs`]));
      } catch {
        /* Logs expire; the time still stands. */
      }
    }
    const time = took !== null ? `${took} s` : step ? `not finished (${step.conclusion ?? step.status})` : `no install (${job.conclusion ?? job.status})`;
    const apt = facts.needed ? `apt needed ${facts.needed}` : facts.fetched ? `apt fetched ${facts.fetched}` : "";
    const carried = began && job.started_at && Date.parse(job.started_at) < Date.parse(began) ? "  (not rerun: an earlier attempt's)" : "";
    rows.push([job.name.replace(/, --grep-invert.*\)$/, ")"), time, facts.cache ?? "", apt + carried]);
  }
  const width = Math.max(...rows.map((r) => r[0].length), 10);
  for (const [name, time, cache, apt] of rows) console.log(`  ${name.padEnd(width)}  ${time.padStart(10)}  ${cache.padEnd(4)}  ${apt}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
