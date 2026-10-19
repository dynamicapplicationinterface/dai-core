import { expect, test } from "@playwright/test";
// @ts-expect-error a plain ES module with no types
import { sumParts } from "../scripts/count-parts.mjs";
// @ts-expect-error a plain ES module with no types
import { BROWSER_PARTS, EXPECTED_JOBS, COUNT_JOB, countArtifact } from "../scripts/ci-verdict.mjs";

/**
 * The count gate covers every shard (C8). A part's count is a fraction by
 * intent, so CI's count-gate job sums the parts' kept reports per project
 * and holds the sum to the floor (scripts/count-parts.mjs). Until 19 October
 * WebKit's parts were held by nothing, and the one whole Chromium job that
 * "covered" them is four shards now.
 */
test.describe("the sum of CI's parts", () => {
  const floor = { chromium: 800, node: 640, webkit: 800, firefox: 790, _from: { run: 1 } };
  /** A report per part: Chromium 200 a shard, node 640, WebKit 160 a part. */
  const reports = (): Map<string, unknown> =>
    new Map(
      BROWSER_PARTS.map((part: string) => {
        const project = /\((\w+),/.exec(part)![1];
        const passed = { [project]: project === "chromium" ? 200 : project === "node" ? 640 : 160 };
        return [countArtifact(part), { checked: false, passed, unexplained: [] }];
      }),
    );
  const sum = (map: Map<string, unknown>) => sumParts((artifact: string) => map.get(artifact), floor);

  test("every part at its share is the floor, and passes", () => {
    expect(sum(reports())).toEqual({ passed: { chromium: 800, node: 640, webkit: 800 }, complaints: [] });
  });

  test("one shard short is a project below its floor", () => {
    const map = reports();
    map.set("count-webkit-3", { checked: false, passed: { webkit: 159 }, unexplained: [] });
    const { complaints } = sum(map);
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toMatch(/^webkit: 799 passed, and this suite has held at least 800/);
  });

  test("a part that kept no report is red by name, never read as zero", () => {
    const map = reports();
    map.delete("count-chromium-2");
    const { complaints } = sum(map);
    expect(complaints[0]).toBe("count-chromium-2: no count report from that part, so the sum of the parts is not the suite's count.");
  });

  test("an unexplained skip in any part fails the sum", () => {
    const map = reports();
    map.set("count-webkit-mailbox", { checked: false, passed: { webkit: 160 }, unexplained: ["mailbox › one"] });
    expect(sum(map).complaints).toEqual([`skipped with no reason given: mailbox › one — use test.skip(condition, "why").`]);
  });

  test("each part's report has its own name, and the count job is in the gate", () => {
    const names = BROWSER_PARTS.map(countArtifact);
    expect(new Set(names).size).toBe(BROWSER_PARTS.length);
    expect(names).toContain("count-chromium-1");
    expect(names).toContain("count-node-whole");
    expect(names).toContain("count-webkit-mailbox");
    expect(EXPECTED_JOBS).toContain(COUNT_JOB);
  });
});
