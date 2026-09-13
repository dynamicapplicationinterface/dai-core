import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * When the write rules cannot be adopted, the person is told which way it
 * failed.
 *
 * The frame checks the module the host sends against a digest compiled into
 * its own runtime, and refuses anything else. That is right, and it stays.
 * What was wrong is that it refused *silently*: three different failures — a
 * source that is not a string, a digest that does not match, and an `import()`
 * the browser will not perform — all ended as `mergeModule === null`, and the
 * only thing anybody saw was the application refusing its own first write with
 * `WRITE_SURFACE_UNAVAILABLE`.
 *
 * That code is accurate and useless. It names a consequence, raised in the
 * frame, of a disagreement between the host and the frame, and it left a
 * person on a phone with nothing to try and nothing to report. This is the
 * test that the reason now travels: frame → shell → host → screen.
 *
 * It matters most for the failure nobody can reproduce. A browser that will
 * not import a blob module, or a build whose two halves were stamped at
 * different times, are indistinguishable from each other and from a bug in the
 * application until something says which one happened.
 */
test.describe("the write rules are refused out loud", () => {
  test.slow();

  /*
   * No service worker, because the worker is what this test would otherwise be
   * measuring. `/runtime/` is in the worker's cache-first allowlist, so once it
   * holds `dai-merge.js` it serves that copy and a route interceptor never sees
   * the request — which made this test pass alone and fail in the file, for a
   * reason that had nothing to do with what it asserts.
   *
   * That is worth stating rather than working around quietly: it is the same
   * mechanism as a phone that keeps serving an old module across deploys, and
   * it reproduced here by accident.
   */
  test.use({ serviceWorkers: "block" });

  let container: string;

  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-refused-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
  });

  test("a module that is not the pinned one is named, with both digests", async ({ page, context }) => {
    /*
     * The exact shape of the field failure this exists for: the host serves a
     * merge module that is not the one this runtime was built against. Served
     * through `context.route` rather than `page.route`, because the fetch can
     * go through the service worker and `page.route` does not see those.
     */
    await context.route("**/runtime/dai-merge.*.js", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: "export const notTheRealModule = true;\n",
      });
    });

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").waitFor({ timeout: 60_000 });
    await page.locator("#card-open").click();

    // The host says it, not the frame, and it says which failure it was.
    await expect(page.locator("#report")).toContainText(/MERGE_MODULE_MISMATCH/, {
      timeout: 60_000,
    });
    // Both digests, so "which two things disagree" is answerable from a
    // screenshot rather than from a debugger.
    await expect(page.locator("#report")).toContainText(/got [0-9a-f]{16} expected [0-9a-f]{16}/);
    // And it is a sentence about what the person can and cannot do, not only a
    // code: the document opens and reads, it just cannot be changed.
    await expect(page.locator("#report")).toContainText(/read here but not changed/i);
  });

  test("a document that needs no rules is unaffected", async ({ page, context }) => {
    /*
     * The other half of the claim. A document with no replicated tables is
     * sent no rules, so it must never see this sentence — otherwise every
     * ordinary document would carry a warning about a feature it does not use.
     */
    const source = mkdtempSync(join(tmpdir(), "dai-plain-"));
    writeFileSync(
      join(source, "schema.sql"),
      "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
      "utf8",
    );
    writeFileSync(
      join(source, "index.html"),
      '<!doctype html><meta charset="utf-8"><title>Notes</title><p id="app">here</p>',
      "utf8",
    );
    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Notes" });
    const plain = join(source, "notes.dai.html");
    writeFileSync(plain, built.html, "utf8");

    await context.route("**/runtime/dai-merge.*.js", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: "export const x=1;\n" });
    });

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", plain);
    await page.locator("#card-open").waitFor({ timeout: 60_000 });
    await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    await expect(page.locator("#report")).not.toContainText(/MERGE_MODULE/);
    await expect(page.locator("#report")).not.toContainText(/not be changed/i);
  });
});
