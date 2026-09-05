import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = resolve(here, "fixture/fixture.dai.html");
const RUNNER_URL = "http://localhost:5175/";

/**
 * Looking inside a document before running it (backlog 1.5).
 *
 * The card says what a document claims about itself and what this host will
 * not let any document do. Neither of those is what is actually in the
 * archive, and until now somebody who wanted to know that had one option:
 * believe the card. The playground reads the same bytes, recomputes every
 * digest, checks the signature — and never mounts anything, which is why it is
 * a separate page and not a tab in this one.
 *
 * The document goes tab to tab by postMessage: no upload, no server, nothing
 * on the network.
 */
test.describe("look inside, before opening", () => {
  test("hands the same bytes to the playground, which reads them and does not run them", async ({
    page,
    context,
  }) => {
    test.slow();

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);

    // The card is up, and offers the way to check rather than take its word.
    const inspect = page.locator("#card-inspect");
    await expect(inspect).toBeVisible({ timeout: 60_000 });

    const [playground] = await Promise.all([
      context.waitForEvent("page"),
      inspect.click(),
    ]);
    await playground.waitForLoadState("domcontentloaded");

    // Same bytes, read on the other side: the file name and the verdict the
    // playground computed for itself.
    await expect(playground.locator(".file-meta")).toContainText("fixture", {
      timeout: 60_000,
    });

    // And it did not run it. The runner's frame is the thing that mounts a
    // document, and the playground has no such thing.
    expect(await playground.locator("#dai-app").count()).toBe(0);
    await expect(playground.locator("body")).not.toHaveClass(/loaded/);

    // The card is still up in the first tab: looking inside decided nothing.
    await expect(page.locator("#card")).toBeVisible();
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });
});
