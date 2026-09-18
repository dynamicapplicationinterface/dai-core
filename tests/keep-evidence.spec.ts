import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { keepEvidence, KEEP } = (await import(pathToFileURL(resolve(repo, "scripts/lib/keep-evidence.mjs")).href)) as {
  keepEvidence: (run: {
    results: string;
    into: string;
    status: number;
    commit: string;
    when?: Date;
    note?: string;
  }) => string | undefined;
  KEEP: number;
};

/**
 * A failed run keeps its own evidence (D47).
 *
 * The push tier calls this after the suite runs. Proved both ways, because a
 * keeper that kept every run would bury the failure in green runs, and one that
 * kept none would be the rule that already failed: a failure is kept whole, a
 * pass leaves nothing, and the folder stays bounded.
 */
function aFailedRun(): { results: string; into: string } {
  const root = mkdtempSync(join(tmpdir(), "dai-evidence-"));
  const results = join(root, "test-results", "static-opener-a-d-link-chromium");
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, "error.md"), "Error: expect(locator).toHaveClass(expected) failed\n");
  return { results: join(root, "test-results"), into: join(root, "test-runs") };
}

test.describe("the push tier's evidence of a failed run", () => {
  test("a failed run is kept whole, with what it was run on", () => {
    const { results, into } = aFailedRun();
    const kept = keepEvidence({ results, into, status: 1, commit: "b6ff876", when: new Date("2026-09-17T12:00:00Z") });

    expect(kept).toBeDefined();
    const error = join(kept!, "test-results", "static-opener-a-d-link-chromium", "error.md");
    expect(readFileSync(error, "utf8")).toContain("toHaveClass(expected) failed");
    const run = readFileSync(join(kept!, "run.txt"), "utf8");
    expect(run).toContain("commit: b6ff876");
    expect(run).toContain("exit status: 1");
  });

  test("a passing run keeps nothing", () => {
    const { results, into } = aFailedRun();
    expect(keepEvidence({ results, into, status: 0, commit: "b6ff876" })).toBeUndefined();
    expect(existsSync(into)).toBe(false);
  });

  test("the folder keeps the newest few and no more", () => {
    const { results, into } = aFailedRun();
    for (let i = 0; i < KEEP + 3; i++) {
      keepEvidence({ results, into, status: 1, commit: `c${i}`, when: new Date(Date.UTC(2026, 8, 17, 0, i)) });
    }
    const runs = readdirSync(into).sort();
    expect(runs).toHaveLength(KEEP);
    // The oldest three went; the newest is still here.
    expect(runs.some((name) => name.endsWith("-c0"))).toBe(false);
    expect(runs.at(-1)).toMatch(new RegExp(`-c${KEEP + 2}$`));
  });
});
