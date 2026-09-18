import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Report = { checked?: boolean; passed?: Record<string, number>; complaints?: string[] } | null;
const { keepEvidence, keepEvidenceSafely, whyFailed, KEEP } = (await import(
  pathToFileURL(resolve(repo, "scripts/lib/keep-evidence.mjs")).href
)) as {
  keepEvidence: (run: { results: string; into: string; reasons: string[]; commit: string; when?: Date; note?: string }) =>
    | string
    | undefined;
  keepEvidenceSafely: (run: { results: string; into: string; reasons: string[]; commit: string }) => {
    kept?: string;
    error?: string;
  };
  whyFailed: (run: { status: number; report: Report; projects: string[] }) => string[];
  KEEP: number;
};

/**
 * A failed run keeps its own evidence (D47).
 *
 * The push tier calls this after the suite runs. Proved both ways, because a
 * keeper that kept every run would bury the failure in green runs, and one that
 * kept none would be the rule that already failed: a failure is kept whole, a
 * pass leaves nothing, and the folder stays bounded.
 *
 * "Failure" is the tier's, not only Playwright's. A gate complaint already fails
 * Playwright's result; what the keeper first missed was a gate that is absent —
 * no report, or a project with no count — while Playwright exits 0. A real run
 * with the gate reporter removed showed the tier now keeps that run. The
 * verdict still counts a complaint on its own, whatever Playwright said.
 */
function aFailedRun(): { results: string; into: string } {
  const root = mkdtempSync(join(tmpdir(), "dai-evidence-"));
  const results = join(root, "test-results", "static-opener-a-d-link-chromium");
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, "error.md"), "Error: expect(locator).toHaveClass(expected) failed\n");
  writeFileSync(join(root, "test-results", "count-gate.json"), '{"checked":false}\n');
  return { results: join(root, "test-results"), into: join(root, "test-runs") };
}

const PROJECTS = ["chromium", "node"];
const GATE_OK: Report = { checked: true, passed: { chromium: 697, node: 373 }, complaints: [] };

test.describe("the push tier's verdict", () => {
  test("a run Playwright passed and the gate checked has nothing wrong with it", () => {
    expect(whyFailed({ status: 0, report: GATE_OK, projects: PROJECTS })).toEqual([]);
  });

  test("a run Playwright passed and the count gate refused is a failure", () => {
    // Tests stopped being collected, and everything reported success.
    const refused = { ...GATE_OK, complaints: ["chromium ran 640, below the floor of 665"] };
    expect(whyFailed({ status: 0, report: refused, projects: PROJECTS })).toEqual([
      "the count gate complained: chromium ran 640, below the floor of 665",
    ]);
    expect(whyFailed({ status: 0, report: { ...GATE_OK, checked: false }, projects: PROJECTS })).toEqual([
      "the count gate did not check this run",
    ]);
    expect(whyFailed({ status: 0, report: { ...GATE_OK, passed: { chromium: 697 } }, projects: PROJECTS })).toEqual([
      "the count gate has no count for node",
    ]);
  });

  test("a run with no count-gate report is a failure", () => {
    expect(whyFailed({ status: 0, report: null, projects: PROJECTS })).toEqual([
      "the count gate did not report, so this run was not checked",
    ]);
  });
});

test.describe("the push tier's evidence of a failed run", () => {
  test("a failed run is kept whole, with what it was run on and why it failed", () => {
    const { results, into } = aFailedRun();
    const kept = keepEvidence({
      results,
      into,
      reasons: ["playwright exited 1"],
      commit: "b6ff876",
      when: new Date("2026-09-17T12:00:00Z"),
    });

    expect(kept).toBeDefined();
    const error = join(kept!, "test-results", "static-opener-a-d-link-chromium", "error.md");
    expect(readFileSync(error, "utf8")).toContain("toHaveClass(expected) failed");
    const run = readFileSync(join(kept!, "run.txt"), "utf8");
    expect(run).toContain("commit: b6ff876");
    expect(run).toContain("failed: playwright exited 1");
  });

  test("a count-gate failure keeps the gate's own report, which the next run would erase", () => {
    const { results, into } = aFailedRun();
    const reasons = whyFailed({ status: 0, report: { checked: false }, projects: PROJECTS });
    const kept = keepEvidence({ results, into, reasons, commit: "7abb896" });

    expect(kept).toBeDefined();
    expect(readFileSync(join(kept!, "test-results", "count-gate.json"), "utf8")).toContain('"checked":false');
    expect(readFileSync(join(kept!, "run.txt"), "utf8")).toContain("failed: the count gate");
  });

  test("a passing run keeps nothing", () => {
    const { results, into } = aFailedRun();
    const reasons = whyFailed({ status: 0, report: GATE_OK, projects: PROJECTS });
    expect(keepEvidence({ results, into, reasons, commit: "b6ff876" })).toBeUndefined();
    expect(existsSync(into)).toBe(false);
  });

  test("a failure to keep is returned, not thrown out of the tier", () => {
    const { results } = aFailedRun();
    // A path under a file: nothing can be written there.
    const blocker = join(mkdtempSync(join(tmpdir(), "dai-evidence-")), "a-file");
    writeFileSync(blocker, "");
    const outcome = keepEvidenceSafely({ results, into: join(blocker, "test-runs"), reasons: ["playwright exited 1"], commit: "x" });
    expect(outcome.kept).toBeUndefined();
    expect(outcome.error).toBeTruthy();
  });

  test("the folder keeps the newest few and no more", () => {
    const { results, into } = aFailedRun();
    for (let i = 0; i < KEEP + 3; i++) {
      keepEvidence({ results, into, reasons: ["playwright exited 1"], commit: `c${i}`, when: new Date(Date.UTC(2026, 8, 17, 0, i)) });
    }
    const runs = readdirSync(into).sort();
    expect(runs).toHaveLength(KEEP);
    // The oldest three went; the newest is still here.
    expect(runs.some((name) => name.endsWith("-c0"))).toBe(false);
    expect(runs.at(-1)).toMatch(new RegExp(`-c${KEEP + 2}$`));
  });
});
