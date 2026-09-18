import { expect, test } from "@playwright/test";

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
  answers: { persisted: boolean; persist: boolean | "never" },
): Promise<void> {
  await page.addInitScript((given) => {
    const real = navigator.storage as StorageManager | undefined;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        getDirectory: real?.getDirectory?.bind(real),
        persisted: async () => given.persisted,
        persist: () => (given.persist === "never" ? new Promise<boolean>(() => {}) : Promise.resolve(given.persist)),
      },
    });
  }, answers);
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

  test("records what the boot request answered, instead of discarding it", async ({ page }) => {
    await storageThatAnswers(page, { persisted: false, persist: false });
    const said = await breadcrumbs(page);
    await page.goto(RUNNER_URL);
    await expect(page.locator("#chooser-storage")).not.toHaveText("", { timeout: 30_000 });

    // The defect was that this answer existed and went nowhere: the request is
    // written down when it is made, and its answer when it comes.
    await expect.poll(() => said.filter((s) => s.includes("(asked at boot)"))).toEqual([
      "dai: storage persistence (tab): not kept (asked at boot)",
    ]);
    expect(said).toContain("dai: storage persistence asked at boot; waiting on the browser");
  });

  test("a request the browser never answers does not silence the reading", async ({ page }) => {
    /*
     * The shape Firefox gave CI on 18 September: `persist()` unanswered. The
     * reading used to be chained behind the request, so neither line was ever
     * written, on the one engine where the question is visible to a person.
     * The reading is independent now, and the request is on record as asked
     * and unanswered, which is the truth.
     */
    await storageThatAnswers(page, { persisted: false, persist: "never" });
    const said = await breadcrumbs(page);
    await page.goto(RUNNER_URL);

    await expect(page.locator("#chooser-storage")).toHaveText("not kept · tab", { timeout: 30_000 });
    await expect.poll(() => said.some((s) => s === "dai: storage persistence (tab): not kept")).toBe(true);
    expect(said).toContain("dai: storage persistence asked at boot; waiting on the browser");
    // No answer was given, so none is written.
    expect(said.some((s) => s.includes("(asked at boot)"))).toBe(false);
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
    expect(said.some((s) => s.includes("(asked at boot)"))).toBe(false);
  });
});
