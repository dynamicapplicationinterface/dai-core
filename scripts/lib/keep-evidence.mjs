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
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How many failed runs are kept. Enough for a week of D47-style sightings. */
export const KEEP = 10;

/**
 * @param {{ results: string, into: string, status: number, commit: string, when?: Date, note?: string }} run
 * @returns {string | undefined} where the evidence was kept, or undefined when there was nothing to keep
 */
export function keepEvidence({ results, into, status, commit, when = new Date(), note = "" }) {
  if (status === 0) return undefined;
  if (!existsSync(results)) return undefined;

  // Sortable by name: the stamp first, the commit after it.
  const stamp = when.toISOString().replace(/[:.]/g, "-");
  const kept = join(into, `${stamp}-${commit}`);
  mkdirSync(kept, { recursive: true });
  cpSync(results, join(kept, "test-results"), { recursive: true });
  writeFileSync(
    join(kept, "run.txt"),
    [`commit: ${commit}`, `when: ${when.toISOString()}`, `exit status: ${status}`, note].filter(Boolean).join("\n") + "\n",
  );

  const runs = readdirSync(into).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - KEEP))) {
    rmSync(join(into, old), { recursive: true, force: true });
  }
  return kept;
}
