import { expect } from "@playwright/test";
import { test } from "./fixtures.js";

const RUNNER_URL = "http://localhost:5175/";

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
