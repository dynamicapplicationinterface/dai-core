import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, appIn, buildNotes, openFile, storedHolds, typeNote, uuidOf, withKeyStore } from "./owner.js";
import { watchKeychain, wipe } from "./keychain.js";
import { serveOwnerStore } from "./owner-store-memory.js";
import { enrollHere, keptRecord, openerWithStore, waitSettledKept } from "./keeping.js";

/**
 * The keychain path, the opener's side (R-D as amended, D298; Build 2b-2b
 * item 6).
 *
 * Enrollment hands the keychain secret to the browser's password manager:
 * through the Credential Management API where the browser has it, and where
 * it has none (Safari), through a form submission the password manager offers
 * to save, the path the 18 Oct spike proved on an iPhone. That submission
 * reloads the page, and it is answered by the opener's own worker, so the
 * secret never leaves the browser; the enrollment is kept before it, and the
 * page comes back signed in with the document open.
 *
 * On a browser with nothing, the saved password alone recovers: it proves the
 * owner to the store's Admit and opens the owner key's keychain wrap, with no
 * passkey. And each path recovers with the other broken: the keychain with no
 * passkey left on the authenticator, the passkey with nothing in the keychain.
 *
 * Chromium only: enrollment needs its virtual authenticator with PRF. The
 * password manager is read here as the test's own record of what the opener
 * handed it; whether a real one keeps it, in Safari and a Home Screen app, is
 * a device reading (D298).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const SENTENCE_TAIL = "Changes saved only in the cleared browser are not included.";

/** Everything this origin keeps that a page can read, as one string: the key store, both web storages, and the library. */
const everythingHeld = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const open = indexedDB.open("dai_runner_storage");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const parts: string[] = [];
    for (const name of [...db.objectStoreNames]) {
      const values: unknown[] = await new Promise((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      parts.push(JSON.stringify(values, (_k, v) => (v instanceof Uint8Array ? [...v] : v)));
    }
    db.close();
    parts.push(JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), location.href);
    return parts.join("\n");
  });

/** Keeps "A" for a new owner and wipes the browser: what each recovery starts from. */
async function keptThenWiped(
  context: BrowserContext,
  base: string,
): Promise<{ page: Page; provider: { cdp: CDPSession; id: string }; uuid: string; owner: string; at: string }> {
  const { page, provider } = await openerWithStore(context, base);
  const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-keychain-")), "Notes"));
  const uuid = await uuidOf(page);
  const owner = await enrollHere(page);
  await typeNote(app, "A-kept-5K");
  await expect.poll(() => storedHolds(page, uuid, "A-kept-5K"), { timeout: 30_000 }).toBe(true);
  const a = await waitSettledKept(page, uuid);
  await wipe(page, provider.cdp);
  await page.evaluate((b) => (window as Any).__runner.useStore(b), base);
  const at = await page.evaluate((iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), a.at);
  return { page, provider, uuid, owner, at };
}

/** Opens the one recovered document and checks it holds A exactly, identified by its time, kept on under the same owner. */
async function holdsA(page: Page, uuid: string, owner: string, at: string): Promise<void> {
  const row = page.locator(`#recovered button[data-document="${uuid}"]`);
  await expect(row).toHaveText(`Notes · kept ${at}`, { timeout: 30_000 });
  await expect(page.locator("#recovered li")).toHaveCount(1);
  await row.click();
  await expect(appIn(page).locator("#note")).toHaveValue("A-kept-5K", { timeout: 60_000 });
  await expect(page.locator("#doc-note")).toHaveText(`Restored the copy kept at ${at}. ${SENTENCE_TAIL}`);
  expect(await page.evaluate(() => (window as Any).__runner.owner.current())).toBe(owner);
  await expect.poll(async () => (await keptRecord(page, uuid))?.owner, { timeout: 30_000 }).toBe(owner);
  await expect(page.locator("#save-state")).toHaveText("Kept", { timeout: 30_000 });
}

/** Fills the recovery form as a password manager fills it, and submits it. */
async function recoverWithPassword(page: Page, filled: { owner: string; secret: string }): Promise<void> {
  await expect(page.locator("#recover-keychain")).toBeVisible();
  await page.locator("#recover-owner").fill(filled.owner);
  await page.locator("#recover-secret").fill(filled.secret);
  await page.locator("#recover-with-password").click();
}

test.describe("the keychain path, the opener's side (R-D, D298; Build 2b-2b item 6)", () => {
  test.slow();

  test("with no Credential Management API, as Safari: the secret is offered by a form the opener's worker answers, never the network, and the page comes back signed in with the document open", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const handed = await watchKeychain(context, { asSafari: true });
      // The form's address, if anything sends it past the browser: a stand-in that answers as a sink would.
      const reachedNetwork: string[] = [];
      await context.route(/\/keychain(\?|$)/, async (route) => {
        reachedNetwork.push(`${route.request().method()} ${route.request().url()}`);
        await route.fulfill({ status: 303, headers: { location: RUNNER_URL } });
      });
      const { page } = await openerWithStore(context, store.base);
      expect(await page.evaluate(() => "PasswordCredential" in window), "no Credential Management API").toBe(false);
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 30_000 }).toBe(true);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-keychain-")), "Notes"));
      const uuid = await uuidOf(page);
      await typeNote(app, "before-enrolling");
      await expect.poll(() => storedHolds(page, uuid, "before-enrolling"), { timeout: 30_000 }).toBe(true);

      let loads = 0;
      page.on("load", () => (loads += 1));
      const owner = await enrollHere(page);

      // Handed over once, by the form, under the owner's id.
      await expect.poll(() => handed.length, { timeout: 30_000 }).toBe(1);
      expect(handed[0]!.by).toBe("form");
      expect(handed[0]!.owner).toBe(owner);
      // The submission reloaded the page, and nothing of it reached the network.
      await expect.poll(() => loads, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      expect(reachedNetwork, "the form never leaves the browser").toEqual([]);

      // Back signed in, the document open with what was typed, the record saying the secret was offered.
      await expect.poll(() => page.evaluate(() => (window as Any).__runner.owner.current()).catch(() => null), { timeout: 30_000 }).toBe(owner);
      await expect(appIn(page).locator("#note")).toHaveValue("before-enrolling", { timeout: 60_000 });
      expect(await withKeyStore<string>(page, `return (await get("dai:owner:" + arg)).keychain;`, owner)).toBe("offered");
      expect(new URL(page.url()).search, "the address is the opener's own again").toBe("");

      // The secret handed over is the one the keychain wrap is under, and nothing here keeps it.
      const opens = await withKeyStore<boolean>(
        page,
        `const record = await get("dai:owner:" + arg.owner);
         const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(arg.secret), "HKDF", false, ["deriveKey"]);
         const wrapping = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("dai owner key v1"), info: new TextEncoder().encode("keychain") },
           base, { name: "AES-KW", length: 256 }, false, ["unwrapKey"]);
         await crypto.subtle.unwrapKey("raw", record.wraps.keychain, wrapping, "AES-KW", { name: "AES-KW", length: 256 }, false, ["unwrapKey"]);
         return true;`,
        { owner, secret: handed[0]!.secret },
      );
      expect(opens).toBe(true);
      expect(await everythingHeld(page), "the secret is kept nowhere in this browser").not.toContain(handed[0]!.secret);
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("with no worker to answer the form, the secret is not submitted at all, and enrollment still holds", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const handed = await watchKeychain(context, { asSafari: true });
      const reachedNetwork: string[] = [];
      await context.route(/\/keychain(\?|$)/, async (route) => {
        reachedNetwork.push(`${route.request().method()} ${route.request().url()}`);
        await route.fulfill({ status: 303, headers: { location: RUNNER_URL } });
      });
      const { page } = await openerWithStore(context, store.base);
      await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-keychain-")), "Notes"));
      const owner = await enrollHere(page);
      await expect.poll(() => withKeyStore<string | undefined>(page, `return (await get("dai:owner:" + arg))?.keychain;`, owner), { timeout: 30_000 }).toBe("not offered");
      expect(handed, "nothing handed over").toEqual([]);
      expect(reachedNetwork, "nothing sent").toEqual([]);
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("keychain recovery, with the passkey path broken: the saved password alone brings back A, with no passkey", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const handed = await watchKeychain(context);
      const { page, provider, uuid, owner, at } = await keptThenWiped(context, store.base);
      expect(handed).toHaveLength(1);
      expect(handed[0]!.owner).toBe(owner);

      // The passkey path broken: the authenticator holds no passkey any more.
      await provider.cdp.send("WebAuthn.clearCredentials", { authenticatorId: provider.id });
      const { credentials } = await provider.cdp.send("WebAuthn.getCredentials", { authenticatorId: provider.id });
      expect(credentials).toHaveLength(0);

      // A wrong password opens nothing, and says so.
      await recoverWithPassword(page, { owner, secret: "not-the-saved-password" });
      await expect(page.locator("#report")).toHaveText("This password did not recover any documents. Nothing was restored.", { timeout: 30_000 });
      expect(await page.evaluate(() => (window as Any).__runner.owner.current())).toBeNull();
      expect(await page.evaluate(() => (window as Any).__runner.listLibrary())).toEqual([]);

      await recoverWithPassword(page, handed[0]!);
      await holdsA(page, uuid, owner, at);
      expect(store.received().filter((r) => r.url.includes("/admit")).length, "admitted by the keychain proof").toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("passkey recovery, with the keychain path broken: nothing in any keychain, and the passkey alone brings back A", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const handed = await watchKeychain(context, { refuse: true });
      const { page, uuid, owner, at } = await keptThenWiped(context, store.base);
      expect(handed, "the keychain kept nothing").toEqual([]);

      await page.locator("#recover").click();
      await holdsA(page, uuid, owner, at);
    } finally {
      await context.close();
      await store.close();
    }
  });
});
