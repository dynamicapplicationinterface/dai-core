import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, appIn, buildNotes, openFile, pointAtStore, storedHolds, typeNote, uuidOf, withKeyStore } from "./owner.js";
import { watchKeychain } from "./keychain.js";
import { serveOwnerStore } from "./owner-store-memory.js";
import { enrollHere, keptRecord, openerWithStore, savesSettled, waitSettledKept, watchDocumentTop } from "./keeping.js";

/**
 * Recovery, Build 2b-2 item 5 (R-Z sentence 5 and its first red test; R-E).
 *
 * R-Z's first red test, in four steps: A is kept; the store is cut off; B is saved in this
 * browser only; the browser's storage is wiped. Recover, with the passkey,
 * brings back A exactly, identified by the time the store acknowledged it,
 * with no claim about B and no invented count of anything. And recovery with
 * the store unreachable says so, and presents nothing as recovered.
 *
 * Chromium only: the passkey with PRF is its virtual authenticator, which
 * keeps the passkey through the wipe as a phone's keychain does.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const SENTENCE_TAIL = "Changes saved only in the cleared browser are not included.";

/** Wipes everything this origin keeps: storage, databases, the worker and its caches. The passkey is the authenticator's. */
async function wipe(page: Page, cdp: CDPSession): Promise<void> {
  await cdp.send("Storage.clearDataForOrigin", { origin: new URL(RUNNER_URL).origin, storageTypes: "all" });
  await page.goto(RUNNER_URL);
  expect(await page.evaluate(() => (window as Any).__runner.listLibrary()), "nothing is left").toEqual([]);
}

/**
 * 2b2-H2's two documents, First and Second, kept under one new owner: the ids,
 * the owner, and which of the two the library lists first (it lists them
 * sorted by id, so a store cut at the second's Heads restores the first alone).
 */
async function twoKept(page: Page): Promise<{ ids: Record<string, string>; owner: string; first: string; second: string }> {
  const scratch = mkdtempSync(join(tmpdir(), "dai-recover-"));
  const files = { First: await buildNotes(scratch, "First"), Second: await buildNotes(scratch, "Second") };
  const ids: Record<string, string> = {};
  let owner = "";
  for (const [title, file] of Object.entries(files)) {
    const app = await openFile(page, file);
    ids[title] = await uuidOf(page);
    if (!owner) owner = await enrollHere(page);
    await typeNote(app, `${title}-text`);
    await expect.poll(() => storedHolds(page, ids[title]!, `${title}-text`), { timeout: 30_000 }).toBe(true);
    await waitSettledKept(page, ids[title]!);
  }
  const [first, second] = Object.keys(ids).sort((x, y) => (ids[x]! < ids[y]! ? -1 : 1)) as [string, string];
  return { ids, owner, first, second };
}

/** The store stops answering from one document's Heads on, until the route is taken away. */
async function cutAtHeadsOf(context: BrowserContext, base: string, documentUuid: string): Promise<void> {
  let cut = false;
  await context.route(`${base}/**`, async (route) => {
    if (route.request().url().includes(`/${documentUuid}/heads`)) cut = true;
    return cut ? route.abort("connectionrefused") : route.continue();
  });
}

test.describe("recovery (R-Z sentence 5, Build 2b-2 item 5)", () => {
  test.slow();

  test("A kept, the store cut off, B saved here only, the browser wiped: Recover brings back A exactly, by its time, and says nothing of B", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, provider } = await openerWithStore(context, store.base);
      const file = await buildNotes(mkdtempSync(join(tmpdir(), "dai-recover-")), "Notes");
      let app = await openFile(page, file);
      const uuid = await uuidOf(page);
      await enrollHere(page);

      // 1. A, kept, at two revisions that differ: a recovery that restores the head's parent is not A.
      await typeNote(app, "A-7Q");
      await expect.poll(() => storedHolds(page, uuid, "A-7Q"), { timeout: 30_000 }).toBe(true);
      const earlier = await waitSettledKept(page, uuid);
      await typeNote(app, "-kept");
      await expect.poll(() => storedHolds(page, uuid, "A-7Q-kept"), { timeout: 30_000 }).toBe(true);
      const a = await waitSettledKept(page, uuid, earlier.revision);
      // 2. The store cut off. 3. B, saved in this browser only.
      store.setMode("unavailable");
      await typeNote(app, " B-local-3X");
      await expect.poll(() => storedHolds(page, uuid, "A-7Q-kept B-local-3X"), { timeout: 30_000 }).toBe(true);
      await page.evaluate(() => (window as Any).__runner.flush());
      expect(await keptRecord(page, uuid), "B was never kept").toEqual(a);
      // 4. The browser's storage wiped; the store back.
      await wipe(page, provider.cdp);
      store.setMode("up");
      await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);

      // Recover, with the passkey.
      await expect(page.locator("#recover")).toBeVisible();
      await page.locator("#recover").click();
      const at = await page.evaluate((iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), a.at);
      const row = page.locator(`#recovered button[data-document="${uuid}"]`);
      await expect(row).toHaveText(`Notes · kept ${at}`, { timeout: 30_000 });
      await expect(page.locator("#recovered li")).toHaveCount(1);
      await row.click();

      // A exactly, identified by its time; nothing about B, and no count of anything.
      app = appIn(page);
      await expect(app.locator("#note")).toHaveValue("A-7Q-kept", { timeout: 60_000 });
      await expect(page.locator("#doc-note")).toHaveText(`Restored the copy kept at ${at}. ${SENTENCE_TAIL}`);
      const said = `${await page.locator("body").innerText()}`;
      expect(said).not.toContain("B-local-3X");
      expect((await page.locator("#doc-note").innerText()).replace(at, "").match(/\d/g), "no number but the time").toBeNull();
      // The restored copy goes on under the same owner: its own save on opening is kept on the chain after A.
      await expect.poll(async () => (await keptRecord(page, uuid))?.owner, { timeout: 30_000 }).toBe(a.owner);
      expect((await keptRecord(page, uuid))!.revision).toBeGreaterThanOrEqual(a.revision);
      await expect(page.locator("#save-state")).toHaveText("Kept", { timeout: 30_000 });
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("the store drops out at the second document: the first is restored whole, its owner signed in, and the sentence says what came back", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, provider } = await openerWithStore(context, store.base);
      const scratch = mkdtempSync(join(tmpdir(), "dai-recover-"));
      const files = { First: await buildNotes(scratch, "First"), Second: await buildNotes(scratch, "Second") };
      const ids: Record<string, string> = {};
      let owner = "";
      for (const [title, file] of Object.entries(files)) {
        const app = await openFile(page, file);
        ids[title] = await uuidOf(page);
        if (!owner) owner = await enrollHere(page);
        await typeNote(app, `${title}-text`);
        await expect.poll(() => storedHolds(page, ids[title]!, `${title}-text`), { timeout: 30_000 }).toBe(true);
        await waitSettledKept(page, ids[title]!);
      }

      await wipe(page, provider.cdp);
      await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
      // The library lists documents sorted: the store stops answering at the second's heads.
      const [first, second] = Object.keys(ids).sort((x, y) => (ids[x]! < ids[y]! ? -1 : 1)) as [string, string];
      let cut = false;
      await context.route(`${store.base}/**`, async (route) => {
        if (route.request().url().includes(`/${ids[second]}/heads`)) cut = true;
        return cut ? route.abort("connectionrefused") : route.continue();
      });
      await page.locator("#recover").click();
      await expect(page.locator("#report")).toHaveText(
        `Restored ${first}. The rest could not be reached: the store stopped answering. Recover again when you are online.`,
        { timeout: 30_000 },
      );
      await expect(page.locator("#recovered li")).toHaveCount(1);
      await expect(page.locator(`#recovered button[data-document="${ids[first]}"]`)).toBeVisible();
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "signed in as the owner it restored for").toBe(owner);
      // The first, whole: in the library, its data key under the owner, its kept record.
      const listed = ((await page.evaluate(() => (window as Any).__runner.listLibrary())) as Any[]).map((item) => item.documentUuid);
      expect(listed).toEqual([ids[first]]);
      expect((await keptRecord(page, ids[first]!))?.owner).toBe(owner);
      expect(await storedHolds(page, ids[first]!, `${first}-text`)).toBe(true);

      // Another page of this browser: Recover is still offered there, so what offers it is held here, not in the page;
      // and the person's own file of the restored document opens: nothing refuses it as another owner's.
      await context.unroute(`${store.base}/**`);
      await pointAtStore(context, store.base);
      const other = await context.newPage();
      await other.goto(RUNNER_URL);
      await expect(other.locator("#recover")).toBeVisible();
      await other.setInputFiles("#file", files[first as keyof typeof files]);
      await other.locator("#card-open").click({ timeout: 30_000 });
      await expect.poll(() => other.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null), { timeout: 30_000 }).toBe(ids[first]);
      expect(await other.locator("body").innerText()).not.toContain("belongs to another owner");

      // Recover again, the store back: the rest comes back, and what is here stays.
      await page.locator("#recover").click();
      await expect(page.locator("#recovered li")).toHaveCount(2, { timeout: 30_000 });
      await expect(page.locator("#report")).toHaveText("");
      expect((await keptRecord(page, ids[second]!))?.owner).toBe(owner);
      expect(await storedHolds(page, ids[second]!, `${second}-text`)).toBe(true);
      await expect(page.locator("#recover")).toBeHidden();
    } finally {
      await context.close();
      await store.close();
    }
  });

  /*
   * 2b2-H2, finished from the menu (R-Z sentence 5, Build 2b-2f item 3).
   * Recover lives in the chooser, and a document on screen hides the chooser:
   * after a cut-short recovery and the first document opened, the person
   * reaches the rest only through the menu. The row runs the same second
   * recovery Recover runs, and is there only while the owner's record carries
   * the recovering mark, from the menu's next opening.
   */
  test("a recovery the store cut short is finished from the menu: with a document open, the menu carries Finish recovering until every document is here", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, provider } = await openerWithStore(context, store.base);
      const scratch = mkdtempSync(join(tmpdir(), "dai-recover-"));
      const files = { First: await buildNotes(scratch, "First"), Second: await buildNotes(scratch, "Second") };
      const ids: Record<string, string> = {};
      let owner = "";
      for (const [title, file] of Object.entries(files)) {
        const app = await openFile(page, file);
        ids[title] = await uuidOf(page);
        if (!owner) owner = await enrollHere(page);
        await typeNote(app, `${title}-text`);
        await expect.poll(() => storedHolds(page, ids[title]!, `${title}-text`), { timeout: 30_000 }).toBe(true);
        await waitSettledKept(page, ids[title]!);
      }

      await wipe(page, provider.cdp);
      await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
      const [first, second] = Object.keys(ids).sort((x, y) => (ids[x]! < ids[y]! ? -1 : 1)) as [string, string];
      let cut = false;
      await context.route(`${store.base}/**`, async (route) => {
        if (route.request().url().includes(`/${ids[second]}/heads`)) cut = true;
        return cut ? route.abort("connectionrefused") : route.continue();
      });
      await page.locator("#recover").click();
      await expect(page.locator("#report")).toHaveText(
        `Restored ${first}. The rest could not be reached: the store stopped answering. Recover again when you are online.`,
        { timeout: 30_000 },
      );
      const recoveringMark = (): Promise<boolean | null> => withKeyStore(page, "return (await get(arg))?.recovering ?? null", `dai:owner:${owner}`);
      expect(await recoveringMark(), "the owner's record is marked recovering").toBe(true);

      // The person opens what came back, as they would. The chooser, and Recover in it, is under the document now.
      await page.locator(`#recovered button[data-document="${ids[first]}"]`).click();
      await expect.poll(() => page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null), { timeout: 30_000 }).toBe(ids[first]);
      await expect(page.locator("#recover")).toBeHidden();

      // The menu, the store still cut: the row is there, since what offers it is held here.
      await page.locator("#more").click();
      await expect(page.locator("#sheet")).toBeVisible();
      await expect(page.locator("#finish-recovering"), "the menu carries Finish recovering").toBeVisible();
      await expect(page.locator("#finish-recovering")).toHaveText("Finish recovering");
      await page.keyboard.press("Escape");
      await expect(page.locator("#sheet")).toBeHidden();

      // The chooser's line, under the document, holds what opening it said; the menu's recovery speaks over the document, never there.
      const chooserLine = await page.locator("#report").textContent();

      /*
       * 2b2f-L1 (Build 2b-2fr item 3): the row's words when the store cuts it
       * short name only what this run restored, and the way back on screen,
       * which is the row, never Recover. First was restored by the earlier run.
       */
      // The store answering again, and stopping at the second's Heads once more: this run restored nothing.
      await context.unroute(`${store.base}/**`);
      await cutAtHeadsOf(context, store.base, ids[second]!);
      await page.locator("#more").click();
      await page.locator("#finish-recovering").click();
      await page.locator("#finish-passkey").click();
      await expect(page.locator("#doc-note")).toHaveText(
        "The rest could not be reached: the store stopped answering. Finish recovering again when you are online.",
        { timeout: 30_000 },
      );
      expect(await recoveringMark()).toBe(true);
      expect(await page.locator("#doc-note").innerText(), "no restoration this run did not make").not.toContain(first);
      // The store, cut from there on, not answering at all: nothing of this run's, and the row is the way back.
      await page.locator("#more").click();
      await page.locator("#finish-recovering").click();
      await page.locator("#finish-passkey").click();
      await expect(page.locator("#doc-note")).toHaveText(
        "The rest of your library could not be reached right now: the store did not answer. Finish recovering again when you are online.",
        { timeout: 30_000 },
      );
      expect(await recoveringMark()).toBe(true);

      // The store back: the row restores the rest, lists both, says what came back, and the mark goes; the document stays open.
      await context.unroute(`${store.base}/**`);
      await page.locator("#more").click();
      await page.locator("#finish-recovering").click();
      await page.locator("#finish-passkey").click();
      await expect(page.locator("#finish-sheet")).toBeHidden({ timeout: 30_000 });
      await expect(page.locator("#sheet")).toBeHidden();
      await expect
        .poll(async () => ((await page.evaluate(() => (window as Any).__runner.listLibrary())) as Any[]).map((item) => item.documentUuid).sort(), { timeout: 30_000 })
        .toEqual([ids[first], ids[second]].sort());
      expect((await keptRecord(page, ids[second]!))?.owner).toBe(owner);
      expect(await storedHolds(page, ids[second]!, `${second}-text`)).toBe(true);
      await expect(page.locator("#recovered li")).toHaveCount(2);
      // 2b2f-M2 (Build 2b-2fr item 3): one sentence over the document naming what this run restored (R-Z sentence 5).
      await expect(page.locator("#doc-note")).toHaveText(`Recovered ${second}. Your library is complete.`, { timeout: 10_000 });
      expect(await page.locator("#report").textContent(), "the chooser's line, unchanged").toBe(chooserLine);
      await expect.poll(recoveringMark, { timeout: 10_000 }).toBeNull();
      expect(await page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null)).toBe(ids[first]);
      /*
       * 2b2fr-M2 (Build 2b-2fr2 item 3; R-Z, "nothing the host shows ever ...
       * moves the document"). The sentence stays through the open document's
       * next save, and the document with it: it goes when dismissed, or at the
       * next mount, like every other.
       */
      const top = await watchDocumentTop(page);
      await typeNote(appIn(page), "-more");
      await expect.poll(() => storedHolds(page, ids[first]!, `${first}-text-more`), { timeout: 30_000 }).toBe(true);
      await savesSettled(page);
      const moved = await top();
      expect(moved, "the document's top, from before the typing to after its save").toEqual({ from: moved.from, min: moved.from, max: moved.from });
      await expect(page.locator("#doc-note"), "the sentence, through the save").toHaveText(`Recovered ${second}. Your library is complete.`);
      await page.locator("#doc-note").click();
      await expect(page.locator("#doc-note")).toBeHidden();

      // From the menu's next opening, the row is gone.
      await page.locator("#more").click();
      await expect(page.locator("#sheet")).toBeVisible();
      await expect(page.locator("#finish-recovering")).toBeHidden();
    } finally {
      await context.close();
      await store.close();
    }
  });

  /*
   * 2b2f-M1 (Build 2b-2fr item 2): an owner who recovered with the saved
   * password alone has no passkey to answer the row's ceremony. Each recovery
   * path recovers alone (R-Z, "Each recovery path ... one never stands in for
   * the other"), so the recovery sheet the row opens carries the
   * saved-password form the chooser offers beside the passkey (Build 2b-2fr2
   * item 2), and the recovery finishes from it.
   */
  test("an owner who recovered with the saved password alone finishes from the menu: no passkey answers, the recovery sheet offers the saved password, and the rest comes back", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const handed = await watchKeychain(context);
      const { page, provider } = await openerWithStore(context, store.base);
      const { ids, owner, first, second } = await twoKept(page);
      expect(handed, "the saved password, handed to the password manager once").toHaveLength(1);

      await wipe(page, provider.cdp);
      await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
      // The passkey gone: the saved password is the one way back.
      await provider.cdp.send("WebAuthn.clearCredentials", { authenticatorId: provider.id });
      await cutAtHeadsOf(context, store.base, ids[second]!);
      await page.locator("#recover-owner").fill(handed[0]!.owner);
      await page.locator("#recover-secret").fill(handed[0]!.secret);
      await page.locator("#recover-with-password").click();
      await expect(page.locator("#report")).toHaveText(
        `Restored ${first}. The rest could not be reached: the store stopped answering. Recover again when you are online.`,
        { timeout: 30_000 },
      );
      const recoveringMark = (): Promise<boolean | null> => withKeyStore(page, "return (await get(arg))?.recovering ?? null", `dai:owner:${owner}`);
      expect(await recoveringMark()).toBe(true);
      await page.locator(`#recovered button[data-document="${ids[first]}"]`).click();
      await expect.poll(() => page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null), { timeout: 30_000 }).toBe(ids[first]);

      // The store back; the row opens the recovery sheet, and its passkey finds none: the sheet stays, the saved password on it.
      await context.unroute(`${store.base}/**`);
      await page.locator("#more").click();
      await page.locator("#finish-recovering").click();
      await expect(page.locator("#finish-sheet")).toBeVisible();
      await expect(page.locator("#sheet")).toBeHidden();
      const answered = page.waitForEvent("console", { predicate: (message) => message.text().includes("finish recovering: no passkey answered"), timeout: 30_000 });
      await page.locator("#finish-passkey").click();
      await answered;
      await expect(page.locator("#finish-sheet")).toBeVisible();
      await expect(page.locator("#finish-keychain")).toBeVisible();
      await expect(page.locator("#finish-with-password")).toBeEnabled();
      expect(await recoveringMark(), "nothing recovered yet").toBe(true);

      // Filled as a password manager fills it, and submitted: the rest comes back, the mark goes, the document stays open.
      await page.locator("#finish-owner").fill(handed[0]!.owner);
      await page.locator("#finish-secret").fill(handed[0]!.secret);
      await page.locator("#finish-with-password").click();
      await expect(page.locator("#finish-sheet")).toBeHidden({ timeout: 30_000 });
      await expect
        .poll(async () => ((await page.evaluate(() => (window as Any).__runner.listLibrary())) as Any[]).map((item) => item.documentUuid).sort(), { timeout: 30_000 })
        .toEqual([ids[first], ids[second]].sort());
      expect((await keptRecord(page, ids[second]!))?.owner).toBe(owner);
      expect(await storedHolds(page, ids[second]!, `${second}-text`)).toBe(true);
      await expect.poll(recoveringMark, { timeout: 10_000 }).toBeNull();
      expect(await page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null)).toBe(ids[first]);
      expect(await page.locator("#finish-secret").inputValue(), "nothing left in the field").toBe("");
      // Said over the document (Build 2b-2fr item 3), and gone when dismissed.
      await expect(page.locator("#doc-note")).toHaveText(`Recovered ${second}. Your library is complete.`);
      await page.locator("#doc-note").click();
      await expect(page.locator("#doc-note")).toBeHidden();

      // From the menu's next opening, no row, and so no way to the recovery sheet.
      await page.locator("#more").click();
      await expect(page.locator("#sheet")).toBeVisible();
      await expect(page.locator("#finish-recovering")).toBeHidden();
      await expect(page.locator("#finish-sheet")).toBeHidden();
    } finally {
      await context.close();
      await store.close();
    }
  });

  /*
   * 2b2fr-M1 (Build 2b-2fr2 item 2; R-Z, "the host's presence over the
   * document is fixed"). Finishing a recovery is asked for and answered: the
   * row opens one recovery sheet, from that tap, carrying both ways, the
   * passkey and the saved password. A ceremony cancelled leaves the person on
   * that sheet with both still offered; the sheet's own cancel closes it, the
   * mark stays, and nothing opens by itself afterwards.
   */
  test("Finish recovering opens one sheet from the tap, with the passkey and the saved password: a cancelled ceremony stays on it, its cancel closes it, and nothing opens by itself", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, provider } = await openerWithStore(context, store.base);
      const { ids, owner, first, second } = await twoKept(page);
      await wipe(page, provider.cdp);
      await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
      await cutAtHeadsOf(context, store.base, ids[second]!);
      await page.locator("#recover").click();
      await expect(page.locator("#report")).toHaveText(
        `Restored ${first}. The rest could not be reached: the store stopped answering. Recover again when you are online.`,
        { timeout: 30_000 },
      );
      const recoveringMark = (): Promise<boolean | null> => withKeyStore(page, "return (await get(arg))?.recovering ?? null", `dai:owner:${owner}`);
      await page.locator(`#recovered button[data-document="${ids[first]}"]`).click();
      await expect.poll(() => page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null), { timeout: 30_000 }).toBe(ids[first]);
      await context.unroute(`${store.base}/**`);

      /** Every sheet on screen, and which ways to finish each offers. */
      const onScreen = (): Promise<string> =>
        page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
              .filter((dialog) => !dialog.hidden && dialog.getBoundingClientRect().height > 0)
              .map((dialog) => {
                const shown = (id: string): boolean => {
                  const el = dialog.querySelector<HTMLElement>(`#${id}`);
                  return !!el && el.offsetParent !== null && !(el as HTMLButtonElement).disabled;
                };
                const ways = [shown("finish-passkey") ? "passkey" : "", shown("finish-keychain") ? "saved password" : "", shown("finish-recovering") ? "the row" : ""].filter(Boolean);
                return `${dialog.id}: ${ways.join(" + ") || "no way to finish"}`;
              })
              .join("; ") || "nothing",
        );

      /*
       * The person cancels the next passkey sheet: the browser answers
       * NotAllowedError, as it does for a cancel. Made in the page, once, since
       * Chromium's virtual authenticator, once made to refuse user
       * verification, refuses every later ceremony on the page too.
       */
      await page.evaluate(() => {
        const get = navigator.credentials.get.bind(navigator.credentials);
        let cancelOnce = true;
        navigator.credentials.get = (options?: CredentialRequestOptions) => {
          if (!cancelOnce) return get(options);
          cancelOnce = false;
          return Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
        };
      });
      await page.locator("#more").click();
      await expect(page.locator("#finish-recovering")).toBeVisible();
      await page.locator("#finish-recovering").click();
      // What the tap opened, settled: the recovery sheet alone, with both ways, the menu closed.
      await expect.poll(onScreen, { timeout: 10_000 }).toBe("finish-sheet: passkey + saved password");
      expect(await recoveringMark(), "nothing recovered by the tap itself").toBe(true);

      // The passkey asked, and the ceremony cancelled: still on the sheet, both ways still offered.
      const answered = page.waitForEvent("console", { predicate: (message) => message.text().includes("finish recovering: no passkey answered"), timeout: 30_000 });
      await page.locator("#finish-passkey").click();
      await answered;
      await expect.poll(onScreen, { timeout: 10_000 }).toBe("finish-sheet: passkey + saved password");
      expect(await recoveringMark()).toBe(true);

      // The sheet's cancel: it closes, the mark stays, and for two seconds nothing opens.
      await page.locator("#finish-cancel").click();
      await expect(page.locator("#finish-sheet")).toBeHidden();
      const opened = await page.evaluate(
        () =>
          new Promise<string[]>((settle) => {
            const seen: string[] = [];
            const look = (): void => {
              for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) if (!dialog.hidden && !seen.includes(dialog.id)) seen.push(dialog.id);
            };
            const watching = new MutationObserver(look);
            watching.observe(document.body, { attributes: true, attributeFilter: ["hidden"], subtree: true });
            look();
            window.setTimeout(() => {
              watching.disconnect();
              look();
              settle(seen);
            }, 2_000);
          }),
      );
      expect(opened, "nothing opens by itself after the cancel").toEqual([]);
      expect(await recoveringMark(), "the mark unchanged").toBe(true);

      // The passkey answering: the next tap offers both ways again, and the passkey finishes it.
      await page.locator("#more").click();
      await page.locator("#finish-recovering").click();
      await expect.poll(onScreen, { timeout: 10_000 }).toBe("finish-sheet: passkey + saved password");
      await page.locator("#finish-passkey").click();
      await expect
        .poll(async () => ((await page.evaluate(() => (window as Any).__runner.listLibrary())) as Any[]).map((item) => item.documentUuid).sort(), { timeout: 30_000 })
        .toEqual([ids[first], ids[second]].sort());
      await expect(page.locator("#finish-sheet")).toBeHidden();
      await expect(page.locator("#doc-note")).toHaveText(`Recovered ${second}. Your library is complete.`, { timeout: 10_000 });
      await expect.poll(recoveringMark, { timeout: 10_000 }).toBeNull();
      expect(await page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null)).toBe(ids[first]);
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("a document kept many times is recovered from its head, the head's parent and its container's envelope, not every revision kept", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, provider } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-recover-")), "Notes"));
      const uuid = await uuidOf(page);
      await enrollHere(page);
      for (let n = 1, after = 0; n <= 6; n += 1) {
        await typeNote(app, ` r${n}`);
        after = (await waitSettledKept(page, uuid, after)).revision;
      }
      const text = await app.locator("#note").inputValue();
      const appended = store.bucket().filter((o) => o.key.includes(`/${uuid}/`));
      expect(appended.length, "kept many times").toBeGreaterThanOrEqual(6);
      const size = new Map(appended.map((o) => [o.key.split("/").pop()!, o.bytes.length]));

      const recoverAndCount = async (): Promise<{ gets: number; bytes: number; chains: number }> => {
        await wipe(page, provider.cdp);
        await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
        const from = store.received().length;
        await page.locator("#recover").click();
        await expect(page.locator(`#recovered button[data-document="${uuid}"]`)).toBeVisible({ timeout: 30_000 });
        expect(await storedHolds(page, uuid, text), "the head, exactly").toBe(true);
        const asked = store.received().slice(from).filter((r) => r.method === "GET" && r.url.includes(`/d/`));
        const gets = asked.filter((r) => r.url.includes("/e/"));
        return {
          gets: gets.length,
          bytes: gets.reduce((sum, r) => sum + (size.get(r.url.split("/e/")[1]!.split("?")[0]!) ?? 0), 0),
          chains: asked.filter((r) => r.url.includes("/c/")).length,
        };
      };

      // What the store answered Chain with: the opener asks it either way, and takes a 404 for a store with no Chain.
      const chainAnswers: number[] = [];
      store.rewrite((path, answer) => {
        if (/\/c\/[A-Za-z0-9_-]{43}$/.test(path)) chainAnswers.push(answer.status);
        return answer;
      });
      const now = await recoverAndCount();
      const largest = Math.max(...size.values());
      const later = [...size.values()].filter((n) => n !== largest);
      console.log(`recovery after ${appended.length} kept: ${now.gets} envelopes, ${now.bytes} bytes (all kept: ${[...size.values()].reduce((a, b) => a + b, 0)} bytes)`);
      expect(now.gets, "the head, its parent, the container's envelope").toBeLessThanOrEqual(3);
      expect(now.bytes).toBeLessThanOrEqual(largest + 2 * Math.max(...later));
      // The chain was read from the store, not walked: a walk fetches the same three here, so the count alone cannot tell them apart.
      expect(now.chains, "Chain asked").toBe(1);
      expect(chainAnswers, "and answered").toEqual([200]);

      // A store with no Chain yet: the envelopes are the chain, and the document still comes back.
      store.rewrite((path, answer) => (/\/c\/[A-Za-z0-9_-]{43}$/.test(path) ? new Response(JSON.stringify({ refused: "no such operation" }), { status: 404, headers: answer.headers }) : answer));
      const without = await recoverAndCount();
      console.log(`recovery without Chain: ${without.gets} envelopes, ${without.bytes} bytes`);
      expect(without.gets).toBeLessThanOrEqual(3);
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("with the store unreachable, recovery says so and presents nothing as recovered", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, provider } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-recover-")), "Notes"));
      const uuid = await uuidOf(page);
      await enrollHere(page);
      await typeNote(app, "kept");
      await expect.poll(() => storedHolds(page, uuid, "kept"), { timeout: 30_000 }).toBe(true);
      await waitSettledKept(page, uuid);

      await wipe(page, provider.cdp);
      store.setMode("unavailable");
      await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
      await page.locator("#recover").click();
      await expect(page.locator("#report")).toHaveText(
        "Your documents could not be recovered right now: the store did not answer. Nothing was restored. Try again when you are online.",
        { timeout: 30_000 },
      );
      await expect(page.locator("#recovered")).toBeHidden();
      expect(await page.evaluate(() => (window as Any).__runner.listLibrary()), "nothing presented as recovered").toEqual([]);
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "and nobody signed in on nothing").toBeNull();
      expect(await page.evaluate(() => (window as Any).__runner.loaded ?? null)).toBeNull();
    } finally {
      await context.close();
      await store.close();
    }
  });
});
