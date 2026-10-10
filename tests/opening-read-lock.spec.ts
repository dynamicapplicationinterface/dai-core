import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { HINT_KEY } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * A tab opening a document reads the stored database and its revision
 * together, under the library lock (2-H2, D41).
 *
 * It read the database outside the lock and learned the revision inside it.
 * A save landing between the two left the opening tab with the older bytes
 * and the newer revision: its next save passed the revision check and wrote
 * the older bytes over a save the other tab had already shown as saved.
 *
 * The window is made deterministic by holding the opening tab's first request
 * for the document's library lock (`dai:<uuid>`) until the other tab has
 * saved. Before the fix that request came after the read; now the read is
 * inside it.
 */
test("a save acknowledged while another tab opens the document survives that tab's save", async ({ browser }) => {
  test.slow();
  const dir = mkdtempSync(join(tmpdir(), "dai-opening-read-"));
  const built = await compileDirectory({ sourceDir: join(repo, "examples", "packing-list"), root: repo, appName: "Beach trip" });
  const file = join(dir, "packing.dai.html");
  writeFileSync(file, built.html, "utf8");

  const context = await browser.newContext();
  const savesWritten = (page: Page): Promise<number> => page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0));
  const dates = (page: Page) => app(page).locator('input[aria-label="When the trip is"]');
  const save = async (page: Page, fill: () => Promise<void>, what: string): Promise<void> => {
    const before = await savesWritten(page);
    await fill();
    await expect.poll(() => savesWritten(page), { timeout: 30_000, message: what }).toBeGreaterThan(before);
  };
  const typeDates = async (page: Page, text: string): Promise<void> => {
    await dates(page).fill(text);
    await dates(page).press("Tab");
  };

  // A opens the document and saves "June, A1".
  const a = await context.newPage();
  await a.goto(RUNNER_URL);
  await a.setInputFiles("#file", file);
  await a.locator("#card-open").click({ timeout: 60_000 });
  await expect(a.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  await expect.poll(() => savesWritten(a), { timeout: 30_000, message: "A saved on opening" }).toBeGreaterThan(0);
  const uuid = await a.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid as string);
  // Where the engine has no Web Locks the opener takes no library lock at all
  // (withLibraryLock runs the work as it stands), so there is no lock to read
  // under and none to hold.
  const hasLocks = await a.evaluate(() => typeof (navigator as any).locks?.request === "function");
  test.skip(!hasLocks, "this engine has no navigator.locks, so the opener takes no library lock to read under");
  await save(a, () => typeDates(a, "June, A1"), "A saved June, A1");

  // B opens it, and its first request for the document's lock waits.
  const b = await context.newPage();
  await b.addInitScript((lock: string) => {
    const locks = navigator.locks as unknown as { request: (...args: unknown[]) => Promise<unknown> };
    const real = locks.request.bind(locks);
    let held = false;
    const w = window as unknown as { __lockAsked?: boolean; __releaseLock?: () => void };
    locks.request = (name: unknown, ...rest: unknown[]) => {
      if (held || name !== lock) return real(name, ...rest);
      held = true;
      w.__lockAsked = true;
      return new Promise<void>((go) => (w.__releaseLock = go)).then(() => real(name, ...rest));
    };
  }, `dai:${uuid}`);
  await b.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
  await expect.poll(() => b.evaluate(() => Boolean((window as any).__lockAsked)), { timeout: 60_000, message: "B asked for the lock" }).toBe(true);

  // A saves "July, A2" meanwhile, and is told it is saved.
  await save(a, () => typeDates(a, "July, A2"), "A saved July, A2");

  // B goes on, opens, and saves a change of its own.
  await b.evaluate(() => (window as any).__releaseLock());
  await expect(b.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  await expect(app(b).locator('input[name="what"]')).toBeVisible({ timeout: 60_000 });
  const shown = await dates(b).inputValue();
  await save(
    b,
    async () => {
      await app(b).locator('input[name="what"]').fill("Sunscreen");
      await app(b).locator('input[name="what"]').press("Enter");
    },
    "B saved its change",
  );

  // A fresh tab reads what is stored: A's acknowledged save is in it.
  const fresh = await context.newPage();
  await fresh.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
  await expect(fresh.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  await expect(dates(fresh), `A's acknowledged save survives (B opened showing "${shown}")`).toHaveValue("July, A2", { timeout: 30_000 });

  await context.close();
});
