import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ISOLATION_CLAUSES, verifyClaim } from "../src/host-profile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probe = resolve(repo, "conformance", "isolation-probe.dai.html");

/**
 * A host's word about itself, held against what the probe finds.
 *
 * A misconfigured host is silently insecure, and a host that self-reports is
 * only as honest as its configuration. So the claim is checked: the probe is
 * mounted in the host, and every clause the host said it applied must come
 * back blocked.
 */
test.describe("what a host claims", () => {
  const blocked = ISOLATION_CLAUSES.map((id) => ({ id, status: "blocked" as const }));

  test("a claim the probe confirms is fine", () => {
    expect(verifyClaim(ISOLATION_CLAUSES, blocked).ok).toBe(true);
  });

  test("a claim the probe finds open fails, and names the clause", () => {
    const results = blocked.map((r) => (r.id === "popup" ? { ...r, status: "allowed" as const } : r));
    const verdict = verifyClaim(ISOLATION_CLAUSES, results);
    expect(verdict.ok).toBe(false);
    expect(verdict.broken).toEqual(["popup"]);
  });

  test("a claim the probe cannot see is not a claim that can be trusted", () => {
    const verdict = verifyClaim([...ISOLATION_CLAUSES, "webrtc"], blocked);
    expect(verdict.ok).toBe(false);
    expect(verdict.unchecked).toEqual(["webrtc"]);
  });

  test("holding more than is claimed is allowed", () => {
    const verdict = verifyClaim(["origin", "shell"], blocked);
    expect(verdict.ok).toBe(true);
    expect(verdict.unclaimed).toContain("network");
  });
});

test.describe("the opener's claim, checked by the probe", () => {
  test.skip(!existsSync(probe), "run `npm run conformance` to build the probe");

  test("every clause the opener claims, the probe finds blocked", async ({ page }) => {
    await page.goto("http://localhost:5175/");
    await page.setInputFiles("#file", probe);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });

    // The shell passes the report up with the claim attached; the opener keeps
    // it where a harness can read it.
    const handle = await page.waitForFunction(
      () =>
        (window as unknown as { __runner: { isolationReport: unknown } }).__runner.isolationReport,
      undefined,
      { timeout: 30_000 },
    );
    const report = (await handle.jsonValue()) as {
      results: { id: string; status: "blocked" | "allowed" }[];
      hostProfile: string[];
    };

    // The claim reached the shell, and it is the one this host makes.
    expect(report.hostProfile).toEqual([...ISOLATION_CLAUSES]);

    const verdict = verifyClaim(report.hostProfile, report.results);
    expect(verdict.broken, `claimed but open: ${verdict.broken.join(", ")}`).toEqual([]);
    expect(verdict.unchecked).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
