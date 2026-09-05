import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = resolve(here, "fixture/fixture.dai.html");
const RUNNER_URL = "http://localhost:5175/";

/**
 * Propagation is counted at the relay, or it is not counted (backlog 5.2).
 *
 * Somebody running a store can see how many distinct times each `/d/<id>` was
 * fetched, because serving a file is a request and a request is a log line.
 * That is a real number, it belongs to whoever runs the store, and it says
 * nothing about what is in the document — the store holds ciphertext and never
 * holds the key.
 *
 * Everything else is a beacon. An opener that reported an open, a session, a
 * document name, or "just an anonymous count" would be a program that phones
 * home about a file somebody was sent, and no amount of care about what it
 * sends changes what it is. There is no analytics endpoint to configure off,
 * because there is none to configure.
 *
 * The rule is easy to hold and easy to lose: one script tag, one font, one
 * error reporter, and the property is gone with nobody noticing. So it is a
 * test, and it watches every request the page makes rather than a list of
 * hosts somebody remembered to update.
 */
test.describe("the opener tells nobody anything", () => {
  test("opens a document without a single request off its own origin", async ({ page }) => {
    test.slow();

    const offOrigin: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      // Its own origin, and the two schemes a document is assembled through.
      if (url.origin === new URL(RUNNER_URL).origin) return;
      if (url.protocol === "blob:" || url.protocol === "data:" || url.protocol === "about:") return;
      offOrigin.push(`${request.method()} ${request.url()}`);
    });

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // The document is running. Give anything deferred — an idle callback, a
    // "report once the page is quiet" — a chance to fire before believing it.
    await page.waitForTimeout(2_000);

    expect(
      offOrigin,
      `the opener reached: ${offOrigin.join(", ")}`,
    ).toEqual([]);
  });

  test("carries no analytics, no error reporter and no third-party script", async ({ page }) => {
    await page.goto(RUNNER_URL);
    const head = await page.evaluate(() => document.documentElement.outerHTML);

    for (const beacon of [
      "google-analytics",
      "googletagmanager",
      "plausible",
      "posthog",
      "segment.com",
      "sentry",
      "hotjar",
      "mixpanel",
      "navigator.sendBeacon",
    ]) {
      expect(head.toLowerCase(), `the opener should not carry ${beacon}`).not.toContain(
        beacon.toLowerCase(),
      );
    }

    // Nothing is loaded from anywhere else either — a script that arrives from
    // another origin can add all of the above after this test has looked.
    const external = await page.evaluate(() =>
      [...document.querySelectorAll("script[src], link[rel=stylesheet], img[src]")]
        .map((element) => element.getAttribute("src") ?? element.getAttribute("href") ?? "")
        .filter((value) => /^https?:\/\//i.test(value) && !value.startsWith(location.origin)),
    );
    expect(external, `loaded from elsewhere: ${external.join(", ")}`).toEqual([]);
  });
});
