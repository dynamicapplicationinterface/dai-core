import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, addPasskeyProvider, appIn, buildNotes, openFile, pointAtStore, storedHolds, typeNote, uuidOf } from "./owner.js";
import { serveOwnerStore, type ServedStore } from "./owner-store-memory.js";
import { enrollHere, keptRecord, pillText, waitSettledKept } from "./keeping.js";
import { wipe } from "./keychain.js";

/**
 * A context meets an existing owner (R-Z, amended 31 October).
 *
 * A person is one owner across their browser contexts: Safari, the Home
 * Screen app, another browser. In a context with no owner signed in, "Keep
 * beyond this browser" offers two ways: a new passkey, which enrolls, and the
 * passkey the person already has, which runs the recovery ceremony, signs the
 * existing owner in, admits this context under them, adopts the documents
 * saved here and keeps them. The device reading of 30 October met the Home
 * Screen app enrolling a second owner, with a second passkey of the same
 * name, because only the first way existed.
 *
 * Chromium only: the passkey with PRF is its virtual authenticator. A copy of
 * its credential added to another context's authenticator carries no PRF
 * secret, so each browser context here is this origin's storage between two
 * wipes, and the passkey is the authenticator's through both, as a phone's
 * keychain keeps it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const offer = (page: Page) => page.locator("#save-state[data-offer]");
/** The owners the store holds: each owner object with an owner record. */
const ownersAt = (store: ServedStore): string[] =>
  store.values().filter((value) => value.object.startsWith("o:") && value.key === "owner").map((value) => value.object.slice(2));
const owner = (page: Page): Promise<string | null> => page.evaluate(() => (window as Any).__runner.owner.current());

/** From the offer: the pill, "Keep beyond this browser", and the way named for a person who has kept documents before. */
async function keepWithThePasskeyIHave(page: Page): Promise<void> {
  await expect(offer(page)).toBeVisible({ timeout: 30_000 });
  await offer(page).click();
  await page.locator("#keep-beyond").click();
  await expect(page.locator("#keep-ways")).toBeVisible();
  await page.locator("#keep-existing").click();
}

test.describe("a context meets an existing owner (R-Z, amended 31 October)", () => {
  test.slow();

  test("an owner enrolled in one context, a document saved in a second: the passkey they already have keeps it under that owner, and a third context recovers both", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      const provider = await addPasskeyProvider(context, page);
      const scratch = mkdtempSync(join(tmpdir(), "dai-existing-"));
      const files = { First: await buildNotes(scratch, "First"), Second: await buildNotes(scratch, "Second") };

      // The first context: First, its owner enrolled, kept.
      let app = await openFile(page, files.First);
      const first = await uuidOf(page);
      const enrolled = await enrollHere(page);
      await typeNote(app, "first-text");
      await expect.poll(() => storedHolds(page, first, "first-text"), { timeout: 30_000 }).toBe(true);
      await waitSettledKept(page, first);
      expect(ownersAt(store)).toEqual([enrolled]);

      // The second context: nothing of the first; Second saved here, no owner signed in.
      await wipe(page, provider.cdp);
      app = await openFile(page, files.Second);
      const second = await uuidOf(page);
      await typeNote(app, "second-text");
      await expect.poll(() => storedHolds(page, second, "second-text"), { timeout: 30_000 }).toBe(true);
      expect(await owner(page)).toBeNull();
      const passkeys = (await provider.cdp.send("WebAuthn.getCredentials", { authenticatorId: provider.id })).credentials.length;

      // The way for a person who has kept documents before.
      await keepWithThePasskeyIHave(page);
      // Kept with no further change: the adopted revision is appended, and the store still lists the one owner.
      await expect.poll(async () => (await keptRecord(page, second)) !== null, { timeout: 45_000 }).toBe(true);
      expect(ownersAt(store), "the store lists one owner").toEqual([enrolled]);
      expect(await owner(page)).toBe(enrolled);
      expect((await keptRecord(page, second))!.owner).toBe(enrolled);
      await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe("Kept");
      expect((await provider.cdp.send("WebAuthn.getCredentials", { authenticatorId: provider.id })).credentials.length, "no passkey made").toBe(passkeys);
      await expect(page.locator("#doc-note")).toBeHidden();

      // A third context: Recover lists both documents.
      await wipe(page, provider.cdp);
      await page.locator("#recover").click();
      await expect(page.locator("#recovered li")).toHaveCount(2, { timeout: 30_000 });
      for (const id of [first, second]) await expect(page.locator(`#recovered button[data-document="${id}"]`)).toBeVisible();
      await page.locator(`#recovered button[data-document="${second}"]`).click();
      await expect(appIn(page).locator("#note")).toHaveValue("second-text", { timeout: 60_000 });
    } finally {
      await context.close();
      await store.close();
    }
  });

  /*
   * The device reading of 30 October: the browser offered to save a password
   * no one had mentioned, and later the person could not tell the passkey
   * from the password. The sheet says, before any ceremony, that the backup
   * password is coming and what it is for.
   */
  test("before any ceremony, the sheet says a backup password will be offered for saving, and why to keep it", async ({ browser }) => {
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.addInitScript(() => {
        (window as Any).__ceremonies = 0;
        for (const name of ["create", "get"] as const) {
          const real = navigator.credentials?.[name]?.bind(navigator.credentials);
          if (real) (navigator.credentials as Any)[name] = (options: Any) => ((window as Any).__ceremonies += 1, real(options));
        }
      });
      await page.goto(RUNNER_URL);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-existing-")), "Notes"));
      await typeNote(app, "worth keeping");
      await expect(offer(page)).toBeVisible({ timeout: 30_000 });
      await offer(page).click();
      await page.locator("#keep-beyond").click();
      await expect(page.locator("#keep-ways")).toBeVisible();
      await expect(page.locator("#keep-ways-backup")).toBeVisible();
      await expect(page.locator("#keep-ways-backup")).toHaveText(
        "Your browser will also offer to save a backup password. Keep it: it opens your documents if the passkey is ever lost.",
      );
      expect(await page.evaluate(() => (window as Any).__ceremonies), "no ceremony yet").toBe(0);
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("the same document in both contexts: the second context's copy is kept under the one owner, beside the first's, with no refusal", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      const provider = await addPasskeyProvider(context, page);
      const file = await buildNotes(mkdtempSync(join(tmpdir(), "dai-existing-")), "Notes");

      // Safari, as the device reading had it: the document kept under its owner.
      let app = await openFile(page, file);
      const uuid = await uuidOf(page);
      const enrolled = await enrollHere(page);
      await typeNote(app, "in-safari");
      await expect.poll(() => storedHolds(page, uuid, "in-safari"), { timeout: 30_000 }).toBe(true);
      const kept = await waitSettledKept(page, uuid);

      // The Home Screen app: the same document, its own storage, a change of its own.
      await wipe(page, provider.cdp);
      app = await openFile(page, file);
      expect(await uuidOf(page)).toBe(uuid);
      await typeNote(app, "on-home-screen");
      await expect.poll(() => storedHolds(page, uuid, "on-home-screen"), { timeout: 30_000 }).toBe(true);
      await keepWithThePasskeyIHave(page);
      await expect.poll(() => owner(page), { timeout: 30_000 }).toBe(enrolled);
      // Sealed under the store's data key for the document, so nothing is refused and the line is kept beside the first.
      await expect.poll(async () => (await keptRecord(page, uuid))?.owner ?? null, { timeout: 45_000 }).toBe(enrolled);
      const here = (await keptRecord(page, uuid))!;
      expect(here.digest).not.toBe(kept.digest);
      await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe("Kept");
      await expect(page.locator("#doc-note")).toBeHidden();
      expect(ownersAt(store), "the store lists one owner").toEqual([enrolled]);

      // Recover elsewhere opens the newest line, which is this one, under the one data key.
      await wipe(page, provider.cdp);
      await page.locator("#recover").click();
      const row = page.locator(`#recovered button[data-document="${uuid}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("#report")).not.toHaveClass(/error/);
      // The document has two kept lines, and Recover says so (R-Z, amended 31 October; D301).
      await expect(page.locator("#report")).toHaveText("Recovered Notes. Notes has two kept lines; the newest is shown.");
      await row.click();
      await expect(appIn(page).locator("#note")).toHaveValue("on-home-screen", { timeout: 60_000 });
    } finally {
      await context.close();
      await store.close();
    }
  });
});
