import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { play } from "./chess-play.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * What the application says is waiting, and what the badge does with it (D34).
 *
 * The badge means "games waiting on you". The application is the only thing
 * that knows whose turn it is, so it reports (`window.dai.reportWaiting`), and
 * a document that never reports is not counted at all. The chess fixture did
 * not report, which is how a badge could be shown for it that no report could
 * ever correct.
 *
 * Driven as a person does it — two games made, a move played in one — and read
 * from the badge's own store, which is what the worker reads.
 */
test.describe("the games an application says are waiting", () => {
  test.slow();

  /** What the badge store holds for the one document this test opens. */
  const entry = (page: Page): Promise<{ waiting: string[]; shown: number } | null> =>
    page.evaluate(
      () =>
        new Promise((resolve2) => {
          const open = indexedDB.open("dai_badge", 1);
          open.onupgradeneeded = () => open.result.createObjectStore("documents", { keyPath: "uuid" });
          open.onsuccess = () => {
            const all = open.result.transaction("documents", "readonly").objectStore("documents").getAll();
            all.onsuccess = () => {
              const first = all.result[0] as { waiting?: string[]; shown?: number } | undefined;
              resolve2(first ? { waiting: first.waiting ?? [], shown: first.shown ?? 0 } : null);
              open.result.close();
            };
            all.onerror = () => resolve2(null);
          };
          open.onerror = () => resolve2(null);
        }),
    );

  async function newGame(inside: FrameLocator, you: string, them: string): Promise<void> {
    await inside.locator("[data-new-game]:visible").first().click();
    await inside.locator("#setup-you").fill(you);
    await inside.locator("#setup-them").fill(them);
    await inside.locator('input[name="color"][value="w"]').check();
    await inside.locator("#new-game-form button[type=submit]").click();
  }

  test("two games waiting are two; a move in one leaves one", async ({ browser }) => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    const file = join(mkdtempSync(join(tmpdir(), "dai-badge-")), "chess.dai.html");
    writeFileSync(file, built.html, "utf8");

    const device = await browser.newContext();
    const page = await device.newPage();
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").click();
    const inside = app(page);
    await expect(inside.locator("#app")).toBeVisible({ timeout: 60_000 });

    // Two games, both White, both unplayed: it is this player's move in each.
    await newGame(inside, "Ada", "Bo");
    await newGame(inside, "Ada", "Cy");
    await expect
      .poll(async () => (await entry(page))?.waiting.length ?? -1, { timeout: 30_000 })
      .toBe(2);

    // A move in the game on screen hands that one over; the other still waits.
    await play(inside, "e2", "e4");
    await expect
      .poll(async () => (await entry(page))?.waiting.length ?? -1, { timeout: 30_000 })
      .toBe(1);

    await device.close();
  });
});
