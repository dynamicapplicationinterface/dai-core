import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, appIn, buildNotes, openFile, pointAtStore, storedRow, typeNote, uuidOf, waitMounted, withKeyStore } from "./owner.js";
import { serveOwnerStore } from "./owner-store-memory.js";
import { enrollHere, openerWithStore, pageWritesLanded } from "./keeping.js";

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
 * request that never fires: while `__stallLibraryRead` names a method (`get`,
 * the one record; `getAll`, the list), each call of it on the library answers
 * nothing, and is counted in `__stalledReads`. Set for one load by
 * `stallNextLoad`, which the load takes and clears, so the load after it reads
 * as it always does.
 */
async function stallableLibrary(context: BrowserContext): Promise<void> {
  await context.addInitScript((flag) => {
    try {
      const methods = sessionStorage.getItem(flag);
      if (methods) {
        sessionStorage.removeItem(flag);
        (window as Any).__stallLibraryRead = methods.split(",");
      }
    } catch {
      /* No storage: nothing stalls. */
    }
    for (const name of ["get", "getAll"] as const) {
      const real = IDBObjectStore.prototype[name] as (...args: Any[]) => IDBRequest;
      (IDBObjectStore.prototype as Any)[name] = function (this: IDBObjectStore, ...args: Any[]) {
        const stalled: unknown = (window as Any).__stallLibraryRead;
        if (Array.isArray(stalled) && stalled.includes(name) && this.name === "cartridges") {
          (window as Any).__stalledReads = ((window as Any).__stalledReads ?? 0) + 1;
          return {} as IDBRequest;
        }
        return real.apply(this, args);
      };
    }
  }, STALL_NEXT_LOAD);
}

/** The next load of `page` stalls these library reads, and only that load. */
const stallNextLoad = (page: Page, methods: ("get" | "getAll")[]): Promise<void> =>
  page.evaluate(([flag, value]) => sessionStorage.setItem(flag, value), [STALL_NEXT_LOAD, methods.join(",")] as const);

/** The resume key as the page holds it. */
const resumeKey = (page: Page): Promise<string | null> => page.evaluate((key) => localStorage.getItem(key), RESUME_KEY);

const stalledReads = (page: Page): Promise<number> => page.evaluate(() => ((window as Any).__stalledReads ?? 0) as number);

/** Said over the document when the library could not be read and so nothing was changed (D308, ruled 1 November). */
const NOTHING_CHANGED = "The library could not be read, so nothing was changed. Try again.";
const LET_GO_SAID =
  'Keeping beyond this browser did not finish setting up here. Your work is still saved in this browser; choose "Keep beyond this browser" in the menu to set it up again. The passkey and saved password made the first time open nothing, and you can delete them.';

/** The owner record kept here, or null. */
const ownerRecordOf = (page: Page, owner: string): Promise<{ verifier: string | null } | null> =>
  withKeyStore(page, "const r = await get(arg); return r ? { verifier: r.verifier ?? null } : null;", `dai:owner:${owner}`);

/** The owner a document's data key is held under here, or null for this browser's own. */
const dataKeyOwner = (page: Page, uuid: string): Promise<string | null> =>
  withKeyStore(page, "const r = await get(arg); return r?.owner ?? null;", `dai:data-key:${uuid}`);

/** The owner record as an opener before D302's ruling kept one on an engine with no Ed25519: no verifier, not at the store. */
async function asBeforeD302(page: Page, owner: string): Promise<void> {
  await page.evaluate(async (key) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const open = indexedDB.open("dai_runner_storage");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      const keys = tx.objectStore("keys");
      const read = keys.get(key);
      read.onsuccess = () => {
        const record = read.result;
        delete record.verifier;
        delete record.atStore;
        keys.put(record, key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, `dai:owner:${owner}`);
}

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
    await stallNextLoad(page, ["get", "getAll"]);
    await page.reload();
    // Decided: the key forgotten, or the reason said for keeping it.
    await expect
      .poll(async () => ((await resumeKey(page)) === null || warned.length > 0 ? "decided" : "deciding"), { timeout: 30_000 })
      .toBe("decided");
    expect(await stalledReads(page), "the library read was stalled").toBeGreaterThan(0);
    expect(await resumeKey(page), "the resume key kept").toBe(uuid);
    expect(warned.join("\n")).toMatch(/the library read did not answer/);
    expect(await page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null), "nothing resumed on this load").toBeNull();

    // The load after it reads as it always does, and resumes the document.
    await page.reload();
    const resumed = await waitMounted(page, file);
    await expect(resumed.locator("#note")).toHaveValue("first");
    expect(await stalledReads(page), "nothing stalled on this load").toBe(0);
  });

  /*
   * `letGoOfOwner` (D308): an owner the store can never register is let go
   * only on a library read that answered, since the documents it names are
   * the ones given back to this browser. On a read that did not answer the
   * owner record and the sign-in stay as they are, and the one note row says
   * the library could not be read, so nothing was changed. The next load,
   * whose read answers, lets it go as D302 rules, and the document opens.
   */
  test("an owner the store can never register is not let go on a library read that stalls", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    test.slow();
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      await stallableLibrary(context);
      const { page } = await openerWithStore(context, store.base);
      const file = await buildNotes(mkdtempSync(join(tmpdir(), "dai-let-go-stall-")), "Notes");
      let app = await openFile(page, file);
      const uuid = await uuidOf(page);
      await typeNote(app, "one");
      await expect.poll(async () => (await storedRow(page, uuid, "notes", "body = ?", ["one"])).length, { timeout: 30_000 }).toBe(1);
      // The store away while the owner is enrolled, so nothing registers; then the record as D302 left it: no verifier.
      store.setMode("unavailable");
      const owner = await enrollHere(page);
      await pageWritesLanded(page);
      await expect.poll(() => dataKeyOwner(page, uuid), { timeout: 30_000 }).toBe(owner);
      await asBeforeD302(page, owner);
      store.setMode("up");

      // The opener names its store as a deploy does; the next load stalls the library's list read, which the let-go reads.
      await pointAtStore(context, store.base);
      await stallNextLoad(page, ["getAll"]);
      await page.reload();
      app = await waitMounted(page, file);
      expect(await stalledReads(page), "the library's list read was stalled").toBeGreaterThan(0);
      await expect.soft(page.locator("#doc-note"), "the sentence for a read that did not answer").toHaveText(NOTHING_CHANGED, { timeout: 30_000 });
      expect.soft(await page.evaluate(() => (window as Any).__runner.owner.current()), "the owner still signed in").toBe(owner);
      expect.soft(await ownerRecordOf(page, owner), "the owner record kept").not.toBeNull();
      expect.soft(await dataKeyOwner(page, uuid), "the document still held under the owner").toBe(owner);

      // The next load, unstalled: the document is opened (not refused as another owner's), and the let-go, on a read that answered, gives it back to this browser.
      const refused: string[] = [];
      page.on("console", (message) => {
        if (message.text().includes(`${uuid} not opened`)) refused.push(message.text());
      });
      await page.reload();
      const card = page.locator("#card-open");
      await expect
        .poll(
          async () => {
            if (refused.length > 0) return `refused: ${refused[0]}`;
            if (await card.isVisible()) await card.click();
            const loaded = await page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null);
            const ready = loaded === uuid && (await appIn(page).locator("#note").isEnabled({ timeout: 500 }).catch(() => false));
            return ready ? "opened" : "waiting";
          },
          { timeout: 60_000 },
        )
        .toBe("opened");
      await expect(appIn(page).locator("#note")).toHaveValue("one");
      expect(await stalledReads(page), "nothing stalled on this load").toBe(0);
      await expect(page.locator("#doc-note")).toHaveText(LET_GO_SAID, { timeout: 30_000 });
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "let go on a read that answered").toBeNull();
      expect(await dataKeyOwner(page, uuid), "the document given back to this browser").toBeNull();
    } finally {
      await context.close();
      await store.close();
    }
  });
});
