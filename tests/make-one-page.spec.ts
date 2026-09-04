import { expect, test } from "@playwright/test";

const PAGE = "http://localhost:5176/make-one";

/**
 * The page that hands a visitor their first container.
 *
 * Everything here is checked by opening the page, because the fault this exists
 * for could not be seen any other way: an edit removed the binding the build
 * step is gated on, Vue resolved it to undefined, `v-if` hid the whole section,
 * and the site built cleanly with the download button simply gone. Every test
 * passed. The page was useless.
 */
test.describe("make-one", () => {
  test("plays the conversation and then offers to build", async ({ page }) => {
    await page.goto(PAGE);

    // Before playing there is nothing to build, and the page says so.
    await expect(page.getByText("Press play to watch it back.")).toBeVisible();

    await page.getByRole("button", { name: /^Play$/ }).click();

    const build = page.getByRole("button", { name: /Build|Building/ });
    await expect(build).toBeVisible({ timeout: 30_000 });
    await expect(build).toBeEnabled();
  });

  test("builds a real container and offers a way to take it", async ({ page }) => {
    test.slow();
    await page.goto(PAGE);
    await page.getByRole("button", { name: /^Play$/ }).click();

    const build = page.getByRole("button", { name: /Build|Building/ });
    await expect(build).toBeVisible({ timeout: 30_000 });
    await build.click();

    // The compile happens in the visitor's browser, against the shell and
    // engine served from /runtime — so this also fails if those go missing.
    const download = page.locator("a.download");
    await expect(download).toBeVisible({ timeout: 120_000 });
    await expect(download).toHaveAttribute("download", /\.dai\.html$/);

    const href = await download.getAttribute("href");
    expect(href).toMatch(/^blob:/);

    // A size that is plausibly a container with an engine in it, rather than
    // an empty blob offered with a confident label.
    await expect(download).toContainText(/\d{3,} KB/);
  });

  test("offers one way to take the file, not two", async ({ page }) => {
    test.slow();

    /*
     * A device that can be handed a file directly, which is what a phone is.
     * Stubbed rather than emulated: Playwright has no share sheet, and the
     * question here is what the page offers, not what the sheet does.
     */
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
      Object.defineProperty(navigator, "share", {
        value: () => Promise.resolve(),
        configurable: true,
      });
    });

    await page.goto(PAGE);
    await page.getByRole("button", { name: /^Play$/ }).click();
    const build = page.getByRole("button", { name: /Build|Building/ });
    await expect(build).toBeVisible({ timeout: 30_000 });
    await build.click();

    const save = page.getByRole("button", { name: /^Save my-tasks/ });
    await expect(save).toBeVisible({ timeout: 120_000 });

    // The download link is the route that does nothing on such a device.
    // Offering both asks somebody to guess which of two identical-looking
    // buttons works, and the wrong guess is the one that fails silently.
    await expect(page.locator("a.download")).toHaveCount(0);
  });

  test("falls back to the download link when the share sheet fails", async ({ page }) => {
    test.slow();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
      Object.defineProperty(navigator, "share", {
        value: () => Promise.reject(new Error("not allowed")),
        configurable: true,
      });
    });

    await page.goto(PAGE);
    await page.getByRole("button", { name: /^Play$/ }).click();
    const build = page.getByRole("button", { name: /Build|Building/ });
    await expect(build).toBeVisible({ timeout: 30_000 });
    await build.click();

    const save = page.getByRole("button", { name: /^Save my-tasks/ });
    await expect(save).toBeVisible({ timeout: 120_000 });
    await save.click();

    // Only now, when the sentence about it is true.
    await expect(page.locator("a.download")).toBeVisible();
    await expect(page.getByText(/would not accept the file/)).toBeVisible();
  });

});

test.describe("the landing page", () => {
  test("explains the phone route and says where the opener is", async ({ page }) => {
    /*
     * A section can vanish from a page without a build failing — that happened
     * to the download button on this same site — and this one carries the only
     * answer to "how do I use this on my phone".
     */
    await page.goto("http://localhost:5176/");

    const phones = page.locator(".phones");
    await expect(phones).toBeVisible();
    await expect(phones.locator(".step")).toHaveCount(3);
    // Drawn, not screenshotted, so this also fails if the artwork is dropped.
    await expect(phones.locator("svg")).toHaveCount(3);

    /*
     * The address on the card, checked against the address it links to.
     *
     * These were two copies of one string, and when the opener moved only the
     * link changed: the card invited people to opendai.app and printed the old
     * host underneath. Comparing them to each other is what makes that a
     * failure rather than a thing somebody notices on the live site.
     */
    const href = await phones
      .getByRole("link", { name: /Open a file/ })
      .getAttribute("href");
    const host = new URL(href!).host;

    await expect(phones.getByText(host, { exact: true })).toBeVisible();
    expect(host).toBe("opendai.app");
    await expect(phones.getByRole("link", { name: /Open a file/ })).toHaveAttribute(
      "href",
      "https://opendai.app",
    );
  });
});

test.describe("what the site claims", () => {
  /*
   * Three sentences that said more than the code does. They were first on the
   * roadmap — "hours, removes the only dishonesty on the site" — and stayed up
   * while every harder item shipped, which is how copy goes stale: nothing
   * fails when it is wrong.
   */
  const overstated = [
    "cannot phone home",
    "altered file refuses to open",
    "writes and seals it",
    "makes the file refuse\nto open",
  ];

  for (const page_ of ["/", "/make-one"]) {
    test(`${page_} does not claim more than the format does`, async ({ page }) => {
      await page.goto(`http://localhost:5176${page_}`);
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      for (const claim of overstated) {
        expect(text, `"${claim}" is not a property this format has`).not.toContain(
          claim.replace(/\s+/g, " "),
        );
      }
    });
  }

  test("the security page names the channels it cannot close", async ({ page }) => {
    // A page that lists only strengths is not one a security team can use.
    await page.goto("http://localhost:5176/tamper-proof");
    const text = await page.locator("body").innerText();
    expect(text).toContain("WebRTC");
    expect(text).toContain("DNS prefetch");
    // And the limit of what a signature proves.
    expect(text).toMatch(/not.*who signed it/i);
  });

  test("the page for somebody holding a file they cannot open", async ({ page }) => {
    /*
     * The address that goes in the message a container arrives in. Somebody
     * reaching it has an attachment their computer will not name and no idea
     * what to do, so the page has to answer that before it explains anything.
     */
    await page.goto("http://localhost:5176/open");

    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");

    // The three ways out, in the order somebody is likely to need them.
    expect(text).toMatch(/opener/i);
    expect(text).toMatch(/dai\.html/i);
    expect(text).toMatch(/desktop app/i);

    // And the part a security-minded reader will look for.
    expect(text).toMatch(/cannot make a network request/i);
    expect(text).toMatch(/asking for a password/i);

    await expect(
      page.getByRole("link", { name: /the opener/i }).first(),
    ).toHaveAttribute("href", "https://opendai.app");
  });
});

test.describe("the front page, read by somebody who is not an engineer", () => {
  /*
   * The page was rewritten after somebody's wife read it and got stuck. It
   * was careful and honest, and every section opened with the mechanism —
   * "the database is inside the file" — which is a sentence for people who
   * know what a database is. Copy drifts back towards the people who write
   * it, and nothing fails when it does, so these hold the line.
   */
  test("no word above the fold that would not come up at a grocery store", async ({ page }) => {
    await page.goto("http://localhost:5176/");
    const hero = (await page.locator(".hero").innerText()).toLowerCase();
    for (const word of ["database", "sqlite", "container", "compil", "signed", "seal", "host", "terminal", "command line", "opener"]) {
      expect(hero, `"${word}" is in the first screen`).not.toContain(word);
    }
  });

  test("there is a button for the person who was sent a file", async ({ page }) => {
    // Most first visits are somebody holding a file. The previous page had a
    // button for people who had built one and a button for IT, and nothing
    // for them.
    await page.goto("http://localhost:5176/");
    await expect(page.locator(".hero").getByRole("link", { name: /sent me a file/i })).toHaveAttribute("href", "/open");
    await expect(page.locator(".hero").getByRole("link", { name: /^Make one$/ })).toHaveAttribute("href", "/make-one");
  });

  test("the prompt her assistant needs is on the page in full", async ({ page }) => {
    // She pastes this address into a chat; the model reads the page. If the
    // prompt is here verbatim it has nothing to invent.
    await page.goto("http://localhost:5176/");
    const text = await page.locator(".prompt-text").innerText();
    expect(text).toMatch(/^Make me a DAI app for \[/);
    expect(text).toContain("/docs/the-recipe");
  });

  test("the pictures are of things she might make", async ({ page }) => {
    await page.goto("http://localhost:5176/");
    const labels = await page.locator(".gallery .label").allInnerTexts();
    expect(labels).toHaveLength(3);
    // Not a task manager. A task manager is what engineers recognise
    // themselves in.
    for (const label of labels) expect(label.toLowerCase()).not.toContain("task");
  });
});
