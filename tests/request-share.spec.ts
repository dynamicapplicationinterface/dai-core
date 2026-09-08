import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * An application's own Share button, wired to the host's own sheet.
 *
 * `window.dai.requestShare()` opens the same sheet the host's "Share app" menu
 * item does, relayed app to shell to host by session nonce the way
 * `dai:save-state` already is. It carries nothing of the application's
 * choosing — no name, no data, no answer to "include data" — because there is
 * nothing to carry: the host reads the document it already mounted, and the
 * sheet asks the person the same question it always asks.
 */
test.describe("an application's own share button", () => {
  test("opens the host's sheet, and the person still chooses and still presses Send", async ({ page }) => {
    const source = mkdtempSync(join(tmpdir(), "dai-request-share-"));
    writeFileSync(
      join(source, "index.html"),
      '<!doctype html><meta charset="utf-8">' +
        '<button id="app-share">Share</button>' +
        "<script>document.getElementById('app-share').onclick = () => window.dai.requestShare();</script>",
      "utf8",
    );
    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Shareable" });
    const file = join(source, "shareable.dai.html");
    writeFileSync(file, built.html, "utf8");

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // Nothing sent, nothing open, before the button is pressed.
    await expect(page.locator("#send-sheet")).toBeHidden();

    const app = page.frameLocator("#cartridge").frameLocator("#dai-app");
    await app.locator("#app-share").click();

    // The host's own sheet — same card, same name — not a substitute.
    await expect(page.locator("#send-sheet")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#send-title")).toContainText("Shareable");
    // The choice is still there, and still the person's to make.
    const withData = page.locator("#send-with-data");
    await expect(withData).toBeVisible();
    await expect(withData).toBeChecked();

    // No send happens on its own: the sheet sits open until Send is pressed.
    await page.waitForTimeout(500);
    await expect(page.locator("#send-sheet")).toBeVisible();

    await withData.uncheck();
    await page.click("#send-go");
    await expect(page.locator("#send-sheet")).toBeHidden({ timeout: 15_000 });
  });

  test("a message claiming to be the request, from a window that is not the mounted frame, is ignored", async ({
    page,
  }) => {
    const source = mkdtempSync(join(tmpdir(), "dai-request-share-forge-"));
    writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><p id="app">here</p>', "utf8");
    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Quiet" });
    const file = join(source, "quiet.dai.html");
    writeFileSync(file, built.html, "utf8");

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // Posted straight at the host, skipping the shell that mints the nonce —
    // the shape a forgery from an unrelated window would take.
    await page.evaluate(() => {
      window.postMessage({ type: "DAI_HOST_REQUEST_SHARE", sessionNonce: "not-a-real-one" }, "*");
    });
    await page.waitForTimeout(500);
    await expect(page.locator("#send-sheet")).toBeHidden();
  });
});
