import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { KEYS } from "../src/keys.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * Asking to keep a document survives the load it causes (D87).
 *
 * On iOS, Keep reloads the page at the document's own launch address — the load
 * is what makes the icon the document's rather than the opener's — and leaves a
 * note in session storage asking for the instructions once the page is back.
 * `describe()` reads the note and shows the sheet.
 *
 * A load can be two loads. The first time a document opens on a device, the
 * opener mounts it once behind the launch screen to learn its colour, then makes
 * a real load to an address that carries the colour — and each of those
 * describes the document. D87 suspected the first `describe()` would consume the
 * note on the page about to be replaced, leaving the load that counted with
 * nothing. Tested here, it does not: the sheet is on the final screen and stays.
 * The walk's failure was D88. This test guards the case anyway — proved to go
 * red when the pending sheet is never shown.
 */
test.describe("asking to keep a document", () => {
  test.slow();

  test("the instructions a person asked for are there after the load that follows", async ({ browser }) => {
    const built = await compileDirectory({
      sourceDir: join(repo, "examples", "packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const file = join(mkdtempSync(join(tmpdir(), "dai-keep-intent-")), "trip.dai.html");
    writeFileSync(file, built.html, "utf8");

    const device = await browser.newContext();
    const page = await device.newPage();
    const describes: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("dai: ")) describes.push(message.text());
    });

    /*
     * The state Keep leaves behind: the note, written before a load. Set here
     * directly rather than by pressing Keep, because what is under test is what
     * the loads that follow do with it, and pressing Keep on a first open is
     * exactly the two-load case — the first time on a device, with nothing
     * remembered about the document's colour.
     */
    await page.goto(RUNNER_URL);
    await page.evaluate(
      ([key, uuid]) => sessionStorage.setItem(key, uuid),
      [KEYS.KEEP_AFTER_RELOAD, built.manifest.documentUuid] as const,
    );

    await page.setInputFiles("#file", file);
    await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#launch")).toBeHidden({ timeout: 60_000 });

    // The instructions are on the screen the person is looking at.
    await expect(page.locator("#keep-sheet"), "the sheet the person asked for, after the loads").toBeVisible({
      timeout: 30_000,
    });
    // And they stay: nothing that draws after this takes them away.
    await page.waitForTimeout(3_000);
    await expect(page.locator("#keep-sheet"), "still there a moment later").toBeVisible();

    // Answered, the note is gone — so it does not come back on its own.
    await page.locator("#keep-done").click();
    await expect(page.locator("#keep-sheet")).toBeHidden();
    const left = await page.evaluate((key) => sessionStorage.getItem(key), KEYS.KEEP_AFTER_RELOAD);
    expect(left, "answering the sheet is what ends the request").toBeNull();

    await device.close();
  });
});
