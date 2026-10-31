import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { signedBytes, signedViewOf } from "../src/core.js";
import { inlineLink } from "../src/link.js";
import { publish } from "../src/store.js";
import { fsStore } from "../src/store-fs.js";
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
    // The change saved and its save written: the library record, not only the stored bytes, says so.
    await page.evaluate(() => (window as Any).__runner.flush());
    await expect.poll(() => page.evaluate(() => (window as Any).__runner.saves === (window as Any).__runner.savesWritten), { timeout: 30_000 }).toBe(true);
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
   * The review of Build 2b-2dr2 (2b2dr2-H1), its own scenario: a file opened,
   * "kept-K" typed and kept; the browser wiped; the same file opened again,
   * unchanged; Recover from the menu by the passkey. Then a context with
   * nothing in it recovers the same.
   */
  test("a file opened again after a wipe, unchanged, is restored over: the kept copy comes back, and an empty context recovers it too", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const context = await browser.newContext({ viewport: PHONE });
    await pointAtStore(context, store.base);
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    const provider = await addPasskeyProvider(context, page);
    const file = await notes();
    let app = await openFile(page, file);
    const uuid = await page.evaluate(() => (window as Any).__runner.loaded.manifest.documentUuid as string);
    await typeNote(app, "kept-K");
    const owner = await enrollHere(page);
    await waitSettledKept(page, uuid);
    const heads = (): string[] => {
      const found = store.values().find((value) => value.object === `d:${owner}:${uuid}` && value.key === "heads");
      return found ? (JSON.parse(found.bytes.toString("utf8")) as string[]) : [];
    };
    await wipe(page, provider.cdp);
    app = await openFile(page, file);
    await expect(app.locator("#note")).toHaveValue("");
    await recoverFromTheMenu(page);
    await expect(app.locator("#note")).toHaveValue("kept-K", { timeout: 60_000 });
    await expect(page.locator("#doc-note")).toHaveText(
      /^Recovered Notes\. Restored the copy kept at [^.]+\. Changes saved only in the cleared browser are not included\.$/,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(3_000);
    expect(heads(), "one head: no line kept for the snapshot").toHaveLength(1);
    expect(
      await page.evaluate(async (id) => ((await (window as Any).__runner.listLibrary()) as Any[]).filter((item) => item.documentUuid === id).length, uuid),
      "one copy in the library",
    ).toBe(1);
    // A context with nothing in it: Recover brings "kept-K".
    await wipe(page, provider.cdp);
    await page.locator("#recover").click();
    const row = page.locator(`#recovered button[data-document="${uuid}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#report")).toHaveText("Recovered Notes.");
    await row.click();
    await expect(appIn(page).locator("#note")).toHaveValue("kept-K", { timeout: 60_000 });
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

/**
 * A snapshot by any inline carrier (D303, ruled on the review of Build 2b-2dr):
 * a document that arrives by `#a=` into a context that does not hold it is a
 * snapshot until the first save that carries the person's change, whether it
 * came from the page's own address or from a link someone followed. The
 * snapshot mark decides what Recover does; the own-address mark decides only
 * what is said. So whether a browser keeps a tab's history state across a
 * wipe never decides what Recover keeps.
 *
 * The owner and the newer kept copy are made in a Chromium of their own (the
 * passkey with PRF is its virtual authenticator); the context the link is
 * followed in is the project's engine, and recovers with the saved password,
 * which both engines can.
 */
test.describe("a snapshot by a link someone followed (D303)", () => {
  test.slow();
  test.skip(({ browserName }) => browserName === "firefox", "Chromium and WebKit");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let store: ServedStore;
  test.beforeAll(async () => {
    store = await serveOwnerStore();
  });
  test.afterAll(async () => {
    await store?.close();
  });

  /** The document kept under its owner, changed past what the link carries; the link, the owner, its saved password and the store's heads. */
  async function keptElsewhere(): Promise<{ file: string; link: string; uuid: string; owner: string; account: string; secret: string; heads: () => string[] }> {
    const file = await buildNotes(mkdtempSync(join(tmpdir(), "dai-followed-")), "Notes");
    const link = await inlineLink(readFileSync(file, "utf8"), RUNNER_URL, {
      template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
      runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
    });
    if (!link) throw new Error("expected an inline link");
    const elsewhere = await chromium.launch();
    try {
      const context = await elsewhere.newContext();
      await pointAtStore(context, store.base);
      const handed = await watchKeychain(context);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      await addPasskeyProvider(context, page);
      const app = await openFile(page, file);
      const uuid = await page.evaluate(() => (window as Any).__runner.loaded.manifest.documentUuid as string);
      await typeNote(app, "kept-copy");
      const owner = await enrollHere(page);
      await waitSettledKept(page, uuid);
      const password = handed.find((entry) => entry.owner === owner);
      if (!password) throw new Error("no saved password handed over");
      const heads = (): string[] => {
        const found = store.values().find((value) => value.object === `d:${owner}:${uuid}` && value.key === "heads");
        return found ? (JSON.parse(found.bytes.toString("utf8")) as string[]) : [];
      };
      expect(heads()).toHaveLength(1);
      return { file, link, uuid, owner, account: password.account, secret: password.secret, heads };
    } finally {
      await elsewhere.close();
    }
  }

  /** The link followed in an empty context of this engine: the card, Open, the document as the link carries it. */
  async function followed(browser: Browser, link: string, uuid: string): Promise<{ page: Page; app: FrameLocator }> {
    const context = await browser.newContext({ viewport: PHONE });
    await pointAtStore(context, store.base);
    const page = await context.newPage();
    await page.goto(link);
    const app = await mounted(page, uuid);
    await expect(app.locator("#note")).toHaveValue("");
    expect(await ownMark(page), "no own-address mark: a link someone followed").toBeNull();
    expect((await page.locator("#doc-note").textContent()) ?? "").not.toContain("this page's address");
    return { page, app };
  }

  async function recoverWithThePassword(page: Page, account: string, secret: string): Promise<void> {
    await page.locator("#more").click();
    await page.locator("#menu-recover").click();
    await page.locator("#finish-owner").fill(account);
    await page.locator("#finish-secret").fill(secret);
    await page.locator("#finish-with-password").click();
  }

  const copiesOf = (page: Page, uuid: string): Promise<number> =>
    page.evaluate(async (id) => ((await (window as Any).__runner.listLibrary()) as Any[]).filter((item) => item.documentUuid === id).length, uuid);

  test("unchanged since it arrived, a document from a followed link is restored over: the kept copy, one head, one copy, no lines clause", async ({ browser }) => {
    const kept = await keptElsewhere();
    const { page, app } = await followed(browser, kept.link, kept.uuid);
    await recoverWithThePassword(page, kept.account, kept.secret);
    await expect(app.locator("#note")).toHaveValue("kept-copy", { timeout: 60_000 });
    await expect(page.locator("#doc-note")).toHaveText(
      /^Recovered Notes\. Restored the copy kept at [^.]+\. Changes saved only in the cleared browser are not included\.$/,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(3_000);
    expect(kept.heads(), "one head: no line kept for the snapshot").toHaveLength(1);
    expect(await copiesOf(page, kept.uuid), "one copy in the library").toBe(1);
  });

  test("changed since it arrived, a document from a followed link is kept as its own line, and the lines sentence says so", async ({ browser }) => {
    const kept = await keptElsewhere();
    const { page, app } = await followed(browser, kept.link, kept.uuid);
    await typeNote(app, "C");
    // The change saved and its save written: the library record, not only the stored bytes, says so.
    await page.evaluate(() => (window as Any).__runner.flush());
    await expect.poll(() => page.evaluate(() => (window as Any).__runner.saves === (window as Any).__runner.savesWritten), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => storedHolds(page, kept.uuid, "C"), { timeout: 30_000 }).toBe(true);
    await recoverWithThePassword(page, kept.account, kept.secret);
    await expect(page.locator("#doc-note")).toHaveText("Recovered Notes. Notes has two kept lines; the one kept last is shown.", { timeout: 30_000 });
    await expect.poll(() => kept.heads().length, { timeout: 30_000 }).toBe(2);
    await expect(app.locator("#note")).toHaveValue("C");
    expect(await copiesOf(page, kept.uuid), "one copy in the library").toBe(1);
  });

  /*
   * Every carrier, not only `#a=` (D303 as amended on the review of Build
   * 2b-2dr2, 2b2dr2-H1 and M1): a file, the share target and a store link,
   * each arriving unchanged into an empty context, are restored over.
   */
  type Kept = Awaited<ReturnType<typeof keptElsewhere>>;

  /** A context of this engine pointed at the store, at the opener. */
  async function emptyContext(browser: Browser, address = RUNNER_URL): Promise<Page> {
    const context = await browser.newContext({ viewport: PHONE });
    await pointAtStore(context, store.base);
    const page = await context.newPage();
    await page.goto(address);
    return page;
  }

  /** Recover with the saved password over a document that arrived unchanged: the kept copy, one head, one copy, no lines clause. */
  async function restoredOver(page: Page, app: FrameLocator, kept: Kept): Promise<void> {
    await expect(app.locator("#note")).toHaveValue("");
    await recoverWithThePassword(page, kept.account, kept.secret);
    await expect(app.locator("#note")).toHaveValue("kept-copy", { timeout: 60_000 });
    await expect(page.locator("#doc-note")).toHaveText(
      /^Recovered Notes\. Restored the copy kept at [^.]+\. Changes saved only in the cleared browser are not included\.$/,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(3_000);
    expect(kept.heads(), "one head: no line kept for the snapshot").toHaveLength(1);
    expect(await copiesOf(page, kept.uuid), "one copy in the library").toBe(1);
  }

  /** Files served as a dumb store serves them, for a link that names one. */
  async function serveFiles(root: string): Promise<{ server: Server; origin: string }> {
    const server = createServer((request, response) => {
      const name = decodeURIComponent((request.url ?? "/").split("?")[0]!.slice(1));
      const file = join(root, name);
      if (!name || !existsSync(file) || statSync(file).isDirectory()) {
        response.writeHead(404, { "access-control-allow-origin": "*" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
      createReadStream(file).pipe(response);
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  }

  test("unchanged since it arrived from a file, a document is restored over", async ({ browser }) => {
    const kept = await keptElsewhere();
    const page = await emptyContext(browser);
    await page.setInputFiles("#file", kept.file);
    const app = await mounted(page, kept.uuid);
    await restoredOver(page, app, kept);
  });

  test("unchanged since it arrived by the share target, a document is restored over", async ({ browser }) => {
    const kept = await keptElsewhere();
    const page = await emptyContext(browser);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });
    await page.evaluate(async (body: string) => {
      const form = new FormData();
      form.append("container", new File([body], "Notes.dai.html", { type: "text/html" }));
      await fetch("./shared", { method: "POST", body: form });
    }, readFileSync(kept.file, "utf8"));
    await page.goto(`${RUNNER_URL}?shared=1`);
    const app = await mounted(page, kept.uuid);
    await restoredOver(page, app, kept);
  });

  test("unchanged since it arrived by a store link, a document is restored over", async ({ browser }) => {
    const kept = await keptElsewhere();
    const root = mkdtempSync(join(tmpdir(), "dai-link-store-"));
    const files = await serveFiles(root);
    try {
      const { sealed } = await publish(readFileSync(kept.file, "utf8"), fsStore({ root, baseUrl: files.origin }), RUNNER_URL);
      const link = `${RUNNER_URL}#h=${sealed.hash}&u=${encodeURIComponent(`${files.origin}/${sealed.hash}`)}&k=${sealed.key}`;
      const page = await emptyContext(browser, link);
      const app = await mounted(page, kept.uuid);
      await restoredOver(page, app, kept);
    } finally {
      files.server.close();
    }
  });
});

/*
 * D303 as amended on the review of Build 2b-2dr2 (2b2dr2-L1): any write here
 * other than the restore ends the snapshot, changes that came across from
 * another copy included. A snapshot that takes in another copy's rows is no
 * longer the arrival's state, so Recover keeps it as a line, not restored
 * over.
 */
test.describe("a snapshot that takes in another copy's changes (D303)", () => {
  test.slow();
  test("changes that came across end the snapshot: Recover keeps the copy as a line", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    try {
      const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      const scratch = mkdtempSync(join(tmpdir(), "dai-snapshot-merge-"));
      const built = await compileDirectory({
        policyLayer: true,
        sourceDir: join(repo, "tests", "fixture", "chess"),
        root: repo,
        appName: "Velvet Chess",
        signingKey: resolve(repo, "conformance", "signing-key.pem"),
        allowTestKey: true,
      });
      const file = join(scratch, "chess.dai.html");
      writeFileSync(file, built.html, "utf8");
      const uuid = built.manifest.documentUuid;
      const view = createHash("sha256").update(signedBytes(signedViewOf(built.manifest))).digest("hex");

      const context = await browser.newContext({ viewport: PHONE });
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      const provider = await addPasskeyProvider(context, page);
      const chess = appIn(page);

      // One copy: a game begun, the document kept under its owner; its database is another copy's changes for the next.
      await page.setInputFiles("#file", file);
      await page.locator("#card-open").click({ timeout: 60_000 });
      await expect(chess.locator("#app")).toBeVisible({ timeout: 60_000 });
      await chess.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
      await chess.locator("#setup-you").fill("Ada");
      await chess.locator("#setup-them").fill("Bo");
      await chess.locator('input[name="color"][value="w"]').check();
      await chess.locator("#new-game-form button[type=submit]").click();
      await expect.poll(() => page.evaluate(() => (window as Any).__runner.savesWritten as number), { timeout: 30_000 }).toBeGreaterThan(0);
      const owner = await enrollHere(page);
      await waitSettledKept(page, uuid);
      const other = (await page.evaluate(async (id) => [...((await (window as Any).__runner.loadStored(id)) as Uint8Array)], uuid)) as number[];
      const heads = (): string[] => {
        const found = store.values().find((value) => value.object === `d:${owner}:${uuid}` && value.key === "heads");
        return found ? (JSON.parse(found.bytes.toString("utf8")) as string[]) : [];
      };
      expect(heads()).toHaveLength(1);

      // A context with nothing: the file opened again (a snapshot), and the other copy's changes come across.
      await wipe(page, provider.cdp);
      await page.setInputFiles("#file", file);
      await page.locator("#card-open").click({ timeout: 60_000 });
      await expect(chess.locator("#app")).toBeVisible({ timeout: 60_000 });
      /*
       * Chess writes a row of its own as it opens, which already ends the
       * snapshot (a write here). So the copy is put back to a snapshot, its
       * writes settled, and the other copy's changes are the only write after.
       */
      await page.evaluate(() => (window as Any).__runner.flush());
      await expect.poll(() => page.evaluate(() => (window as Any).__runner.saves === (window as Any).__runner.savesWritten), { timeout: 30_000 }).toBe(true);
      await page.evaluate(async (id) => {
        const db: IDBDatabase = await new Promise((done, fail) => {
          const open = indexedDB.open("dai_runner_storage");
          open.onsuccess = () => done(open.result);
          open.onerror = () => fail(open.error);
        });
        const store = db.transaction("cartridges", "readwrite").objectStore("cartridges");
        const held = await new Promise<Any>((done) => {
          const get = store.get(id);
          get.onsuccess = () => done(get.result);
        });
        await new Promise<void>((done) => {
          const put = store.put({ ...held, arrivedSnapshot: true });
          put.onsuccess = () => done();
        });
        db.close();
      }, uuid);
      const report = (await page.evaluate(([bytes, digest]) => (window as Any).__runner.mergeInFrame(bytes, digest), [other, view] as const)) as {
        applied: number;
        refused?: string;
      };
      expect(report.refused).toBeUndefined();
      expect(report.applied, "changes came across").toBeGreaterThan(0);
      await page.evaluate(() => (window as Any).__runner.flush());
      await expect.poll(() => page.evaluate(() => (window as Any).__runner.saves === (window as Any).__runner.savesWritten), { timeout: 30_000 }).toBe(true);

      // Recover from the menu: the copy here is kept as a line, not restored over.
      await page.locator("#more").click();
      await page.locator("#menu-recover").click();
      await page.locator("#finish-passkey").click();
      await expect(page.locator("#doc-note")).toHaveText("Recovered Velvet Chess. Velvet Chess has two kept lines; the one kept last is shown.", { timeout: 30_000 });
      await expect.poll(() => heads().length, { timeout: 30_000 }).toBe(2);
    } finally {
      await store.close();
    }
  });
});
