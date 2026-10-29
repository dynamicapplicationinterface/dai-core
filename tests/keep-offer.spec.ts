import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { RUNNER_URL, addPasskeyProvider, appIn, buildNotes, currentOwner, openFile, pointAtStore, storedHolds, typeNote, uuidOf, waitMounted, withKeyStore } from "./owner.js";
import { serveOwnerStore, type ServedStore } from "./owner-store-memory.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The invitation, Build 2b-1 (R-Z sentence 3).
 *
 * After the first change a person makes lands in this browser, the status
 * pill reads "Saved in this browser · Keep?", in the box it has without the
 * offer, and covers nothing more of the document. Not after the document's
 * seed, a projection of another copy's changes, or the runtime's own
 * bookkeeping: the runtime says whether a save carries a change of this
 * author's (R-X, R-S). A tap on the pill opens the menu, whose first two rows
 * are "Keep beyond this browser" and "Not now"; the ceremony starts only from
 * the first. "Not now" is remembered for the browser context, and the offer
 * stays in the menu.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

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
 * far: the state an assertion that no offer is made depends on (tests/README.md,
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

test.describe("the invitation to keep beyond this browser (R-Z sentence 3)", () => {
  test.slow();
  // An opener offers to keep beyond this browser only with a store to keep in: these tests have one.
  let store: ServedStore;
  test.beforeAll(async () => {
    store = await serveOwnerStore();
  });
  test.afterAll(async () => {
    await store?.close();
  });

  test("an opener with no store offers nothing beyond this browser: no invitation after a change, no row, no ceremony; given a store, the row is there", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const file = await buildNotes(scratch, "Nowhere");
    await countCeremonies(page);
    await page.goto(RUNNER_URL);
    expect(await page.evaluate(() => (window as Any).__runner.keeping.base() ?? null), "this opener names no store").toBeNull();
    const app = await openFile(page, file);
    await typeNote(app, "kept nowhere else");
    await decidedForEverySave(page);
    await expect(page.locator("#save-state")).toHaveText("Saved in this browser");
    await expect(offer(page)).toHaveCount(0);

    await page.locator("#more").click();
    await expect(page.locator("#sheet")).toBeVisible();
    await expect(page.locator("#keep-beyond")).toBeHidden();
    await expect(page.locator("#keep-not-now")).toBeHidden();
    expect(await ceremonies(page)).toBe(0);
    expect(await currentOwner(page)).toBeNull();
    await page.keyboard.press("Escape");
    await expect(page.locator("#sheet")).toBeHidden();

    // The same page, given a store: keeping beyond this browser is something it can do, so the menu offers it.
    const store = await serveOwnerStore();
    try {
      await page.evaluate((base) => (window as Any).__runner.useStore(base), store.base);
      await page.locator("#more").click();
      await expect(page.locator("#keep-beyond")).toBeVisible();
    } finally {
      await store.close();
    }
  });

  test("a document opened and not touched, its seed and the runtime's bookkeeping saved, shows no invitation", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const file = await buildNotes(scratch, "Starter", true);
    await pointAtStore(page.context(), store.base);
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    await expect(app.locator("#note")).toHaveValue("starter");
    await decidedForEverySave(page);
    await expect(offer(page)).toBeHidden();
  });

  test("an app that writes back what it read as it opens, an echo, shows no invitation", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    // Not a change (R-X), but a write: the save after it is not the document's setup alone.
    const file = await buildNotes(scratch, "Echo", true, "UPDATE notes SET body = body WHERE id = 1");
    await pointAtStore(page.context(), store.base);
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    await expect(app.locator("#note")).toHaveValue("starter");
    await decidedForEverySave(page);
    await expect(offer(page)).toBeHidden();
  });

  test("a person who taps the field and changes nothing, while the app writes back what it shows, gets no invitation", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    // After a tap the page is used: what keeps this save from being an offer is that it carries no change (R-X).
    const file = await buildNotes(scratch, "Focus", true, "", "UPDATE notes SET body = body WHERE id = 1");
    await pointAtStore(page.context(), store.base);
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    await expect(app.locator("#note")).toHaveValue("starter");
    await decidedForEverySave(page);
    const before = await page.evaluate(() => (window as Any).__runner.savesWritten as number);
    await app.locator("#note").click();
    await expect.poll(() => page.evaluate(() => (window as Any).__runner.savesWritten as number), { timeout: 30_000 }).toBeGreaterThan(before);
    await decidedForEverySave(page);
    await expect(offer(page)).toBeHidden();

    await app.locator("#note").press("End");
    await app.locator("#note").pressSequentially(" and mine");
    await expect(offer(page)).toBeVisible({ timeout: 30_000 });
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
    await pointAtStore(context, store.base);
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
    await expect(offer(page)).toBeHidden();
    await expect.poll(() => app.locator("#note").evaluate(async () => ((await (window as Any).__db.query("SELECT body FROM notes WHERE id = 1"))[0] ?? {}).body)).toBe("from the other copy");
    await context.close();
  });

  test("the offer appears after the first change while typing goes on uninterrupted, and takes nothing from the field", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const file = await buildNotes(scratch, "Notes");
    await pointAtStore(page.context(), store.base);
    await page.goto(RUNNER_URL);
    const app = await openFile(page, file);
    const uuid = await uuidOf(page);
    const words = "the quick brown fox jumps over the lazy dog, twice over";
    // Where the document is before the offer: an offer that moves it moves what the person is about to tap.
    const before = await page.locator("#cartridge").boundingBox();
    // A key every 60 ms, about three seconds: the first save lands while the person is still typing.
    const typing = typeNote(app, words, 60);
    await expect(offer(page)).toBeVisible({ timeout: 30_000 });
    expect(await page.locator("#cartridge").boundingBox(), "the offer moves nothing").toEqual(before);
    expect(await app.locator("#note").evaluate((el) => el.ownerDocument.activeElement === el)).toBe(true);
    await typing;
    await expect(app.locator("#note")).toHaveValue(words);
    expect(await app.locator("#note").evaluate((el) => el.ownerDocument.activeElement === el)).toBe(true);
    await expect.poll(() => storedHolds(page, uuid, words), { timeout: 30_000 }).toBe(true);

    await expect(offer(page)).toHaveText(OFFER);
    // The status pill, not a sheet: in the bar, nothing modal.
    expect(await offer(page).evaluate((el) => [el.closest("header") !== null, el.closest("[aria-modal='true']")])).toEqual([true, null]);
  });

  test("after Not now, a second document in the same browser context shows no invitation, and the offer stays in the menu", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const first = await buildNotes(scratch, "First");
    const second = await buildNotes(scratch, "Second");
    const context = await browser.newContext();
    await pointAtStore(context, store.base);
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    let app = await openFile(page, first);
    await typeNote(app, "one");
    await expect(offer(page)).toBeVisible({ timeout: 30_000 });
    await offer(page).click();
    await page.locator("#keep-not-now").click();
    await expect(offer(page)).toBeHidden();
    await expect(page.locator("#save-state")).toHaveText("Saved in this browser");

    // The opener resumes the first document on load; the second is picked once that has landed.
    await page.goto(RUNNER_URL);
    await waitMounted(page, first);
    app = await openFile(page, second);
    const uuid = await uuidOf(page);
    await typeNote(app, "two");
    await expect.poll(() => storedHolds(page, uuid, "two"), { timeout: 30_000 }).toBe(true);
    await decidedForEverySave(page);
    await expect(offer(page)).toBeHidden();

    await page.locator("#more").click();
    await expect(page.locator("#keep-beyond")).toBeVisible();
    await context.close();
  });

  test("no ceremony starts when the offer appears, nor on the tap that opens the menu; one starts on the menu's row", async ({ browser, browserName }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const file = await buildNotes(scratch, "Notes");
    const context = await browser.newContext();
    await pointAtStore(context, store.base);
    const page = await context.newPage();
    await countCeremonies(page);
    await page.goto(RUNNER_URL);
    // Where a passkey can be made here, it is: the tap then enrolls. Elsewhere the ceremony starts and is refused.
    if (browserName === "chromium") await addPasskeyProvider(context, page);
    const app = await openFile(page, file);
    // Playwright's WebKit here has PublicKeyCredential but no navigator.credentials, so no ceremony can start:
    // there the second tap's mark is the host's refusal, said only after it.
    const passkeys = await page.evaluate(() => "PublicKeyCredential" in window && typeof navigator.credentials?.create === "function");
    const noPasskeys = page.locator("#doc-note", { hasText: "This browser cannot make a passkey." });
    await typeNote(app, "worth keeping");
    await expect(offer(page)).toBeVisible({ timeout: 30_000 });
    await decidedForEverySave(page);
    expect(await ceremonies(page)).toBe(0);
    await expect(noPasskeys).toBeHidden();
    expect(await currentOwner(page)).toBeNull();

    // Two taps, neither on the document: the pill, then the menu's first row.
    await offer(page).click();
    await expect(page.locator("#sheet")).toBeVisible();
    expect(await ceremonies(page)).toBe(0);
    await expect(noPasskeys).toBeHidden();
    for (const target of ["#save-state", "#keep-beyond"]) {
      const box = (await page.locator(target).boundingBox())!;
      const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? null, [box.x + box.width / 2, box.y + box.height / 2] as const);
      expect(top, `${target} is the host's, not the document's`).not.toBe("cartridge");
    }
    await page.locator("#keep-beyond").click();
    if (passkeys) await expect.poll(() => ceremonies(page)).toBe(1);
    else await expect(noPasskeys).toBeVisible();
    await expect(offer(page)).toBeHidden();
    if (browserName === "chromium") await expect.poll(() => currentOwner(page), { timeout: 30_000 }).not.toBeNull();
    await context.close();
  });

  test("with an owner signed in here, a first change brings no offer", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "a passkey with PRF is Chromium's virtual authenticator");
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const file = await buildNotes(scratch, "Notes");
    const context = await browser.newContext();
    await pointAtStore(context, store.base);
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await addPasskeyProvider(context, page);
    const app = await openFile(page, file);
    // Enrolled from the menu before any change: no offer stood, so none was answered, and the owner is what holds it back.
    await page.locator("#more").click();
    await page.locator("#keep-beyond").click();
    await expect.poll(() => currentOwner(page), { timeout: 30_000 }).not.toBeNull();
    expect(await withKeyStore(page, 'return (await get("dai:keep-offer")) ?? null;'), "the offer was never answered").toBeNull();

    const before = await page.evaluate(() => (window as Any).__runner.savesWritten as number);
    const offered: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("keep offer")) offered.push(message.text());
    });
    const uuid = await uuidOf(page);
    await typeNote(app, "mine");
    await expect.poll(() => page.evaluate(() => (window as Any).__runner.savesWritten as number), { timeout: 30_000 }).toBeGreaterThan(before);
    // Every key's save written and decided, not only the first.
    await expect.poll(() => storedHolds(page, uuid, "mine"), { timeout: 30_000 }).toBe(true);
    await decidedForEverySave(page);
    await expect(offer(page)).toHaveCount(0);
    // With a store the change is kept, so the words are the status's, whichever it has reached, and never carry the offer.
    await expect(page.locator("#save-state")).not.toContainText("Keep?");
    expect(offered.some((text) => text.includes("an owner is signed in")), offered.join("\n")).toBe(true);
    await context.close();
  });

  test("a tap that lands before the seed's first save is the person's change: the offer and the status follow it, not the next one", async ({ page }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const taps = await buildTaps(scratch, "Taps");
    await pointAtStore(page.context(), store.base);
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", taps.file);
    const app = appIn(page);
    const card = page.locator("#card-open");
    await Promise.race([card.waitFor({ timeout: 60_000 }), app.locator("#tap").waitFor({ timeout: 60_000 })]);
    if (await card.isVisible()) await card.click();
    // At once, as the control shows: no save asked yet, so the seed has not been captured on its own.
    await app.locator("#tap").click();
    const askedAtTap = await page.evaluate(() => (window as Any).__runner.saves as number);
    expect(askedAtTap, "the tap came before the seed's save was asked").toBe(0);
    await expect(app.locator("#count")).toHaveText("1", { timeout: 30_000 });
    // The tap's write saved, nothing pending: the frame says "saved" only once every write is written.
    await expect(page.locator("#save-state[data-state='saved']")).toHaveCount(1, { timeout: 30_000 });
    await decidedForEverySave(page);
    // No second tap: what the first one brought.
    await expect(offer(page)).toHaveText(OFFER);
    await expect(page.locator("#save-state[data-shown]")).toBeVisible();
  });

  test("an offer standing in one tab is withdrawn when an owner enrolls in another tab of the same browser context", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "a passkey with PRF is Chromium's virtual authenticator");
    const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
    const first = await buildNotes(scratch, "First");
    const second = await buildNotes(scratch, "Second");
    const context = await browser.newContext();
    await pointAtStore(context, store.base);
    const one = await context.newPage();
    await one.goto(RUNNER_URL);
    await typeNote(await openFile(one, first), "first");
    await expect(offer(one)).toHaveText(OFFER, { timeout: 30_000 });

    // A second tab: it resumes the first document, then a second one is picked, changed, and kept beyond from its offer.
    const two = await context.newPage();
    await two.goto(RUNNER_URL);
    await addPasskeyProvider(context, two);
    await waitMounted(two, first);
    await typeNote(await openFile(two, second), "second");
    await expect(offer(two)).toBeVisible({ timeout: 30_000 });
    await offer(two).click();
    await two.locator("#keep-beyond").click();
    await expect.poll(() => currentOwner(two), { timeout: 30_000 }).not.toBeNull();

    // The first tab, untouched since: an owner is signed in, so the offer is gone, and the pill says where the work is.
    await expect(offer(one)).toHaveCount(0, { timeout: 10_000 });
    await expect(one.locator("#save-state")).toHaveText("Saved in this browser");
    await one.locator("#more").click();
    await expect(one.locator("#sheet")).toBeVisible();
    await expect(one.locator("#keep-not-now")).toBeHidden();
    await expect(one.locator("#keep-beyond")).toBeHidden();
    await context.close();
  });

  for (const [width, viewport] of [["phone", { width: 390, height: 700 }], ["desktop", { width: 1280, height: 720 }]] as const)
    test(`at ${width} width the offer is the status pill: the document keeps every tap, and nothing outside the pill opens anything`, async ({ browser }) => {
      const scratch = mkdtempSync(join(tmpdir(), "dai-offer-"));
      const taps = await buildTaps(scratch, "Taps");
      const context = await browser.newContext({ viewport });
      await pointAtStore(context, store.base);
      const page = await context.newPage();
      await countCeremonies(page);
      await page.goto(RUNNER_URL);
      const app = await openTaps(page, taps);
      const before = await page.locator("#cartridge").boundingBox();
      const control = (await app.locator("#tap").boundingBox())!;
      const centre = [control.x + control.width / 2, control.y + control.height / 2] as const;

      // The first change, a kit-handled tap on the application's own bottom control, its save written and decided.
      await decidedForEverySave(page);
      const seedSaves = await page.evaluate(() => (window as Any).__runner.savesWritten as number);
      await page.mouse.click(...centre);
      await expect(app.locator("#count")).toHaveText("1", { timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => (window as Any).__runner.savesWritten as number), { timeout: 30_000 }).toBeGreaterThan(seedSaves);
      await decidedForEverySave(page);
      expect(await page.locator("#cartridge").boundingBox(), "the offer moves nothing").toEqual(before);
      expect(await app.locator("#tap").boundingBox()).toEqual(control);

      // What is on top, the offer up: the document everywhere but the pill and the menu button.
      const shown = await page.locator("#save-state").boundingBox();
      const menu = (await page.locator("#more").boundingBox())!;
      const host = shown ? { "save-state": shown, more: menu } : { more: menu };
      expect(await whatCovers(page, [0, 0, viewport.width, viewport.height], 8, host), "the host over the document").toEqual([]);
      const pill = shown!;
      expect(await whatCovers(page, [control.x, control.y, control.width, control.height], 4, {}), "the bottom control's points").toEqual([]);
      await expect(offer(page)).toHaveText(OFFER);

      // Taps on the document, the control and just past each edge of the pill, open nothing.
      await page.mouse.click(...centre);
      await expect(app.locator("#count")).toHaveText("2", { timeout: 30_000 });
      const pastEdges = [
        [pill.x - 2, pill.y + pill.height / 2],
        [pill.x + pill.width + 2, pill.y + pill.height / 2],
        [pill.x + pill.width / 2, Math.max(1, pill.y - 2)],
        [pill.x + pill.width / 2, pill.y + pill.height + 2],
      ] as const;
      for (const [x, y] of pastEdges) await page.mouse.click(x, y);
      await expect(page.locator("[role='dialog']:visible")).toHaveCount(0);
      expect(await ceremonies(page)).toBe(0);
      await expect(offer(page)).toHaveText(OFFER);

      // The pill opens the menu, whose first two rows answer the offer; nothing starts yet.
      await page.mouse.click(pill.x + pill.width / 2, pill.y + pill.height / 2);
      await expect(page.locator("#sheet")).toBeVisible();
      expect((await sheetRows(page)).slice(0, 2)).toEqual(["keep-beyond", "keep-not-now"]);
      expect(await ceremonies(page)).toBe(0);
      await page.locator("#keep-not-now").click();
      await expect(page.locator("#sheet")).toBeHidden();
      await expect(page.locator("#save-state")).toHaveText("Saved in this browser");
      await expect(offer(page)).toHaveCount(0);
      const plain = (await page.locator("#save-state").boundingBox())!;
      expect(pill.width, "the pill is no wider with the offer").toBeLessThanOrEqual(plain.width + 0.5);
      expect(pill.height, "and no taller").toBeLessThanOrEqual(plain.height + 0.5);
      expect(await ceremonies(page)).toBe(0);
      await context.close();
    });
});

const OFFER = "Saved in this browser · Keep?";
const offer = (page: Page) => page.locator("#save-state[data-offer]");

/** The menu's rows, as a person sees them, top to bottom. */
const sheetRows = (page: Page): Promise<string[]> =>
  page.locator("#sheet .sheet-panel > button:visible").evaluateAll((els) =>
    els
      .map((el) => [el.id, el.getBoundingClientRect().top] as const)
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id),
  );

/**
 * Every point of `area`, on a grid of `step` px, whose top element is not the
 * document's frame, unless it falls in one of `allowed` and is that element:
 * where the host is over the document.
 */
function whatCovers(page: Page, area: readonly number[], step: number, allowed: Record<string, { x: number; y: number; width: number; height: number }>): Promise<string[]> {
  return page.evaluate(
    ([[x0, y0, w, h], by, boxes]) => {
      const over: string[] = [];
      for (let y = y0! + by / 2; y < y0! + h!; y += by)
        for (let x = x0! + by / 2; x < x0! + w!; x += by) {
          const el = document.elementFromPoint(x, y);
          if (el?.id === "cartridge") continue;
          const ok = Object.entries(boxes).some(
            // A pixel either way: hit testing snaps to device pixels, a box's edges need not.
            ([id, b]) => x >= b.x - 1 && x <= b.x + b.width + 1 && y >= b.y - 1 && y <= b.y + b.height + 1 && el?.closest(`#${id}`),
          );
          if (!ok) over.push(`${Math.round(x)},${Math.round(y)} ${el ? `${el.tagName}#${el.id}` : "none"}`);
        }
      return over;
    },
    [area, step, allowed] as const,
  );
}

/**
 * A kit app whose one control is fixed along the bottom edge, 56 px tall, as a
 * phone app's bar is: a seeded counter, and a tap on the control adds one.
 */
async function buildTaps(scratch: string, name: string): Promise<{ file: string; uuid: string }> {
  const src = join(scratch, name, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "schema.sql"), "CREATE TABLE IF NOT EXISTS taps (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);\n");
  writeFileSync(
    join(src, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body style="margin:0">\n` +
      `<script type="application/sql">INSERT OR IGNORE INTO taps (id, n) VALUES (1, 0);</script>\n` +
      `<p>count: <dai-value id="count" query="SELECT n FROM taps WHERE id = 1"></dai-value></p>\n` +
      `<dai-rows query="SELECT id FROM taps WHERE id = 1"><template><button id="tap" style="position:fixed;left:0;right:0;bottom:0;height:56px;font-size:18px" data-run="UPDATE taps SET n = n + 1 WHERE id = :id">Add one</button></template></dai-rows>\n` +
      `<script type="module" src="./dai-kit.js"></script>\n</body></html>\n`,
  );
  const uuid = randomUUID();
  const compiled = await compileDirectory({ sourceDir: src, root: repo, appName: name, documentUuid: uuid });
  const file = join(scratch, `${name}.dai.html`);
  writeFileSync(file, compiled.html, "utf8");
  return { file, uuid };
}

/** Opens the counter and waits until it, and no other document, shows its count and its control. */
async function openTaps(page: Page, taps: { file: string; uuid: string }): Promise<FrameLocator> {
  await page.setInputFiles("#file", taps.file);
  const app = appIn(page);
  await expect
    .poll(
      async () => {
        const card = page.locator("#card-open");
        if (await card.isVisible()) await card.click();
        if ((await page.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null)) !== taps.uuid) return "another document";
        const count = await app.locator("#count").textContent({ timeout: 500 }).catch(() => null);
        const control = await app.locator("#tap").isVisible({ timeout: 500 }).catch(() => false);
        return count === "0" && control ? "mounted" : "waiting";
      },
      { timeout: 60_000 },
    )
    .toBe("mounted");
  return app;
}

