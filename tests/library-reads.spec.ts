import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, buildNotes, openFile, storedRow, typeNote, uuidOf, waitMounted } from "./owner.js";
import { pageWritesLanded } from "./keeping.js";

/**
 * A library read that fails or does not answer says nothing about what is held
 * (D308, ruled 1 November). Each decision here is made on a read that answered;
 * on one that did not, nothing is let go, forgotten or written, and the reason
 * is said.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const RESUME_KEY = "dai:resume";
/** Set in sessionStorage before a reload: the library's reads stall for that one load. */
const STALL_NEXT_LOAD = "dai-test:stall-library-next-load";

/**
 * A library read that can be made to stall, as a stalled IndexedDB leaves a
 * request that never fires: while `__stallLibraryRead` is set, every `get` and
 * `getAll` on the library answers nothing, and is counted in `__stalledReads`.
 * Set for one load by `STALL_NEXT_LOAD`, which the load takes and clears, so
 * the load after it reads as it always does.
 */
async function stallableLibrary(context: BrowserContext): Promise<void> {
  await context.addInitScript((flag) => {
    try {
      if (sessionStorage.getItem(flag) === "1") {
        sessionStorage.removeItem(flag);
        (window as Any).__stallLibraryRead = true;
      }
    } catch {
      /* No storage: nothing stalls. */
    }
    for (const name of ["get", "getAll"] as const) {
      const real = IDBObjectStore.prototype[name] as (...args: Any[]) => IDBRequest;
      (IDBObjectStore.prototype as Any)[name] = function (this: IDBObjectStore, ...args: Any[]) {
        if ((window as Any).__stallLibraryRead === true && this.name === "cartridges") {
          (window as Any).__stalledReads = ((window as Any).__stalledReads ?? 0) + 1;
          return {} as IDBRequest;
        }
        return real.apply(this, args);
      };
    }
  }, STALL_NEXT_LOAD);
}

/** The resume key as the page holds it. */
const resumeKey = (page: Page): Promise<string | null> => page.evaluate((key) => localStorage.getItem(key), RESUME_KEY);

test.describe("a library read that did not answer", () => {
  /*
   * The resume on load (D308): the document open last is looked up in the
   * library, and only a read that answered with no such document forgets it.
   * A read that did not answer shows the chooser for this load, keeps the key,
   * and says why in the console; the next load resumes the document.
   */
  test("the resume on load keeps the document open last when the library read stalls", async ({ browser }) => {
    const file = await buildNotes(mkdtempSync(join(tmpdir(), "dai-resume-stall-")), "Notes");
    const context = await browser.newContext();
    await stallableLibrary(context);
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    const uuid = await uuidOf(page);
    await typeNote(app, "first");
    await pageWritesLanded(page);
    await expect.poll(async () => (await storedRow(page, uuid, "notes", "body = ?", ["first"])).length, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => resumeKey(page), { timeout: 10_000 }).toBe(uuid);

    // The next load, with every library read stalled: the resume decides on a read that never answers.
    const warned: string[] = [];
    page.on("console", (message) => {
      if (/^dai: resume on load/.test(message.text())) warned.push(message.text());
    });
    await page.evaluate((flag) => sessionStorage.setItem(flag, "1"), STALL_NEXT_LOAD);
    await page.reload();
    // Decided: the key forgotten, or the reason said for keeping it.
    await expect
      .poll(async () => ((await resumeKey(page)) === null || warned.length > 0 ? "decided" : "deciding"), { timeout: 30_000 })
      .toBe("decided");
    expect(await page.evaluate(() => (window as Any).__stalledReads ?? 0), "the library read was stalled").toBeGreaterThan(0);
    expect(await resumeKey(page), "the resume key kept").toBe(uuid);
    expect(warned.join("\n")).toMatch(/the library read did not answer/);
    expect(await page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null), "nothing resumed on this load").toBeNull();

    // The load after it reads as it always does, and resumes the document.
    await page.reload();
    const resumed = await waitMounted(page, file);
    await expect(resumed.locator("#note")).toHaveValue("first");
    expect(await page.evaluate(() => (window as Any).__stalledReads ?? 0), "nothing stalled on this load").toBe(0);
  });
});
