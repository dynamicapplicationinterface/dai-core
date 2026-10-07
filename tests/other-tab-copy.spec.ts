import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { HINT_KEY } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * Save a copy, in the tab that lost a document to another tab (pass B's B1).
 *
 * A tab whose save is refused because another tab saved the document since it
 * was opened was told to use Save a copy to keep its changes. Save a copy
 * flushed first (the flush's save is refused the same way) and then packaged
 * the stored copy, which is the *other* tab's: a file was made, and the
 * changes it promised to keep were not in it. On a replicated document the
 * flush refused the copy outright, with "try again in a moment", a moment that
 * never comes in that tab.
 *
 * Now the copy is this tab's own bytes, asked of the frame that holds them,
 * and checked as any bytes leaving are (docs/identity.md, rule 3): a change of
 * this device's that was never signed does not leave, and the sentence says
 * why and that closing the other tab is what lets this one go on. Moving the
 * document from one tab to the other is later work (Phase 1.4).
 */
test.describe("Save a copy after another tab saved the document", () => {
  test.slow();

  let packing: string;
  let chess: string;
  test.beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dai-other-tab-"));
    const one = await compileDirectory({ sourceDir: join(repo, "examples", "packing-list"), root: repo, appName: "Beach trip" });
    const two = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
    packing = join(dir, "packing.dai.html");
    chess = join(dir, "chess.dai.html");
    writeFileSync(packing, one.html, "utf8");
    writeFileSync(chess, two.html, "utf8");
  });

  const savesWritten = (page: Page): Promise<number> => page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0));

  async function firstTab(context: BrowserContext, file: string): Promise<{ page: Page; uuid: string }> {
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect.poll(() => savesWritten(page), { timeout: 30_000, message: "the first tab saved" }).toBeGreaterThan(0);
    return { page, uuid: await page.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid as string) };
  }

  async function secondTab(context: BrowserContext, uuid: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    return page;
  }

  const dates = (page: Page) => app(page).locator('input[aria-label="When the trip is"]');

  async function typeDates(page: Page, text: string): Promise<void> {
    await dates(page).fill(text);
    await dates(page).press("Tab");
  }

  /** Presses Save a copy in the menu, as a person does; the download, if one is made. */
  async function saveACopy(page: Page): Promise<string | null> {
    await page.evaluate(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    let made: string | null = null;
    const onDownload = async (download: import("@playwright/test").Download): Promise<void> => {
      made = readFileSync((await download.path())!, "utf8");
    };
    page.on("download", (d) => void onDownload(d));
    await page.click("#more");
    await page.click("#export");
    return await new Promise((done) => {
      const started = Date.now();
      const look = (): void => {
        if (made !== null || Date.now() - started > 20_000) return done(made);
        setTimeout(look, 200);
      };
      look();
    });
  }

  test("a document without shared tables: the copy holds this tab's change, and the sentence says to close the other tab", async ({
    browser,
  }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const { page: first, uuid } = await firstTab(context, packing);
    const second = await secondTab(context, uuid);

    // The second tab saves first.
    const before = await savesWritten(second);
    await typeDates(second, "June, the other tab");
    await expect.poll(() => savesWritten(second), { timeout: 30_000, message: "the second tab saved" }).toBeGreaterThan(before);

    // The first tab's change is refused, and it is told what to do.
    await typeDates(first, "July, this tab");
    await expect(first.locator("#save-state")).toHaveAttribute("title", /saved from another tab/, { timeout: 30_000 });
    await expect(first.locator("#doc-note")).toContainText("Close the other tab");
    await expect(first.locator("#doc-note")).toContainText("Save a copy");

    // Save a copy makes a file holding this tab's change, not the other tab's.
    const html = await saveACopy(first);
    expect(html, "a copy was made").not.toBeNull();
    const elsewhere = await browser.newContext();
    const reader = await elsewhere.newPage();
    await reader.goto(RUNNER_URL);
    const file = join(mkdtempSync(join(tmpdir(), "dai-other-tab-copy-")), "copy.dai.html");
    writeFileSync(file, html!, "utf8");
    await reader.setInputFiles("#file", file);
    await reader.locator("#card-open").click({ timeout: 60_000 });
    await expect(dates(reader)).toHaveValue("July, this tab", { timeout: 60_000 });

    await elsewhere.close();
    await context.close();
  });

  test("a replicated document: a change never signed does not leave, and the sentence names the other tab and says to close it", async ({
    browser,
  }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const { page: first, uuid } = await firstTab(context, chess);
    const second = await secondTab(context, uuid);
    await expect.poll(() => savesWritten(second), { timeout: 30_000, message: "the second tab saved on opening" }).toBeGreaterThan(0);

    // The first tab writes a game; it is not signed, so not saved.
    const ui = app(first);
    await ui.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
    await ui.locator("#setup-you").fill("Ada");
    await ui.locator("#setup-them").fill("Cy");
    await ui.locator('input[name="color"][value="w"]').check();
    await ui.locator("#new-game-form button[type=submit]").click();
    await expect(first.locator("#save-state")).toHaveAttribute("title", /another tab/, { timeout: 30_000 });
    await expect(first.locator("#doc-note")).toContainText("Close the other tab");

    // Save a copy makes no file, and says why and what to do.
    await first.evaluate(() => {
      (document.getElementById("doc-note") as HTMLElement).textContent = "";
    });
    const html = await saveACopy(first);
    expect(html, "no file carries a change nobody signed").toBeNull();
    await expect(first.locator("#doc-note")).toContainText("another tab");
    await expect(first.locator("#doc-note")).toContainText("Close the other tab");
    await expect(first.locator("#doc-note")).not.toContainText("Try again in a moment");

    await context.close();
  });
});
