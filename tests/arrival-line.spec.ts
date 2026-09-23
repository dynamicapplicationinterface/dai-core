import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { HINT_KEY } from "../src/link.js";
import { test } from "./fixtures.js";

const RUNNER_URL = "http://localhost:5175/";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The arrival line reads a `data:` manifest instead of printing it.
 *
 * A phone's panel showed the arrived manifest as its whole `data:` address:
 * fetching it was refused, because the opener's `connect-src` lists `'self'
 * https:` and no `data:`, and the fallback printed the address — the manifest's
 * bytes. The line says the manifest's name and where it launches, and nothing
 * else.
 */
test("a page that arrived with a data: manifest says its name and start_url, not its bytes", async ({ page }) => {
  const manifest = { name: "Beach trip", start_url: "/?name=Beach%20trip#u=probe", icons: [] };
  const address = "data:application/manifest+json," + encodeURIComponent(JSON.stringify(manifest));
  // Rewritten as the parser inserts it, so the page's own first read sees it.
  await page.addInitScript((href) => {
    new MutationObserver((records, observer) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLLinkElement && node.rel === "manifest") {
            node.setAttribute("href", href);
            observer.disconnect();
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  }, address);
  // The live policy's refusal. The local server sends no CSP, so without this
  // the test would pass on the code that printed the bytes.
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).startsWith("data:")
        ? Promise.reject(new TypeError("Refused to connect: connect-src"))
        : real(input, init)) as typeof window.fetch;
  });

  await page.goto(RUNNER_URL);
  const line = page.locator("#chooser-arrival");
  await expect(line).toContainText("arrived with Beach trip → /?name=Beach%20trip#u=probe", { timeout: 30_000 });
  await expect(line, "not the manifest's bytes").not.toContainText("data:");
});

test("a manifest that never answers does not hold the launch panel up", async ({ page }) => {
  /*
   * The panel is for a launch that has stalled, and asked for the arrived
   * manifest with no bound: on that same stalled page it could stay on
   * "gathering…", and the error ring with it.
   */
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const address = String(input instanceof Request ? input.url : input);
      if (!address.includes("manifest")) return real(input, init);
      // Never answers, until the caller gives up on it.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as typeof window.fetch;
  });
  await page.goto(RUNNER_URL);
  await page.evaluate((to) => {
    document.body.classList.add("launching");
    (window as unknown as { __runner: { guardLaunch(t: string): void } }).__runner.guardLaunch(to);
  }, `${RUNNER_URL}#${HINT_KEY}=11111111-1111-4111-8111-111111111111`);
  await page.locator("#launch-details-toggle").click({ timeout: 15_000 });
  const panel = page.locator("#launch-details");
  await expect(panel, "filled, with the manifest named as unreadable").toContainText(/arrived with: .*\(unreadable\)/, {
    timeout: 5_000,
  });
  await expect(panel).toContainText("trace (");
});

test("putting a document away takes its lines off the panel", async ({ page }) => {
  const built = await compileDirectory({ sourceDir: join(repo, "examples", "packing-list"), root: repo, appName: "Beach trip" });
  const file = join(mkdtempSync(join(tmpdir(), "dai-arrival-eject-")), "trip.dai.html");
  writeFileSync(file, built.html, "utf8");
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
  await page.locator("#card-open").click();
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  const line = page.locator("#chooser-arrival");
  await expect(line).toContainText("opened from a file or a link, opened here", { timeout: 15_000 });

  await page.evaluate(() => (window as unknown as { __runner: { eject(): void } }).__runner.eject());
  await expect(line, "nothing is open, so nothing was opened from anywhere").not.toContainText("opened from", {
    timeout: 15_000,
  });
  await expect(line).toContainText("iOS reload: not reached");
});

test("a manifest written as data: says why, on the launch panel, in the tab it happened in", async ({ page }) => {
  /*
   * The one writer of a data: manifest is the fallback for a cache that
   * refused, and a phone read one with nothing to say how. Which step refused,
   * and the error's own name and message, are kept for the panel.
   */
  await page.addInitScript(() => {
    // On the prototype: WebKit ignores an own property set on `caches`.
    CacheStorage.prototype.open = () =>
      Promise.reject(new DOMException("The operation is insecure.", "SecurityError"));
  });
  const built = await compileDirectory({ sourceDir: join(repo, "examples", "packing-list"), root: repo, appName: "Beach trip" });
  const file = join(mkdtempSync(join(tmpdir(), "dai-arrival-fallback-")), "trip.dai.html");
  writeFileSync(file, built.html, "utf8");
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
  await page.locator("#card-open").click();
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  await expect
    .poll(() => page.locator('link[rel="manifest"]').getAttribute("href"), { timeout: 15_000 })
    .toMatch(/^data:/);

  // Later in the same tab, on a launch that has stalled: the panel a phone reads.
  await page.evaluate(() => (window as unknown as { __runner: { eject(): void } }).__runner.eject());
  await page.evaluate((to) => {
    document.body.classList.add("launching");
    (window as unknown as { __runner: { guardLaunch(t: string): void } }).__runner.guardLaunch(to);
  }, `${RUNNER_URL}#${HINT_KEY}=11111111-1111-4111-8111-111111111111`);
  // The line a phone reads first, before any launch has stalled.
  await expect(page.locator("#chooser-arrival")).toContainText(
    "manifest as data: caches.open: SecurityError: The operation is insecure.",
    { timeout: 15_000 },
  );

  await page.locator("#launch-details-toggle").click({ timeout: 15_000 });
  const panel = page.locator("#launch-details");
  await expect(panel).toContainText("manifest written as data: caches.open: SecurityError: The operation is insecure.", {
    timeout: 5_000,
  });
  // And in the trace, beside the steps, so one screenshot carries the order.
  await expect(panel).toContainText(/manifest as data: caches.open: SecurityError/);
});
