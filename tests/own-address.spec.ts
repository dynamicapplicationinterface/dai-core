import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, addPasskeyProvider, appIn, buildNotes, openFile, pointAtStore, storedHolds, typeNote, withKeyStore } from "./owner.js";
import { watchKeychain, wipe } from "./keychain.js";
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
  // The inline address the opener minted, its own mark in the tab's history state and never in the address.
  expect(address, "the document in the address").toMatch(/#.*\ba=/);
  expect(address, "no hint in the address bar").not.toContain("opener-doc=");
  expect(await ownMark(page), "the mark, in the tab's history state").toBe(uuid);
  // Nothing said over a document reopened from the library.
  await expect(page.locator("#doc-note")).toBeHidden();
  return { address, uuid };
}

/** The page's own-address mark: the document the tab's history state names, or null. */
const ownMark = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const state = history.state as { daiOwnAddress?: unknown } | null;
    return typeof state?.daiOwnAddress === "string" ? state.daiOwnAddress : null;
  });

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

  /*
   * The address bar as a person copies it, or as Safari's share sheet sends
   * it, opened in another context: a link someone followed (D303, ruled on
   * the review of Build 2b-2dr, 2b2dr-M1). The address carries the document
   * and no mark; the tab's history state is not in it.
   */
  test("the address bar, copied and opened elsewhere, is a link someone followed, and gets no such sentence", async ({ browser }) => {
    const first = await iphone(browser, store);
    const { address, uuid } = await atOwnAddress(first);
    const page = await iphone(browser, store);
    await page.goto(address);
    await mounted(page, uuid);
    expect(await page.locator("#doc-note").textContent()).not.toContain("this page's address");
    // Held here now, at its own address: the bar still carries the document and no hint.
    expect(page.url()).toMatch(/#.*\ba=/);
    expect(page.url()).not.toContain("opener-doc=");
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

  /*
   * The review of Build 2b-2dr (2b2dr-H1), its own scenario: a document opened
   * from a file, "A" typed and kept; the reload takes the tab to its own
   * address (minted before "A"); "-B" typed and kept, so the store's one head
   * holds "A-B". Everything cleared under the live tab and the address
   * reloaded: the field reads "". Answers the page, the field, the document,
   * its owner, the store's heads and the kept record of "A-B".
   */
  async function keptThenArrived(browser: Browser): Promise<{
    page: Page;
    app: FrameLocator;
    uuid: string;
    owner: string;
    provider: Awaited<ReturnType<typeof addPasskeyProvider>>;
    heads: () => string[];
    keptAB: { digest: string; revision: number };
  }> {
    const page = await iphone(browser, store);
    await page.goto(RUNNER_URL);
    const provider = await addPasskeyProvider(page.context(), page);
    await page.setInputFiles("#file", await notes());
    let app = await mounted(page, null);
    const uuid = await page.evaluate(() => (window as Any).__runner.loaded.manifest.documentUuid as string);
    await typeNote(app, "A");
    await expect.poll(() => storedHolds(page, uuid, "A"), { timeout: 30_000 }).toBe(true);
    const owner = await enrollHere(page);
    const keptA = await waitSettledKept(page, uuid);
    await page.reload();
    app = await mounted(page, uuid);
    expect(await ownMark(page)).toBe(uuid);
    await typeNote(app, "-B");
    await expect(app.locator("#note")).toHaveValue("A-B");
    const keptAB = await waitSettledKept(page, uuid, keptA.revision);
    const heads = (): string[] => {
      const found = store.values().find((value) => value.object === `d:${owner}:${uuid}` && value.key === "heads");
      return found ? (JSON.parse(found.bytes.toString("utf8")) as string[]) : [];
    };
    expect(heads()).toEqual([keptAB.digest]);
    await wipeUnderLivePage(page);
    await page.reload();
    app = await mounted(page, uuid);
    await expect(app.locator("#note")).toHaveValue("");
    await expect(page.locator("#doc-note")).toContainText(RECOVER_TOO);
    return { page, app, uuid, owner, provider, heads, keptAB: { digest: keptAB.digest, revision: keptAB.revision } };
  }

  /** ⋯ → "Recover documents kept beyond this browser" → the passkey. */
  async function recoverFromTheMenu(page: Page): Promise<void> {
    await page.locator("#more").click();
    await page.locator("#menu-recover").click();
    await page.locator("#finish-passkey").click();
  }

  test("an arrival unchanged since it arrived is restored over: the kept copy comes back, no line is kept for it, and an empty context recovers the same", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const { page, app, uuid, owner, provider, heads } = await keptThenArrived(browser);
    await recoverFromTheMenu(page);
    await expect(app.locator("#note")).toHaveValue("A-B", { timeout: 60_000 });
    await expect(page.locator("#doc-note")).toHaveText(
      /^Recovered Notes\. Restored the copy kept at [^.]+\. Changes saved only in the cleared browser are not included\.$/,
      { timeout: 30_000 },
    );
    expect(await page.evaluate(() => (window as Any).__runner.owner.current())).toBe(owner);
    await page.waitForTimeout(3_000);
    // One head: no line kept for the snapshot (the reopened copy's own save may follow "A-B" on its line).
    expect(heads(), "one head: no line kept for the snapshot").toHaveLength(1);
    const copies = await page.evaluate(
      async (id) => ((await (window as Any).__runner.listLibrary()) as Any[]).filter((item) => item.documentUuid === id).length,
      uuid,
    );
    expect(copies, "one copy in the library").toBe(1);

    // A context with nothing in it: Recover brings "A-B".
    await wipe(page, provider.cdp);
    await page.locator("#recover").click();
    const row = page.locator(`#recovered button[data-document="${uuid}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#report")).toHaveText("Recovered Notes.");
    await row.click();
    await expect(appIn(page).locator("#note")).toHaveValue("A-B", { timeout: 60_000 });
  });

  test("an arrival changed since it arrived is kept as its own line: two heads, the store's earlier head kept, the line kept last shown and said", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const { page, app, uuid, owner, heads, keptAB } = await keptThenArrived(browser);
    await typeNote(app, "C");
    await expect.poll(() => storedHolds(page, uuid, "C"), { timeout: 30_000 }).toBe(true);
    await recoverFromTheMenu(page);
    await expect(page.locator("#doc-note")).toHaveText("Recovered Notes. Notes has two kept lines; the one kept last is shown.", { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as Any).__runner.owner.current()), { timeout: 30_000 }).toBe(owner);
    // The copy here kept as its own line, and "A-B" still a head at the store.
    await expect.poll(() => heads().length, { timeout: 30_000 }).toBe(2);
    const keptC = await waitKeptCurrent(page, uuid);
    expect(heads()).toContain(keptAB.digest);
    expect(heads()).toContain(keptC.digest);
    await expect(app.locator("#note")).toHaveValue("C");
    const copies = await page.evaluate(
      async (id) => ((await (window as Any).__runner.listLibrary()) as Any[]).filter((item) => item.documentUuid === id).length,
      uuid,
    );
    expect(copies, "one copy in the library").toBe(1);
  });

  /*
   * D303, ruled on the review of Build 2b-2dr (2b2dr-H2): a document held here
   * under another owner is passed over by Recover, not restored, not re-keyed,
   * not touched, and the note row says it was left as it is.
   */
  test("Recover by one owner passes over a document held here under another: its unkept work stays, its key stays, and the note row says so", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const context = await browser.newContext({ viewport: PHONE });
    await pointAtStore(context, store.base);
    const handed = await watchKeychain(context);
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    const provider = await addPasskeyProvider(context, page);
    const file = await notes();
    // Context A: owner X keeps the document.
    let app = await openFile(page, file);
    const uuid = await page.evaluate(() => (window as Any).__runner.loaded.manifest.documentUuid as string);
    await typeNote(app, "x-kept");
    const x = await enrollHere(page);
    await waitSettledKept(page, uuid);
    const xPassword = handed.find((entry) => entry.owner === x)!;
    expect(xPassword, "X's saved password").toBeTruthy();
    // Context B: the same document, owner Y keeps it, signs out, and types more here.
    await wipe(page, provider.cdp);
    app = await openFile(page, file);
    await typeNote(app, "y-kept");
    const y = await enrollHere(page);
    expect(y).not.toBe(x);
    await waitSettledKept(page, uuid);
    await page.evaluate(() => (window as Any).__runner.owner.leave());
    await expect.poll(() => page.evaluate(() => (window as Any).__runner.owner.current())).toBeNull();
    await typeNote(app, "-y-unkept");
    await expect.poll(() => storedHolds(page, uuid, "-y-unkept"), { timeout: 30_000 }).toBe(true);
    const keyOwner = (): Promise<string | null> => withKeyStore<string | null>(page, 'return (await get("dai:data-key:" + arg))?.owner ?? null;', uuid);
    expect(await keyOwner()).toBe(y);

    // Recover from the menu with X's saved password.
    await page.locator("#more").click();
    await page.locator("#menu-recover").click();
    await page.locator("#finish-owner").fill(xPassword.account);
    await page.locator("#finish-secret").fill(xPassword.secret);
    await page.locator("#finish-with-password").click();
    await expect(page.locator("#doc-note")).toHaveText("Notes was left as it is: this browser holds it for another passkey.", { timeout: 30_000 });
    expect(await storedHolds(page, uuid, "-y-unkept"), "Y's unkept change, still here").toBe(true);
    expect(await keyOwner(), "the key, still Y's").toBe(y);
  });
});
