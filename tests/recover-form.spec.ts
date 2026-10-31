import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, buildNotes, openFile, pointAtStore } from "./owner.js";
import { serveOwnerStore, type ServedStore } from "./owner-store-memory.js";
import { putInKeyStore } from "./keeping.js";

/**
 * The chooser's "Recover with the saved password" form, as a phone meets it
 * (Build 2b-2d item 3; R-D as amended, D298).
 *
 * The device reading of 30 October: on an iPhone, a tap on the button did
 * nothing a person could see. A recording of 31 October: iOS filled both
 * fields from a saved password, visibly, and the submit answered "Fill in the
 * saved password first", the sentence for empty fields. So: the button cannot
 * be tapped until both fields hold something, a line under the form says how
 * they fill, the submit reads the fields as they are when it runs, waiting a
 * frame for a value the engine delivers late, every outcome is said in the
 * chooser's report within the screen, and the form is shown only where it can
 * work. At 390 × 844, a phone's size.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const PHONE = { width: 390, height: 844 };
const HINT = "Tap the field and choose the saved password; both fields fill in.";
const REFUSED = "This password did not recover any documents. Nothing was restored.";

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

  test("the button cannot be tapped with a field empty, and the line under the form says how both fill", async ({ browser }) => {
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
      await expect(button).toBeDisabled();
      // A tap on it changes nothing and says nothing.
      await button.click({ force: true });
      await expect(page.locator("#report")).toHaveText("");
      await autofill(page, "#recover-owner", "an-account");
      await expect(button).toBeDisabled();
      await autofill(page, "#recover-secret", "a-password");
      await expect(button).toBeEnabled();
      await autofill(page, "#recover-owner", "");
      await expect(button).toBeDisabled();
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

  test("the form is shown only where it can work: a store stamped, and no owner signed in here, after Remove from this device too", async ({ browser }) => {
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

    // An owner signed in here, the document removed: the chooser comes back, and offers no recovery form.
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
      await expect(page.locator("#recover-keychain")).toBeHidden();
      await expect(page.locator("#recover")).toBeHidden();
    } finally {
      await context.close();
    }
  });
});
