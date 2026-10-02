import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { play } from "./chess-play.js";

/**
 * The kit's merge work runs before the application's, whatever the order they
 * registered in (D177).
 *
 * On the creator's copy the kit seats whoever asked when their file arrives,
 * and the application redraws. The redraw has to come after the seating, or it
 * draws the joiner unseated (their marks wait in t_pending) and nothing draws
 * again. Step 7a met this on Chromium: the kit's capturing `dai:merged`
 * listener on window did not run before an application listener added before
 * the kit loaded, so the apps added theirs after the kit, by order.
 *
 * Here tic-tac-toe is built with its merge listener registered before the kit
 * is imported, on whatever event it listens to, and the creator's board must
 * still show the joiner's mark once their file is merged in. Chess, which loads
 * the kit by its own script tag, gets the same join flow: the creator's board
 * redraws with the joiner seated and his move on it.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/** Tic-tac-toe with its merge listener added first in its start-up, before the kit loads. */
async function listenerFirst(scratch: string): Promise<string> {
  const copy = mkdtempSync(join(tmpdir(), "dai-listener-first-"));
  cpSync(join(repo, "examples", "tic-tac-toe"), copy, { recursive: true });
  const path = join(copy, "app.js");
  const source = readFileSync(path, "utf8");
  const registration = /^ *window\.addEventListener\("([^"]+)", onMerged\);\n/m.exec(source);
  expect(registration, "tic-tac-toe registers onMerged").not.toBeNull();
  const kitImport = '  await import("./dai-kit.js");\n';
  const without = source.replace(registration![0], "");
  expect(without.split(kitImport).length - 1, "one kit import in the start-up").toBe(1);
  const changed = without.replace(kitImport, `  window.addEventListener("${registration![1]}", onMerged);\n${kitImport}`);
  expect(changed.indexOf("onMerged);\n" + kitImport)).toBeGreaterThan(0);
  writeFileSync(path, changed);
  const built = await compileDirectory({ sourceDir: copy, root: repo, appName: "Tic-tac-toe" });
  const file = join(scratch, "listener-first.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

async function saveOut(page: Page, to: string): Promise<string> {
  await page.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.evaluate(() =>
    (window as unknown as { __runner: { exportContainer(): Promise<void> } }).__runner.exportContainer(),
  );
  const download = await downloading;
  writeFileSync(to, readFileSync(await download.path()));
  return to;
}

async function firstOpen(page: Page, file: string, ready: string): Promise<FrameLocator> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const app = appIn(page);
  await expect(app.locator(ready)).toBeVisible({ timeout: 60_000 });
  return app;
}

test.describe("the kit's merge work runs before the application's (D177)", () => {
  test.slow();

  test("an application that registers its merge listener before the kit loads still draws the joiner seated", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-d177-"));
    const container = await listenerFirst(scratch);
    const contexts = [await browser.newContext({ acceptDownloads: true }), await browser.newContext({ acceptDownloads: true })];
    const [pageA, pageB] = await Promise.all(contexts.map((c) => c.newPage()));
    const cell = (app: FrameLocator, index: number) => app.locator("#board .cell").nth(index);

    const appA = await firstOpen(pageA!, container, "#new-game");
    await appA.locator("#you").fill("Ada");
    await appA.locator("#them").fill("Bo");
    await appA.locator("#new-game button[type=submit]").click();
    await cell(appA, 0).click();
    await expect(cell(appA, 0)).toHaveText("X", { timeout: 30_000 });
    const a1 = await saveOut(pageA!, join(scratch, "a1.dai.html"));

    const appB = await firstOpen(pageB!, a1, "#play");
    await expect(appB.locator("#status")).toContainText("Your move, Bo.", { timeout: 30_000 });
    await cell(appB, 4).click();
    await expect(cell(appB, 4)).toHaveText("O");
    const b1 = await saveOut(pageB!, join(scratch, "b1.dai.html"));

    // Ada's copy seats Bo as his file arrives, and her redraw comes after it:
    // his mark counts on her board, and it is her move.
    await pageA!.setInputFiles("#file", b1);
    await expect(pageA!.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
    await pageA!.locator("#card-open").click();
    await expect(cell(appA, 4)).toHaveText("O", { timeout: 60_000 });
    await expect(appA.locator("#status")).toContainText("Your move, Ada.");

    for (const context of contexts) await context.close();
  });

  test("chess: the creator's board draws the joiner seated when the joiner's file arrives, with the joiner's move on it", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-d177-chess-"));
    const built = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
    const container = join(scratch, "chess.dai.html");
    writeFileSync(container, built.html, "utf8");
    const contexts = [await browser.newContext({ acceptDownloads: true }), await browser.newContext({ acceptDownloads: true })];
    const [pageA, pageB] = await Promise.all(contexts.map((c) => c.newPage()));
    const square = (app: FrameLocator, at: string) => app.locator(`[data-square="${at}"]`);

    // Ada starts a game as White and opens with e4.
    const appA = await firstOpen(pageA!, container, "#app");
    await appA.locator("[data-new-game]:visible").first().click();
    await appA.locator("#setup-you").fill("Ada");
    await appA.locator("#setup-them").fill("Bo");
    await appA.locator('input[name="color"][value="w"]').check();
    await appA.locator("#new-game-form button[type=submit]").click();
    await play(appA, "e2", "e4");
    await expect(square(appA, "e4")).toHaveAttribute("aria-label", /^e4, white pawn/i, { timeout: 30_000 });
    const a1 = await saveOut(pageA!, join(scratch, "a1.dai.html"));

    // Bo opens Ada's file and asks for the open seat. Ada's copy has not seated
    // him yet, and he plays e5 while he waits.
    const appB = await firstOpen(pageB!, a1, "#app");
    await expect(appB.locator("#game-id")).toContainText("waiting for Ada to let you in", { timeout: 30_000 });
    await play(appB, "e7", "e5");
    await expect(square(appB, "e5")).toHaveAttribute("aria-label", /^e5, black pawn/i, { timeout: 30_000 });
    const b1 = await saveOut(pageB!, join(scratch, "b1.dai.html"));

    // Ada's copy seats Bo as his file arrives, and her board redraws after it:
    // his move counts (it waited in t_pending until he was seated), and it is
    // her turn.
    await pageA!.setInputFiles("#file", b1);
    await expect(pageA!.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
    await pageA!.locator("#card-open").click();
    await expect(square(appA, "e5")).toHaveAttribute("aria-label", /^e5, black pawn/i, { timeout: 60_000 });
    await expect(appA.locator("#turn-title")).toHaveText("Ada’s Move");

    for (const context of contexts) await context.close();
  });
});
