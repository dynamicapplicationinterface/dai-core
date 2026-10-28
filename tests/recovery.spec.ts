import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type CDPSession, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, appIn, buildNotes, openFile, storedHolds, typeNote, uuidOf } from "./owner.js";
import { serveOwnerStore } from "./owner-store-memory.js";
import { enrollHere, keptRecord, openerWithStore, waitSettledKept } from "./keeping.js";

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

      // 1. A, kept.
      await typeNote(app, "A-kept-7Q");
      await expect.poll(() => storedHolds(page, uuid, "A-kept-7Q"), { timeout: 30_000 }).toBe(true);
      const a = await waitSettledKept(page, uuid);
      // 2. The store cut off. 3. B, saved in this browser only.
      store.setMode("unavailable");
      await typeNote(app, " B-local-3X");
      await expect.poll(() => storedHolds(page, uuid, "A-kept-7Q B-local-3X"), { timeout: 30_000 }).toBe(true);
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
      await expect(app.locator("#note")).toHaveValue("A-kept-7Q", { timeout: 60_000 });
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
