import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * What each encoding costs to open, measured rather than argued.
 *
 * The cold-open breakdown put the largest single cost before the bootloader
 * runs at all — 77 ms of an 831 kB container, which is the browser parsing an
 * HTML document with a base64 payload inside a script tag, plus the base64
 * inflating the file by a third.
 *
 * The sectioned form has neither problem: it is bytes, read by a host that
 * already has them. If that difference is real it decides something — which
 * form a link should point at, and which one a runner should hand out — so it
 * is worth knowing rather than assuming.
 */
const build = (sectioned: boolean): string => {
  const dir = mkdtempSync(join(tmpdir(), "dai-form-"));
  const out = join(dir, sectioned ? "tasks.dai" : "tasks.dai.html");
  execFileSync(
    process.execPath,
    [
      join(repo, "dist", "bin.js"),
      "build",
      join(repo, "examples", "tasks"),
      "-o",
      out,
      "--quiet",
      ...(sectioned ? ["--dai"] : []),
    ],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  return out;
};

interface Phase {
  phase: string;
  at: number;
}

async function open(page: import("@playwright/test").Page, file: string): Promise<Phase[]> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });

  const collected = await page.waitForFunction(
    () => {
      const table = (window as unknown as { __daiTimings?: Phase[] }).__daiTimings;
      return table?.some((entry) => entry.phase === "interactive") ? table : null;
    },
    undefined,
    { timeout: 30_000 },
  );

  return (await collected.jsonValue()) as Phase[];
}

test.describe("what each form costs to open", () => {
  test.slow();

  test("reports both, so the difference decides which one a link points at", async ({ page }) => {
    const viewer = build(false);
    const sectioned = build(true);

    const viewerPhases = await open(page, viewer);
    const sectionedPhases = await open(page, sectioned);

    const interactive = (phases: Phase[]): number =>
      phases.find((entry) => entry.phase === "interactive")!.at;

    const report = (name: string, file: string, phases: Phase[]): string =>
      `    ${name.padEnd(10)} ${(statSync(file).size / 1024).toFixed(0).padStart(4)} KB   ` +
      `interactive ${interactive(phases).toFixed(0).padStart(5)} ms   ` +
      phases.map((entry) => `${entry.phase} ${entry.at.toFixed(0)}`).join("  ");

    console.log(
      "\n  the same application, two encodings\n" +
        report("viewer", viewer, viewerPhases) +
        "\n" +
        report("sectioned", sectioned, sectionedPhases) +
        "\n",
    );

    // Both must work. Which is faster is what the numbers are for; asserting a
    // margin here would be asserting a property of this machine.
    expect(interactive(viewerPhases)).toBeGreaterThan(0);
    expect(interactive(sectionedPhases)).toBeGreaterThan(0);

    // The one difference that is not a matter of degree: base64 inflates a
    // payload by a third, and the sectioned form does not carry one.
    expect(statSync(sectioned).size).toBeLessThan(statSync(viewer).size);
  });
});
