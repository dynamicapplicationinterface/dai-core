import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, addPasskeyProvider, appIn, buildNotes, openFile, pointAtStore, storedHolds, typeNote } from "./owner.js";
import { serveOwnerStore, type ServedStore } from "./owner-store-memory.js";
import { enrollHere, putInKeyStore, waitKeptCurrent, waitSettledKept } from "./keeping.js";

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

/**
 * Recover over a document (D303, ruled 31 October; Build 2b-2dr item 6).
 *
 * Recover lives in the chooser, which an open document covers. So the menu
 * offers it when nobody is signed in and a store is stamped, and it opens the
 * recovery sheet with both ways. A document held here and kept nowhere, the
 * arrival from the page's own address among them, is not replaced by what
 * Recover brings: it is adopted under the owner and kept as a line beside the
 * store's, and the newest line is shown and said.
 */
test.describe("Recover from the menu over a document (D303)", () => {
  test.slow();
  test.skip(({ browserName }) => browserName === "firefox", "the iOS path: WebKit's, and Chromium for a second engine");
  let store: ServedStore;
  test.beforeAll(async () => {
    store = await serveOwnerStore();
  });
  test.afterAll(async () => {
    await store?.close();
  });

  const notes = (): Promise<string> => buildNotes(mkdtempSync(join(tmpdir(), "dai-menu-recover-")), "Notes");

  test("the menu has Recover with a store stamped and nobody signed in, opening the recovery sheet with both ways; not with no store, nor with an owner signed in", async ({ browser }) => {
    // No store: no row.
    const bare = await browser.newContext({ viewport: PHONE });
    const plain = await bare.newPage();
    await plain.goto(RUNNER_URL);
    await openFile(plain, await notes());
    await plain.locator("#more").click();
    await expect(plain.locator("#sheet")).toBeVisible();
    await expect(plain.locator("#menu-recover")).toBeHidden();

    // A store, nobody signed in: the row, and the sheet it opens.
    const context = await browser.newContext({ viewport: PHONE });
    await pointAtStore(context, store.base);
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await openFile(page, await notes());
    await page.locator("#more").click();
    await expect(page.locator("#menu-recover")).toBeVisible();
    await expect(page.locator("#menu-recover")).toHaveText("Recover documents kept beyond this browser");
    await page.locator("#menu-recover").click();
    await expect(page.locator("#finish-sheet")).toBeVisible();
    await expect(page.locator("#finish-title")).toHaveText("Recover documents kept beyond this browser");
    await expect(page.locator("#finish-passkey")).toBeVisible();
    await expect(page.locator("#finish-keychain")).toBeVisible();
    await page.locator("#finish-cancel").click();
    await expect(page.locator("#finish-sheet")).toBeHidden();

    // An owner signed in here: no row.
    const owner = "menu-owner-0000000000000";
    await putInKeyStore(page, `dai:owner:${owner}`, { owner, atStore: true });
    await putInKeyStore(page, "dai:owner", owner);
    await page.evaluate(() => new BroadcastChannel("dai:owner").postMessage("changed"));
    await expect.poll(() => page.evaluate(() => (window as Any).__runner.owner.current())).toBe(owner);
    await page.locator("#more").click();
    await expect(page.locator("#sheet")).toBeVisible();
    await expect(page.locator("#menu-recover")).toBeHidden();
  });

  test("after the arrival from the page's own address and a change, Recover from the menu keeps the copy here as a second line, shows the newest and says so, and leaves one copy in the library", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const page = await iphone(browser, store);
    await page.goto(RUNNER_URL);
    const provider = await addPasskeyProvider(page.context(), page);
    expect(provider.id).toBeTruthy();
    // Safari, earlier: the document opened from a file, changed, and kept under its owner.
    await page.setInputFiles("#file", await notes());
    let app = await mounted(page, null);
    const uuid = await page.evaluate(() => (window as Any).__runner.loaded.manifest.documentUuid as string);
    await typeNote(app, "kept");
    await expect.poll(() => storedHolds(page, uuid, "kept"), { timeout: 30_000 }).toBe(true);
    const owner = await enrollHere(page);
    await waitSettledKept(page, uuid);
    const heads = (): string[] => {
      const found = store.values().find((value) => value.object === `d:${owner}:${uuid}` && value.key === "heads");
      return found ? (JSON.parse(found.bytes.toString("utf8")) as string[]) : [];
    };
    expect(heads()).toHaveLength(1);

    // The tab at its own address, everything cleared under it, and the address reloaded.
    await page.reload();
    await mounted(page, uuid);
    expect(page.url()).toMatch(/#.*\ba=.*opener-doc=/);
    await wipeUnderLivePage(page);
    await page.reload();
    app = await mounted(page, uuid);
    await expect(page.locator("#doc-note")).toContainText(RECOVER_TOO);
    await typeNote(app, "here");
    await expect.poll(() => storedHolds(page, uuid, "here"), { timeout: 30_000 }).toBe(true);
    const shown = await app.locator("#note").inputValue();

    // Recover, from the menu, with the passkey.
    await page.locator("#more").click();
    await page.locator("#menu-recover").click();
    await page.locator("#finish-passkey").click();
    await expect(page.locator("#doc-note")).toHaveText("Recovered Notes. Notes has two kept lines; the newest is shown.", { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as Any).__runner.owner.current()), { timeout: 30_000 }).toBe(owner);
    // The copy here, kept as its own line: two heads, and the revision here acknowledged by the store.
    await expect.poll(() => heads().length, { timeout: 30_000 }).toBe(2);
    await waitKeptCurrent(page, uuid);
    // The newest line is the one shown, and nothing of the person's was replaced.
    await expect(app.locator("#note")).toHaveValue(shown);
    expect(shown).toContain("here");
    const copies = await page.evaluate(
      async (id) => ((await (window as Any).__runner.listLibrary()) as Any[]).filter((item) => item.documentUuid === id).length,
      uuid,
    );
    expect(copies, "one copy in the library").toBe(1);
    expect(await storedHolds(page, uuid, "here")).toBe(true);
  });
});
