import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Whether a deploy of the opener reaches anyone who has used it before.
 *
 * It did not. The service worker served the shell cache-first under a fixed
 * name and never itself changed, so a browser that had visited once kept the
 * first build it ever saw. The website was handing documents to an opener
 * from weeks earlier that could not receive them, and the symptom — an empty
 * chooser — said nothing about why. Every test passed, because every test
 * ran against a fresh browser.
 *
 * A worker's update cycle is not something a page test can drive, so this
 * reads the worker and holds its shape.
 */
test.describe("the opener updates", () => {
  const worker = readFileSync(resolve(repo, "apps/runner/public/sw.js"), "utf8");

  test("the shell is fetched from the network before the cache", () => {
    // The navigation branch must reach for the network and fall back to the
    // cache, not the other way round.
    const shell = worker.slice(worker.indexOf("isShell"));
    expect(shell).toMatch(/fromNetwork\(\)\s*\.catch\(/);
  });

  test("the cache name is the build's, not a number somebody bumps", () => {
    /*
     * This asserted `dai-runner-v\d+` — a hand-bumped version — and a
     * hand-bumped version is a promise somebody has to remember to break. It
     * went unbumped across every deploy of a day's work, so the worker's bytes
     * never changed, the browser never reinstalled it, and the precached shell
     * was served from cache through all of them. A phone reported a build two
     * deploys behind while production served the fix it was waiting for, and
     * every test passed, because every test starts a fresh browser.
     *
     * So the source carries a marker and the build replaces it with the
     * commit. Both halves are held: the marker in the source, so the build has
     * something to stamp, and the commit in the built worker, so a deploy is
     * a new worker by construction.
     */
    expect(worker).toContain('const BUILD = "__DAI_BUILD__"');
    expect(worker).not.toMatch(/const CACHE = "dai-runner-v\d+"/);

    const built = readFileSync(resolve(repo, "apps/runner/dist/sw.js"), "utf8");
    expect(built).toMatch(/const BUILD = "[0-9a-f]{40}"/);
    expect(built).not.toContain("__DAI_BUILD__");
  });

  test("a page picks up a new worker rather than waiting for the next visit", () => {
    const app = readFileSync(resolve(repo, "apps/runner/src/main.ts"), "utf8");
    expect(app).toContain('addEventListener("controllerchange"');
    expect(app).toMatch(/location\.reload\(\)/);
  });
});
