import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, addPasskeyProvider, appIn, buildNotes, openFile, pointAtStore, storedRow, typeNote } from "./owner.js";
import { watchKeychain } from "./keychain.js";
import { serveOwnerStore, type ServedStore } from "./owner-store-memory.js";
import { enrollHere, putInKeyStore, waitSettledKept } from "./keeping.js";

/**
 * The chooser's "Recover with the saved password" form, as a phone meets it
 * (Build 2b-2d item 3; R-D as amended, D298).
 *
 * The device reading of 30 October: on an iPhone, a tap on the button did
 * nothing a person could see. A recording of 31 October: iOS filled both
 * fields from a saved password, visibly, and the submit answered "Fill in the
 * saved password first", the sentence for empty fields. So: a line under the
 * form says how they fill, the submit reads the fields as they are when it
 * runs, waiting a few frames for a value the engine delivers late, every
 * outcome is said in the chooser's report within the screen, and the form is
 * shown only where it can work. At 390 × 844, a phone's size.
 *
 * The button is never disabled (Build 2b-2dr item 3): a disabled default
 * button also blocks the keyboard's Go, and the page cannot see every state
 * an autofill shows. An autofill iOS commits with no event, a frame after the
 * tap, reaches the submit.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const PHONE = { width: 390, height: 844 };
const HINT = "Tap the field and choose the saved password; both fields fill in.";
const REFUSED = "This password did not recover any documents. Nothing was restored.";
const EMPTY = "The account or the saved password reached this page empty. Tap the field, choose the saved password, and both fields fill in.";

/** Sets a field the way a password manager's autofill does: the value, then input and change, and no focus. */
const autofill = (page: Page, selector: string, value: string): Promise<void> =>
  page.locator(selector).evaluate((input, text) => {
    (input as HTMLInputElement).value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);

/** Whether the report's sentence is on the screen: its box inside the viewport. */
const reportInView = (page: Page): Promise<{ top: number; bottom: number; inView: boolean }> =>
  page.locator("#report").evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { top: Math.round(box.top), bottom: Math.round(box.bottom), inView: box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight };
  });

test.describe("the chooser's saved-password form on a phone (Build 2b-2d item 3)", () => {
  test.slow();
  let store: ServedStore;
  test.beforeAll(async () => {
    store = await serveOwnerStore();
  });
  test.afterAll(async () => {
    await store?.close();
  });

  test("the button can always be tapped; tapped with both fields empty it says so in the report, on the screen, and the line under the form says how both fill", async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONE });
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      const form = page.locator("#recover-keychain");
      const button = page.locator("#recover-with-password");
      await expect(form).toBeVisible();
      await expect(page.locator("#recover-hint")).toHaveText(HINT);
      await expect(page.locator("#recover-hint")).toBeVisible();
      await expect(button).toBeEnabled();
      const before = store.received().length;
      await button.click();
      await expect(page.locator("#report")).toHaveText(EMPTY, { timeout: 10_000 });
      expect(await reportInView(page), "the report, on the screen").toMatchObject({ inView: true });
      expect(store.received().length, "nothing sent for empty fields").toBe(before);
      await autofill(page, "#recover-owner", "an-account");
      await expect(button).toBeEnabled();
    } finally {
      await context.close();
    }
  });

  /*
   * iOS fills both fields from a saved password visibly and hands the page
   * the values with no event, after the tap. Here, as the form submits, both
   * fields are empty, and their values land a frame later with no input and
   * no change event: the submit waits for them, and the recovery runs.
   */
  test("values an autofill commits with no event a frame after the tap reach the submit, and the recovery runs", async ({ browser, browserName }) => {
    test.skip(browserName !== "webkit", "the iPhone's engine");
    const context = await browser.newContext({ viewport: PHONE });
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      await expect(page.locator("#recover-keychain")).toBeVisible();
      await page.locator("#recover-keychain").evaluate((form) => {
        form.addEventListener(
          "submit",
          () => {
            const [owner, secret] = [...form.querySelectorAll("input")];
            requestAnimationFrame(() => {
              owner!.value = "AAAAAAAAAAAAAAAAAAAAAA";
              secret!.value = "c2VjcmV0LXRoYXQtb3BlbnMtbm90aGluZy1oZXJlLTAw";
            });
          },
          { capture: true, once: true },
        );
      });
      const before = store.received().length;
      await page.locator("#recover-with-password").click({ force: true });
      await expect.poll(() => store.received().length, { message: "the recovery's request left", timeout: 10_000 }).toBeGreaterThan(before);
      await expect(page.locator("#report")).toHaveText(REFUSED, { timeout: 30_000 });
      expect(await reportInView(page)).toMatchObject({ inView: true });
    } finally {
      await context.close();
    }
  });

  test("the form is shown on an engine with no WebAuthn: the saved password needs none (2b2d-L3)", async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONE });
    try {
      await pointAtStore(context, store.base);
      await context.addInitScript(() => {
        delete (window as Any).PublicKeyCredential;
      });
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      await expect(page.locator("#open")).toBeVisible();
      expect(await page.evaluate(() => typeof (window as Any).PublicKeyCredential)).toBe("undefined");
      await expect(page.locator("#recover-keychain")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("fields filled the way autofill fills them reach the submit, and its outcome is said in the report, on the screen", async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONE });
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      const said: string[] = [];
      page.on("console", (message) => {
        if (message.text().includes("recover form")) said.push(message.text());
      });
      await page.goto(RUNNER_URL);
      await expect(page.locator("#recover-keychain")).toBeVisible();
      // An account the store does not hold, as a saved password would name one: the store refuses it.
      await autofill(page, "#recover-owner", "AAAAAAAAAAAAAAAAAAAAAA");
      await autofill(page, "#recover-secret", "c2VjcmV0LXRoYXQtb3BlbnMtbm90aGluZy1oZXJlLTAw");
      await page.locator("#recover-with-password").click();
      await expect(page.locator("#report")).toHaveText(REFUSED, { timeout: 30_000 });
      expect(await reportInView(page), "the report, on the screen").toMatchObject({ inView: true });
      expect(said.join("\n"), "the submit saw both fields").toMatch(/account \d+ characters, password \d+ characters/);
      expect(said.join("\n")).not.toContain("c2VjcmV0");
    } finally {
      await context.close();
    }
  });

  /*
   * The recording of 31 October: both fields visibly filled, and the submit
   * read them empty. An engine that commits an autofill after the tap is
   * stood in for here: as the form submits, the fields read empty, and their
   * values land a frame later. The submit waits for them.
   */
  test("a value the engine commits a frame after the tap is waited for, not called empty", async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONE });
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      await expect(page.locator("#recover-keychain")).toBeVisible();
      await autofill(page, "#recover-owner", "AAAAAAAAAAAAAAAAAAAAAA");
      await autofill(page, "#recover-secret", "c2VjcmV0LXRoYXQtb3BlbnMtbm90aGluZy1oZXJlLTAw");
      await page.locator("#recover-keychain").evaluate((form) => {
        form.addEventListener(
          "submit",
          () => {
            const fields = [...form.querySelectorAll("input")];
            const values = fields.map((field) => field.value);
            for (const field of fields) field.value = "";
            requestAnimationFrame(() => {
              fields.forEach((field, at) => {
                field.value = values[at]!;
                field.dispatchEvent(new Event("change", { bubbles: true }));
              });
            });
          },
          { capture: true, once: true },
        );
      });
      await page.locator("#recover-with-password").click();
      await expect(page.locator("#report")).toHaveText(REFUSED, { timeout: 30_000 });
      expect(await reportInView(page)).toMatchObject({ inView: true });
    } finally {
      await context.close();
    }
  });

  test("the form is shown wherever a store is stamped, an owner signed in here or not: after Remove from this device, Recover and the form are on the chooser", async ({ browser }) => {
    // No store: no form, and the reason in the console.
    const bare = await browser.newContext({ viewport: PHONE });
    try {
      const page = await bare.newPage();
      const said: string[] = [];
      page.on("console", (message) => said.push(message.text()));
      await page.goto(RUNNER_URL);
      await expect(page.locator("#open")).toBeVisible();
      await expect(page.locator("#recover-keychain")).toBeHidden();
      await expect.poll(() => said.join("\n")).toContain("recover form hidden: no store");
    } finally {
      await bare.close();
    }

    /*
     * An owner signed in here, the document removed: the chooser comes back,
     * and offers Recover and the saved-password form, the owner unchanged
     * (D304, amended 1 November: the person who removed their last document
     * is the one who wants Recover next).
     */
    const context = await browser.newContext({ viewport: PHONE });
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-form-")), "Notes"));
      const owner = "form-owner-000000000000";
      await putInKeyStore(page, `dai:owner:${owner}`, { owner, atStore: true });
      await putInKeyStore(page, "dai:owner", owner);
      await page.evaluate(() => new BroadcastChannel("dai:owner").postMessage("changed"));
      page.once("dialog", (dialog) => void dialog.accept());
      await page.click("#more");
      await page.click("#remove");
      await expect(page.locator("body")).not.toHaveClass(/loaded/, { timeout: 30_000 });
      await expect(page.locator("#open")).toBeVisible();
      expect(await page.evaluate(() => (window as Any).__runner.owner.current())).toBe(owner);
      await expect(page.locator("#recover-keychain")).toBeVisible();
      await expect(page.locator("#recover")).toBeVisible();
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "the owner unchanged").toBe(owner);
    } finally {
      await context.close();
    }
  });
});

/*
 * The device reading of 1 November, step 2 (Build 2b-2dr6). After "Remove from
 * this device", the owner still signed in, the password typed and Return
 * pressed: to the person nothing happened, the fields kept their values and no
 * sentence was in sight. Tapping the button then said "Your library is
 * complete." over an empty list, with no way onward. The Return had recovered
 * the document; its sentence and its row were drawn under the keyboard, and the
 * second recovery emptied the list of what the first had brought back.
 *
 * Now, after a saved-password recovery on the chooser answers, whatever the
 * outcome, the password field is emptied and both fields let go of the focus,
 * so the keyboard drops and the sentence and the list are in view; the account
 * stays. The list is this page's record of what was recovered: a later
 * recovery never empties it. A document held here under this owner is not
 * named in the sentence, which says what this run did, but is listed, as
 * here, with its open button (2b2dr5-L1 as amended). Enter in the password
 * field recovers as the button does: the phone's Return relies on the form's
 * implicit submission, which WebKit pins here; iOS itself cannot be driven.
 *
 * The owner and the kept copy are made in a Chromium of their own (the passkey
 * with PRF is its virtual authenticator); the page under test is the project's
 * engine, which recovers with the saved password alone.
 */
test.describe("the saved password after Remove from this device, on a phone (Build 2b-2dr6)", () => {
  test.slow();
  test.skip(({ browserName }) => browserName === "firefox", "Chromium and WebKit");
  let store: ServedStore;
  test.beforeAll(async () => {
    store = await serveOwnerStore();
  });
  test.afterAll(async () => {
    await store?.close();
  });

  /** A notes document kept under a new owner in another browser; its id and the saved password the opener handed over. */
  async function keptElsewhere(): Promise<{ uuid: string; owner: string; account: string; secret: string }> {
    const elsewhere = await chromium.launch();
    try {
      const context = await elsewhere.newContext();
      await pointAtStore(context, store.base);
      const handed = await watchKeychain(context);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      await addPasskeyProvider(context, page);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-after-remove-")), "Notes"));
      const uuid = await page.evaluate(() => (window as Any).__runner.loaded.manifest.documentUuid as string);
      await typeNote(app, "kept-copy");
      const owner = await enrollHere(page);
      await waitSettledKept(page, uuid);
      const password = handed.find((entry) => entry.owner === owner);
      if (!password) throw new Error("no saved password handed over");
      return { uuid, owner, account: password.account, secret: password.secret };
    } finally {
      await elsewhere.close();
    }
  }

  /** The input that has the focus on the page, by id, or null: whether a keyboard is up. */
  const focusedField = (page: Page): Promise<string | null> =>
    page.evaluate(() => (document.activeElement instanceof HTMLInputElement ? document.activeElement.id : null));

  test("after Remove, Enter in the password field recovers and the keyboard drops; a recovery again keeps the list, the document listed as here; a fresh page lists it as here", async ({ browser }) => {
    const kept = await keptElsewhere();
    const context = await browser.newContext({ viewport: PHONE });
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      const report = page.locator("#report");
      const row = page.locator(`#recovered button[data-document="${kept.uuid}"]`);
      const opened = (): Promise<string | null> => page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null);

      // Step 1 of the reading: the saved password brings the document back, and it opens.
      await expect(page.locator("#recover-keychain")).toBeVisible();
      await page.locator("#recover-owner").fill(kept.account);
      await page.locator("#recover-secret").fill(kept.secret);
      await page.locator("#recover-with-password").click();
      await expect(report).toHaveText("Recovered Notes.", { timeout: 30_000 });
      await row.click();
      await expect.poll(opened, { timeout: 30_000 }).toBe(kept.uuid);
      await expect(appIn(page).locator("#note")).toHaveValue("kept-copy", { timeout: 60_000 });
      await expect.poll(async () => (await storedRow(page, kept.uuid, "notes", "body = ?", ["kept-copy"])).length, { timeout: 30_000 }).toBe(1);

      // Step 2: Remove from this device, the owner still signed in; the chooser offers the form.
      page.once("dialog", (dialog) => void dialog.accept());
      await page.click("#more");
      await page.click("#remove");
      await expect(page.locator("body")).not.toHaveClass(/loaded/, { timeout: 30_000 });
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "the owner still signed in").toBe(kept.owner);
      await expect(page.locator("#recover-keychain")).toBeVisible();

      // The password typed and Return pressed: the form's implicit submission recovers, as the button does.
      await page.locator("#recover-owner").fill(kept.account);
      await page.locator("#recover-secret").fill(kept.secret);
      await page.locator("#recover-secret").press("Enter");
      await expect(report).toHaveText("Recovered Notes.", { timeout: 30_000 });
      await expect(row).toHaveText(/^Notes · kept /);
      await expect(page.locator("#recovered li")).toHaveCount(1);
      // The password field emptied and no field holding the focus, so the keyboard drops; the account stays.
      await expect(page.locator("#recover-secret")).toHaveValue("");
      await expect(page.locator("#recover-owner")).toHaveValue(kept.account);
      await expect.poll(() => focusedField(page), { message: "no field has the focus" }).toBeNull();

      // Recover again: nothing new; the sentence says so, and the list keeps the document, as here.
      await page.locator("#recover-secret").fill(kept.secret);
      await page.locator("#recover-with-password").click();
      await expect(report).toHaveText("Your library is complete.", { timeout: 30_000 });
      await expect(row).toHaveText("Notes · here");
      await expect(page.locator("#recovered li")).toHaveCount(1);
      await expect(page.locator("#recover-secret")).toHaveValue("");
      await expect.poll(() => focusedField(page)).toBeNull();

      // A fresh page: the document held here, the recovery lists it as here, and its button opens it.
      await page.reload();
      await expect(page.locator("#recover-keychain")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("#recovered li")).toHaveCount(0);
      await page.locator("#recover-owner").fill(kept.account);
      await page.locator("#recover-secret").fill(kept.secret);
      await page.locator("#recover-secret").press("Enter");
      await expect(report).toHaveText("Your library is complete.", { timeout: 30_000 });
      await expect(row).toHaveText("Notes · here");
      await expect(page.locator("#recovered li")).toHaveCount(1);
      await row.click();
      await expect.poll(opened, { timeout: 30_000 }).toBe(kept.uuid);
      await expect(appIn(page).locator("#note")).toHaveValue("kept-copy", { timeout: 60_000 });
    } finally {
      await context.close();
    }
  });

  /*
   * The review of Build 2b-2dr6 (2b2dr6-L2): a row outlives a document removed
   * by any way but this page's Remove, another tab's included, and its button
   * then did nothing. Tapped with the document no longer in the library, the
   * row is taken out and the chooser says so.
   */
  test("a row whose document another tab removed says it is no longer on this device, and goes", async ({ browser }) => {
    const kept = await keptElsewhere();
    const context = await browser.newContext({ viewport: PHONE });
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      const row = page.locator(`#recovered button[data-document="${kept.uuid}"]`);
      await expect(page.locator("#recover-keychain")).toBeVisible();
      await page.locator("#recover-owner").fill(kept.account);
      await page.locator("#recover-secret").fill(kept.secret);
      await page.locator("#recover-secret").press("Enter");
      await expect(page.locator("#report")).toHaveText("Recovered Notes.", { timeout: 30_000 });
      await expect(row).toHaveText(/^Notes · kept /);

      // Another tab of this browser opens the document from its own recovery, and removes it.
      const other = await context.newPage();
      await other.goto(RUNNER_URL);
      await expect(other.locator("#recover-keychain")).toBeVisible();
      await other.locator("#recover-owner").fill(kept.account);
      await other.locator("#recover-secret").fill(kept.secret);
      await other.locator("#recover-secret").press("Enter");
      await expect(other.locator("#report")).toHaveText("Your library is complete.", { timeout: 30_000 });
      await other.locator(`#recovered button[data-document="${kept.uuid}"]`).click();
      await expect.poll(() => other.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null), { timeout: 30_000 }).toBe(kept.uuid);
      await expect.poll(async () => (await storedRow(other, kept.uuid, "notes", "body = ?", ["kept-copy"])).length, { timeout: 30_000 }).toBe(1);
      other.once("dialog", (dialog) => void dialog.accept());
      await other.click("#more");
      await other.click("#remove");
      await expect(other.locator("body")).not.toHaveClass(/loaded/, { timeout: 30_000 });
      await expect
        .poll(async () => ((await page.evaluate(() => (window as Any).__runner.listLibrary())) as Any[]).some((item) => item.documentUuid === kept.uuid), { timeout: 30_000 })
        .toBe(false);

      // The first tab's row, tapped: no document behind it, so it says so and goes.
      await row.click();
      await expect(page.locator("#report")).toHaveText("Notes is no longer on this device.", { timeout: 30_000 });
      await expect(page.locator("#recovered li")).toHaveCount(0);
      await expect(page.locator("#recovered")).toBeHidden();
      expect(await page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null), "nothing opened").toBeNull();
    } finally {
      await context.close();
    }
  });

  /*
   * The review of Build 2b-2dr6 item 1b (2b2dr6b-L1): the row's tap decided
   * "gone" on a library read that answers empty when it times out or fails,
   * so a stalled read said the document was no longer here, and took the row
   * out, while the library still held it. A read that did not answer says
   * nothing about what is held: the row stays, the chooser says the library
   * could not be read, and a tap again opens the document.
   */
  test("a library read that does not answer leaves the row, says the library could not be read, and a tap again opens the document", async ({ browser }) => {
    const kept = await keptElsewhere();
    const context = await browser.newContext({ viewport: PHONE });
    try {
      // The next library read stalls once, a request that never answers, then reads answer again.
      await context.addInitScript(() => {
        const stallOnce = <T extends (...args: Any[]) => IDBRequest>(real: T): T =>
          function (this: IDBObjectStore, ...args: Any[]) {
            if ((window as Any).__stallLibraryOnce === true && this.name === "cartridges") {
              (window as Any).__stallLibraryOnce = false;
              (window as Any).__stalledLibraryReads = ((window as Any).__stalledLibraryReads ?? 0) + 1;
              return {} as IDBRequest;
            }
            return real.apply(this, args);
          } as T;
        IDBObjectStore.prototype.getAll = stallOnce(IDBObjectStore.prototype.getAll);
        IDBObjectStore.prototype.get = stallOnce(IDBObjectStore.prototype.get);
      });
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      const row = page.locator(`#recovered button[data-document="${kept.uuid}"]`);
      const opened = (): Promise<string | null> => page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null);
      await expect(page.locator("#recover-keychain")).toBeVisible();
      await page.locator("#recover-owner").fill(kept.account);
      await page.locator("#recover-secret").fill(kept.secret);
      await page.locator("#recover-secret").press("Enter");
      await expect(page.locator("#report")).toHaveText("Recovered Notes.", { timeout: 30_000 });
      await expect(row).toHaveText(/^Notes · kept /);

      // The tap, with the library read stalled: nothing is said about what is held.
      await page.evaluate(() => {
        (window as Any).__stallLibraryOnce = true;
      });
      await row.click();
      await expect(page.locator("#report")).toHaveText("The library could not be read. Try again.", { timeout: 30_000 });
      expect(await page.evaluate(() => (window as Any).__stalledLibraryReads), "the stall was met").toBe(1);
      await expect(page.locator("#recovered li")).toHaveCount(1);
      await expect(row).toBeVisible();
      expect(await opened(), "nothing opened").toBeNull();
      expect(((await page.evaluate(() => (window as Any).__runner.listLibrary())) as Any[]).some((item) => item.documentUuid === kept.uuid), "the library still holds it").toBe(true);

      // Tapped again, the read answering: the document opens with what was kept.
      await row.click();
      await expect.poll(opened, { timeout: 30_000 }).toBe(kept.uuid);
      await expect(appIn(page).locator("#note")).toHaveValue("kept-copy", { timeout: 60_000 });
      await expect.poll(async () => (await storedRow(page, kept.uuid, "notes", "body = ?", ["kept-copy"])).length, { timeout: 30_000 }).toBe(1);
    } finally {
      await context.close();
    }
  });

  /*
   * D310, ruled 1 November: the clause about a cleared browser is said only
   * when no owner was signed in here as Recover was asked, as a wipe leaves
   * none. After "Remove from this device" the owner is still signed in, the
   * browser was not cleared, and the sentence says what it leaves out: changes
   * not yet kept. Decided from the signed-in state when Recover was asked.
   */
  test("the restored sentence names a cleared browser only when nobody was signed in as Recover was asked; after Remove it says changes not yet kept are not included", async ({ browser }) => {
    const kept = await keptElsewhere();
    const context = await browser.newContext({ viewport: PHONE });
    try {
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await page.goto(RUNNER_URL);
      const row = page.locator(`#recovered button[data-document="${kept.uuid}"]`);
      const opened = (): Promise<string | null> => page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null);
      const recoverWithThePassword = async (): Promise<void> => {
        await page.locator("#recover-owner").fill(kept.account);
        await page.locator("#recover-secret").fill(kept.secret);
        await page.locator("#recover-with-password").click();
        await expect(page.locator("#report")).toHaveText("Recovered Notes.", { timeout: 30_000 });
      };

      // A context that holds nothing, nobody signed in, as after a wipe: the cleared browser's clause.
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "nobody signed in").toBeNull();
      await recoverWithThePassword();
      await row.click();
      await expect.poll(opened, { timeout: 30_000 }).toBe(kept.uuid);
      await expect(page.locator("#doc-note")).toHaveText(/^Restored the copy kept at [^.]+\. Changes saved only in the cleared browser are not included\.$/, { timeout: 30_000 });
      await expect.poll(async () => (await storedRow(page, kept.uuid, "notes", "body = ?", ["kept-copy"])).length, { timeout: 30_000 }).toBe(1);

      // Remove from this device, the owner still signed in; Recover again, and open it.
      page.once("dialog", (dialog) => void dialog.accept());
      await page.click("#more");
      await page.click("#remove");
      await expect(page.locator("body")).not.toHaveClass(/loaded/, { timeout: 30_000 });
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "the owner still signed in").toBe(kept.owner);
      await recoverWithThePassword();
      await row.click();
      await expect.poll(opened, { timeout: 30_000 }).toBe(kept.uuid);
      await expect(page.locator("#doc-note")).toHaveText(/^Restored the copy kept at [^.]+\. Changes not yet kept are not included\.$/, { timeout: 30_000 });
      await expect(appIn(page).locator("#note")).toHaveValue("kept-copy", { timeout: 60_000 });
    } finally {
      await context.close();
    }
  });
});
