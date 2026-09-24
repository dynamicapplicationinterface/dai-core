import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * A sequence floor that cannot be read is not waited on forever (cold review of
 * identity step 3, finding 4; ruled: a 4-second read-again deadline, the same
 * three outcomes as the key).
 *
 * The floor is read before a document may be written. A store that never
 * answers (the iOS IndexedDB open that hangs, which the opener already guards
 * against elsewhere) left that decision pending for good: the document silently
 * read-only, and every save waiting inside the document's lock. Now a read that
 * does not answer is read again for a few seconds, and then the document opens
 * with its writes refused and says so.
 *
 * The hang is forced on this document's floor read alone, by name: scenery.
 */
test.describe("a sequence floor that does not answer", () => {
  test.slow();

  let container: string;
  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-floor-read-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
  });

  /** Make the next `hangs` reads of a sequence floor never answer, or every one when -1. */
  async function hangFloorReads(context: BrowserContext, hangs: number): Promise<void> {
    await context.addInitScript((n) => {
      let left = n;
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
        if (typeof key === "string" && key.startsWith("dai:seq-floor:") && left !== 0) {
          if (left > 0) left -= 1;
          // A request that never fires either event.
          return {} as IDBRequest;
        }
        return get.call(this, key);
      } as typeof IDBObjectStore.prototype.get;
    }, hangs);
  }

  const saves = (page: Page): Promise<number> =>
    page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0));

  test("a read that hangs once is read again, and the document is written", async ({ browser }) => {
    const context = await browser.newContext();
    await hangFloorReads(context, 1);
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => saves(page), { timeout: 30_000, message: "the document saved" }).toBeGreaterThan(0);
    await expect(page.locator("#report")).not.toContainText("can be read here but not changed");
    await context.close();
  });

  test("a read that never answers: within seconds the document says it cannot be changed, and saves nothing", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await hangFloorReads(context, -1);
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("#report"), "said, not silently read-only").toContainText(
      "could not read how far it has written",
      { timeout: 20_000 },
    );
    expect(await saves(page), "no save written").toBe(0);
    await context.close();
  });
});
