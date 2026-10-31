import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { appIn, buildNotes, keepFromMenu, openFile, storedHolds, typeNote, uuidOf, withKeyStore } from "./owner.js";
import { watchKeychain, wipe } from "./keychain.js";
import { serveOwnerStore } from "./owner-store-memory.js";
import { enrollHere, keptRecord, openerWithStore, waitSettledKept } from "./keeping.js";

/**
 * An engine whose WebCrypto has no Ed25519 (D302, ruled 30 October; Build
 * 2b-2fr item 6).
 *
 * The keychain path's verifier is an Ed25519 key derived from the keychain
 * secret (docs/store.md, "Keys"), and the store's Enroll needs it. Playwright's
 * Windows WebKit has passkeys and no Ed25519 in WebCrypto; a Chromium release
 * with PRF from before its WebCrypto had Ed25519 would be the same. The opener
 * carries an Ed25519 implementation for such an engine and uses it only there:
 * the same seed, the same verifier, the same signed challenge, so nothing on
 * the wire changes. Enrollment that cannot derive a verifier at all refuses
 * before any passkey is made, and an owner record kept here that the store
 * can never register is not a dead end.
 *
 * Chromium, with Ed25519 taken out of `crypto.subtle` before the opener
 * loads: the passkey with PRF is its virtual authenticator.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** Takes Ed25519 out of WebCrypto before anything on the page runs; with `sha512`, SHA-512 as well, so no carried Ed25519 can work either. */
async function withoutEd25519(context: BrowserContext, also: { sha512?: boolean } = {}): Promise<void> {
  await context.addInitScript((options: { sha512?: boolean }) => {
    const subtle = crypto.subtle as Any;
    const nameOf = (alg: unknown): string | undefined => (typeof alg === "string" ? alg : (alg as { name?: string } | null)?.name);
    const refused = (alg: unknown): boolean => nameOf(alg) === "Ed25519" || (options.sha512 === true && nameOf(alg) === "SHA-512");
    for (const method of ["importKey", "generateKey", "sign", "verify", "exportKey", "digest"]) {
      const original = subtle[method].bind(subtle);
      subtle[method] = (...args: unknown[]) => {
        const alg = method === "importKey" ? args[2] : method === "exportKey" ? (args[1] as Any)?.algorithm : args[0];
        if (refused(alg)) return Promise.reject(new DOMException("Unrecognized name.", "NotSupportedError"));
        return original(...args);
      };
    }
  }, also);
}

const ownerRecordOf = (page: Page, owner: string): Promise<{ verifier: string | null; registration: boolean; atStore: boolean } | null> =>
  withKeyStore(page, "const r = await get(arg); return r ? { verifier: r.verifier ?? null, registration: !!r.registration, atStore: r.atStore === true } : null;", `dai:owner:${owner}`);

test.describe("an engine whose WebCrypto has no Ed25519 (D302, Build 2b-2fr item 6)", () => {
  test.slow();
  test.skip(({ browserName }) => browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");

  test("the ruling's red test: Keep beyond this browser enrolls an owner the store lists, the next save is Kept, and after a wipe the saved password restores the document", async ({
    browser,
  }) => {
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      await withoutEd25519(context);
      const handed = await watchKeychain(context);
      const { page, provider } = await openerWithStore(context, store.base);
      expect(
        await page.evaluate(async () => crypto.subtle.generateKey({ name: "Ed25519" } as Any, true, ["sign", "verify"]).then(() => "Ed25519", (e: Error) => e.message)),
        "this engine's WebCrypto has no Ed25519",
      ).toBe("Unrecognized name.");
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-no-ed25519-")), "Notes"));
      const uuid = await uuidOf(page);
      await typeNote(app, "kept-");
      const owner = await enrollHere(page);

      // The record holds the verifier the store's Enroll needs.
      const record = await ownerRecordOf(page, owner);
      expect(record?.verifier ?? null, "the owner record holds a verifier").not.toBeNull();

      // The next save is kept: the store enrolls the owner, with that verifier, and acknowledges the revision.
      await typeNote(app, "D302");
      await expect.poll(() => storedHolds(page, uuid, "kept-D302"), { timeout: 30_000 }).toBe(true);
      await waitSettledKept(page, uuid);
      await expect(page.locator("#save-state")).toHaveText("Kept", { timeout: 30_000 });
      expect(store.objects(), "the store lists the owner").toContain(`o:${owner}`);
      expect(
        store.values().some((value) => value.object === `o:${owner}` && value.bytes.toString("utf8").includes(record!.verifier!)),
        "under the verifier derived here",
      ).toBe(true);
      expect((await ownerRecordOf(page, owner))?.atStore).toBe(true);

      // The browser wiped; the saved password alone brings the document back.
      await wipe(page, provider.cdp);
      await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
      expect(handed, "the saved password, handed to the password manager once").toHaveLength(1);
      await page.locator("#recover-owner").fill(handed[0]!.owner);
      await page.locator("#recover-secret").fill(handed[0]!.secret);
      await page.locator("#recover-with-password").click();
      const row = page.locator(`#recovered button[data-document="${uuid}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      await expect(appIn(page).locator("#note")).toHaveValue("kept-D302", { timeout: 60_000 });
      expect(await page.evaluate(() => (window as Any).__runner.owner.current())).toBe(owner);
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("where no verifier can be derived at all, Keep beyond this browser refuses before any passkey is made, says so, and stays in the menu", async ({ browser }) => {
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      await withoutEd25519(context, { sha512: true });
      await context.addInitScript(() => {
        (window as Any).__ceremonies = 0;
        const create = navigator.credentials?.create?.bind(navigator.credentials);
        if (!create) return;
        navigator.credentials.create = (options?: CredentialCreationOptions) => {
          (window as Any).__ceremonies += 1;
          return create(options);
        };
      });
      const { page, provider } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-no-ed25519-")), "Notes"));
      await typeNote(app, "here");
      await keepFromMenu(page);
      await expect(page.locator("#doc-note")).toHaveText("This browser cannot keep work beyond itself yet. Your work is still saved in this browser.", { timeout: 30_000 });
      expect(await page.evaluate(() => (window as Any).__ceremonies), "no passkey ceremony").toBe(0);
      expect((await provider.cdp.send("WebAuthn.getCredentials", { authenticatorId: provider.id })).credentials, "no passkey made").toHaveLength(0);
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "nobody signed in").toBeNull();
      await page.locator("#more").click();
      await expect(page.locator("#keep-beyond"), "the offer stays in the menu").toBeVisible();
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("a passkey whose public key the browser does not give: nothing kept, nobody signed in, said, and the offer stays in the menu", async ({ browser }) => {
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      // An attestation response with no getPublicKey, as some browsers' are: the store's Enroll needs the key it would give.
      await context.addInitScript(() => {
        delete (AuthenticatorAttestationResponse.prototype as Any).getPublicKey;
      });
      const { page } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-no-ed25519-")), "Notes"));
      await typeNote(app, "here");
      await keepFromMenu(page);
      await expect(page.locator("#doc-note")).toHaveText("This browser cannot keep work beyond itself yet. Your work is still saved in this browser.", { timeout: 30_000 });
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "nobody signed in").toBeNull();
      await page.locator("#more").click();
      await expect(page.locator("#keep-beyond"), "the offer stays in the menu").toBeVisible();
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("an owner record kept with no verifier, as an earlier opener kept one here, is not a dead end: at the first save it is let go, said, and Keep beyond this browser keeps the document", async ({
    browser,
  }) => {
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-no-ed25519-")), "Notes"));
      const uuid = await uuidOf(page);
      await typeNote(app, "one");
      await expect.poll(() => storedHolds(page, uuid, "one"), { timeout: 30_000 }).toBe(true);
      // The store away while the owner is enrolled, so nothing registers; then the record as D302 left it: no verifier.
      store.setMode("unavailable");
      const owner = await enrollHere(page);
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
      expect((await ownerRecordOf(page, owner))?.verifier).toBeNull();
      store.setMode("up");

      // The next save: the store can never register this owner, so it is let go, and the person is told what to do.
      await typeNote(app, "-two");
      await expect(page.locator("#doc-note")).toHaveText(
        'Keeping beyond this browser did not finish setting up here. Your work is still saved in this browser; choose "Keep beyond this browser" in the menu to set it up again.',
        { timeout: 30_000 },
      );
      expect(store.objects(), "the store never heard of the owner").not.toContain(`o:${owner}`);
      await expect.poll(() => page.evaluate(() => (window as Any).__runner.owner.current()), { timeout: 10_000 }).toBeNull();
      expect(await ownerRecordOf(page, owner), "the record let go").toBeNull();
      expect(await storedHolds(page, uuid, "one-two"), "the document, still here").toBe(true);

      // Keep beyond this browser, again: a new owner adopts the document, and its next save is kept.
      const again = await enrollHere(page);
      expect(again).not.toBe(owner);
      await typeNote(app, "-three");
      await expect.poll(() => storedHolds(page, uuid, "one-two-three"), { timeout: 30_000 }).toBe(true);
      await waitSettledKept(page, uuid);
      expect((await keptRecord(page, uuid))?.owner).toBe(again);
      await expect(page.locator("#save-state")).toHaveText("Kept", { timeout: 30_000 });
    } finally {
      await context.close();
      await store.close();
    }
  });
});
