import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * What a person is told when they share, and when they keep (D53, and the
 * share default ruled 21 September).
 *
 * Two facts nobody could work out for themselves, said where they can still be
 * acted on:
 *
 * - **A share of a single person's document sends the app, not their entries.**
 *   A document with replicated tables is shared to be joined and its data is
 *   the point; one with none is a log or a list, and "here is the app I use"
 *   should hand over the app. The toggle is still there for the other case.
 * - **The link is the way back** (D53). A document's key lives in this device's
 *   library row and on no server, so once this device forgets the document what
 *   a store holds is ciphertext nobody can read again. The property is the same
 *   one that makes a link safe on a home screen; it is useless to somebody who
 *   is never told it, because the action it implies can only be taken first.
 *
 * Read from the screen, in the words a person reads there.
 */
test.describe("what a share and a keep say", () => {
  test.slow();

  let solo: string;
  let shared: string;

  test.beforeAll(async () => {
    // A document for one person (packing-list declares no replicated tables:
    // "one family's packing list, kept on one phone"), and one made to be
    // joined.
    const one = await compileDirectory({
      sourceDir: join(repo, "examples", "packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const two = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    const dir = mkdtempSync(join(tmpdir(), "dai-sentences-"));
    solo = join(dir, "packing.dai.html");
    shared = join(dir, "chess.dai.html");
    writeFileSync(solo, one.html, "utf8");
    writeFileSync(shared, two.html, "utf8");
  });

  async function open(page: Page, file: string): Promise<void> {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  }

  test("a document nobody joins sends the app, not the person's entries", async ({ browser }) => {
    const device = await browser.newContext();
    const page = await device.newPage();
    await open(page, solo);
    await page.click("#more");
    await page.click("#send");
    await expect(page.locator("#send-sheet")).toBeVisible({ timeout: 30_000 });

    const toggle = page.locator("#send-with-data");
    await expect(toggle, "the data goes only if this person asks for it").not.toBeChecked();
    await expect(page.locator("#send-note")).toHaveText(
      "Anyone with the link gets the app as it arrived, with none of your entries.",
    );

    // Turned on, the sentence says the other thing, so the person is never
    // reading a promise the toggle has already broken.
    await toggle.check();
    await expect(page.locator("#send-note")).toHaveText("Anyone with the link can open it, with what is in it now.");
    await device.close();
  });

  test("a document made to be joined still sends what the other person needs", async ({ browser }) => {
    /*
     * The guard on the default. A share of a replicated document with its data
     * left out is an app the other person cannot join, so the default there is
     * the opposite one — and a rule that just said "off" would have broken the
     * case the whole mechanism exists for.
     */
    const device = await browser.newContext();
    const page = await device.newPage();
    await open(page, shared);
    await page.click("#more");
    await page.click("#send");
    await expect(page.locator("#send-sheet")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#send-with-data")).toBeChecked();
    await device.close();
  });

  test("the share card says whether the link is a way back to the data (D53)", async ({ browser }) => {
    const device = await browser.newContext();
    const page = await device.newPage();
    await open(page, solo);
    await page.click("#more");
    await page.click("#send");
    await expect(page.locator("#send-sheet")).toBeVisible({ timeout: 30_000 });

    const backup = page.locator("#send-backup");
    // Data off, which is this document's default: the link is explicitly not a
    // copy of what they have written. The sentence somebody about to send the
    // app to a friend would otherwise supply for themselves, wrongly.
    await expect(backup).toHaveText(
      "This link carries the app without your entries, so it is not a copy of them. What you have written lives on this device only.",
    );

    await page.locator("#send-with-data").check();
    await expect(backup).toHaveText(
      "Keep this link yourself: it is the way back if this device ever forgets this app.",
    );
    await device.close();
  });

  test("the keep sheet says this device is the only place it lives (D53)", async ({ browser }) => {
    /*
     * Read from the sheet a person meets while deciding to keep the document —
     * the last moment the action it implies is still available to them.
     *
     * The sheet is what iOS and a desktop browser without an install prompt
     * show; the button reaches it through `keep()`.
     */
    const device = await browser.newContext();
    const page = await device.newPage();
    await open(page, solo);
    // No install prompt in a headless browser, which is also iOS's case, so
    // the button opens the sheet of instructions rather than firing a prompt.
    await page.click("#more");
    await page.click("#keep-cta");
    await expect(page.locator("#keep-sheet")).toBeVisible({ timeout: 30_000 });

    /*
     * It says what keeping does not do. An earlier version called the link
     * "the way back", which is true of the app and false of the entries: a
     * link carries the document as it was when the link was made, and the
     * opener mints one for a file-borne document at mount. Beside somebody's
     * log, "the way back" reads as "my log is safe".
     */
    await expect(page.locator("#keep-backup")).toHaveText(
      "Keeping Beach trip here is not a backup. The link or file you opened it from brings the app back; what you write in it stays on this device.",
    );
    await device.close();
  });
});
