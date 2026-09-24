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
 * A key read that fails is not "no key" (cold review of identity step 2, #5).
 *
 * The key store answers three ways: a key, nothing kept, or nothing readable.
 * Only the second may make a key. A device that has a key and cannot read it
 * for a moment (the iOS IndexedDB open timeout the opener already guards
 * against) must not come up as a new author: that contests the person's own
 * seat. So an unreadable key is read again within a short deadline, and if it
 * stays unreadable the document opens with every write refused, and says so,
 * rather than writing as somebody new.
 *
 * The failure is forced on the key read alone, by name, so the rest of the
 * opener's storage behaves as it does on a good day: that is the scenery. What
 * the opener does with the failure is the fact under test.
 */
test.describe("a person key that cannot be read", () => {
  test.slow();

  let container: string;
  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-key-read-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
  });

  /** Make the next `failures` reads of the person key throw, or every one when -1. */
  async function failKeyReads(context: BrowserContext, failures: number): Promise<void> {
    await context.addInitScript((n) => {
      let left = n;
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
        if (key === "dai:person-key" && left !== 0) {
          if (left > 0) left -= 1;
          throw new DOMException("The key store is not answering.", "UnknownError");
        }
        return get.call(this, key);
      } as typeof IDBObjectStore.prototype.get;
    }, failures);
  }

  async function openWith(page: Page): Promise<void> {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").waitFor({ timeout: 60_000 });
    await page.locator("#card-open").click();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
  }

  const hostAuthor = (page: Page): Promise<string | null> =>
    page.evaluate(async () => {
      try {
        return await (window as any).__runner.authorId();
      } catch {
        return null;
      }
    });

  test("read again within a deadline: a device that has a key keeps its author id", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openWith(page);
    const first = await hostAuthor(page);
    expect(first, "this device made its key on first use").toMatch(/^[A-Za-z0-9_-]{22}$/);

    // The same device, the next load, and the key store fails twice first.
    await failKeyReads(context, 2);
    await page.reload();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => hostAuthor(page), { timeout: 30_000 }).toBe(first);
    expect(
      await page.evaluate(() => (window as any).__runner.replicaId()),
      "and the copy writes under it, not a throwaway",
    ).toBe(first);

    await context.close();
  });

  test("still unreadable: every write is refused, it says so, and no author is made", async ({ browser }) => {
    const context = await browser.newContext();
    await failKeyReads(context, -1);
    const page = await context.newPage();
    // Opened, but not waited on to draw: the chess fixture seeds its demo game
    // with a shared write at boot, and in a document that refuses writes it does
    // not draw at all. That is the fixture's to handle; what is under test is
    // what the opener refuses and says.
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").click({ timeout: 60_000 });

    await expect(page.locator("#report"), "the page says why nothing can be changed").toContainText(
      "can be read here but not changed",
      { timeout: 30_000 },
    );
    expect(await hostAuthor(page), "no key was made in place of the one that could not be read").toBeNull();
    // Nothing is written under an id the device does not hold.
    expect(await page.evaluate(() => (window as any).__runner.savesWritten ?? 0), "no save was written").toBe(0);

    await context.close();
  });

  /*
   * A read-only mount still draws (identity step 5). The chess fixture used to
   * seed its practice board, a shared write, at boot, and on a mount that
   * refuses writes it threw there and never drew. The boot writes now go
   * through the kit's whenWritable, which runs them only on a mount that can
   * write; the page draws what it holds either way.
   */
  test("a read-only mount still draws: the boot write waits for a mount that can write", async ({ browser }) => {
    const context = await browser.newContext();
    await failKeyReads(context, -1);
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").waitFor({ timeout: 60_000 });
    await page.locator("#card-open").click();
    const ui = app(page);
    await expect(ui.locator("#app"), "the application drew").toBeVisible({ timeout: 60_000 });
    await expect(ui.locator("#boot-notice"), "and did not stop at its boot").toBeHidden();
    expect(await page.evaluate(() => (window as any).__runner.savesWritten ?? 0), "nothing was written").toBe(0);
    await context.close();
  });
});
