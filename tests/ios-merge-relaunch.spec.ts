import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { HINT_KEY } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/**
 * A move folded into this device's copy on a cold launch, on an iPhone.
 *
 * `openThenMerge` opens this device's copy and merges the arriving one into it
 * once the frame is up. On iOS away from the document's address it also has
 * to reload there, and the move exists only in this page until it is saved.
 * So the merge is rehearsed like a first open: mounted behind the launch
 * screen, merged, saved, and only then loaded at the address, where the merged
 * copy is drawn. A reload that ran ahead of the save would draw the copy
 * without the move. A merge that does not land does not reload at all: the
 * copy is shown as it was, and one sentence says so (review of 454e2db, Q1.4
 * and Q1.5).
 *
 * WebKit only: the iPhone's path.
 */
test.skip(({ browserName }) => browserName !== "webkit", "the iOS merge reload is an iPhone's: WebKit only");

const appIn = (page: Page): FrameLocator => page.frameLocator("#cartridge").frameLocator("#dai-app");

async function built(): Promise<{ file: string; uuid: string }> {
  const out = await compileDirectory({
    sourceDir: join(repo, "examples", "tic-tac-toe"),
    root: repo,
    appName: "Tic-tac-toe",
  });
  const file = join(mkdtempSync(join(tmpdir(), "dai-ios-merge-")), "ttt.dai.html");
  writeFileSync(file, out.html, "utf8");
  return { file, uuid: out.manifest.documentUuid };
}

/** Opens a document this device has never seen, pressing the card as a person does. */
async function firstOpen(page: Page, file: string): Promise<void> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").waitFor({ timeout: 60_000 });
  await page.locator("#card-open").click();
}

/** An iPhone holding its own copy, back on the bare opener with nothing open: a cold launch. */
async function iphoneHolding(browser: Browser, file: string): Promise<Page> {
  const device = await browser.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });
  const page = await device.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "iPhone", configurable: true });
  });
  await firstOpen(page, file);
  await expect(page.locator("#sheet-arrival")).toContainText("iOS reload: taken on the load before this one", {
    timeout: 60_000,
  });
  await expect(appIn(page).locator("#new-game")).toBeVisible({ timeout: 60_000 });
  // Nothing resumed: the next visit is the chooser, with nothing mounted.
  await page.evaluate(() => localStorage.removeItem("dai:resume"));
  await page.goto(RUNNER_URL);
  await expect(page.locator("body")).not.toHaveClass(/loaded/);
  return page;
}

const mergeInto = (page: Page, uuid: string, bytes: number[]): Promise<void> =>
  page.evaluate(
    ([id, data]) =>
      (
        window as unknown as { __runner: { openThenMerge(u: string, b: number[]): Promise<void> } }
      ).__runner.openThenMerge(id, data),
    [uuid, bytes] as const,
  );

test.describe("a move merged into a held copy on an iPhone", () => {
  test.slow();

  test("is saved before the page reloads, and drawn at the document's address", async ({ browser }) => {
    const { file, uuid } = await built();

    // Somebody else's copy, with a game started and a move made.
    const other = await browser.newContext();
    const theirs = await other.newPage();
    await firstOpen(theirs, file);
    const app = appIn(theirs);
    await expect(app.locator("#new-game")).toBeVisible({ timeout: 60_000 });
    await app.locator("#you").fill("Ada");
    await app.locator("#them").fill("Bo");
    await app.locator("#new-game button[type=submit]").click();
    await app.locator("#board .cell").nth(0).click();
    await expect(app.locator("#board .cell").nth(0)).toHaveText("X");
    const bytes = await expect
      .poll(
        () =>
          theirs.evaluate(async (id) => {
            const runner = (window as unknown as { __runner: { loadStored(u: string): Promise<Uint8Array | null> } })
              .__runner;
            const stored = await runner.loadStored(id);
            return stored ? Array.from(stored) : [];
          }, uuid),
        { timeout: 30_000 },
      )
      .not.toHaveLength(0)
      .then(() =>
        theirs.evaluate(async (id) => {
          const runner = (window as unknown as { __runner: { loadStored(u: string): Promise<Uint8Array | null> } })
            .__runner;
          return Array.from((await runner.loadStored(id)) ?? []);
        }, uuid),
      );

    const page = await iphoneHolding(browser, file);
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });
    // Seen by the page itself at the moment the move is folded in, and carried
    // across the reload: whether anything a person could use was on screen.
    await page.addInitScript(() => {
      const info = console.info.bind(console);
      console.info = (...args: unknown[]) => {
        if (String(args[0]).startsWith("dai: pending merge applied")) {
          sessionStorage.setItem("test:covered-when-merged", String(document.body.classList.contains("booting")));
        }
        info(...args);
      };
    });
    await page.reload();
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
    loads = 0;

    await mergeInto(page, uuid, bytes);

    // The load at the address, drawn with the move in it.
    await expect(page.locator("#sheet-arrival")).toContainText("iOS reload: taken on the load before this one", {
      timeout: 60_000,
    });
    expect(page.url()).toMatch(new RegExp(`[#&]${HINT_KEY}=${uuid}`));
    await expect(
      appIn(page).locator("#board .cell").nth(0),
      "the move was saved before the reload, so the drawn copy has it",
    ).toHaveText("X", { timeout: 60_000 });
    await page.waitForTimeout(2_000);
    expect(loads, "one reload, after the save").toBe(1);
    const covered = await page.evaluate(() => sessionStorage.getItem("test:covered-when-merged"));
    expect(covered, "behind the launch screen while the move was folded in").toBe("true");

    await other.close();
    await page.context().close();
  });

  test("a move that does not land does not reload, and says so in one sentence", async ({ browser }) => {
    const { file, uuid } = await built();
    const page = await iphoneHolding(browser, file);
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });

    // Not a database: the merge is refused, which is a merge that gave up.
    await mergeInto(page, uuid, [1, 2, 3, 4]);

    await expect(page.locator("#doc-note")).toHaveText(
      "The move that arrived couldn't be added to your copy, so your copy is as it was.",
      { timeout: 30_000 },
    );
    await expect(page.locator("body"), "the copy is shown, not left behind the launch screen").not.toHaveClass(
      /booting/,
    );
    await expect(appIn(page).locator("#new-game")).toBeVisible();
    await page.waitForTimeout(3_000);
    expect(loads, "no reload for a move that did not land").toBe(0);
    await expect(page.locator("#sheet-arrival")).toContainText("iOS reload: not taken: the arriving move was not applied");

    await page.context().close();
  });

  test("a frame that never answers leaves a cover with a way off it", async ({ browser }) => {
    /*
     * The merge waits on the frame's handshake, and can wait on one that never
     * comes. The launch screen stood over that wait with no way off: `mount`
     * clears the launch guard, and nothing armed it again (cold review of
     * c424598, Q2.1). Now the cover carries Tap to open, and tapping it shows
     * the copy as it stands with the sentence that says the move did not land.
     */
    const { file, uuid } = await built();
    const page = await iphoneHolding(browser, file);
    // A frame whose handshake never reaches the host: the merge waits for ever.
    await page.addInitScript(() => {
      (window as unknown as { __daiTimers: { launchStallMs: number } }).__daiTimers = { launchStallMs: 1000 };
      const add = window.addEventListener.bind(window);
      window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
        if (type !== "message") return add(type, listener, options as AddEventListenerOptions);
        const filtered = (event: Event): void => {
          const data = (event as MessageEvent).data as { type?: string } | null;
          if (data && data.type === "DAI_HOST_HANDSHAKE") return;
          (listener as EventListener)(event);
        };
        return add(type, filtered, options as AddEventListenerOptions);
      }) as typeof window.addEventListener;
    });
    await page.reload();
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });

    await mergeInto(page, uuid, [1, 2, 3, 4]);

    // The cover, and then a way off it.
    await expect(page.locator("body"), "behind the launch screen while it waits").toHaveClass(/booting/, {
      timeout: 30_000,
    });
    await expect(page.locator("#launch-open"), "a way off the cover").toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#launch-stall-note")).toBeVisible();

    await page.locator("#launch-open").click();
    await expect(page.locator("body"), "the copy, as it was").not.toHaveClass(/booting/, { timeout: 30_000 });
    await expect(appIn(page).locator("#new-game")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#doc-note")).toHaveText(
      "The move that arrived couldn't be added to your copy, so your copy is as it was.",
    );
    await page.waitForTimeout(3_000);
    expect(loads, "the tap is not a navigation").toBe(0);

    await page.context().close();
  });

  test("the tap ends the merge: a frame that answers late does not apply the move", async ({ browser }) => {
    /*
     * Tapping the cover says the copy as it stands is what they want to see,
     * and the sentence says the move was not added. The retry loop kept going,
     * so a frame that answered a moment later applied the move under a sentence
     * saying it had not (second cold review of c1490cb).
     */
    const { file, uuid } = await built();

    // Somebody else's copy, with a move in it.
    const other = await browser.newContext();
    const theirs = await other.newPage();
    await firstOpen(theirs, file);
    const app = appIn(theirs);
    await expect(app.locator("#new-game")).toBeVisible({ timeout: 60_000 });
    await app.locator("#you").fill("Ada");
    await app.locator("#them").fill("Bo");
    await app.locator("#new-game button[type=submit]").click();
    await app.locator("#board .cell").nth(0).click();
    await expect(app.locator("#board .cell").nth(0)).toHaveText("X");
    const read = async (): Promise<number[]> =>
      theirs.evaluate(async (id) => {
        const runner = (window as unknown as { __runner: { loadStored(u: string): Promise<Uint8Array | null> } })
          .__runner;
        return Array.from((await runner.loadStored(id)) ?? []);
      }, uuid);
    // Written, not merely asked for: the move has to be in the bytes we hand on.
    await expect.poll(async () => (await read()).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const bytes = await read();

    const page = await iphoneHolding(browser, file);
    /*
     * A frame whose handshake is held back and delivered later, on a word from
     * the test: the wait the person ends, and then the answer arriving after.
     */
    await page.addInitScript(() => {
      (window as unknown as { __daiTimers: { launchStallMs: number } }).__daiTimers = { launchStallMs: 1000 };
      const held: { listener: EventListener; event: Event }[] = [];
      (window as unknown as { __release: () => void }).__release = () => {
        for (const one of held.splice(0)) one.listener(one.event);
      };
      const add = window.addEventListener.bind(window);
      window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
        if (type !== "message") return add(type, listener, options as AddEventListenerOptions);
        const hold = (event: Event): void => {
          const data = (event as MessageEvent).data as { type?: string } | null;
          if (data && data.type === "DAI_HOST_HANDSHAKE") {
            held.push({ listener: listener as EventListener, event });
            return;
          }
          (listener as EventListener)(event);
        };
        return add(type, hold, options as AddEventListenerOptions);
      }) as typeof window.addEventListener;
    });
    await page.reload();
    await expect(page.locator("body")).not.toHaveClass(/loaded/);

    await mergeInto(page, uuid, bytes);
    await expect(page.locator("#launch-open")).toBeVisible({ timeout: 30_000 });
    await page.locator("#launch-open").click();
    await expect(page.locator("#doc-note")).toHaveText(
      "The move that arrived couldn't be added to your copy, so your copy is as it was.",
      { timeout: 30_000 },
    );

    // The frame answers now. Nothing is asked of it: the move is not applied.
    await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await page.waitForTimeout(6_000);
    const cells = appIn(page).locator("#board .cell");
    expect(await cells.count(), "the copy as it was: their game is not in it").toBe(0);
    await expect(appIn(page).locator("#new-game"), "still the copy that has no game").toBeVisible();
    await expect(page.locator("#doc-note"), "and the sentence still true").toBeVisible();
    const held = await page.evaluate(async (id) => {
      const runner = (window as unknown as { __runner: { loadStored(u: string): Promise<Uint8Array | null> } }).__runner;
      return Array.from((await runner.loadStored(id)) ?? []);
    }, uuid);
    expect(held.length, "this device holds its own copy still").toBeGreaterThan(0);

    await other.close();
    await page.context().close();
  });
});
