import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Frame, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = resolve(here, "fixture/fixture.dai.html");
const RUNNER_URL = "http://localhost:5175/";

/**
 * Whether this device's documents are kept, said out loud (D49).
 *
 * The entry this holds: `persist()` was called at boot and its answer thrown
 * away, `persisted()` was read nowhere, and nothing on the device recorded
 * whether either context was durable. The consequence was not a broken feature
 * — it was that the seven-day phone reading could not be interpreted, because
 * it measured an install of unknown status and saw exactly what an unpersisted
 * one would produce.
 *
 * What a test can and cannot see here matters, and the entry says so. It cannot
 * see whether a grant is real: persistence is the browser's decision, made from
 * operating-system state and engagement history, and a headless Chromium grants
 * freely — the opposite of the case that matters. So nothing below asserts that
 * storage *is* persistent. What it holds is the three things that made the
 * reading uninterpretable:
 *
 *   1. the two contexts are told apart, because they can be granted differently
 *      and it is the installed one that matters;
 *   2. the request's answer is recorded rather than discarded;
 *   3. a browser that will not answer produces silence, not a "no".
 *
 * The third is the guard proved the other way. "The browser says it may evict
 * this" and "the browser will not say" are different facts, and a surface that
 * printed `false` for both would be a new instance of the mistake the whole
 * storage cluster is about — an empty store and an unreadable store looking
 * alike.
 */

/**
 * A Storage API that gives the answers a test names, on every engine.
 *
 * The engines disagree about the real one, and none of them is the case that
 * matters: Chromium answers `false` at once, Firefox can leave `persist()`
 * unanswered (most likely on a permission prompt), and Playwright's WebKit has
 * no `navigator.storage` at all (CI, 18 September). These tests hold what the
 * opener does with an answer — which context it names, that it writes the
 * request down, that it says nothing when there is nothing — so they give it
 * the answer and run identically everywhere. Skipping an engine instead would
 * run nothing there and say nothing about it (D24). What a real browser grants
 * is a device reading, and D49 says so.
 *
 * `getDirectory` is kept from the real object, so a document's bytes still go
 * where they would.
 */
async function storageThatAnswers(
  page: import("@playwright/test").Page,
  answers: {
    persisted: boolean;
    /**
     * `true` grants, and from then on `persisted()` answers `true` — which is
     * what a real grant does. `"reject"` is a browser that will not take the
     * question. `"never"` leaves it unanswered.
     */
    persist: boolean | "never" | "reject";
    /** How long a `persisted()` asked before the grant takes to answer, with what was true when asked. */
    staleReadMs?: number;
  },
): Promise<void> {
  await page.addInitScript((given) => {
    const real = navigator.storage as StorageManager | undefined;
    let kept = given.persisted;
    let granted = false;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        getDirectory: real?.getDirectory?.bind(real),
        persisted: () => {
          const answer = kept;
          const delay = granted ? 0 : (given.staleReadMs ?? 0);
          return new Promise<boolean>((resolve) => setTimeout(() => resolve(answer), delay));
        },
        persist: () => {
          const held = window as unknown as { __persistCalls?: number };
          held.__persistCalls = (held.__persistCalls ?? 0) + 1;
          if (given.persist === "never") return new Promise<boolean>(() => {});
          if (given.persist === "reject") {
            return Promise.reject(new DOMException("persistence is not available here", "NotAllowedError"));
          }
          // Answered a moment after asking, as a real browser does, so the
          // load-time reading has already been taken when the grant arrives.
          return new Promise<boolean>((resolve) =>
            setTimeout(() => {
              if (given.persist === true) {
                kept = true;
                granted = true;
              }
              resolve(given.persist as boolean);
            }, 200),
          );
        },
      },
    });
  }, answers);
}

/** How many times the page has asked the browser to keep this origin. */
const requestsMade = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __persistCalls?: number }).__persistCalls ?? 0);

/** The document's own frame, once its API is up. */
async function appFrameOf(page: Page): Promise<Frame> {
  const runnerFrameEl = page.locator("#cartridge");
  await runnerFrameEl.waitFor({ state: "attached" });
  const runnerFrame = await runnerFrameEl.elementHandle().then((h) => h!.contentFrame());
  if (!runnerFrame) throw new Error("no runner frame");
  const appEl = runnerFrame.locator("#dai-app");
  await appEl.waitFor({ state: "attached" });
  const appFrame = await appEl.elementHandle().then((h) => h!.contentFrame());
  if (!appFrame) throw new Error("no app frame");
  await appFrame.waitForFunction(() => Boolean((window as never as { dai?: unknown }).dai));
  return appFrame;
}

/** Opens the fixture and waits until it is on screen, writing nothing. */
async function openDocument(page: Page): Promise<void> {
  await page.setInputFiles("#file", CONTAINER);
  await page.locator("#card-open").click();
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
}

/** The first thing worth keeping: a save this person's use of the app caused. */
async function writeSomething(page: Page, said: string[]): Promise<void> {
  const frame = await appFrameOf(page);
  await frame.evaluate(async () => {
    const dai = (window as unknown as { dai: { saveState: (bytes: Uint8Array) => Promise<unknown> } }).dai;
    await dai.saveState(new Uint8Array([1, 2, 3, 4]));
  });
  await expect.poll(() => said.some((s) => /^dai: save \d+ written$/.test(s)), { timeout: 30_000 }).toBe(true);
}

/** Every `dai:` breadcrumb the page writes, from before the first script runs. */
async function breadcrumbs(page: import("@playwright/test").Page): Promise<string[]> {
  const seen: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("dai:")) seen.push(text);
  });
  return seen;
}

test.describe("the storage persistence reading", () => {
  test("names the context it is reporting from, and shows it where a phone can read it", async ({
    page,
  }) => {
    await storageThatAnswers(page, { persisted: false, persist: false });
    const said = await breadcrumbs(page);
    await page.goto(RUNNER_URL);

    // The chooser is the screen the person whose documents are gone is looking
    // at, and it has no menu. The line has to be here, not only in the sheet.
    const line = page.locator("#chooser-storage");
    await expect(line).toHaveText("not kept · tab", { timeout: 30_000 });

    // A plain page load is the tab context. Named, not implied.
    await expect.poll(() => said.some((s) => s === "dai: storage persistence (tab): not kept")).toBe(true);
    expect(said.some((s) => s.includes("storage persistence (installed)"))).toBe(false);

    // The same fact is in the sheet as well, for the person who has a menu.
    await expect(page.locator("#sheet-storage")).toHaveText(/·\s*tab$/);
  });

  test("says 'installed' when it is running as an installed app", async ({ page }) => {
    // The context the seven-day reading was actually taken in, and the one the
    // browser weights differently. `standalone()` reads display-mode first.
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = ((query: string) =>
        query.includes("display-mode: standalone")
          ? ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList)
          : real(query)) as typeof window.matchMedia;
    });

    // Kept, this time, so both of the line's wordings are held.
    await storageThatAnswers(page, { persisted: true, persist: true });
    const said = await breadcrumbs(page);
    await page.goto(RUNNER_URL);

    await expect(page.locator("#chooser-storage")).toHaveText("kept on this device · installed", {
      timeout: 30_000,
    });
    await expect.poll(() => said.some((s) => s === "dai: storage persistence (installed): kept")).toBe(true);
    expect(said.some((s) => s.includes("storage persistence (tab)"))).toBe(false);
  });

  test("is not asked at boot, nor on opening a document, but after the first thing worth keeping", async ({
    page,
  }) => {
    /*
     * D55, ruled 21 September. The request used to be made at page boot: no
     * document open, no engagement, nothing the person had done with this
     * origin — the moment a browser is least likely to grant it, and the only
     * moment the code made it.
     *
     * Three moments, in order, because the ruling is about *when* and a test
     * that only checked the end state would pass with the request back at
     * boot. Opening a document is deliberately included: it is the obvious
     * place to move it to, and it is still before there is anything to lose.
     *
     * What this cannot see is whether moving it changes what a browser
     * answers. That is engagement heuristics on a real device, and it is the
     * phone reading this entry has always wanted; a headless Chromium grants
     * freely, which is the opposite of the case that matters.
     */
    test.slow();
    await storageThatAnswers(page, { persisted: false, persist: false });
    const said = await breadcrumbs(page);

    await page.goto(RUNNER_URL);
    // The reading is at boot and stays there: it asks the browser nothing.
    await expect(page.locator("#chooser-storage")).toHaveText("not kept · tab", { timeout: 30_000 });
    expect(await requestsMade(page), "nothing is asked for at boot").toBe(0);

    await openDocument(page);
    expect(await requestsMade(page), "nor merely for opening a document").toBe(0);

    await writeSomething(page, said);
    await expect
      .poll(() => requestsMade(page), { timeout: 30_000, message: "asked once the first save is written" })
      .toBe(1);

    // And once only: the second save does not ask again.
    const frame = await appFrameOf(page);
    await frame.evaluate(async () => {
      const dai = (window as unknown as { dai: { saveState: (bytes: Uint8Array) => Promise<unknown> } }).dai;
      await dai.saveState(new Uint8Array([5, 6, 7, 8]));
    });
    await expect.poll(() => said.filter((s) => /^dai: save \d+ written$/.test(s)).length).toBeGreaterThan(1);
    expect(await requestsMade(page), "asked once, not once per save").toBe(1);
  });

  test("records what the request answered, instead of discarding it", async ({ page }) => {
    test.slow();
    await storageThatAnswers(page, { persisted: false, persist: false });
    const said = await breadcrumbs(page);
    await page.goto(RUNNER_URL);
    await expect(page.locator("#chooser-storage")).not.toHaveText("", { timeout: 30_000 });
    await openDocument(page);
    await writeSomething(page, said);

    // The defect was that this answer existed and went nowhere: the request is
    // written down when it is made, and its answer when it comes.
    await expect.poll(() => said.filter((s) => s.includes("(asked after the first save)"))).toEqual([
      "dai: storage persistence (tab): not kept (asked after the first save)",
    ]);
    expect(said).toContain("dai: storage persistence asked after the first save; waiting on the browser");
  });

  test("when the request is granted, the line on screen says so", async ({ page }) => {
    /*
     * The case the first build missed. The line was read once at load, beside
     * the request, and never again: on a device that granted it, the screen
     * said "not kept" for the rest of the visit. The first launch after
     * installing is when this is read before a multi-day phone test, so the
     * test would have measured something other than what the screen said.
     */
    test.slow();
    await storageThatAnswers(page, { persisted: false, persist: true });
    const said = await breadcrumbs(page);
    await page.goto(RUNNER_URL);
    await openDocument(page);
    await writeSomething(page, said);

    await expect(page.locator("#sheet-storage")).toHaveText("kept on this device · tab", { timeout: 30_000 });
    await expect.poll(() => said).toContain("dai: storage persistence (tab): kept (asked after the first save)");
    await expect.poll(() => said).toContain("dai: storage persistence (tab): kept (after the request)");
  });

  test("a reading asked before the grant cannot land after it", async ({ page }) => {
    // The load-time reading is slow here and answers with what was true when
    // it was asked. It comes back well after the grant, and must be dropped
    // rather than put "not kept" back on the screen.
    test.slow();
    await storageThatAnswers(page, { persisted: false, persist: true, staleReadMs: 1_500 });
    const said = await breadcrumbs(page);
    await page.goto(RUNNER_URL);
    await openDocument(page);
    await writeSomething(page, said);

    await expect(page.locator("#sheet-storage")).toHaveText("kept on this device · tab", { timeout: 30_000 });
    // Past the moment the stale reading answers, and still right.
    await page.waitForTimeout(2_000);
    await expect(page.locator("#sheet-storage")).toHaveText("kept on this device · tab");
  });

  test("a request the browser would not take is not reported as a refusal", async ({ page }) => {
    // A rejection is the browser declining the question, not answering it.
    // "Not kept" would be a fact it never gave.
    test.slow();
    await storageThatAnswers(page, { persisted: false, persist: "reject" });
    const said = await breadcrumbs(page);
    await page.goto(RUNNER_URL);
    await openDocument(page);
    await writeSomething(page, said);

    await expect
      .poll(() => said.filter((s) => s.includes("(asked after the first save)")))
      .toEqual([
        "dai: storage persistence (tab): the browser did not take the request (persistence is not available here) (asked after the first save)",
      ]);
    expect(said).not.toContain("dai: storage persistence (tab): not kept (asked after the first save)");
    // The standing reading is its own fact, and still reported.
    await expect(page.locator("#chooser-storage")).toHaveText("not kept · tab");
  });

  test("a request the browser never answers does not silence the reading", async ({ page }) => {
    /*
     * The shape Firefox gave CI on 18 September: `persist()` unanswered. The
     * reading used to be chained behind the request, so neither line was ever
     * written, on the one engine where the question is visible to a person.
     * The reading is independent now, and the request is on record as asked
     * and unanswered, which is the truth.
     */
    test.slow();
    await storageThatAnswers(page, { persisted: false, persist: "never" });
    const said = await breadcrumbs(page);
    await page.goto(RUNNER_URL);
    await expect(page.locator("#chooser-storage")).toHaveText("not kept · tab", { timeout: 30_000 });
    await openDocument(page);
    await writeSomething(page, said);

    await expect.poll(() => said.some((s) => s === "dai: storage persistence (tab): not kept")).toBe(true);
    expect(said).toContain("dai: storage persistence asked after the first save; waiting on the browser");
    // No answer was given, so none is written.
    expect(said.some((s) => s.includes("(asked after the first save)"))).toBe(false);
  });

  test("a browser that will not answer says nothing, rather than saying no", async ({ page }) => {
    // Not an absent Storage API in general — `persisted()` specifically refusing
    // to answer, which is the shape a locked-down or older browser takes.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "storage", {
        configurable: true,
        value: {
          getDirectory: undefined,
          persist: undefined,
          persisted: undefined,
        },
      });
    });

    const said = await breadcrumbs(page);
    await page.goto(RUNNER_URL);
    await page.locator("#open").waitFor({ timeout: 30_000 });

    // Silence on screen. Not "not kept", which would be a fact we were never given.
    await expect(page.locator("#chooser-storage")).toHaveText("");
    await expect(page.locator("#sheet-storage")).toHaveText("");

    // And the breadcrumb says which of the two silences this is, because the
    // console is where the difference has to be legible.
    expect(said.some((s) => s.includes("storage persistence: the browser will not say"))).toBe(
      true,
    );
    expect(said.some((s) => s.includes("(asked after the first save)"))).toBe(false);
  });
});
