import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
 * A device never issues the same `(author, seq)` twice for one document
 * (docs/identity.md; cold review of step 2, findings #1 and #3).
 *
 * The author id is the device's key, so it outlives any one copy: a copy can
 * be removed and received again, or reopened from a save older than what the
 * device already sent. Whatever copy is open, the next row this device writes
 * takes a seq above every seq the device ever let leave it. The host keeps a
 * high-water mark per document beside the person key, raised before a save is
 * written and before a batch is published, and hands it to the frame as the
 * floor; the frame holds its seq at or above it on every write.
 *
 * A seq that never left the device (written, then lost before any save or
 * publish) may be issued again: nobody else ever saw it.
 */
test.describe("one (author, seq) per row, whatever copy is open", () => {
  test.slow();

  let container: string;
  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-seq-floor-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
  });

  async function openWith(page: Page, file: string): Promise<FrameLocator> {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").waitFor({ timeout: 60_000 });
    await page.locator("#card-open").click();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    return app(page);
  }

  async function saveOut(page: Page, to: string): Promise<void> {
    await page.evaluate(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const dl = page.waitForEvent("download", { timeout: 60_000 });
    await page.evaluate(() =>
      (window as unknown as { __runner: { exportContainer(): Promise<void> } }).__runner.exportContainer(),
    );
    writeFileSync(to, readFileSync(await (await dl).path()));
  }

  async function newGame(ui: FrameLocator, you: string, them: string): Promise<void> {
    await ui.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
    await ui.locator("#setup-you").fill(you);
    await ui.locator("#setup-them").fill(them);
    await ui.locator('input[name="color"][value="w"]').check();
    await ui.locator("#new-game-form button[type=submit]").click();
  }

  /** Every row this copy holds under its own current id, as `table:seq`, with the seqs. */
  const ownRows = (page: Page): Promise<{ key: string; seq: number }[]> =>
    app(page)
      .locator("#app")
      .evaluate(() => {
        const db = (window as any).daiKit.db;
        const me = db.selectObjects("SELECT id FROM _dai_replica")[0]?.id;
        if (!me) return [];
        const tables = db
          .selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")
          .map((r: any) => String(r.name))
          .filter((name: string) => {
            const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => c.name);
            return cols.includes("_r_replica") && cols.includes("_r_seq");
          });
        const rows: { key: string; seq: number }[] = [];
        for (const t of tables) {
          for (const r of db.selectObjects(`SELECT _r_seq s FROM "${t}" WHERE _r_replica = ?`, [me])) {
            rows.push({ key: `${t}:${r.s}`, seq: Number(r.s) });
          }
        }
        return rows;
      });

  const savesWritten = (page: Page): Promise<number> =>
    page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0));

  test("removed and received again: the next row is above everything this device already saved", async ({
    browser,
  }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    // An early copy, with this device's first rows in it.
    const ui = await openWith(page, container);
    await newGame(ui, "Ada", "Bo");
    await play(ui, "e2", "e4");
    const seed = join(dirname(container), "seq-floor-seed.dai.html");
    await saveOut(page, seed);
    const inSeed = await ownRows(page);

    // More rows, and a save that writes them: now they have left the page.
    const before = await savesWritten(page);
    await newGame(ui, "Ada", "Cy");
    await expect.poll(() => savesWritten(page), { timeout: 30_000 }).toBeGreaterThan(before);
    const highest = Math.max(...(await ownRows(page)).map((r) => r.seq));
    expect(highest, "the second game wrote rows past the seed").toBeGreaterThan(Math.max(...inSeed.map((r) => r.seq)));

    // Removed from this device, then the early copy arrives again.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.click("#more");
    await page.click("#remove");
    await expect(page.locator("body")).not.toHaveClass(/loaded/, { timeout: 30_000 });
    const again = await openWith(page, seed);
    const held = new Set((await ownRows(page)).map((r) => r.key));

    // The next row this device writes.
    await newGame(again, "Ada", "Di");
    await expect.poll(async () => (await ownRows(page)).filter((r) => !held.has(r.key)).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const written = (await ownRows(page)).filter((r) => !held.has(r.key)).map((r) => r.seq);
    expect(Math.min(...written), `new rows ${written} must be above ${highest}, the highest already saved`).toBeGreaterThan(
      highest,
    );

    await context.close();
  });

  test("an application that rewinds _dai_replica.seq does not rewind the next row", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const ui = await openWith(page, container);
    await newGame(ui, "Ada", "Bo");
    await play(ui, "e2", "e4");
    const highest = Math.max(...(await ownRows(page)).map((r) => r.seq));
    const held = new Set((await ownRows(page)).map((r) => r.key));

    // The application holds the database, and rewinds the counter.
    await app(page)
      .locator("#app")
      .evaluate(() => (window as any).daiKit.db.exec("UPDATE _dai_replica SET seq = 0"));

    await newGame(ui, "Ada", "Cy");
    await expect
      .poll(async () => (await ownRows(page)).filter((r) => !held.has(r.key)).length, {
        timeout: 30_000,
        // How a rewound counter shows itself: the next row reissues a seq this
        // copy already holds, and the write surface refuses it, so nothing lands.
        message: "the write after the rewind landed (a rewound seq reissues one this copy holds, and is refused)",
      })
      .toBeGreaterThan(0);
    const written = (await ownRows(page)).filter((r) => !held.has(r.key)).map((r) => r.seq);
    expect(Math.min(...written), `new rows ${written} must be above ${highest}`).toBeGreaterThan(highest);

    await context.close();
  });
});
