import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, addPasskeyProvider, buildNotes, currentOwner, openFile, storedHolds, typeNote, uuidOf, waitMounted } from "./owner.js";

/**
 * The invitation, Build 2b-1 (R-Z sentence 3).
 *
 * After the first change a person makes lands in this browser, one line under
 * the bar, which takes nothing from them: "Saved in this browser. Keep your
 * work if this browser is cleared. Keep beyond this browser · Not now". Not
 * after the document's seed, a projection of another copy's changes, or the
 * runtime's own bookkeeping: the runtime says whether a save carries a change
 * of this author's (R-X, R-S). Nothing starts until a tap; "Not now" is
 * remembered for the browser context, and the offer stays in the menu.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const LINE = "Saved in this browser. Keep your work if this browser is cleared. Keep beyond this browser · Not now";

/** Counts passkey ceremonies the page starts, before the opener loads: whether a ceremony began. */
async function countCeremonies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as Any).__ceremonies = 0;
    const create = navigator.credentials?.create?.bind(navigator.credentials);
    if (!create) return;
    navigator.credentials.create = (options?: CredentialCreationOptions) => {
      (window as Any).__ceremonies += 1;
      return create(options);
    };
  });
}
const ceremonies = (page: Page): Promise<number> => page.evaluate(() => (window as Any).__ceremonies as number);

/**
 * Waits until the opener has decided about the offer for every save written so
 * far: the state an assertion that no line is shown depends on (tests/README.md,
 * waiting). A save asked is not one written, and one written is not yet decided.
 */
async function decidedForEverySave(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const [written, decided] = await page.evaluate(() => [(window as Any).__runner.savesWritten, (window as Any).__runner.keepOfferDecided]);
      return written > 0 && decided >= written;
    }, { timeout: 30_000 })
    .toBe(true);
}

const line = (page: Page) => page.locator("#keep-offer");

test.describe("the invitation to keep beyond this browser (R-Z sentence 3)", () => {
  test.slow();

  test("a document opened and not touched, its seed and the runtime's bookkeeping saved, shows no invitation", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const file = await buildNotes(scratch, "Starter", true);
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    await expect(app.locator("#note")).toHaveValue("starter");
    await decidedForEverySave(page);
    await expect(line(page)).toBeHidden();
  });

  test("an app that writes back what it read as it opens, an echo, shows no invitation", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    // Not a change (R-X), but a write: the save after it is not the document's setup alone.
    const file = await buildNotes(scratch, "Echo", true, "UPDATE notes SET body = body WHERE id = 1");
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    await expect(app.locator("#note")).toHaveValue("starter");
    await decidedForEverySave(page);
    await expect(line(page)).toBeHidden();
  });

  test("a person who taps the field and changes nothing, while the app writes back what it shows, gets no invitation", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    // After a tap the page is used: what keeps this save from being an offer is that it carries no change (R-X).
    const file = await buildNotes(scratch, "Focus", true, "", "UPDATE notes SET body = body WHERE id = 1");
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    await expect(app.locator("#note")).toHaveValue("starter");
    await decidedForEverySave(page);
    const before = await page.evaluate(() => (window as Any).__runner.savesWritten as number);
    await app.locator("#note").click();
    await expect.poll(() => page.evaluate(() => (window as Any).__runner.savesWritten as number), { timeout: 30_000 }).toBeGreaterThan(before);
    await decidedForEverySave(page);
    await expect(line(page)).toBeHidden();

    await app.locator("#note").press("End");
    await app.locator("#note").pressSequentially(" and mine");
    await expect(line(page)).toBeVisible({ timeout: 30_000 });
  });

  test("another copy's changes, merged into a copy nobody here has changed and saved, show no invitation", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const file = await buildNotes(scratch, "Notes");
    // Another device: a change of its person's, sent as a copy.
    const elsewhere = await browser.newContext({ acceptDownloads: true });
    const other = await elsewhere.newPage();
    await other.goto(RUNNER_URL);
    const theirs = await openFile(other, file);
    const uuid = await uuidOf(other);
    await typeNote(theirs, "from the other copy");
    await expect.poll(() => storedHolds(other, uuid, "from the other copy"), { timeout: 30_000 }).toBe(true);
    await other.evaluate(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const downloading = other.waitForEvent("download", { timeout: 60_000 });
    await other.evaluate(() => (window as Any).__runner.exportContainer());
    const copy = join(scratch, "Notes.copy.dai.html");
    await (await downloading).saveAs(copy);
    await elsewhere.close();

    // This device: the same document, opened and not touched, then the copy opened into it.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    const saves = await page.evaluate(() => (window as Any).__runner.savesWritten as number);
    await page.setInputFiles("#file", copy);
    await expect(page.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
    await page.locator("#card-open").click();
    await expect.poll(() => storedHolds(page, uuid, "from the other copy"), { timeout: 60_000 }).toBe(true);
    expect(await page.evaluate(() => (window as Any).__runner.savesWritten as number)).toBeGreaterThan(saves);
    await decidedForEverySave(page);
    await expect(line(page)).toBeHidden();
    await expect.poll(() => app.locator("#note").evaluate(async () => ((await (window as Any).__db.query("SELECT body FROM notes WHERE id = 1"))[0] ?? {}).body)).toBe("from the other copy");
    await context.close();
  });

  test("the line appears after the first change while typing goes on uninterrupted, and takes nothing from the field", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const file = await buildNotes(scratch, "Notes");
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    const uuid = await uuidOf(page);
    const words = "the quick brown fox jumps over the lazy dog, twice over";
    // A key every 60 ms, about three seconds: the first save lands while the person is still typing.
    const typing = typeNote(app, words, 60);
    await expect(line(page)).toBeVisible({ timeout: 30_000 });
    expect(await app.locator("#note").evaluate((el) => el.ownerDocument.activeElement === el)).toBe(true);
    await typing;
    await expect(app.locator("#note")).toHaveValue(words);
    expect(await app.locator("#note").evaluate((el) => el.ownerDocument.activeElement === el)).toBe(true);
    await expect.poll(() => storedHolds(page, uuid, words), { timeout: 30_000 }).toBe(true);

    await expect(line(page)).toHaveText(LINE);
    // A line, not a sheet: nothing modal, nothing over the application.
    expect(await line(page).evaluate((el) => [el.getAttribute("role"), el.getAttribute("aria-modal"), el.closest("[aria-modal='true']")])).toEqual(["status", null, null]);
  });

  test("after Not now, a second document in the same browser context shows no invitation, and the offer stays in the menu", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const first = await buildNotes(scratch, "First");
    const second = await buildNotes(scratch, "Second");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    let app = await openFile(page, first);
    await typeNote(app, "one");
    await expect(line(page)).toBeVisible({ timeout: 30_000 });
    await page.locator("#keep-offer-no").click();
    await expect(line(page)).toBeHidden();

    // The opener resumes the first document on load; the second is picked once that has landed.
    await page.goto(RUNNER_URL);
    await waitMounted(page, first);
    app = await openFile(page, second);
    const uuid = await uuidOf(page);
    await typeNote(app, "two");
    await expect.poll(() => storedHolds(page, uuid, "two"), { timeout: 30_000 }).toBe(true);
    await decidedForEverySave(page);
    await expect(line(page)).toBeHidden();

    await page.locator("#more").click();
    await expect(page.locator("#keep-beyond")).toBeVisible();
    await context.close();
  });

  test("no ceremony starts when the line appears; one starts on the tap", async ({ browser, browserName }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const file = await buildNotes(scratch, "Notes");
    const context = await browser.newContext();
    const page = await context.newPage();
    await countCeremonies(page);
    await page.goto(RUNNER_URL);
    // Where a passkey can be made here, it is: the tap then enrolls. Elsewhere the ceremony starts and is refused.
    if (browserName === "chromium") await addPasskeyProvider(context, page);
    const app = await openFile(page, file);
    // Playwright's WebKit here has PublicKeyCredential but no navigator.credentials, so no ceremony can start:
    // there the tap's mark is the host's refusal, said only after it.
    const passkeys = await page.evaluate(() => "PublicKeyCredential" in window && typeof navigator.credentials?.create === "function");
    const noPasskeys = page.locator("#doc-note", { hasText: "This browser cannot make a passkey." });
    await typeNote(app, "worth keeping");
    await expect(line(page)).toBeVisible({ timeout: 30_000 });
    await decidedForEverySave(page);
    expect(await ceremonies(page)).toBe(0);
    await expect(noPasskeys).toBeHidden();
    expect(await currentOwner(page)).toBeNull();

    await page.locator("#keep-offer-yes").click();
    if (passkeys) await expect.poll(() => ceremonies(page)).toBe(1);
    else await expect(noPasskeys).toBeVisible();
    await expect(line(page)).toBeHidden();
    if (browserName === "chromium") await expect.poll(() => currentOwner(page), { timeout: 30_000 }).not.toBeNull();
    await context.close();
  });
});

