import { expect, test } from "@playwright/test";
// @ts-expect-error a plain ES module with no types
import { jobFailed, tallyFrom } from "../scripts/ci-verdict.mjs";

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
