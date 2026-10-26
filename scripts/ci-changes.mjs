/**
 * Whether a CI run needs the browser matrix, decided once, in the run's first
 * job (`changes`, .github/workflows/test.yml).
 *
 *     node scripts/ci-changes.mjs        # in CI: writes code=true|false to $GITHUB_OUTPUT
 *     node scripts/ci-changes.mjs <sha>  # locally: what a run on <sha> would decide
 *
 * A build costs one run of the browser matrix, not three (D296). A commit that
 * changes only prose — under docs/, under website/docs/, or a `.md` file — does
 * not change what the matrix tests, so the browser jobs, the count gate and the
 * property checks skip; the checks-fast and checks-holdout jobs run whatever
 * changed.
 *
 * "Changed" is measured from the nearest ancestor with a green run of this
 * workflow, not from the parent commit. A docs-only commit pushed on top of a
 * red or cancelled run must not turn the branch green by skipping the jobs
 * that were red: its diff from the last green tree holds the code that was
 * never passed, so the matrix runs. A docs-only run that is itself green is a
 * fair base for the next, since its own base was.
 *
 * And prose a spec reads is not prose: the impact map (scripts/impact.mjs)
 * claims some `.md` files for specs (the site's pages under website/docs/,
 * README files an opener build reaches), and a change to one of those runs the
 * matrix. Run less must not become check less.
 *
 * Anything this cannot decide — no green ancestor among the recent runs, gh
 * unreadable, a git error — is code, and the matrix runs.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A path whose change cannot change what the browser matrix tests, unless a spec reads it. */
export function isProse(path) {
  return path.startsWith("docs/") || path.startsWith("website/docs/") || path.endsWith(".md");
}

/**
 * The decision from what changed and what the impact map selects for it.
 * `changed` is the paths since the green base; `selected` is impact.mjs's
 * output for them (spec paths, `check:<name>`, or `ALL`).
 */
export function decide(changed, selected) {
  const code = changed.filter((path) => !isProse(path));
  if (code.length > 0) return { code: true, reason: `${code.length} path(s) outside the prose: ${code.slice(0, 5).join(", ")}${code.length > 5 ? ", …" : ""}` };
  const specs = selected.filter((line) => !line.startsWith("check:"));
  if (specs.length > 0) return { code: true, reason: `prose a spec reads: ${specs.slice(0, 5).join(", ")}${specs.length > 5 ? ", …" : ""}` };
  return { code: false, reason: changed.length === 0 ? "the tree is the green one" : `${changed.length} prose path(s), none read by a spec` };
}

/**
 * The nearest commit at or below `head` with a green run, from `runs` (newest
 * first, each `{ databaseId, headSha }`). `distance(sha)` is the number of
 * commits from `sha` to head, or null when `sha` is not an ancestor.
 */
export function nearestGreen(runs, distance) {
  let best = null;
  for (const run of runs) {
    const d = distance(run.headSha);
    if (d === null) continue;
    if (best === null || d < best.distance) best = { sha: run.headSha, run: run.databaseId, distance: d };
    if (d === 0) break;
  }
  return best;
}

const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function distanceFrom(head) {
  return (sha) => {
    try {
      git(["merge-base", "--is-ancestor", sha, head]);
    } catch {
      return null;
    }
    return Number(git(["rev-list", "--count", `${sha}..${head}`]).trim());
  };
}

function main(argv) {
  const head = argv[0] ?? "HEAD";
  let verdict;
  try {
    const runs = JSON.parse(
      execFileSync(
        "gh",
        ["run", "list", "--workflow", "test.yml", "--status", "success", "--limit", "100", "--json", "databaseId,headSha"],
        { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      ),
    );
    const base = nearestGreen(runs, distanceFrom(head));
    if (!base) {
      verdict = { code: true, reason: "no ancestor of this commit has a green run among the last 100" };
    } else {
      const changed = git(["diff", "--name-only", base.sha, head]).split(/\r?\n/).filter(Boolean);
      const selected = changed.length
        ? execFileSync(process.execPath, [join(repo, "scripts", "impact.mjs")], { cwd: repo, input: changed.join("\n"), encoding: "utf8" })
            .split(/\r?\n/)
            .filter(Boolean)
        : [];
      verdict = { ...decide(changed, selected), base };
      for (const path of changed) console.log(`  ${path}`);
    }
  } catch (error) {
    verdict = { code: true, reason: `could not decide (${String(error?.message ?? error).split("\n")[0]})` };
  }
  // The line scripts/ci-verdict.mjs reads from this job's log; keep its shape.
  const since = verdict.base ? ` since ${verdict.base.sha.slice(0, 8)} (run ${verdict.base.run})` : "";
  console.log(`changes: ${verdict.code ? "code" : "docs only"}${since}: ${verdict.reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `code=${verdict.code}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
