import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * The shared examples, used the way the documentation says they work.
 *
 * These are the applications the model file hands a model as the complete
 * example of a passable and a session document. An example that teaches a
 * pattern which does not work in the real host would teach it to every
 * application written from it, so each is compiled by the real compiler,
 * opened in the real host on separate devices, and driven by clicking —
 * with the rows travelling by file, as they do between two people.
 */

function appIn(page: Page): FrameLocator {
  return page.frameLocator("iframe").frameLocator("iframe");
}

async function build(dir: string, name: string, scratch: string): Promise<string> {
  const built = await compileDirectory({ sourceDir: join(repo, dir), root: repo, appName: name });
  const file = join(scratch, `${name.replace(/\W+/g, "-").toLowerCase()}.dai.html`);
  writeFileSync(file, built.html, "utf8");
  return file;
}

/** Saves this copy out as a file, down the download route a browser without a picker takes. */
async function saveOut(page: Page, to: string): Promise<string> {
  await page.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.evaluate(() =>
    (window as unknown as { __runner: { exportContainer(): Promise<void> } }).__runner.exportContainer(),
  );
  const download = await downloading;
  writeFileSync(to, readFileSync(await download.path()));
  return to;
}

/** Opens a document this device has never seen. */
async function firstOpen(page: Page, file: string, ready: string): Promise<FrameLocator> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").waitFor({ timeout: 60_000 });
  await page.locator("#card-open").click();
  const app = appIn(page);
  await expect(app.locator(ready)).toBeVisible({ timeout: 60_000 });
  return app;
}

/** Brings another copy's rows into this one. The first merge on a device asks; later ones do not. */
async function mergeIn(page: Page, file: string, first: boolean): Promise<void> {
  await page.setInputFiles("#file", file);
  if (first) {
    await expect(page.locator("#card-merge")).toBeVisible({ timeout: 60_000 });
    await page.locator("#card-merge").click();
  }
}

async function devices(browser: import("@playwright/test").Browser, count: number): Promise<{ contexts: BrowserContext[]; pages: Page[] }> {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (let index = 0; index < count; index += 1) {
    const context = await browser.newContext({ acceptDownloads: true });
    contexts.push(context);
    const page = await context.newPage();
    // Every frame's console, when asked for: an application that never starts
    // says why only there.
    if (process.env.DAI_EXAMPLES_DEBUG) {
      page.on("console", (message) => process.stdout.write(`[device ${index} console.${message.type()}] ${message.text()}\n`));
      page.on("pageerror", (error) => process.stdout.write(`[device ${index} pageerror] ${error.message}\n`));
    }
    pages.push(page);
  }
  return { contexts, pages };
}

test.describe("receipts, a passable document", () => {
  test.slow();

  test("both copies' receipts are kept, totals are derived, and an edit made on both is settled by the person", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-receipts-"));
    const container = await build("examples/receipts", "Receipts", scratch);
    const { contexts, pages } = await devices(browser, 2);
    const [pageA, pageB] = pages as [Page, Page];

    const addReceipt = async (app: FrameLocator, store: string, amount: string, paidBy: string): Promise<void> => {
      await app.locator("#store").fill(store);
      await app.locator("#amount").fill(amount);
      await app.locator("#paid-by").fill(paidBy);
      await app.locator("#save-entry").click();
      await expect(app.locator("#list")).toContainText(store, { timeout: 30_000 });
    };

    const appA = await firstOpen(pageA, container, "#entry");
    // Ready means app.js has run (its handlers attach after openDatabase), not
    // that the static form is showing; resetForm() fills in today's date.
    await expect(appA.locator("#spent-on")).not.toHaveValue("", { timeout: 60_000 });
    await addReceipt(appA, "Grocer", "30", "Ada");
    const a1 = await saveOut(pageA, join(scratch, "a1.dai.html"));

    const appB = await firstOpen(pageB, a1, "#entry");
    await expect(appB.locator("#spent-on")).not.toHaveValue("", { timeout: 60_000 });
    await expect(appB.locator("#list")).toContainText("Grocer", { timeout: 30_000 });
    await addReceipt(appB, "Hardware", "10", "Bo");
    // Derived from both rows: nothing about the balance is stored.
    await expect(appB.locator("#balance")).toContainText("$40.00 spent");
    await expect(appB.locator("#balance")).toContainText("Ada paid $30.00 · is owed $10.00");
    const b1 = await saveOut(pageB, join(scratch, "b1.dai.html"));

    // A's copy redraws on dai:merged, without a reload.
    await mergeIn(pageA, b1, true);
    await expect(appA.locator("#list")).toContainText("Hardware", { timeout: 60_000 });
    await expect(appA.locator("#balance")).toContainText("$40.00 spent");

    // The same receipt edited on both copies before they meet.
    const edit = async (app: FrameLocator, amount: string): Promise<void> => {
      await app.locator(".receipt", { hasText: "Grocer" }).getByRole("button", { name: "Edit" }).click();
      await app.locator("#amount").fill(amount);
      await app.locator("#save-entry").click();
      await expect(app.locator(".receipt", { hasText: "Grocer" })).toContainText(`$${amount}.00`, { timeout: 30_000 });
    };
    await edit(appA, "35");
    await edit(appB, "32");
    const b2 = await saveOut(pageB, join(scratch, "b2.dai.html"));

    await mergeIn(pageA, b2, false);
    const grocer = appA.locator(".receipt", { hasText: "Grocer" });
    const choose = grocer.getByRole("button", { name: /Changed twice/ });
    await expect(choose).toBeVisible({ timeout: 60_000 });
    await choose.click();
    await expect(appA.locator("#versions li")).toHaveCount(2);
    await appA.locator("#versions li", { hasText: "$32.00" }).getByRole("button", { name: "Keep this" }).click();
    await expect(grocer).toContainText("$32.00", { timeout: 30_000 });
    await expect(grocer.getByRole("button", { name: /Changed twice/ })).toHaveCount(0);

    for (const context of contexts) await context.close();
  });
});

test.describe("receipts keeps what a person is typing when rows arrive", () => {
  test.slow();

  test("a half-finished edit survives the other copy's receipts being merged in", async ({ browser }) => {
    // SHARED-REDRAW-ON-MERGE: a redraw must not discard work in progress. A blind
    // candidate rebuilt its editor on every merge and lost what was being typed;
    // the receipts form is written once in the HTML, so a redraw leaves it alone.
    const scratch = mkdtempSync(join(tmpdir(), "dai-receipts-draft-"));
    const container = await build("examples/receipts", "Receipts", scratch);
    const { contexts, pages } = await devices(browser, 2);
    const [pageA, pageB] = pages as [Page, Page];

    // Ready means app.js has run, not that the static form is visible: its
    // handlers attach only after openDatabase resolves, and resetForm() is what
    // fills in today's date.
    const ready = (app: FrameLocator) => expect(app.locator("#spent-on")).not.toHaveValue("", { timeout: 60_000 });

    const appA = await firstOpen(pageA, container, "#entry");
    await ready(appA);
    await appA.locator("#store").fill("Grocer");
    await appA.locator("#amount").fill("30");
    await appA.locator("#paid-by").fill("Ada");
    await appA.locator("#save-entry").click();
    await expect(appA.locator("#list")).toContainText("Grocer", { timeout: 30_000 });
    const a1 = await saveOut(pageA, join(scratch, "a1.dai.html"));

    const appB = await firstOpen(pageB, a1, "#entry");
    await ready(appB);
    await expect(appB.locator("#list")).toContainText("Grocer", { timeout: 30_000 });
    // A adds a receipt B has not seen. Union merge needs no common ancestry
    // beyond the document, so B can take A's copy directly.
    await appA.locator("#store").fill("Hardware");
    await appA.locator("#amount").fill("10");
    // Paid by is required, and resetForm() sets it back to this copy's name,
    // which nobody set here — so it is filled each time, as addReceipt does.
    await appA.locator("#paid-by").fill("Ada");
    await appA.locator("#save-entry").click();
    await expect(appA.locator("#list")).toContainText("Hardware", { timeout: 30_000 });
    const a2 = await saveOut(pageA, join(scratch, "a2.dai.html"));

    // B is halfway through editing Grocer when A's receipt arrives.
    await appB.locator(".receipt", { hasText: "Grocer" }).getByRole("button", { name: "Edit" }).click();
    await appB.locator("#amount").fill("31.75");
    await mergeIn(pageB, a2, true);
    await expect(appB.locator("#list")).toContainText("Hardware", { timeout: 60_000 });
    await expect(appB.locator("#amount")).toHaveValue("31.75");
    await expect(appB.locator("#save-entry")).toHaveText("Save changes");

    for (const context of contexts) await context.close();
  });
});

test.describe("nothing a person does while the app is opening is lost", () => {
  test.slow();

  /*
   * NO-INPUT-LOST-WHILE-OPENING. The window between the page appearing and
   * app.js finishing its start-up is milliseconds under a host, and the full
   * rules wait — about ten seconds — when a shared document is opened with no
   * host at all. That long window makes the moment deterministic to test.
   */
  async function openWithoutHost(page: Page, file: string): Promise<FrameLocator> {
    await page.goto(pathToFileURL(file).href);
    await page.locator("body.dai-mounted").waitFor({ timeout: 30_000 });
    const app = page.frameLocator("#dai-app");
    await app.locator("body").evaluate(() => {
      (window as unknown as { __stillHere: boolean }).__stillHere = true;
    });
    return app;
  }
  const stillHere = (app: FrameLocator): Promise<boolean> =>
    app.locator("body").evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere === true);

  test("while opening there is nothing to type into, and the page is never reloaded", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-opening-"));
    const container = await build("examples/receipts", "Receipts", scratch);
    const app = await openWithoutHost(page, container);

    await expect(app.locator("#opening")).toBeVisible();
    await expect(app.locator("#entry")).toBeHidden();
    // A person trying anyway: keys reach nothing that can submit.
    await page.keyboard.type("Grocer");
    await page.keyboard.press("Enter");

    // Started: the form appears, live and empty, in the same page it began in.
    await expect(app.locator("#entry")).toBeVisible({ timeout: 30_000 });
    await expect(app.locator("#opening")).toBeHidden();
    expect(await stillHere(app), "the app frame was reloaded").toBe(true);
    await expect(app.locator("#store")).toHaveValue("");
  });

  test("without the gate, a submit in that window reloads the app and loses what was typed", async ({ page }) => {
    // The same example with the gate taken out — the pattern both blind
    // candidates copied. Kept as the demonstration that the test above can fail.
    const ungated = mkdtempSync(join(tmpdir(), "dai-ungated-"));
    cpSync(join(repo, "examples", "receipts"), ungated, { recursive: true });
    const index = join(ungated, "index.html");
    const before = readFileSync(index, "utf8");
    const after = before.replace('<main id="app" hidden>', '<main id="app">');
    expect(after, "the gate was removed").not.toBe(before);
    writeFileSync(index, after);
    const built = await compileDirectory({ sourceDir: ungated, root: repo, appName: "Receipts" });
    const container = join(mkdtempSync(join(tmpdir(), "dai-ungated-out-")), "receipts.dai.html");
    writeFileSync(container, built.html, "utf8");

    const app = await openWithoutHost(page, container);
    await expect(app.locator("#entry")).toBeVisible();
    await app.locator("#store").fill("Grocer");
    await app.locator("#amount").fill("30");
    await app.locator("#paid-by").fill("Ada");
    await app.locator("#spent-on").fill("2026-09-13");
    await app.locator("#store").press("Enter");

    /*
     * The loss arrives by one of two routes, and which depends on the engine:
     * the browser submits the form itself and the frame is replaced, or the
     * press is ignored and app.js, once it has started, resets the form. Either
     * way what was typed is gone and nothing was added — which is what is
     * asserted. The route taken is printed, because it is the finding.
     */
    let outcome = "waiting";
    await expect
      .poll(
        async () => {
          if (!(await stillHere(app).catch(() => false))) return (outcome = "the frame was replaced");
          if (!(await app.locator("#empty").isVisible().catch(() => false))) return (outcome = "waiting");
          const typed = await app.locator("#store").inputValue();
          const listed = await app.locator("#list").innerText();
          return (outcome = typed === "" && !listed.includes("Grocer") ? "the press was ignored and start-up cleared the form" : "kept");
        },
        { timeout: 30_000 },
      )
      .toMatch(/replaced|cleared/);
    process.stdout.write(`[${test.info().project.name}] ungated submit while opening: ${outcome}\n`);
  });
});

test.describe("tic-tac-toe, a session document", () => {
  test.slow();

  test("the invitee takes the open seat, marks cross both ways, and a forwarded copy cannot play", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-ttt-"));
    const container = await build("examples/tic-tac-toe", "Tic-tac-toe", scratch);
    const { contexts, pages } = await devices(browser, 4);
    const [pageA, pageB, pageC, pageD] = pages as [Page, Page, Page, Page];
    const cell = (app: FrameLocator, index: number) => app.locator("#board .cell").nth(index);

    // A starts a game and, as X, moves before anybody has joined.
    const appA = await firstOpen(pageA, container, "#new-game");
    await appA.locator("#you").fill("Ada");
    await appA.locator("#them").fill("Bo");
    await appA.locator("#new-game button[type=submit]").click();
    await expect(appA.locator("#status")).toContainText("Your move, Ada. Then send the invite.", { timeout: 30_000 });
    await cell(appA, 0).click();
    await expect(cell(appA, 0)).toHaveText("X");
    const a1 = await saveOut(pageA, join(scratch, "a1.dai.html"));

    // B opens the invite: joins at start-up, sees X's mark, and plays O.
    const appB = await firstOpen(pageB, a1, "#play");
    await expect(appB.locator("#status")).toContainText("Your move, Bo.", { timeout: 30_000 });
    await expect(cell(appB, 0)).toHaveText("X");
    await cell(appB, 4).click();
    await expect(cell(appB, 4)).toHaveText("O");
    await expect(appB.locator("#status")).toContainText("Ada's move");
    const b1 = await saveOut(pageB, join(scratch, "b1.dai.html"));

    // A's copy redraws when B's mark arrives.
    await mergeIn(pageA, b1, true);
    await expect(cell(appA, 4)).toHaveText("O", { timeout: 60_000 });
    await expect(appA.locator("#status")).toContainText("Your move, Ada.");

    // C holds B's copy but was never invited: the seat is taken, and C is told so.
    const appC = await firstOpen(pageC, b1, "#play");
    await expect(appC.locator("#seat-text")).toContainText("you have not been invited into it", { timeout: 30_000 });
    await expect(cell(appC, 8)).toBeDisabled();

    // D opens A's original invite too: two replicas bind one seat, which admits neither.
    const appD = await firstOpen(pageD, a1, "#play");
    await expect(appD.locator("#status")).toContainText(/Your move, Bo|not playing/, { timeout: 30_000 });
    const d1 = await saveOut(pageD, join(scratch, "d1.dai.html"));
    await mergeIn(pageA, d1, false);
    await expect(appA.locator("#seat-text")).toContainText("Two people opened this invite", { timeout: 60_000 });
    await expect(appA.locator("#reseat")).toBeVisible();

    for (const context of contexts) await context.close();
  });
});
