import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./fixtures.js";
import { appIn, buildNotes, openFile, pointAtStore, storedHolds, typeNote, uuidOf } from "./owner.js";
import { serveOwnerStore } from "./owner-store-memory.js";
import { enrollHere, openerWithStore, waitSettledKept } from "./keeping.js";
import { watchKeychain, wipe } from "./keychain.js";

/**
 * The passkey's name, and the saved password's (Build 2b-2d item 4).
 *
 * The device reading of 30 October: two passkeys, both named "Your
 * documents", and a person who could not tell which a prompt wanted; the
 * recording of 31 October: the password manager's entry named "Your
 * documents" and the keychain's two named by bare owner ids. So the passkey
 * says which site it is for and that it is the one for all the person's
 * documents, "Your documents · <hostname>", and the saved password carries
 * the same name: its account reads "Your documents · <hostname> · <owner
 * id>", the owner id last, so each owner's password is its own entry and
 * recovery reads the owner from the end of it. Chromium: the passkey is its
 * virtual authenticator.
 */

const NAME = "Your documents · localhost";

test.describe("the passkey's name and the saved password's (Build 2b-2d item 4)", () => {
  test.slow();

  test("the passkey is named for the site and all the documents, the saved password carries the same name, and recovery reads the owner from it", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      await pointAtStore(context, store.base);
      const handed = await watchKeychain(context);
      const { page, provider } = await openerWithStore(context, store.base);
      let app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-name-")), "Notes"));
      const uuid = await uuidOf(page);
      const owner = await enrollHere(page);

      const { credentials } = await provider.cdp.send("WebAuthn.getCredentials", { authenticatorId: provider.id });
      expect(credentials.map((credential) => [credential.userName, credential.userDisplayName])).toEqual([[NAME, NAME]]);
      await expect.poll(() => handed.length, { timeout: 30_000 }).toBe(1);
      expect(handed[0]).toMatchObject({ by: "credential management", name: NAME, account: `${NAME} · ${owner}`, owner });

      // The saved password, as the password manager fills it, recovers: the owner is read from the end of the account.
      await typeNote(app, "named");
      await expect.poll(() => storedHolds(page, uuid, "named"), { timeout: 30_000 }).toBe(true);
      await waitSettledKept(page, uuid);
      await wipe(page, provider.cdp);
      await provider.cdp.send("WebAuthn.clearCredentials", { authenticatorId: provider.id });
      await page.locator("#recover-owner").fill(handed[0]!.account);
      await page.locator("#recover-secret").fill(handed[0]!.secret);
      await page.locator("#recover-with-password").click();
      await page.locator(`#recovered button[data-document="${uuid}"]`).click({ timeout: 30_000 });
      app = appIn(page);
      await expect(app.locator("#note")).toHaveValue("named", { timeout: 60_000 });
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("where the browser has no Credential Management API, the form's account carries the same name", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      await pointAtStore(context, store.base);
      const handed = await watchKeychain(context, { asSafari: true });
      const { page } = await openerWithStore(context, store.base);
      await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 60_000 });
      await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-name-")), "Notes"));
      const owner = await enrollHere(page);
      await expect.poll(() => handed.length, { timeout: 30_000 }).toBe(1);
      expect(handed[0]).toMatchObject({ by: "form", account: `${NAME} · ${owner}`, owner });
    } finally {
      await context.close();
      await store.close();
    }
  });
});
