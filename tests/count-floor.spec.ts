import { expect, test } from "@playwright/test";
// @ts-expect-error a plain ES module with no types
import { countsFrom, floorDrift, staleFloor } from "../scripts/count-floor.mjs";

/**
 * The floor is counted from CI's own lines as the count gate counts a run
 * (scripts/count-floor.mjs, pass C's H1): a test once, by its last attempt; a
 * retried test that passed counts; a skip, a failure and an expected failure
 * do not.
 */
test.describe("counting a CI job's passed tests", () => {
  const job = "a job\tUNKNOWN STEP\t2026-10-06T02:45:30Z ";
  const log = [
    `${job}  ✓     1 [chromium] › tests/a.spec.ts:3:1 › one (1.2s)`,
    `${job}  ✘     2 [chromium] › tests/a.spec.ts:9:1 › two (3.0s)`,
    `${job}  ✓     3 [chromium] › tests/a.spec.ts:9:1 › two (retry #1) (2.1s)`,
    `${job}  -     4 [chromium] › tests/b.spec.ts:5:1 › skipped here`,
    `${job}  ✘     5 [chromium] › tests/c.spec.ts:16:3 › expected to fail (162ms)`,
    `${job}  ✓     6 [node] › tests/n.spec.ts:4:1 › a node test (8ms)`,
    `${job}[WebServer] ✓ building client + server bundles...`,
    `${job}  3 passed (20.0m)`,
  ].join("\n");

  test("per project, by the last attempt", () => {
    expect(countsFrom(log)).toEqual({ chromium: 2, node: 1 });
  });

  test("a floor taken before a spec CI has run is stale", () => {
    expect(staleFloor("2026-10-04T23:55:46-04:00", "2026-10-05T09:00:00-04:00")).toBe(true);
    expect(staleFloor("2026-10-05T09:00:00-04:00", "2026-10-04T23:55:46-04:00")).toBe(false);
    expect(staleFloor(undefined, "2026-10-04T23:55:46-04:00"), "a floor with no record is stale").toBe(true);
  });
});

/**
 * The floor is a lower bound. Drift fails only on a floor above what the newest
 * completed green run passes for a project, a floor nobody could meet; a floor
 * below it is reported and passes. Regenerating is a chore, never what makes a
 * run green: the two runs of 7 October counted WebKit 800 and 801 on the same
 * tests, and a floor that had to equal the newest run flipped with whichever
 * one finished last.
 */
test.describe("the floor against the newest green run", () => {
  test("a floor above a project's newest count is drift", () => {
    const { above, below } = floorDrift({ chromium: 805, webkit: 801 }, { chromium: 805, webkit: 800 });
    expect(above).toEqual(["webkit: the floor is 801, above the 800 the newest green run passes"]);
    expect(below).toEqual([]);
  });

  test("a floor below a project's newest count is not drift", () => {
    const { above, below } = floorDrift({ chromium: 805, webkit: 800 }, { chromium: 805, webkit: 801 });
    expect(above).toEqual([]);
    expect(below).toEqual(["webkit: the floor is 800, 1 below the 801 the newest green run passes"]);
  });

  test("a project with no green run, or no floor, is neither", () => {
    expect(floorDrift({ firefox: 794 }, {})).toEqual({ above: [], below: [] });
    expect(floorDrift({}, { firefox: 794 })).toEqual({ above: [], below: [] });
  });
});
