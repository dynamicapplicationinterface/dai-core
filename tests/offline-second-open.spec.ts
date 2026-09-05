import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

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
  test("comes back on its own, engine and all", async ({ page, context }) => {
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
    await page.setInputFiles("#file", {
      name: "chore-chart.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(built.html, "utf8"),
    });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    /*
     * Anything that reaches the network from here is a failure, whether or not
     * it is fatal. Recorded rather than asserted immediately so the report
     * names what asked, instead of only that something did.
     */
    const attempted: string[] = [];
    page.on("requestfailed", (request) => attempted.push(request.url()));

    await context.setOffline(true);
    await page.reload();

    // The document comes back by itself: an app that opened on an empty
    // chooser would have remembered nothing, whatever it had stored.
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(
      page.frameLocator("#cartridge").frameLocator("#dai-app").locator("body"),
    ).toContainText(/chore/i, { timeout: 60_000 });

    // The engine included, which is the megabyte that would otherwise be the
    // one thing standing between this and working on a train.
    expect(attempted, `these went to the network: ${attempted.join(", ")}`).toEqual([]);
  });
});
