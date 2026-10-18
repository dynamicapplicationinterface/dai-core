import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { HINT_KEY } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * Save a copy, in the tab that lost a document to another tab (pass B's B1).
 *
 * A tab whose save is refused because another tab saved the document since it
 * was opened was told to use Save a copy to keep its changes. Save a copy
 * flushed first (the flush's save is refused the same way) and then packaged
 * the stored copy, which is the *other* tab's: a file was made, and the
 * changes it promised to keep were not in it. On a replicated document the
 * flush refused the copy outright, with "try again in a moment", a moment that
 * never comes in that tab.
 *
 * Now the copy is this tab's own bytes, asked of the frame that holds them,
 * and checked as any bytes leaving are (docs/identity.md, rule 3): a change of
 * this device's that was never signed does not leave, and the sentence says
 * why and that closing the other tab is what lets this one go on. Moving the
 * document from one tab to the other is later work (Phase 1.4).
 */
test.describe("Save a copy after another tab saved the document", () => {
  test.slow();

  let packing: string;
  let chess: string;
  test.beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dai-other-tab-"));
    // A document as built before R-O: the path a plain document without the changeset log takes.
    const one = await compileDirectory({ sourceDir: join(repo, "examples", "packing-list"), root: repo, appName: "Beach trip", changesetLog: false });
    const two = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
    packing = join(dir, "packing.dai.html");
    chess = join(dir, "chess.dai.html");
    writeFileSync(packing, one.html, "utf8");
    writeFileSync(chess, two.html, "utf8");
  });

  const savesWritten = (page: Page): Promise<number> => page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0));

  async function firstTab(context: BrowserContext, file: string): Promise<{ page: Page; uuid: string }> {
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect.poll(() => savesWritten(page), { timeout: 30_000, message: "the first tab saved" }).toBeGreaterThan(0);
    return { page, uuid: await page.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid as string) };
  }

  async function secondTab(context: BrowserContext, uuid: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    return page;
  }

  const dates = (page: Page) => app(page).locator('input[aria-label="When the trip is"]');

  async function typeDates(page: Page, text: string): Promise<void> {
    await dates(page).fill(text);
    await dates(page).press("Tab");
  }

  /** Presses Save a copy in the menu, as a person does; the download, if one is made. */
  async function saveACopy(page: Page): Promise<string | null> {
    await page.evaluate(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    let made: string | null = null;
    const onDownload = async (download: import("@playwright/test").Download): Promise<void> => {
      made = readFileSync((await download.path())!, "utf8");
    };
    page.on("download", (d) => void onDownload(d));
    await page.click("#more");
    await page.click("#export");
    return await new Promise((done) => {
      const started = Date.now();
      const look = (): void => {
        if (made !== null || Date.now() - started > 20_000) return done(made);
        setTimeout(look, 200);
      };
      look();
    });
  }

  test("a document without shared tables: the copy holds this tab's change, and the sentence says to close the other tab", async ({
    browser,
  }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const { page: first, uuid } = await firstTab(context, packing);
    const second = await secondTab(context, uuid);

    // The second tab saves first.
    const before = await savesWritten(second);
    await typeDates(second, "June, the other tab");
    await expect.poll(() => savesWritten(second), { timeout: 30_000, message: "the second tab saved" }).toBeGreaterThan(before);

    // The first tab's change is refused, and it is told what to do.
    await typeDates(first, "July, this tab");
    await expect(first.locator("#save-state")).toHaveAttribute("title", /saved from another tab/, { timeout: 30_000 });
    await expect(first.locator("#doc-note")).toContainText("Close the other tab");
    await expect(first.locator("#doc-note")).toContainText("Save a copy");

    // Save a copy makes a file holding this tab's change, not the other tab's.
    const html = await saveACopy(first);
    expect(html, "a copy was made").not.toBeNull();
    const elsewhere = await browser.newContext();
    const reader = await elsewhere.newPage();
    await reader.goto(RUNNER_URL);
    const file = join(mkdtempSync(join(tmpdir(), "dai-other-tab-copy-")), "copy.dai.html");
    writeFileSync(file, html!, "utf8");
    await reader.setInputFiles("#file", file);
    await reader.locator("#card-open").click({ timeout: 60_000 });
    await expect(dates(reader)).toHaveValue("July, this tab", { timeout: 60_000 });

    await elsewhere.close();
    await context.close();
  });

  /*
   * 2-H1: Save a copy pressed right after the change, inside the autosave
   * delay, before any save of this tab's was refused. The branch was taken on
   * `elsewhere` before the flush, and the flush's own refusal is what sets it,
   * so the copy was the stored one: the other tab's, without the change. Save
   * a copy now flushes before it branches.
   */
  test("a document without shared tables: Save a copy right after a change, before any refusal, holds the change", async ({
    browser,
  }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const { page: first, uuid } = await firstTab(context, packing);
    const second = await secondTab(context, uuid);

    const before = await savesWritten(second);
    await typeDates(second, "June, the other tab");
    await expect.poll(() => savesWritten(second), { timeout: 30_000, message: "the second tab saved" }).toBeGreaterThan(before);

    // No wait for the refusal: the copy is asked for while the change is pending.
    await typeDates(first, "July, this tab");
    expect((await first.locator("#save-state").getAttribute("title")) ?? "", "nothing refused yet").not.toMatch(/another tab/);
    const html = await saveACopy(first);
    expect(html, "a copy was made").not.toBeNull();
    await expect(first.locator("#save-state")).toHaveAttribute("title", /saved from another tab/, { timeout: 30_000 });

    const elsewhere = await browser.newContext();
    const reader = await elsewhere.newPage();
    await reader.goto(RUNNER_URL);
    const file = join(mkdtempSync(join(tmpdir(), "dai-other-tab-copy-")), "copy.dai.html");
    writeFileSync(file, html!, "utf8");
    await reader.setInputFiles("#file", file);
    await reader.locator("#card-open").click({ timeout: 60_000 });
    await expect(dates(reader), "the copy holds this tab's change").toHaveValue("July, this tab", { timeout: 60_000 });

    await elsewhere.close();
    await context.close();
  });

  test("a replicated document: a change never signed does not leave, and the sentence names the other tab and says to close it", async ({
    browser,
  }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const { page: first, uuid } = await firstTab(context, chess);
    const second = await secondTab(context, uuid);
    await expect.poll(() => savesWritten(second), { timeout: 30_000, message: "the second tab saved on opening" }).toBeGreaterThan(0);

    // The first tab writes a game; it is not signed, so not saved.
    const ui = app(first);
    await ui.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
    await ui.locator("#setup-you").fill("Ada");
    await ui.locator("#setup-them").fill("Cy");
    await ui.locator('input[name="color"][value="w"]').check();
    await ui.locator("#new-game-form button[type=submit]").click();
    await expect(first.locator("#save-state")).toHaveAttribute("title", /another tab/, { timeout: 30_000 });
    await expect(first.locator("#doc-note")).toContainText("Close the other tab");

    // Save a copy makes no file, and says why and what to do.
    await first.evaluate(() => {
      (document.getElementById("doc-note") as HTMLElement).textContent = "";
    });
    const html = await saveACopy(first);
    expect(html, "no file carries a change nobody signed").toBeNull();
    await expect(first.locator("#doc-note")).toContainText("another tab");
    await expect(first.locator("#doc-note")).toContainText("Close the other tab");
    await expect(first.locator("#doc-note")).not.toContainText("Try again in a moment");

    await context.close();
  });

  /*
   * The review of PR #6: 2-H1's defect on the next two buttons. A share and an
   * invite read the stored copy, the other tab's, as Save a copy did: on a
   * plain document the link carried the other tab's bytes without this tab's
   * change and was recorded as sent; on a replicated one the person read
   * "…Try again in a moment", false in that tab. A plain document has no
   * invite (an invite is into one session), so its share is the one action.
   */

  /** Presses `press`, then the sheet's Share; the link put on the clipboard, or null when none comes. */
  async function sendLink(page: Page, press: () => Promise<void>): Promise<string | null> {
    await page.evaluate(() => {
      (window as any).__copied = undefined;
      navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
    });
    await press();
    await page.locator("#send-go").click({ timeout: 30_000 });
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      const copied = await page.evaluate(() => (window as any).__copied as string | undefined);
      if (copied) return copied;
      if (!(await page.locator("#send-go").isVisible())) {
        // The sheet closed: a link copied, or a sentence said.
        if ((await page.locator("#doc-note").textContent())?.trim()) break;
      }
      await page.waitForTimeout(200);
    }
    return (await page.evaluate(() => (window as any).__copied as string | undefined)) ?? null;
  }

  const matchedDigest = (page: Page, uuid: string): Promise<string | null> =>
    page.evaluate(
      async (id) =>
        (((await (window as any).__runner.listLibrary()) as { documentUuid: string; matchedDigest?: string }[]).find(
          (item) => item.documentUuid === id,
        )?.matchedDigest ?? null),
      uuid,
    );

  test("a document without shared tables: Share carries this tab's change, and records nothing as sent", async ({ browser }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const { page: first, uuid } = await firstTab(context, packing);
    const second = await secondTab(context, uuid);

    const before = await savesWritten(second);
    await typeDates(second, "June, the other tab");
    await expect.poll(() => savesWritten(second), { timeout: 30_000, message: "the second tab saved" }).toBeGreaterThan(before);
    await typeDates(first, "July, this tab");
    await expect(first.locator("#save-state")).toHaveAttribute("title", /saved from another tab/, { timeout: 30_000 });
    const matched = await matchedDigest(first, uuid);

    await first.evaluate(() => {
      (document.getElementById("doc-note") as HTMLElement).textContent = "";
    });
    const link = await sendLink(first, async () => {
      await first.click("#more");
      await first.click("#send");
      await expect(first.locator("#send-sheet")).toBeVisible({ timeout: 30_000 });
      await first.locator("#send-with-data").check();
    });
    expect(link, "a link was made").not.toBeNull();
    expect(await matchedDigest(first, uuid), "nothing recorded as sent: these are not the stored copy").toBe(matched);

    const elsewhere = await browser.newContext();
    const reader = await elsewhere.newPage();
    await reader.goto(link!);
    await reader.locator("#card-open").click({ timeout: 60_000 });
    await expect(dates(reader), "the link holds this tab's change").toHaveValue("July, this tab", { timeout: 60_000 });

    await elsewhere.close();
    await context.close();
  });

  for (const action of ["Share", "Invite"] as const) {
    test(`a replicated document: ${action} sends nothing, and the sentence says to close the other tab`, async ({ browser }) => {
      const context = await browser.newContext({ acceptDownloads: true });
      const { page: first, uuid } = await firstTab(context, chess);
      const second = await secondTab(context, uuid);
      await expect.poll(() => savesWritten(second), { timeout: 30_000, message: "the second tab saved on opening" }).toBeGreaterThan(0);

      const ui = app(first);
      await ui.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
      await ui.locator("#setup-you").fill("Ada");
      await ui.locator("#setup-them").fill("");
      await ui.locator('input[name="color"][value="w"]').check();
      await ui.locator("#new-game-form button[type=submit]").click();
      await expect(first.locator("#save-state")).toHaveAttribute("title", /another tab/, { timeout: 30_000 });
      const matched = await matchedDigest(first, uuid);

      await first.evaluate(() => {
        (document.getElementById("doc-note") as HTMLElement).textContent = "";
      });
      const link = await sendLink(first, async () => {
        if (action === "Share") {
          await first.click("#more");
          await first.click("#send");
        } else {
          await ui.locator("#share").click();
        }
      });
      expect(link, "no link carries a change nobody signed").toBeNull();
      await expect(first.locator("#doc-note")).toContainText("another tab");
      await expect(first.locator("#doc-note")).toContainText("Close the other tab, then reopen the document here.");
      await expect(first.locator("#doc-note")).not.toContainText("Try again in a moment");
      await expect(first.locator("#doc-note")).not.toContainText("try again in a moment");
      expect(await matchedDigest(first, uuid), "nothing recorded as sent").toBe(matched);

      await context.close();
    });
  }

  /*
   * The review of R1c: the tests above wait for "another tab" before they
   * press, so the share skips its flush. Here the press comes inside the
   * autosave delay, before any save of this tab's was asked, so the share's
   * own flush is this tab's first refused save and the branch is taken after
   * it (sendingBytes). The sheet is opened before the change, and the check
   * and the press are one task in the page, so no autosave can come between
   * them.
   */
  test("Share whose own flush is the first refused save: a plain document's link holds the change, a replicated one sends nothing", async ({
    browser,
  }) => {
    /** Presses Send now if no save was asked since `asked` and nothing is refused yet; what it saw. */
    const sendBeforeAnySave = (page: Page, asked: number) =>
      page.evaluate((count) => {
        const runner = (window as any).__runner;
        const title = document.getElementById("save-state")?.getAttribute("title") ?? "";
        const pressed = runner.saves === count && !/another tab/.test(title);
        if (pressed) document.getElementById("send-go")!.click();
        return { pressed, saves: runner.saves as number, title };
      }, asked);
    /** The link the share copied, or null once the sheet closed with a sentence instead. */
    const linkOrSentence = async (page: Page): Promise<string | null> => {
      await expect
        .poll(
          async () =>
            Boolean(await page.evaluate(() => (window as any).__copied)) ||
            (!(await page.locator("#send-go").isVisible()) && Boolean((await page.locator("#doc-note").textContent())?.trim())),
          { timeout: 30_000, message: "the share finished: a link copied, or a sentence said" },
        )
        .toBe(true);
      return (await page.evaluate(() => (window as any).__copied as string | undefined)) ?? null;
    };
    const openSheet = async (page: Page): Promise<void> => {
      await page.evaluate(() => {
        (window as any).__copied = undefined;
        navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
        (document.getElementById("doc-note") as HTMLElement).textContent = "";
      });
      await page.click("#more");
      await page.click("#send");
      await expect(page.locator("#send-sheet")).toBeVisible({ timeout: 30_000 });
    };

    // A document without shared tables.
    {
      const context = await browser.newContext({ acceptDownloads: true });
      const { page: first, uuid } = await firstTab(context, packing);
      const second = await secondTab(context, uuid);
      const before = await savesWritten(second);
      await typeDates(second, "June, the other tab");
      await expect.poll(() => savesWritten(second), { timeout: 30_000, message: "the second tab saved" }).toBeGreaterThan(before);
      const matched = await matchedDigest(first, uuid);

      await openSheet(first);
      await first.locator("#send-with-data").check();
      const asked = await first.evaluate(() => (window as any).__runner.saves as number);
      await typeDates(first, "July, this tab");
      const press = await sendBeforeAnySave(first, asked);
      expect(press, "pressed before any save of the change was asked, with nothing refused").toMatchObject({ pressed: true, saves: asked });
      const link = await linkOrSentence(first);
      await expect(first.locator("#save-state"), "the share's flush was refused").toHaveAttribute("title", /saved from another tab/, {
        timeout: 30_000,
      });
      expect(link, "a link was made").not.toBeNull();
      expect(await matchedDigest(first, uuid), "nothing recorded as sent").toBe(matched);

      const elsewhere = await browser.newContext();
      const reader = await elsewhere.newPage();
      await reader.goto(link!);
      await reader.locator("#card-open").click({ timeout: 60_000 });
      await expect(dates(reader), "the link holds this tab's change").toHaveValue("July, this tab", { timeout: 60_000 });
      await elsewhere.close();
      await context.close();
    }

    // A replicated document.
    {
      const context = await browser.newContext({ acceptDownloads: true });
      const { page: first, uuid } = await firstTab(context, chess);
      const second = await secondTab(context, uuid);
      await expect.poll(() => savesWritten(second), { timeout: 30_000, message: "the second tab saved on opening" }).toBeGreaterThan(0);
      const matched = await matchedDigest(first, uuid);

      // The change is the new game's name, which the app writes on input. The
      // dialog opens with no write, then the sheet; the name is typed under it,
      // and Send pressed at once.
      const ui = app(first);
      await ui.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
      await expect(ui.locator("#setup-you")).toBeVisible({ timeout: 30_000 });
      await openSheet(first);
      const asked = await first.evaluate(() => (window as any).__runner.saves as number);
      await ui.locator("#setup-you").fill("Ada, this tab");
      const press = await sendBeforeAnySave(first, asked);
      expect(press, "pressed before any save of the change was asked, with nothing refused").toMatchObject({ pressed: true, saves: asked });
      const link = await linkOrSentence(first);
      expect(link, "no link carries a change nobody signed").toBeNull();
      await expect(first.locator("#doc-note")).toContainText(
        "Nothing was sent: another tab wrote this document after it was opened here, so this tab's changes cannot leave from here. " +
          "Close the other tab, then reopen the document here.",
      );
      await expect(first.locator("#doc-note")).not.toContainText(/try again in a moment/i);
      await expect(first.locator("#save-state"), "the share's flush was refused").toHaveAttribute("title", /another tab/, { timeout: 30_000 });
      expect(await matchedDigest(first, uuid), "nothing recorded as sent").toBe(matched);
      await context.close();
    }
  });
});
