import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type Page } from "@playwright/test";
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

  test("a redraw while the keep sheet is open leaves it open, until the person answers it", async ({ browser }) => {
    const built = await compileDirectory({
      sourceDir: join(repo, "examples", "packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const file = join(mkdtempSync(join(tmpdir(), "dai-keep-redraw-")), "trip.dai.html");
    writeFileSync(file, built.html, "utf8");

    const device = await browser.newContext();
    const page = await device.newPage();
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#launch")).toBeHidden({ timeout: 60_000 });

    // The person asks: the menu, then Add to Home Screen.
    await page.locator("#more").click();
    await expect(page.locator("#sheet")).toBeVisible({ timeout: 15_000 });
    await page.locator("#keep-cta").click();
    await expect(page.locator("#keep-sheet"), "the sheet the person opened").toBeVisible({ timeout: 15_000 });

    // Whatever draws next: the page loads again and the document is described
    // again. The sheet was the person's, so it is there after.
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#launch")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator("#keep-sheet"), "still open after the redraw").toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3_000);
    await expect(page.locator("#keep-sheet"), "and it stays").toBeVisible();

    // Answered, it goes, and the next redraw does not bring it back.
    await page.locator("#keep-done").click();
    await expect(page.locator("#keep-sheet")).toBeHidden();
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await expect(page.locator("#keep-sheet"), "answered is answered").toBeHidden();

    await device.close();
  });

  /** A device with packing-list open and its keep sheet asked for, the way a person asks. */
  async function askedToKeep(
    browser: Browser,
    options: { installed?: boolean } = {},
  ): Promise<{ page: Page; uuid: string; file: string }> {
    const built = await compileDirectory({
      sourceDir: join(repo, "examples", "packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const file = join(mkdtempSync(join(tmpdir(), "dai-keep-ends-")), "trip.dai.html");
    writeFileSync(file, built.html, "utf8");
    const device = await browser.newContext();
    const page = await device.newPage();
    if (options.installed) {
      // Running as an installed app: `standalone()` reads display-mode first.
      await page.addInitScript(() => {
        const real = window.matchMedia.bind(window);
        window.matchMedia = ((query: string) =>
          query.includes("display-mode: standalone")
            ? ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList)
            : real(query)) as typeof window.matchMedia;
      });
    }
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#launch")).toBeHidden({ timeout: 60_000 });
    return { page, uuid: built.manifest.documentUuid, file };
  }

  const note = (page: Page) => page.evaluate((key) => sessionStorage.getItem(key), KEYS.KEEP_AFTER_RELOAD);

  async function pressKeep(page: Page): Promise<void> {
    await page.locator("#more").click();
    await expect(page.locator("#sheet")).toBeVisible({ timeout: 15_000 });
    await page.locator("#keep-cta").click();
    await expect(page.locator("#keep-sheet")).toBeVisible({ timeout: 15_000 });
  }

  test("the backdrop answers it: the note goes, and a reload does not bring the sheet back", async ({ browser }) => {
    const { page, uuid } = await askedToKeep(browser);
    await pressKeep(page);
    expect(await note(page), "asked, and written down").toBe(uuid);

    // Off the panel, at the top of the screen: the backdrop, where a person taps away.
    await page.locator("#keep-sheet").click({ position: { x: 10, y: 10 } });
    await expect(page.locator("#keep-sheet")).toBeHidden();
    expect(await note(page), "answered by the backdrop").toBeNull();
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await expect(page.locator("#keep-sheet")).toBeHidden();
    await page.context().close();
  });

  test("putting the document away ends the request", async ({ browser }) => {
    const { page, uuid } = await askedToKeep(browser);
    await pressKeep(page);
    expect(await note(page)).toBe(uuid);

    await page.evaluate(() => (window as unknown as { __runner: { eject(): void } }).__runner.eject());
    await expect(page.locator("#keep-sheet")).toBeHidden();
    expect(await note(page), "the document is gone, and the request with it").toBeNull();
    await page.context().close();
  });

  test("seen running installed, the request is over: no sheet, and the note is gone", async ({ browser }) => {
    /*
     * On iOS a person finishes in the Share sheet and never taps Done. The
     * request lasted, and the next time the document was described the sheet
     * came back for an app they already had. Running installed is the install.
     */
    const { page, uuid } = await askedToKeep(browser, { installed: true });
    await page.evaluate(([key, id]) => sessionStorage.setItem(key, id), [KEYS.KEEP_AFTER_RELOAD, uuid] as const);
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await expect(page.locator("#keep-sheet"), "nothing to ask an installed app").toBeHidden();
    expect(await note(page), "and nothing left to ask it later").toBeNull();
    await page.context().close();
  });
});
