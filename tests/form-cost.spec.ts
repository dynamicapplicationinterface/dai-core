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

interface Opened {
  host: Phase[];
  container: Phase[];
}

async function open(page: import("@playwright/test").Page, file: string): Promise<Opened> {
  await page.goto(RUNNER_URL);

  /*
   * Cleared between measurements.
   *
   * The runner reopens whatever was last used, so a second measurement in the
   * same profile can be a measurement of the first container all over again —
   * which is exactly what this test did before it was written this way, and it
   * is why the two encodings first looked identical.
   */
  await page.evaluate(async () => {
    localStorage.clear();
    for (const name of await caches.keys()) await caches.delete(name);
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("dai_runner_storage");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });
  await page.reload();

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

  const container = (await collected.jsonValue()) as Phase[];
  const host = (await page.evaluate(
    () => (window as unknown as { __daiHostTimings?: Phase[] }).__daiHostTimings ?? [],
  )) as Phase[];

  return { host, container };
}

test.describe("what each form costs to open", () => {
  test.slow();

  test("reports both, so the difference decides which one a link points at", async ({ page }) => {
    const viewer = build(false);
    const sectioned = build(true);

    const viewerPhases = await open(page, viewer);
    const sectionedPhases = await open(page, sectioned);

    /*
     * Host and container, added together.
     *
     * The container cannot see what happened before it started, and for the
     * sectioned form that is not free — the manifest and the payload have to be
     * put back together before a shell can carry them. A measurement that
     * stopped at the container's own first mark would be optimising the visible
     * half.
     */
    const usable = (opened: Opened): number =>
      (opened.host.at(-1)?.at ?? 0) +
      opened.container.find((entry) => entry.phase === "interactive")!.at;

    const report = (name: string, file: string, opened: Opened): string =>
      `    ${name.padEnd(10)} ${(statSync(file).size / 1024).toFixed(0).padStart(4)} KB   ` +
      `usable ${usable(opened).toFixed(0).padStart(5)} ms   ` +
      `host [${opened.host.map((e) => `${e.phase} ${e.at.toFixed(0)}`).join(" ")}]   ` +
      `container [${opened.container.map((e) => `${e.phase} ${e.at.toFixed(0)}`).join(" ")}]`;

    console.log(
      "\n  the same application, two encodings\n" +
        report("viewer", viewer, viewerPhases) +
        "\n" +
        report("sectioned", sectioned, sectionedPhases) +
        "\n",
    );

    // Both must work. Which is faster is what the numbers are for; asserting a
    // margin here would be asserting a property of this machine.
    expect(usable(viewerPhases)).toBeGreaterThan(0);
    expect(usable(sectionedPhases)).toBeGreaterThan(0);

    // The one difference that is not a matter of degree: base64 inflates a
    // payload by a third, and the sectioned form does not carry one.
    expect(statSync(sectioned).size).toBeLessThan(statSync(viewer).size);
  });
});
