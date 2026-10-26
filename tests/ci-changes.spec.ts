import { expect, test } from "@playwright/test";
// @ts-expect-error a plain ES module with no types
import { decide, isProse, nearestGreen } from "../scripts/ci-changes.mjs";

/**
 * Whether a CI run needs the engine matrix (D296, scripts/ci-changes.mjs).
 * Prose skips it; prose a spec reads does not; and the diff is taken from the
 * nearest green ancestor, so a docs-only commit on top of a red run cannot
 * skip the jobs that were red.
 */
test.describe("what counts as prose", () => {
  test("docs/, website/docs/ and any .md file", () => {
    for (const path of ["docs/backlog.md", "docs/spec-v0.2.md", "website/docs/guide.md", "README.md", "apps/runner/README.md", "docs/figure.svg"]) {
      expect(isProse(path), path).toBe(true);
    }
    for (const path of ["src/kit.ts", "website/open.ts", "tests/README.mdx", ".github/workflows/test.yml", "docsite/x.ts"]) {
      expect(isProse(path), path).toBe(false);
    }
  });
});

test.describe("the decision", () => {
  test("prose that no spec reads is docs only", () => {
    expect(decide(["docs/backlog.md", "docs/handoff-2026-10-26.md"], ["check:build-conformance"])).toEqual({
      code: false,
      reason: "2 prose path(s), none read by a spec",
    });
  });

  test("an unchanged tree is docs only", () => {
    expect(decide([], [])).toEqual({ code: false, reason: "the tree is the green one" });
  });

  test("any path outside the prose is code", () => {
    const verdict = decide(["docs/backlog.md", "scripts/ci-changes.mjs"], []);
    expect(verdict.code).toBe(true);
    expect(verdict.reason).toContain("scripts/ci-changes.mjs");
  });

  test("prose a spec reads is code", () => {
    const verdict = decide(["website/docs/guide.md"], ["tests/rules.spec.ts"]);
    expect(verdict.code).toBe(true);
    expect(verdict.reason).toBe("prose a spec reads: tests/rules.spec.ts");
  });
});

test.describe("the green base", () => {
  // Commits c0 (head) .. c5, each one below the last; x is on another line.
  const distance = (sha: string) => (/^c\d$/.test(sha) ? Number(sha.slice(1)) : null);

  test("the nearest green ancestor, whatever order the runs are listed in", () => {
    const runs = [{ databaseId: 9, headSha: "x" }, { databaseId: 8, headSha: "c4" }, { databaseId: 7, headSha: "c2" }, { databaseId: 6, headSha: "c5" }];
    expect(nearestGreen(runs, distance)).toEqual({ sha: "c2", run: 7, distance: 2 });
  });

  test("none when no green run is an ancestor", () => {
    expect(nearestGreen([{ databaseId: 1, headSha: "x" }], distance)).toBeNull();
    expect(nearestGreen([], distance)).toBeNull();
  });

  test("a docs-only commit on a red run diffs from the last green tree, code included", () => {
    // c1 changed src and its run was red (so not listed); c0 is a prose commit on top.
    const base = nearestGreen([{ databaseId: 3, headSha: "c2" }], distance);
    expect(base.sha).toBe("c2");
    expect(decide(["src/kit.ts", "docs/backlog.md"], []).code).toBe(true);
  });
});
