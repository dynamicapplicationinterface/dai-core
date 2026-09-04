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

  test("the cache name carries a version", () => {
    // A change to this file under the same cache name leaves the old shell in
    // place for the new worker to serve.
    expect(worker).toMatch(/const CACHE = "dai-runner-v\d+"/);
    expect(worker).not.toContain('"dai-runner-v1"');
  });

  test("a page picks up a new worker rather than waiting for the next visit", () => {
    const app = readFileSync(resolve(repo, "apps/runner/src/main.ts"), "utf8");
    expect(app).toContain('addEventListener("controllerchange"');
    expect(app).toMatch(/location\.reload\(\)/);
  });
});
