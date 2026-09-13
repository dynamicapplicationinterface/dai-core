import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * The menu offers the update; the load never asks for it.
 *
 * A stale shell — a cached opener a deploy or two behind — is the failure this
 * repository has been bitten by, and push delivery makes it worse: a
 * notification that opens yesterday's runtime against a moved protocol fails
 * with no visible cause. So the menu turns its build stamp into a one-tap update
 * when a newer build is live. The load-time guarantee it must not break is the
 * sharp one: a held document opens with zero network. So the check runs only on
 * the menu opening, and offline it says nothing and leaves the stamp.
 */
test.describe("the menu offers an update when a newer build is live", () => {
  let html: string;

  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/chore-chart"),
      root: repo,
      appName: "Chore chart",
    });
    html = built.html;
  });

  const openApp = async (page: Page): Promise<void> => {
    await page.goto(RUNNER_URL);
    await openFile(page, {
      name: "chore-chart.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(html, "utf8"),
    });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  };

  /** The commit the running shell reports, from its build stamp. */
  const runningCommit = (page: Page): Promise<string> =>
    page.evaluate(
      () =>
        document
          .querySelector('meta[name="dai-build"]')
          ?.getAttribute("content")
          ?.split("·")[0]
          ?.trim() ?? "",
    );

  const serveVersion = (context: BrowserContext, commit: string, asked?: () => void): Promise<void> =>
    context.route("**/version.json*", async (route) => {
      asked?.();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ commit }) });
    });

  test("a newer live build turns the stamp into a one-tap update", async ({ page, context }) => {
    let asked = 0;
    await serveVersion(context, "0000000deadbeefcafe", () => (asked += 1));

    await openApp(page);
    // The load-time guarantee: opening the document asked the network nothing
    // about the version.
    expect(asked, "version.json must not be fetched at load").toBe(0);

    await page.locator("#more").click();
    await expect(page.locator("#sheet-version")).toHaveText("New version — update", { timeout: 15_000 });
    expect(asked, "the menu open did the check").toBeGreaterThan(0);
    // It is a control, not a caption.
    await expect(page.locator("#sheet-version.update-available")).toBeVisible();
  });

  test("the matching live build shows the stamp, not an update", async ({ page, context }) => {
    await openApp(page);
    const running = await runningCommit(page);
    expect(running).toMatch(/^[0-9a-f]{7}$/);
    // The deployed commit shares this running one's prefix: the same build.
    await serveVersion(context, `${running}0123456789abcdef`);

    await page.locator("#more").click();
    // The stamp stays what it was; no update is offered.
    await expect(page.locator("#sheet-version")).toContainText(running);
    await expect(page.locator("#sheet-version")).not.toHaveText("New version — update");
    await expect(page.locator("#sheet-version.update-available")).toHaveCount(0);
  });

  test("offline, the menu says nothing and keeps the stamp", async ({ page, context }) => {
    await openApp(page);
    const running = await runningCommit(page);
    await context.setOffline(true);

    await page.locator("#more").click();
    await expect(page.locator("#sheet-version")).toContainText(running);
    await expect(page.locator("#sheet-version")).not.toHaveText("New version — update");

    await context.setOffline(false);
  });
});
