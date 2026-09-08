import { expect, test } from "@playwright/test";

const RUNNER_URL = "http://localhost:5175/";

/**
 * What a shared document is called at the moment somebody installs it.
 *
 * `/d/<id>` and `/p/<id>` rewrite to the opener's own page, and the edge fills
 * a placeholder in its head with that document's title and apple-touch icon.
 * Those two tags are what iOS reads at Add to Home Screen, so they decide
 * whether an install of a shared document is that document or is the reader.
 *
 * The worker used to answer every navigation from the cached shell, which does
 * not have them — so the install was named and iconed as the reader. Only for
 * people who had used the opener before, though: a first-ever visitor has no
 * worker and reaches the edge, so the failure is invisible on a fresh device
 * and universal in the field. That asymmetry is why this is a test and not a
 * note.
 *
 * `describedAs` in the worker covers the other case — a home-screen icon for a
 * document this device holds — by reading a manifest it cached for that
 * document. It cannot cover this one: a reference link is for a document this
 * device has never held and has no manifest for.
 */
test.describe("the head a reference link arrives with", () => {
  test("survives an active worker, which is when the bug appeared", async ({ page, context }) => {
    test.slow();

    // The edge, stood in for: the dev server applies no rewrite and injects
    // nothing, so the per-document head is served here instead. What is under
    // test is which of the two the worker hands to the page, not who wrote it.
    // context.route, not page.route: the request under test is made by
    // the service worker, and page.route does not see those at all — a first
    // attempt with it silently measured the dev server instead.
    await context.route("**/d/*", async (route) => {
      const shell = await (await fetch(RUNNER_URL)).text();
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: shell
          .replace(/<title>[^<]*<\/title>/, "<title>Ledger</title>")
          .replace(
            /<link rel="apple-touch-icon"[^>]*>/,
            '<link rel="apple-touch-icon" href="/icons/ledger.png" />',
          ),
      });
    });

    // The visit that installs the worker and caches the generic shell. Every
    // real person who has opened the opener once is in this state.
    await page.goto(RUNNER_URL);
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 60_000,
    });
    await expect(page).not.toHaveTitle("Ledger");

    // Now a shared link, for a document this device has never held.
    await page.goto(`${RUNNER_URL}d/1f4a9c2e5b7d`);
    await expect(page).toHaveTitle("Ledger");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      "href",
      "/icons/ledger.png",
    );
  });

});
