import { expect, test } from "@playwright/test";
// @ts-expect-error a plain ES module with no types
import { attemptsFrom, countsFrom, floorDrift, newestGreen, staleFloor } from "../scripts/count-floor.mjs";
// @ts-expect-error a plain ES module with no types
import { EXPECTED_JOBS } from "../scripts/ci-verdict.mjs";

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

  // Playwright prints a duration over a minute as "(1.0m)". Unstripped, it
  // stayed in the title, and so did the retry mark before it, so the two
  // attempts of one test were two tests (D198).
  test("a test that ran for minutes is one test, by its last attempt", () => {
    const slow = [
      `${job}  ✘     7 [webkit] › tests/d.spec.ts:2:1 › slow one (1.0m)`,
      `${job}  ✓     8 [webkit] › tests/d.spec.ts:2:1 › slow one (retry #1) (1.1m)`,
    ].join("\n");
    expect([...attemptsFrom(slow).values()]).toEqual([
      { project: "webkit", title: "tests/d.spec.ts:2:1 › slow one", passed: true },
    ]);
    expect(countsFrom(slow)).toEqual({ webkit: 1 });
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

/**
 * Which run the floor is measured against (3-M1, D246): the newest green run
 * whose commit is an ancestor of HEAD, on any branch, where green is every
 * gating job green. The floor read only the current branch's runs, per project,
 * so a branch's green run did not count once merged, and Firefox (a reading,
 * continue-on-error) made a run unusable for itself: one flaky Firefox test on
 * main sent its figure back to a September run, and main stayed red.
 */
test.describe("the run the floor is measured against", () => {
  type Job = { name: string; conclusion: string; databaseId: number; passes: Record<string, number> };
  type Run = { databaseId: number; headSha: string; headBranch: string; status: string; jobs: Job[] };

  const FIREFOX = `${EXPECTED_JOBS[0].replace("chromium", "firefox")})`;
  let id = 0;
  /** A run of every gating job and Firefox, each a success unless `failed` names it, with `passes` per job. */
  const runOf = (databaseId: number, headBranch: string, failed: string[], firefoxPasses = 800): Run => {
    const job = (name: string, passes: Record<string, number>): Job => ({
      name,
      conclusion: failed.some((f) => name.startsWith(f)) ? "failure" : "success",
      databaseId: ++id,
      passes,
    });
    const jobs = EXPECTED_JOBS.map((name: string) =>
      name.includes("chromium")
        ? job(`${name}, --project=node)`, { chromium: 805, node: 640 })
        : name.includes("webkit")
          ? job(`${name}, x)`, { webkit: 160 })
          : job(name, {}),
    );
    jobs.push(job(FIREFOX, { firefox: firefoxPasses }));
    return { databaseId, headSha: `c${databaseId}`, headBranch, status: "completed", jobs };
  };
  const lines = (passes: Record<string, number>) =>
    Object.entries(passes)
      .flatMap(([project, n]) => Array.from({ length: n }, (_, i) => `  ✓  ${i + 1} [${project}] › tests/t.spec.ts:${i + 1}:1 › t${i} (1ms)`))
      .join("\n");
  const read = (runs: Run[]) =>
    newestGreen(runs, { isAncestor: () => true, jobsOf: (run: Run) => run.jobs, logOf: (job: Job) => lines(job.passes) });
  const from = (run: number, counts: Record<string, number>) =>
    Object.fromEntries(Object.entries(counts).map(([project, count]) => [project, { count, run, sha: `c${run}` }]));

  test("the only green run is on a branch since merged: that run", () => {
    const runs = [
      runOf(3, "main", ["checks-fast", FIREFOX]),
      runOf(2, "review/merged", []),
      runOf(1, "main", [EXPECTED_JOBS[2]]),
    ];
    expect(read(runs)).toEqual(from(2, { chromium: 805, firefox: 800, webkit: 800, node: 640 }));
  });

  test("a run green except Firefox is green, and gives no Firefox figure", () => {
    const runs = [runOf(5, "main", [FIREFOX], 803), runOf(4, "main", [], 728)];
    const found = read(runs);
    expect(found).toEqual(from(5, { chromium: 805, webkit: 800, node: 640 }));
    const newest = Object.fromEntries(Object.entries(found).map(([p, s]) => [p, (s as { count: number }).count]));
    expect(floorDrift({ chromium: 805, firefox: 794, webkit: 800, node: 638 }, newest).above).toEqual([]);
  });

  test("a run not in HEAD's history, or lacking a gating job, is not the measure", () => {
    const lacking = runOf(8, "main", []);
    lacking.jobs = lacking.jobs.filter((job) => job.name !== "checks-holdout");
    const runs = [runOf(9, "elsewhere", []), lacking, runOf(7, "main", [])];
    const found = newestGreen(runs, {
      isAncestor: (sha: string) => sha !== "c9",
      jobsOf: (run: Run) => run.jobs,
      logOf: (job: Job) => lines(job.passes),
    });
    expect(found).toEqual(from(7, { chromium: 805, firefox: 800, webkit: 800, node: 640 }));
  });
});
