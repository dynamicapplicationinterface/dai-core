import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, appIn, buildNotes, pointAtStore, storedHolds, typeNote } from "./owner.js";
import { serveOwnerStore, type ServedStore } from "./owner-store-memory.js";

/**
 * A document that arrives from the page's own address (D303, ruled 31 October).
 *
 * On iOS a document is on screen only at its own launch address, and for a
 * document that came as a file that address is an inline link the opener
 * minted from the container, the document's data in it. A tab left open
 * across Clear History and Website Data keeps that address, and a reload of it
 * brings the document back as the address held it, with nothing held here.
 * The address stays as the Home Screen carrier; the note row says what was
 * opened: "as this page's address held it on <date>", and, with a store
 * stamped, that a kept copy may be newer and Recover brings it. The arrival is
 * not kept and not signed in. A link someone followed is not the page's own
 * address, and is not said to be.
 *
 * The wipe is every store this origin has, cleared under the live page, the
 * worker unregistered, then a reload of the same address: what the device
 * reading of 30 October did with the tab left open.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PHONE = { width: 390, height: 844 };
const RECOVER_TOO = "A kept copy may be newer; Recover brings it.";

/** An iPhone's browser context, so the opener takes the iOS path: user agent and platform both. */
async function iphone(browser: Browser, store?: ServedStore): Promise<Page> {
  const context = await browser.newContext({ userAgent: IPHONE, viewport: PHONE });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "iPhone", configurable: true });
  });
  if (store) await pointAtStore(context, store.base);
  return context.newPage();
}

/** Waits until `uuid` is the document mounted and its field takes input, opening a card if one is shown. */
async function mounted(page: Page, uuid: string | null): Promise<FrameLocator> {
  const app = appIn(page);
  const card = page.locator("#card-open");
  await expect
    .poll(
      async () => {
        if (await card.isVisible().catch(() => false)) await card.click().catch(() => undefined);
        const loaded = await page.evaluate(() => (window as Any).__runner?.loaded?.manifest?.documentUuid ?? null).catch(() => null);
        if (uuid !== null && loaded !== uuid) return "another document";
        return (await app.locator("#note").isEnabled({ timeout: 500 }).catch(() => false)) ? "mounted" : "waiting";
      },
      { timeout: 60_000 },
    )
    .toBe("mounted");
  return app;
}

/** Every store this origin has, cleared under the live page, and the worker unregistered. */
async function wipeUnderLivePage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const databases = (await (indexedDB as Any).databases?.()) ?? [];
    for (const database of databases) {
      await new Promise<void>((done) => {
        const request = indexedDB.deleteDatabase(database.name);
        request.onsuccess = () => done();
        request.onerror = () => done();
        request.onblocked = () => done();
      });
    }
    try {
      const root = await navigator.storage.getDirectory();
      const names: string[] = [];
      for await (const [name] of (root as Any).entries()) names.push(name);
      for (const name of names) await root.removeEntry(name, { recursive: true });
    } catch {
      /* WebKit's OPFS throws on Playwright's Windows build; the library is in IndexedDB. */
    }
    for (const key of await caches.keys()) await caches.delete(key);
    localStorage.clear();
    sessionStorage.clear();
    for (const registration of (await navigator.serviceWorker?.getRegistrations?.()) ?? []) await registration.unregister();
  });
}

/**
 * A document opened from a file and changed, then reopened, so the tab sits at
 * the address the opener minted for it; the address and the document's id.
 */
async function atOwnAddress(page: Page): Promise<{ address: string; uuid: string }> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", await buildNotes(mkdtempSync(join(tmpdir(), "dai-own-address-")), "Notes"));
  const app = await mounted(page, null);
  const uuid = await page.evaluate(() => (window as Any).__runner.loaded.manifest.documentUuid as string);
  await typeNote(app, "first");
  await expect.poll(() => storedHolds(page, uuid, "first"), { timeout: 30_000 }).toBe(true);
  await page.reload();
  await mounted(page, uuid);
  const address = page.url();
  expect(address, "the inline address the opener minted, with its own hint").toMatch(/#.*\ba=.*opener-doc=/);
  // Nothing said over a document reopened from the library.
  await expect(page.locator("#doc-note")).toBeHidden();
  return { address, uuid };
}

/** The date the address's state was written, in the person's own words for a date. */
const heldOn = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const manifest = (window as Any).__runner.loaded.manifest;
    const at = (manifest.savedAt as string | undefined) ?? (manifest.createdAt as string);
    return new Date(at).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
  });

test.describe("a document from the page's own address (D303)", () => {
  test.slow();
  test.skip(({ browserName }) => browserName === "firefox", "the iOS path: WebKit's, and Chromium for a second engine");
  let store: ServedStore;
  test.beforeAll(async () => {
    store = await serveOwnerStore();
  });
  test.afterAll(async () => {
    await store?.close();
  });

  test("after a wipe, the reload of the tab's own address says the document is as the address held it, on its date", async ({ browser }) => {
    const page = await iphone(browser);
    const { uuid } = await atOwnAddress(page);
    const today = await page.evaluate(() => new Date().toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" }));
    await wipeUnderLivePage(page);
    await page.reload();
    await mounted(page, uuid);
    await expect(page.locator("#card")).toBeHidden();
    const on = await heldOn(page);
    expect(on, "the address was minted in this test").toBe(today);
    await expect(page.locator("#doc-note")).toHaveText(`Opened as this page's address held it on ${on}.`);
    await expect(page.locator("#doc-note")).not.toHaveClass(/\berror\b/);
  });

  test("with a store stamped it says a kept copy may be newer and Recover brings it; nothing is kept, nobody signed in, and a save neither clears it nor moves the document", async ({ browser }) => {
    const page = await iphone(browser, store);
    const { uuid } = await atOwnAddress(page);
    await wipeUnderLivePage(page);
    const before = store.received().length;
    await page.reload();
    const app = await mounted(page, uuid);
    const note = page.locator("#doc-note");
    const on = await heldOn(page);
    await expect(note).toHaveText(`Opened as this page's address held it on ${on}. ${RECOVER_TOO}`);
    const top = (): Promise<number> => page.locator("#cartridge").evaluate((frame) => frame.getBoundingClientRect().top);
    const first = await top();
    // A change of the person's, saved here: the sentence stays and the document does not move.
    const written = await page.evaluate(() => (window as Any).__runner.savesWritten as number);
    await typeNote(app, " later");
    await expect.poll(() => page.evaluate(() => (window as Any).__runner.savesWritten as number), { timeout: 30_000 }).toBeGreaterThan(written);
    await expect.poll(() => storedHolds(page, uuid, "later"), { timeout: 30_000 }).toBe(true);
    await expect(note).toHaveText(`Opened as this page's address held it on ${on}. ${RECOVER_TOO}`);
    expect(await top(), "the document did not move").toBe(first);
    expect(await page.locator("#doc-note").count(), "one note row").toBe(1);
    // Not kept and not signed in: no owner here, no kept record, and nothing sent to the store.
    expect(await page.evaluate(() => (window as Any).__runner.owner.current())).toBeNull();
    expect(await page.evaluate((id) => (window as Any).__runner.keeping.kept(id), uuid)).toBeNull();
    expect(store.received().slice(before).filter((request) => request.method !== "GET")).toEqual([]);
  });

  test("a link someone followed is not the page's own address, and gets no such sentence", async ({ browser }) => {
    const first = await iphone(browser, store);
    const { address, uuid } = await atOwnAddress(first);
    // The same document as a link a person shares: the opener's hint is never in one.
    const shared = new URL(address);
    shared.hash = `#${shared.hash
      .replace(/^#/, "")
      .split("&")
      .filter((part) => !part.startsWith("opener-doc="))
      .join("&")}`;
    shared.searchParams.delete("ground");
    const page = await iphone(browser, store);
    await page.goto(shared.href);
    await mounted(page, uuid);
    // The iOS reload has taken it to its own address since, where it is held.
    await expect.poll(() => page.url()).toContain("opener-doc=");
    await expect(page.locator("#doc-note")).not.toContainText("this page's address");
  });
});
