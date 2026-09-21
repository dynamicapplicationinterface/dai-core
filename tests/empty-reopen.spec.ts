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
 * What a person is told when the app comes back and the data does not (D51).
 *
 * The state is the one a partial sweep leaves: the library row survives, the
 * stored database does not, and the container mounts as it arrived. The app
 * opens, looks right, and is empty. The opener always knew — its breadcrumb
 * logged the difference — and said nothing to the person.
 *
 * The sweep is done here by deleting the stored database and leaving the
 * library alone, which is exactly the half-state, rather than by waiting for a
 * browser to evict something.
 */
test.describe("a reopen with the database gone", () => {
  test.slow();

  let container: string;

  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-empty-")), "chess.dai.html");
    writeFileSync(container, built.html, "utf8");
  });

  /** The stored database, both where it lives and where it falls back to. */
  const sweepDatabases = (page: Page): Promise<number> =>
    page.evaluate(async () => {
      let removed = 0;
      try {
        const root = await navigator.storage.getDirectory();
        for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
          if (name.endsWith(".sqlite")) {
            await root.removeEntry(name);
            removed += 1;
          }
        }
      } catch {
        /* No OPFS here; the fallback below is the whole story. */
      }
      await new Promise<void>((resolve2) => {
        const open = indexedDB.open("dai_runner_storage");
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("sqlite_databases")) {
            db.close();
            resolve2();
            return;
          }
          const tx = db.transaction("sqlite_databases", "readwrite");
          const store = tx.objectStore("sqlite_databases");
          const keys = store.getAllKeys();
          keys.onsuccess = () => {
            removed += keys.result.length;
            store.clear();
          };
          tx.oncomplete = () => {
            db.close();
            resolve2();
          };
          tx.onerror = () => {
            db.close();
            resolve2();
          };
        };
        open.onerror = () => resolve2();
      });
      return removed;
    });

  async function newGame(inside: FrameLocator): Promise<void> {
    await inside.locator("[data-new-game]:visible").first().click();
    await inside.locator("#setup-you").fill("Ada");
    await inside.locator("#setup-them").fill("Bo");
    await inside.locator('input[name="color"][value="w"]').check();
    await inside.locator("#new-game-form button[type=submit]").click();
  }

  test("says what happened, in words a person can act on", async ({ browser }) => {
    const device = await browser.newContext();
    const page = await device.newPage();
    const saves: string[] = [];
    page.on("console", (message) => {
      if (/^dai: save \d+ written/.test(message.text())) saves.push(message.text());
    });

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").click();
    const inside = app(page);
    await expect(inside.locator("#app")).toBeVisible({ timeout: 60_000 });

    // Something worth losing, and written: the sentence is only for a device
    // that had saved something, so the test must be such a device.
    await newGame(inside);
    await expect
      .poll(() => saves.length, { timeout: 30_000, message: "this device wrote a save before the sweep" })
      .toBeGreaterThan(0);

    // The sweep: the database goes, the library row stays.
    expect(await sweepDatabases(page), "there was a stored database to sweep").toBeGreaterThan(0);

    // Reopened from the library, as coming back to the app does.
    await page.reload();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });

    const said = page.locator("#report");
    await expect(said, "the person is told, rather than left with an app that looks right").toContainText(
      "opened empty",
      { timeout: 30_000 },
    );
    const sentence = (await said.textContent())!;
    expect(sentence, "it names the app, so it is about something they recognize").toContain("Velvet Chess");
    expect(
      sentence,
      "and it names something they can do, which is the half a notice usually leaves out",
    ).toMatch(/open that here/);
    // Not a guess at the cause: nothing here can know why the storage went.
    expect(sentence).not.toMatch(/browser|evicted|deleted it|storage was/i);

    await device.close();
  });

  test("a copy this device never wrote to is not told it lost anything", async ({ browser }) => {
    /*
     * The guard that keeps the sentence honest, and it is about a reopen, not a
     * first open: a first open does not come through the library at all, so a
     * test that opened a file and looked at the screen would pass however wrong
     * the condition was. (It did, when this test was written that way.)
     *
     * The state that does reach it: a library row for a copy this device has
     * never saved — a document stored on arrival and reopened before anything
     * was written to it — with no stored database, which is every such copy.
     * Telling that person their data is missing would be inventing a loss.
     */
    const device = await browser.newContext();
    const page = await device.newPage();
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").click();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });

    // Nothing has been done in the app, so nothing should have been written.
    // Both halves are swept, so the reopen below is the branch under test.
    await sweepDatabases(page);
    const saves = await page.evaluate(
      () =>
        new Promise<number>((resolve2) => {
          // Every path settles, including the one where the store is not what
          // this test thinks it is: an unsettled promise here reads as a
          // 90-second timeout with nothing said about the cause, which is how
          // the first version of this read failed.
          const open = indexedDB.open("dai_runner_storage");
          open.onsuccess = () => {
            try {
              const all = open.result
                .transaction("cartridges", "readonly")
                .objectStore("cartridges")
                .getAll();
              all.onsuccess = () => {
                const rows = all.result as { revision?: number }[];
                resolve2(rows.reduce((most, row) => Math.max(most, row.revision ?? 0), 0));
                open.result.close();
              };
              all.onerror = () => resolve2(-1);
            } catch {
              resolve2(-1);
            }
          };
          open.onerror = () => resolve2(-1);
        }),
    );
    expect(saves, "the library has this copy and no save of it").toBe(0);

    await page.reload();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    await expect(
      page.locator("#report"),
      "nothing was lost, so nothing is claimed to be",
    ).not.toContainText("opened empty");
    await device.close();
  });
});
