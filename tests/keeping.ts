import { expect, type BrowserContext, type Page } from "@playwright/test";
import { RUNNER_URL, addPasskeyProvider, keepFromMenu, waitMounted, withKeyStore } from "./owner.js";
import { dataKeyKey } from "../src/keys.js";

/**
 * What the keeping specs share (Build 2b-2): the opener pointed at a local
 * test store, an owner enrolled through the menu on Chromium's virtual
 * authenticator, and the opener's own account of each append.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface KeptRecord {
  owner: string;
  revision: number;
  digest: string;
  checkpoint: string;
  at: string;
  as: "head" | "branch";
}

export const keptRecord = (page: Page, uuid: string): Promise<KeptRecord | null> =>
  page.evaluate(async (id) => ((await (window as Any).__runner.keeping.kept(id)) as KeptRecord | null) ?? null, uuid);

export const keepingLog = (page: Page): Promise<{ sent: number; kept: number; refusedReceipts: number; unavailable: number; refused: number; last: string }> =>
  page.evaluate(() => ({ ...(window as Any).__runner.keeping.log }));

/** The library's revision for a document: the revision on screen once its save is written. */
export const libraryRevision = (page: Page, uuid: string): Promise<number> =>
  page.evaluate(async (id) => {
    const held = ((await (window as Any).__runner.listLibrary()) as Any[]).find((item) => item.documentUuid === id);
    return Number(held?.revision ?? -1);
  }, uuid);

export const pillText = (page: Page): Promise<string> => page.locator("#save-state").evaluate((el) => (el as HTMLElement).innerText.trim());

/**
 * Watches the document's top (the frame's `getBoundingClientRect().top`) at
 * every animation frame from now until it is read: whether anything the host
 * showed or took away moved the document (R-Z, "the host's presence over the
 * document is fixed"). The read gives where it was at the start, and the
 * lowest and highest it was since.
 */
export async function watchDocumentTop(page: Page): Promise<() => Promise<{ from: number; min: number; max: number }>> {
  await page.evaluate(() => {
    const frame = document.getElementById("cartridge");
    if (!frame) throw new Error("no document frame");
    const top = (): number => frame.getBoundingClientRect().top;
    const watch = { from: top(), min: top(), max: top(), on: true };
    (window as Any).__topWatch = watch;
    const step = (): void => {
      if (!watch.on) return;
      const now = top();
      watch.min = Math.min(watch.min, now);
      watch.max = Math.max(watch.max, now);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  return () =>
    page.evaluate(() => {
      const watch = (window as Any).__topWatch;
      watch.on = false;
      const now = (document.getElementById("cartridge") as HTMLElement).getBoundingClientRect().top;
      return { from: watch.from as number, min: Math.min(watch.min, now), max: Math.max(watch.max, now) };
    });
}

/**
 * What this page has written has landed, by state, not by a window
 * (tests/README.md, waiting for the needed state): what a test waits on before
 * it clears the origin under the live page, so no write of the page lands
 * after the clear and brings a record back (2b2dr6c-M1, 2b2dr6d-L1).
 *
 * - The frame's pending writes flushed (`__runner.flush()`: the frame saves
 *   what it holds unsaved, the mount's replica settling included, and answers
 *   once that save is stored), then every save asked is written. A written save
 *   includes its library record: `savesWritten` counts after that write.
 * - Once a save was written on this page, the open document's data key is in
 *   the key store: the write `afterSaveWritten` makes behind a save, which
 *   nothing counts. A key store read that does not answer fails the wait.
 * - Checked, not assumed: no save was asked while these were waited for.
 *
 * The open document only: a document written on this page and then put away
 * is not looked for.
 */
export async function pageWritesLanded(page: Page): Promise<void> {
  await page.evaluate(() => (window as Any).__runner.loaded && (window as Any).__runner.flush());
  await expect
    .poll(() => page.evaluate(() => (window as Any).__runner.saves === (window as Any).__runner.savesWritten), { timeout: 30_000 })
    .toBe(true);
  const { asked, written, uuid } = (await page.evaluate(() => ({
    asked: (window as Any).__runner.saves as number,
    written: (window as Any).__runner.savesWritten as number,
    uuid: ((window as Any).__runner.loaded?.manifest?.documentUuid ?? null) as string | null,
  }))) as { asked: number; written: number; uuid: string | null };
  if (written > 0 && uuid !== null) {
    await expect
      .poll(() => withKeyStore<boolean>(page, "return (await get(arg)) !== undefined", dataKeyKey(uuid)), { timeout: 30_000 })
      .toBe(true);
  }
  expect(await page.evaluate(() => (window as Any).__runner.saves), "no save asked while the page's writes landed").toBe(asked);
}

/**
 * Every save asked is written, and then a window of `ms` with nothing more
 * asked: long enough for whatever the host does after a save (its state
 * message, a keep, a sentence it would add or take away) to have happened.
 */
export async function savesSettled(page: Page, ms = 2_500): Promise<void> {
  await page.evaluate(() => (window as Any).__runner.flush());
  await expect
    .poll(() => page.evaluate(() => (window as Any).__runner.saves === (window as Any).__runner.savesWritten), { timeout: 30_000 })
    .toBe(true);
  await page.waitForTimeout(ms);
}

/** Opens the opener pointed at `base`, with a passkey provider, ready for a document. */
export async function openerWithStore(context: BrowserContext, base: string): Promise<{ page: Page; provider: Awaited<ReturnType<typeof addPasskeyProvider>> }> {
  const page = await context.newPage();
  await page.goto(RUNNER_URL);
  const provider = await addPasskeyProvider(context, page);
  await page.evaluate((b) => (window as Any).__runner.useStore(b), base);
  return { page, provider };
}

/**
 * Enrolls from the menu and waits until this browser context is signed in as
 * the new owner, on the page the next step will use (tests/README.md, the
 * rule for waiting). Where the browser has no Credential Management API, as
 * Safari, enrolling hands the keychain secret to a form whose submission
 * reloads the page: then the owner is read only after that load, with the
 * opener on the page that came back. A read that lands while a page is going
 * or coming answers nothing and is asked again (2b2dr5c-M1).
 */
export async function enrollHere(page: Page): Promise<string> {
  const said = { form: false, settled: false };
  let loadsAfterForm = 0;
  const onConsole = (message: { text(): string }): void => {
    const text = message.text();
    if (text.includes("keychain secret offered by a form")) said.form = true;
    else if (/dai: keychain secret (offered|not offered)/.test(text)) said.settled = true;
  };
  const onLoad = (): void => {
    if (said.form) loadsAfterForm += 1;
  };
  page.on("console", onConsole);
  page.on("load", onLoad);
  try {
    await keepFromMenu(page);
    let owner: string | null = null;
    await expect
      .poll(
        async () => {
          // The state the next step needs: the keychain offer settled, and with a form, the page it reloaded to.
          if (said.form ? loadsAfterForm === 0 : !said.settled) return false;
          owner = await page.evaluate(() => (window as Any).__runner?.owner?.current?.() ?? null).catch(() => null);
          return owner !== null;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    return owner!;
  } finally {
    page.off("console", onConsole);
    page.off("load", onLoad);
  }
}

/**
 * Flushes the frame's pending writes, waits until every save asked is
 * written, so the revision on screen is the last one coming, and then until
 * the store has acknowledged it. The runtime saves 800 ms after the last
 * change, and a first save can land mid-typing: without the flush, a revision
 * still on its debounce lands after the test has moved on (tests/README.md,
 * waiting).
 */
export async function waitSettledKept(page: Page, uuid: string, after = 0): Promise<KeptRecord> {
  await page.evaluate(() => (window as Any).__runner.flush());
  await expect
    .poll(() => page.evaluate(() => (window as Any).__runner.saves === (window as Any).__runner.savesWritten), { timeout: 30_000 })
    .toBe(true);
  return waitKeptCurrent(page, uuid, after);
}

/** Waits until the store has acknowledged the revision on screen, past `after`, as this opener recorded it. */
export async function waitKeptCurrent(page: Page, uuid: string, after = 0): Promise<KeptRecord> {
  let record: KeptRecord | null = null;
  await expect
    .poll(
      async () => {
        record = await keptRecord(page, uuid);
        const revision = await libraryRevision(page, uuid);
        return record !== null && revision > after && record.revision === revision ? "kept" : `kept ${record?.revision ?? "none"} of ${revision}`;
      },
      { timeout: 45_000 },
    )
    .toBe("kept");
  return record!;
}

/**
 * Writes one entry of the opener's key store, as the opener would have kept
 * it: how a test on an engine with no passkey stands up a state the opener
 * reads (an owner signed in, a revision kept), never how one is made.
 */
export function putInKeyStore(page: Page, key: string, value: unknown): Promise<void> {
  return page.evaluate(
    async ([k, v]) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const open = indexedDB.open("dai_runner_storage");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("keys", "readwrite");
        tx.objectStore("keys").put(v, k as string);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    [key, value] as const,
  );
}

export { waitMounted };
