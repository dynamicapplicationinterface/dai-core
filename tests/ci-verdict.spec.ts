import { expect, test } from "@playwright/test";
// @ts-expect-error a plain ES module with no types
import { CHECKS_JOBS, EXPECTED_JOBS, gateLine, jobFailed, missingJobs, tallyFrom } from "../scripts/ci-verdict.mjs";

/**
 * A job that did not finish is not a pass, whatever it printed (pass C's H2).
 *
 * The verdict read FAIL only on the conclusion `failure`, no tally, or a
 * failed count. A job cancelled at its wall, or timed out, whose log held any
 * "N passed" (a shard's earlier lines, a retry's) read PASS, though it never
 * reached its own summary. A conclusion other than success is a failure; the
 * tally only adds reasons.
 */
test.describe("the verdict on one job", () => {
  const printed = "  812 passed (24.9m)\n";

  for (const conclusion of ["cancelled", "timed_out", "failure", "startup_failure", "action_required", "stale"]) {
    test(`${conclusion} is FAIL even with a tally that says passed`, () => {
      expect(jobFailed({ conclusion }, tallyFrom(printed))).toBe(true);
    });
  }

  test("success with a clean tally is a pass", () => {
    expect(jobFailed({ conclusion: "success" }, tallyFrom(printed))).toBe(false);
  });

  test("success with no tally, or a failed count, is FAIL", () => {
    expect(jobFailed({ conclusion: "success" }, tallyFrom("no summary here"))).toBe(true);
    expect(jobFailed({ conclusion: "success" }, tallyFrom("  3 failed\n  800 passed\n"))).toBe(true);
  });
});

/**
 * The summary names the red jobs and only those (pass C's M4). It said "RED on
 * chromium, webkit and checks" when only checks was red, and the checks job is
 * four jobs now (8 October), each of which must be in a run that has any.
 */
test.describe("the summary line", () => {
  test("names only the jobs that are red", () => {
    expect(gateLine("completed", ["checks-properties-python"])).toBe(
      "gate: RED on checks-properties-python; firefox above is a reading",
    );
    expect(gateLine("completed", [])).toBe("gate: green on chromium, webkit and every checks job; firefox above is a reading");
    expect(gateLine("in_progress", ["checks-fast"])).toBe("gate: not finished (in_progress)");
  });

  test("a run with some of the four checks jobs must have all four", () => {
    expect(missingJobs([...EXPECTED_JOBS.filter((name: string) => !CHECKS_JOBS.includes(name)), "checks-fast", "checks-holdout", "checks-properties-node"])).toEqual(["checks-properties-python"]);
    expect(missingJobs(EXPECTED_JOBS)).toEqual([]);
  });
});

/**
 * The gate is red unless every expected job is in the run (3-H2). A job that
 * is absent gave no verdict: the four checks jobs were held to that only when
 * one of them was present, so a run with no jobs, or no checks jobs, read
 * green on the line the gate is read from.
 */
test.describe("a run lacking an expected job", () => {
  // A job's name as test.yml gives it: the expected start, then its matrix values.
  const named = (expected: string) => (CHECKS_JOBS.includes(expected) ? expected : `${expected}, x)`);

  test("a run with no jobs is red on every expected job", () => {
    expect(missingJobs([])).toEqual(EXPECTED_JOBS);
    expect(gateLine("completed", missingJobs([]))).toMatch(/^gate: RED on /);
  });

  test("a run missing checks-holdout is red on checks-holdout", () => {
    const names = EXPECTED_JOBS.filter((name: string) => name !== "checks-holdout").map(named);
    expect(missingJobs(names)).toEqual(["checks-holdout"]);
    expect(gateLine("completed", missingJobs(names))).toBe("gate: RED on checks-holdout; firefox above is a reading");
  });

  test("a run with only its chromium job is red on the rest", () => {
    expect(missingJobs([named(EXPECTED_JOBS[0])])).toEqual(EXPECTED_JOBS.slice(1));
  });

  test("a run with every expected job lacks none", () => {
    expect(missingJobs(EXPECTED_JOBS.map(named))).toEqual([]);
  });
});
