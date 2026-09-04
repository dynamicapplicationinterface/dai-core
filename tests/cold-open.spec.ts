import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/*
 * A container carrying the engine, which is the only kind worth timing: it is
 * 850 kB against 60 kB without, and the whole question is what a person waits
 * for. Copied to a name the browser will render — a `.dai` over file:// is
 * offered as a download rather than opened, which is what the sectioned form is
 * for and not what this measures.
 */
const CONTAINER = (() => {
  const source = resolve(repo, "website", "public", "sample-intact.dai");
  const file = join(mkdtempSync(join(tmpdir(), "dai-cold-")), "sample.dai.html");
  copyFileSync(source, file);
  return file;
})();

interface Phase {
  phase: string;
  at: number;
  took: number;
}

/**
 * Seconds from tap to interactive, which is the number this has to win on.
 *
 * A container on a phone competes with a web page, and nobody waits for a
 * document. The costs are not obvious from reading the code: an 850 kB
 * WebAssembly instantiate looks like the expensive part, and decoding base64,
 * inflating a zip and digesting every entry before anything may run are all
 * candidates. Guessing which is which is how the wrong thing gets optimised.
 *
 * So this measures, prints the breakdown, and holds a ceiling. The ceiling is
 * generous on purpose: a desktop CI runner is not the phone the target is
 * written against, and a budget that fails on a busy machine teaches people to
 * rerun it rather than to read it.
 *
 * The target, agreed rather than assumed: under two seconds to interactive on a
 * mid-range Android over cellular, with nothing cached. That is not what this
 * measures — no CI runner can — so this exists to catch regressions of the kind
 * that would be visible anywhere, and to publish where the time goes so the
 * phone measurement has somewhere to start.
 */
const CEILING_MS = 8000;

test.describe("cold open", () => {
  test("reports where the time goes, and stays under the ceiling", async ({ page }) => {
    test.slow();

    await page.goto(pathToFileURL(CONTAINER).href);
    await expect(page.locator("body")).toHaveClass(/dai-mounted/, { timeout: 30_000 });

    const phases = (await page.evaluate(
      () => (window as unknown as { __DAI__: { timings: Phase[] } }).__DAI__.timings,
    )) as Phase[];

    // Printed rather than only asserted: the point of the harness is the shape
    // of the breakdown, and a number nobody sees is a number nobody improves.
    const table = phases.map((p) => `${p.phase.padEnd(12)} +${String(p.took).padStart(7)}ms`);
    console.log(
      `\n  cold open — ${(readFileSync(CONTAINER).byteLength / 1024).toFixed(0)} KB container\n` +
        table.map((line) => `    ${line}`).join("\n") +
        `\n    ${"total".padEnd(12)} ${String(phases[phases.length - 1]?.at ?? 0).padStart(8)}ms\n`,
    );

    // Every phase on the path to interactive, in the order it must have them.
    // The engine may follow, and does; it is asserted separately below.
    expect(phases.map((p) => p.phase).slice(0, 7)).toEqual([
      "boot",
      "decoded",
      "unzipped",
      "digests",
      "signature",
      "frame",
      "interactive",
    ]);

    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]!.at, `${phases[i]!.phase} came before ${phases[i - 1]!.phase}`)
        .toBeGreaterThanOrEqual(phases[i - 1]!.at);
    }

    const total = phases.find((p) => p.phase === "interactive")!.at;
    expect(total, `interactive took ${total}ms`).toBeLessThan(CEILING_MS);
  });

  test("the engine is not on the path to being interactive", async ({ page }) => {
    /*
     * Worth asserting rather than believing. The engine starts when the
     * application first asks for the database, which for most applications is
     * after they have painted — so the largest thing in the container is not
     * what the person is waiting for, and optimising it first would have been
     * effort spent off the critical path.
     *
     * If an application does open the database before it paints, this fails,
     * and the failure is informative rather than a bug.
     */
    await page.goto(pathToFileURL(CONTAINER).href);
    await expect(page.locator("body")).toHaveClass(/dai-mounted/, { timeout: 30_000 });

    const phases = (await page.evaluate(
      () => (window as unknown as { __DAI__: { timings: Phase[] } }).__DAI__.timings,
    )) as Phase[];

    const interactive = phases.findIndex((p) => p.phase === "interactive");
    const engine = phases.findIndex((p) => p.phase === "engine");

    expect(interactive).toBeGreaterThan(-1);
    if (engine > -1) expect(engine).toBeGreaterThan(interactive);
  });

  test("a host is handed the breakdown, not just the verdict", async ({ page }) => {
    // A container cannot compare one open against another; only whatever
    // mounted it can. So the table travels with the handshake.
    // Written to disk rather than set as content: a file:// frame will not load
    // inside a document that has no origin of its own.
    const host = join(dirname(CONTAINER), "host.html");
    writeFileSync(
      host,
      `<!doctype html><meta charset="utf-8">
       <iframe id="f" src="${pathToFileURL(CONTAINER).href}"></iframe>
       <script>
         window.timings = null;
         window.addEventListener("message", (event) => {
           const data = event.data;
           if (data && data.type === "DAI_HOST_HANDSHAKE") window.timings = data.payload.timings;
         });
       </script>`,
    );
    await page.goto(pathToFileURL(host).href);

    const handed = await page.waitForFunction(
      () => (window as unknown as { timings: Phase[] | null }).timings,
      undefined,
      { timeout: 30_000 },
    );

    const phases = (await handed.jsonValue()) as Phase[];
    expect(phases.length).toBeGreaterThanOrEqual(6);
    expect(phases.some((p) => p.phase === "digests")).toBe(true);
  });
});
