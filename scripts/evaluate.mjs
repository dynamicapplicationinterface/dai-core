/**
 * Scores applications a model wrote, against the only question that matters.
 *
 * "Can an assistant produce a working DAI application?" is the first thing
 * anybody asks, and until now the honest answer was that nobody had counted.
 * This counts.
 *
 * It does not call a model. Completions are an input — a directory of source
 * files per prompt, committed alongside the score — for three reasons, and the
 * order is deliberate:
 *
 *   1. A score anybody can reproduce is worth more than one only we can
 *      produce. With the completions committed, somebody who doubts the number
 *      can recompute it in a minute, with no keys and no spend.
 *   2. Calling an API is the only step here that costs money, and it should be
 *      a decision somebody makes rather than something a script does.
 *   3. Model endpoints change; the scoring does not. A pipeline that speaks
 *      three SDKs would break on somebody else's release schedule.
 *
 *   node scripts/evaluate.mjs eval/candidates/claude --json
 *
 * A candidate directory holds one directory per prompt id, each containing the
 * source the model wrote — index.html and whatever it referenced.
 *
 * Scoring is in stages, because "it failed" is not a finding. An application
 * that will not compile and one that compiles but loses your data are different
 * problems with different fixes, and lumping them together loses the only
 * information the exercise produces.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "dist", "bin.js");
const harness = join(repo, "scripts", "try-container.mjs");

/** The stages an application passes through, in order. */
const STAGES = ["checked", "built", "mounted", "usable"];

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}

/**
 * Runs one application through every stage, stopping at the first failure.
 *
 * Stopping is the point: an application that does not compile cannot be opened,
 * and reporting three further failures for one cause would inflate the count of
 * things wrong with it.
 */
function score(prompt, directory) {
  const result = { id: prompt.id, reached: null, failedAt: null, why: null };

  // 1. Would this work inside a container at all?
  const checked = run(process.execPath, [cli, "check", directory, "--json"]);
  const findings = checked.stdout ? JSON.parse(checked.stdout).findings ?? [] : [];
  if (!checked.ok) {
    result.failedAt = "checked";
    result.why = findings.length
      ? findings.map((finding) => `${finding.file}: ${finding.id}`).join(", ")
      : (checked.stderr || "").trim().split("\n")[0];
    result.findings = findings;
    return result;
  }
  result.reached = "checked";

  // 2. Does it compile?
  const built = run(process.execPath, [cli, "build", directory, "--quiet"]);
  if (!built.ok) {
    result.failedAt = "built";
    result.why = (built.stderr || "").trim().split("\n").slice(-1)[0];
    return result;
  }
  result.reached = "built";

  // 3. Does it open, and can somebody use it?
  const tried = run(process.execPath, [
    harness,
    directory,
    "--do",
    JSON.stringify(prompt.try ?? []),
    ...(prompt.expect?.sql ? ["--sql", prompt.expect.sql] : []),
    "--json",
  ]);

  const report = tried.stdout ? JSON.parse(tried.stdout) : {};
  if (!report.mounted) {
    result.failedAt = "mounted";
    result.why = (report.problems ?? ["it never mounted"])[0];
    return result;
  }
  result.reached = "mounted";

  if (!report.saved) {
    result.failedAt = "usable";
    result.why = "nothing was saved: the data a person entered is not in the file";
    return result;
  }

  if (prompt.expect?.sql) {
    const rows = report.rows ?? [];
    const expected = prompt.expect.rows;
    const atLeast = prompt.expect.atLeast;

    const matched = expected
      ? JSON.stringify(rows) === JSON.stringify(expected)
      : atLeast !== undefined
        ? Number(rows[0]?.n ?? 0) >= atLeast
        : rows.length > 0;

    if (!matched) {
      result.failedAt = "usable";
      result.why = `the database does not look right: ${JSON.stringify(rows)}`;
      return result;
    }
  }

  result.reached = "usable";
  return result;
}

function main(argv) {
  const json = argv.includes("--json");
  const target = argv.find((token) => !token.startsWith("-"));
  if (!target) {
    process.stderr.write(
      "usage: node scripts/evaluate.mjs <candidates directory> [--json]\n" +
        "  one directory per prompt id, each holding the source a model wrote\n",
    );
    return 2;
  }

  const root = resolve(process.cwd(), target);
  if (!existsSync(root)) {
    process.stderr.write(`No candidates at ${root}.\n`);
    return 2;
  }

  const { prompts } = JSON.parse(readFileSync(join(repo, "eval", "prompts.json"), "utf8"));
  const results = [];

  for (const prompt of prompts) {
    const directory = join(root, prompt.id);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      // Recorded rather than skipped. A model that produced nothing for a
      // prompt failed that prompt, and quietly dropping it would score the
      // ones it managed and call that the rate.
      results.push({ id: prompt.id, reached: null, failedAt: "missing", why: "no candidate" });
      continue;
    }
    results.push(score(prompt, directory));
  }

  const usable = results.filter((result) => result.reached === "usable").length;
  const summary = {
    candidates: root,
    prompts: results.length,
    usable,
    rate: results.length ? Math.round((usable / results.length) * 100) : 0,
    byStage: Object.fromEntries(
      STAGES.map((stage) => [
        stage,
        results.filter((result) => STAGES.indexOf(result.reached) >= STAGES.indexOf(stage)).length,
      ]),
    ),
    results,
  };

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `${root}\n` +
      `  ${usable} of ${results.length} usable (${summary.rate}%)\n` +
      STAGES.map((stage) => `  ${stage.padEnd(8)} ${summary.byStage[stage]}`).join("\n") +
      "\n\n",
  );
  for (const result of results) {
    if (result.reached === "usable") continue;
    process.stdout.write(`  ${result.id}: failed at ${result.failedAt} — ${result.why}\n`);
  }

  return 0;
}

process.exit(main(process.argv.slice(2)));
