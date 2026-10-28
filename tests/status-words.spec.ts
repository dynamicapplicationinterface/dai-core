import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { cutTheNetwork } from "./offline.js";
import { RUNNER_URL, buildNotes, openFile, savesWritten, storedHolds, typeNote, uuidOf, waitMounted } from "./owner.js";
import { storageSentence, storageWords } from "../apps/runner/src/status.js";

/**
 * The status words, Build 2b-1 (R-Z sentences 2 and 4; ruling 6 as amended).
 *
 * "Saved in this browser" is said on the host's acknowledgment of a local
 * save, and it stays up. "Kept" is said only of a revision the owner's store
 * acknowledged; there is no store in this build (2b-2), so it is never shown.
 * Reconnecting alone changes nothing: only an acknowledgment would.
 *
 * The words appear once a change of the person's has landed, and while the
 * offer to keep beyond this browser stands they carry it: "Saved in this
 * browser · Keep?", in the same pill.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAVED = "Saved in this browser";
const status = (page: Page) => page.locator("#save-state");
/** The host's own text, the application's frames left out. */
const hostText = (page: Page): Promise<string> => page.evaluate(() => document.body.innerText);

/** Types a first change, and answers the offer "Not now", as a person who goes on would. */
async function firstChange(page: Page, app: Awaited<ReturnType<typeof openFile>>, text: string): Promise<void> {
  await typeNote(app, text);
  await expect(page.locator("#save-state[data-offer]")).toHaveText(`${SAVED} · Keep?`, { timeout: 30_000 });
  await status(page).click();
  await page.locator("#keep-not-now").click();
  await expect(page.locator("#save-state[data-offer]")).toHaveCount(0);
}

test.describe("the status words (R-Z sentences 2 and 4)", () => {
  test.slow();

  test("the words, from the host's evidence only", () => {
    expect(storageWords({ state: "saved", kept: null })).toBe(SAVED);
    expect(storageWords({ state: "saved", kept: { revision: "current", at: "10:42" } })).toBe("Kept");
    // Both facts in the pill's own box (D300), and R-Z sentence 4's words as its name.
    expect(storageWords({ state: "saved", kept: { revision: "earlier", at: "10:42 AM" } })).toBe("Saved here · kept 10:42 AM");
    expect(storageSentence({ state: "saved", kept: { revision: "earlier", at: "10:42 AM" } })).toBe("Saved in this browser. Last kept at 10:42 AM.");
    expect(storageSentence({ state: "saved", kept: null })).toBe(SAVED);
    expect(storageWords({ state: "saving", kept: null })).toBe("Saving…");
    expect(storageWords({ state: "failed", kept: { revision: "current", at: "10:42" } })).toBe("Not saved");
  });

  test("with no store to reach, a save says Saved in this browser and nothing else, and it stays up", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-status-"));
    const file = await buildNotes(scratch, "Notes");
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    const uuid = await uuidOf(page);
    await firstChange(page, app, "one");
    await expect(status(page)).toBeVisible();
    await expect(status(page)).toHaveText(SAVED);

    // Past the three seconds "Saved" used to stay for.
    await page.waitForTimeout(4_000);
    await expect(status(page)).toBeVisible();
    await expect(status(page)).toHaveText(SAVED);

    await app.locator("#note").press("End");
    await app.locator("#note").pressSequentially(" two");
    await expect.poll(() => storedHolds(page, uuid, "one two"), { timeout: 30_000 }).toBe(true);
    await expect(status(page)).toHaveText(SAVED);
    expect(await hostText(page)).not.toContain("Kept");
  });

  test("after a reload, the status says where the document is before any change", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-status-"));
    const file = await buildNotes(scratch, "Notes");
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    const uuid = await uuidOf(page);
    await firstChange(page, app, "one");
    await expect.poll(() => storedHolds(page, uuid, "one"), { timeout: 30_000 }).toBe(true);

    // The opener resumes the document on load; nothing is typed, and nothing need be saved.
    await page.reload();
    await waitMounted(page, file);
    await expect(status(page)).toBeVisible({ timeout: 30_000 });
    await expect(status(page)).toHaveText(SAVED);
    expect(await savesWritten(page), "said from what this browser holds, not from a new save").toBe(0);
  });

  test("the built opener says Kept nowhere but the status's own word, which only a held receipt feeds", () => {
    // What the opener's page can show: its markup, comments aside, and its bundled scripts. The worker draws nothing.
    const dist = join(repo, "apps", "runner", "dist");
    const files = ["index.html", ...readdirSync(join(dist, "assets")).filter((name) => name.endsWith(".js")).map((name) => join("assets", name))];
    const said: string[] = [];
    for (const name of files) {
      let text = readFileSync(join(dist, name), "utf8");
      if (name.endsWith(".html")) text = text.replace(/<!--[\s\S]*?-->/g, "");
      for (const found of text.matchAll(/Kept/g)) {
        const at = found.index;
        // The status's word for a store's acknowledgment (storageWords), whole and alone in its string.
        if (/^["'`]Kept["'`]$/.test(text.slice(at - 1, at + 5))) continue;
        said.push(`${name}: ${text.slice(Math.max(0, at - 40), at + 40)}`);
      }
    }
    expect(said).toEqual([]);
  });

  test("the menu says where the document is: Saved in this browser, never Kept", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-status-"));
    const file = await buildNotes(scratch, "Notes");
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    await firstChange(page, app, "one");
    await page.locator("#more").click();
    await expect(page.locator("#sheet")).toBeVisible();
    await expect(page.locator("#sheet-kept")).toHaveText("Saved in this browser · works offline");
    expect(await hostText(page)).not.toContain("Kept");
  });

  test("offline, a save says Saved in this browser; reconnecting alone changes nothing", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-status-"));
    const file = await buildNotes(scratch, "Notes");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    const uuid = await uuidOf(page);
    // Online first: on WebKit here no service worker serves the save's engine offline (owner-enrollment.spec).
    await firstChange(page, app, "online");
    await expect.poll(() => storedHolds(page, uuid, "online"), { timeout: 30_000 }).toBe(true);

    const cut = await cutTheNetwork(context, page);
    await app.locator("#note").press("End");
    await app.locator("#note").pressSequentially(" offline");
    await expect.poll(() => storedHolds(page, uuid, "online offline"), { timeout: 30_000 }).toBe(true);
    await expect(status(page)).toHaveText(SAVED);
    expect(cut.reached, cut.summary()).toEqual([]);

    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    // Nothing follows a reconnect that the words could wait on: what is checked is that they did not move.
    await page.waitForTimeout(1_500);
    await expect(status(page)).toHaveText(SAVED);
    expect(await hostText(page)).not.toContain("Kept");
    await context.close();
  });
});

