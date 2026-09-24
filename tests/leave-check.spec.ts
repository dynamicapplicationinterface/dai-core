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

/**
 * The host checks the bytes that are about to leave, not a report about them
 * (cold review of identity step 3, #2; ruled 24 September).
 *
 * A document's own code can hand the runtime database bytes of its own making
 * and ask for them to be downloaded. Those bytes can hold rows of this
 * device's that were never sealed. Before any file leaves the device, the host
 * opens the outgoing bytes itself, and if it finds a row of this author's that
 * is pending, or that names a batch the file holds no header for, the leave is
 * refused with a sentence. The seal is a courtesy to the honest path; the
 * verifier is the enforcement, and this keeps an unsigned row from going out
 * under this person's name through the honest host.
 */
test("a download of bytes holding an unsealed row of this device's is refused, and nothing is written", async ({ page }) => {
  test.slow();
  const built = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
  const file = join(mkdtempSync(join(tmpdir(), "dai-leave-check-")), "chess.dai.html");
  writeFileSync(file, built.html, "utf8");
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0)), { timeout: 30_000 })
    .toBeGreaterThan(0);

  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });

  // In one synchronous turn: a shared row written (pending: no seal can happen
  // before this turn ends), the database exported, and those bytes handed to
  // the runtime to download.
  const outcome = await app(page)
    .locator("#app")
    .evaluate(async () => {
      const db = (window as any).daiKit.db;
      const game = db.selectObjects("SELECT lower(hex(_r_entity)) id, lower(hex(_r_session)) s FROM games_current LIMIT 1")[0];
      (window as any).dai.replicated.insert(
        "moves",
        { game_id: game.id, ply: 99, color: "w", from_sq: "a2", to_sq: "a3", promotion: null, san: "a3", draw_offer: 0 },
        game.s,
      );
      const bytes = (window as any).dai.exportDatabase(db);
      try {
        await (window as any).dai.saveState(bytes, { method: "download" });
        return "saved";
      } catch (error) {
        return `refused: ${String((error as Error)?.message ?? error)}`;
      }
    });

  expect(outcome, "the runtime refused the download").toMatch(/^refused: .*(signed|unsigned|sealed)/);
  await page.waitForTimeout(1_000);
  expect(downloaded, "and no file left the device").toBe(false);
});
