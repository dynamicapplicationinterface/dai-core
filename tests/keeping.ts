import { expect, type BrowserContext, type Page } from "@playwright/test";
import { RUNNER_URL, addPasskeyProvider, keepFromMenu, waitMounted } from "./owner.js";

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

/** Opens the opener pointed at `base`, with a passkey provider, ready for a document. */
export async function openerWithStore(context: BrowserContext, base: string): Promise<{ page: Page; provider: Awaited<ReturnType<typeof addPasskeyProvider>> }> {
  const page = await context.newPage();
  await page.goto(RUNNER_URL);
  const provider = await addPasskeyProvider(context, page);
  await page.evaluate((b) => (window as Any).__runner.useStore(b), base);
  return { page, provider };
}

/** Enrolls from the menu and waits until this browser context is signed in as the new owner. */
export async function enrollHere(page: Page): Promise<string> {
  await keepFromMenu(page);
  let owner: string | null = null;
  await expect
    .poll(
      async () => {
        owner = await page.evaluate(() => (window as Any).__runner.owner.current());
        return owner !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return owner!;
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
