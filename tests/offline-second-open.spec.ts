import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { CONFUSABLES_FILE } from "../src/confusables-id.js";
import { openFile } from "./open.js";
import { cutTheNetwork, WEBKIT_CANNOT_DRIVE_OFFLINE_NAV } from "./offline.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * The second open needs nothing.
 *
 * A container is offline software, and an opener that needs connectivity to
 * start would defeat it. The claim is not "it caches well" — it is that after
 * one visit, opening a document you already have asks the network for nothing
 * at all. Written as the person experiences it: the network is switched off,
 * and the app either comes back or it does not.
 *
 * Watching the request log would be the weaker test. A request served from the
 * worker's cache and a request that reached a server look alike from outside,
 * and a test that counted them would pass on a machine with a warm HTTP cache.
 * Switching the network off cannot be satisfied by a cache we did not mean.
 */
test.describe("opening a document you already have, with no network", () => {
  test("comes back on its own, engine and all", async ({ page, context, browserName }) => {
    test.skip(browserName === "webkit", WEBKIT_CANNOT_DRIVE_OFFLINE_NAV);
    test.slow();

    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/chore-chart"),
      root: repo,
      appName: "Chore chart",
    });

    // The first visit, which is the one that is allowed to use the network.
    await page.goto(RUNNER_URL);
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 60_000,
    });
    await openFile(page, {
      name: "chore-chart.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(built.html, "utf8"),
    });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    /*
     * Every request aborted from here on, and each one recorded. "Comes back on
     * its own" means nothing reaches the network — the service worker serves it
     * all from cache — so an aborting route proves the claim directly, and any
     * request at all becomes a named failure rather than an invisible one. See
     * tests/offline.ts for why this replaced offline emulation.
     */
    const net = await cutTheNetwork(context, page);
    await page.reload();

    // The document comes back by itself: an app that opened on an empty
    // chooser would have remembered nothing, whatever it had stored.
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(
      page.frameLocator("#cartridge").frameLocator("#dai-app").locator("body"),
    ).toContainText(/chore/i, { timeout: 60_000 });

    // The engine included, which is the megabyte that would otherwise be the
    // one thing standing between this and working on a train.
    expect(net.reached, net.summary()).toEqual([]);

    /*
     * And the confusable table is here, offline, without the page asking the
     * browser to prefetch it (D29). The prefetch link was both the escape —
     * Firefox sends a prefetch past the worker — and the only reason the table
     * was cached; the worker now names it itself. Both halves are held: no
     * prefetch in the page, and the table in the worker's cache.
     */
    await expect(page.locator('link[rel="prefetch"]')).toHaveCount(0);
    expect(
      await page.evaluate(async (name) => Boolean(await caches.match(new URL(name, location.href).href)), CONFUSABLES_FILE),
      "the confusable table is cached for an offline open",
    ).toBe(true);
  });
});
