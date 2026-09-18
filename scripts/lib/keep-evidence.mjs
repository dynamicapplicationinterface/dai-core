/**
 * A failed run's evidence, copied aside before anything can erase it (D47).
 *
 * Playwright clears `test-results/` at the start of every run, so the error
 * text, the snapshot and the trace of a failure die the moment anyone runs the
 * suite again. That is how `static-opener` failed several times in one week and
 * was called environmental without its error ever being read: the rerun that
 * passed destroyed the run that did not. "Remember to keep the directory" is a
 * rule that had already failed once, so the tier keeps it instead.
 *
 * Only on failure. A green run's results are not evidence of anything, and
 * keeping them would bury the one that matters. The newest few are kept and the
 * rest removed, so the folder never grows without bound.
 *
 * "Failed" means the push tier failed, not only that Playwright did. A gate
 * complaint already fails Playwright's result, but a gate that is absent — no
 * report written, or a project with no count — leaves Playwright exiting 0
 * while the run was never checked. That run is a failure too, and the keeper
 * first kept nothing for it. So the verdict is one function, `whyFailed`, and
 * the tier's exit and the keeper both read it: two places deciding "failed" is
 * how the keeper and the tier came to disagree.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How many failed runs are kept. Enough for a week of D47-style sightings. */
export const KEEP = 10;

/**
 * Every reason this run failed, in words; empty when it passed.
 *
 * @param {{ status: number, report: { checked?: boolean, passed?: Record<string, number>, complaints?: string[] } | null, projects: string[] }} run
 *   `report` is the count gate's `count-gate.json`, or null when it wrote none or it could not be read.
 * @returns {string[]}
 */
export function whyFailed({ status, report, projects }) {
  const reasons = [];
  if (status !== 0) reasons.push(`playwright exited ${status}`);
  if (!report) {
    reasons.push("the count gate did not report, so this run was not checked");
    return reasons;
  }
  const missing = projects.filter((project) => !(project in (report.passed ?? {})));
  if (missing.length > 0) reasons.push(`the count gate has no count for ${missing.join(", ")}`);
  if (!report.checked) reasons.push("the count gate did not check this run");
  if ((report.complaints ?? []).length > 0) reasons.push(`the count gate complained: ${report.complaints.join("; ")}`);
  return reasons;
}

/**
 * @param {{ results: string, into: string, reasons: string[], commit: string, when?: Date, note?: string }} run
 * @returns {string | undefined} where the evidence was kept, or undefined when there was nothing to keep
 */
export function keepEvidence({ results, into, reasons, commit, when = new Date(), note = "" }) {
  if (reasons.length === 0) return undefined;
  if (!existsSync(results)) return undefined;

  // Sortable by name: the stamp first, the commit after it.
  const stamp = when.toISOString().replace(/[:.]/g, "-");
  const kept = join(into, `${stamp}-${commit}`);
  mkdirSync(kept, { recursive: true });
  cpSync(results, join(kept, "test-results"), { recursive: true });
  writeFileSync(
    join(kept, "run.txt"),
    [`commit: ${commit}`, `when: ${when.toISOString()}`, ...reasons.map((reason) => `failed: ${reason}`), note]
      .filter(Boolean)
      .join("\n") + "\n",
  );

  const runs = readdirSync(into).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - KEEP))) {
    rmSync(join(into, old), { recursive: true, force: true });
  }
  return kept;
}

/**
 * `keepEvidence`, unable to throw.
 *
 * The keeper runs on the path to a failing exit. An exception inside it — a
 * full disk, a locked file on Windows — would leave the tier through the
 * exception instead of through its own verdict, and the failure it was keeping
 * would be reported as a crash in the keeper. So a failure to keep is caught
 * and returned, for the tier to say out loud, and the tier's exit is still its
 * own.
 *
 * @param {Parameters<typeof keepEvidence>[0]} run
 * @returns {{ kept?: string, error?: string }}
 */
export function keepEvidenceSafely(run) {
  try {
    return { kept: keepEvidence(run) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
