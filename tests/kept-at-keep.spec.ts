import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, addPasskeyProvider, buildNotes, openFile, pointAtStore, storedHolds, typeNote, uuidOf, waitMounted } from "./owner.js";
import { serveOwnerStore, type ServedStore } from "./owner-store-memory.js";
import { enrollHere, keepingLog, keptRecord, pillText, waitSettledKept } from "./keeping.js";
import { wipe } from "./keychain.js";

/**
 * Kept at Keep (Build 2b-2d item 5; R-Z sentence 2).
 *
 * The device reading of 30 October: after "Keep beyond this browser" in the
 * Home Screen app, the pill read "Saved in this browser", and Safari's
 * "Kept". The cause, found here without a device: enrolling adopted the
 * documents written here and asked the store to keep none of them; only the
 * next save did. In Safari the person went on changing the document, and it
 * was kept; in the Home Screen app they did not. And Safari, with no
 * Credential Management API, reloads the page for the keychain form right
 * after enrolling, so a keep started then can be cut off: the opener asks
 * again as it loads, for what an owner holds here that the store has not
 * acknowledged.
 *
 * Chromium only: the passkey with PRF is its virtual authenticator; each
 * browser context is this origin's storage between two wipes.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const offer = (page: Page) => page.locator("#save-state[data-offer]");
const ownersAt = (store: ServedStore): string[] =>
  store.values().filter((value) => value.object.startsWith("o:") && value.key === "owner").map((value) => value.object.slice(2));
const owner = (page: Page): Promise<string | null> => page.evaluate(() => (window as Any).__runner.owner.current());

/** From the offer: the pill, "Keep beyond this browser", "Make a new passkey". */
async function keepWithANewPasskey(page: Page): Promise<void> {
  await expect(offer(page)).toBeVisible({ timeout: 30_000 });
  await offer(page).click();
  await page.locator("#keep-beyond").click();
  await page.locator("#keep-new").click();
}

test.describe("kept at Keep (Build 2b-2d item 5)", () => {
  test.slow();

  test("a second context enrolled as a second owner: its document is kept at Keep, with no further change, and the pill says Kept", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      const provider = await addPasskeyProvider(context, page);
      const file = await buildNotes(mkdtempSync(join(tmpdir(), "dai-keep-")), "Notes");

      // Safari: the document kept under its owner.
      let app = await openFile(page, file);
      const uuid = await uuidOf(page);
      const first = await enrollHere(page);
      await typeNote(app, "in-safari");
      await expect.poll(() => storedHolds(page, uuid, "in-safari"), { timeout: 30_000 }).toBe(true);
      await waitSettledKept(page, uuid);

      // The Home Screen app: the same document, a change, and Keep by a new passkey, as before R-Z's amendment of 31 October.
      await wipe(page, provider.cdp);
      app = await openFile(page, file);
      await typeNote(app, "on-home-screen");
      await expect.poll(() => storedHolds(page, uuid, "on-home-screen"), { timeout: 30_000 }).toBe(true);
      await keepWithANewPasskey(page);
      await expect.poll(() => owner(page), { timeout: 30_000 }).not.toBeNull();
      const second = (await owner(page))!;
      expect(second).not.toBe(first);

      // No further change: the first append completes, under the second owner, and the pill says so.
      await expect.poll(async () => (await keptRecord(page, uuid))?.owner ?? null, { timeout: 45_000 }).toBe(second);
      await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe("Kept");
      expect(ownersAt(store).sort()).toEqual([first, second].sort());
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("a keep cut off at enrollment is asked again as the opener loads: the document is Kept with no further change", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      await addPasskeyProvider(context, page);
      const file = await buildNotes(mkdtempSync(join(tmpdir(), "dai-keep-")), "Notes");
      const app = await openFile(page, file);
      const uuid = await uuidOf(page);
      await typeNote(app, "before-keeping");
      await expect.poll(() => storedHolds(page, uuid, "before-keeping"), { timeout: 30_000 }).toBe(true);

      // The store away while the person keeps: the keep asked at enrollment does not land.
      store.setMode("unavailable");
      await keepWithANewPasskey(page);
      await expect.poll(() => owner(page), { timeout: 30_000 }).not.toBeNull();
      await expect.poll(async () => (await keepingLog(page)).unavailable, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(await keptRecord(page, uuid)).toBeNull();

      // The page goes, as the keychain form's navigation takes it; the store is back; nothing is typed.
      store.setMode("up");
      await page.reload();
      await waitMounted(page, file);
      await expect.poll(async () => (await keptRecord(page, uuid))?.owner ?? null, { timeout: 45_000 }).toBe(await owner(page));
      await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe("Kept");
    } finally {
      await context.close();
      await store.close();
    }
  });
});
