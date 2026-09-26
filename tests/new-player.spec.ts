import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");
const SENTENCE = "This device is a new player here. Your earlier moves are still on the board.";

/**
 * The loss sentence (docs/identity.md, "Loss"; identity step 5).
 *
 * If a device loses its key, it makes a new one and becomes a new author. Old
 * documents stay readable, and nothing pretends a continuity that does not
 * exist: the kit says so once, in its own words unless the application takes
 * the hook. The host knows the one fact that defines it: it made the key on this
 * page, and its library says this device wrote the document before.
 */
test.describe("a device that lost its key is told it is a new player", () => {
  test.slow();

  let container: string;
  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-new-player-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
  });

  async function openAndWrite(page: Page): Promise<void> {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    // The practice board is written on first open; the library records that
    // this device wrote the document once a save of it lands.
    await expect
      .poll(() => page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0)), { timeout: 30_000 })
      .toBeGreaterThan(0);
  }

  const said = (page: Page) => app(page).locator("[data-dai-new-player]");

  test("the key is lost and made again: the document it wrote says, once, that this is a new player", async ({ page }) => {
    await openAndWrite(page);
    await expect(said(page), "a first open is not a loss").toHaveCount(0);

    // The key is gone from this device's store; everything else is kept.
    await page.evaluate(
      () =>
        new Promise<void>((resolveDelete, rejectDelete) => {
          const open = indexedDB.open("dai_runner_storage");
          open.onerror = () => rejectDelete(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction("keys", "readwrite");
            tx.objectStore("keys").delete("dai:person-key");
            tx.oncomplete = () => {
              open.result.close();
              resolveDelete();
            };
            tx.onerror = () => rejectDelete(tx.error);
          };
        }),
    );
    await page.reload();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    await expect(said(page), "the kit says it, in its own words").toHaveText(SENTENCE, { timeout: 30_000 });
    await expect(said(page)).toHaveCount(1);
  });

  test("a reload with the key kept says nothing", async ({ page }) => {
    await openAndWrite(page);
    await page.reload();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    // Settled: the host has mounted and handed over the rules, which is when the
    // fact would arrive.
    await expect
      .poll(() => app(page).locator("#app").evaluate(() => Boolean((window as any).daiKit?.author?.())), { timeout: 30_000 })
      .toBe(true);
    await expect(said(page)).toHaveCount(0);
  });
});
