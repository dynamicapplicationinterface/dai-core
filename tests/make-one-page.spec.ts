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
  test("explains the phone route and says where the runner is", async ({ page }) => {
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

    await expect(phones.getByText("run.dynamicapplicationinterface.io")).toBeVisible();
    await expect(phones.getByRole("link", { name: /Open the runner/ })).toHaveAttribute(
      "href",
      "https://run.dynamicapplicationinterface.io",
    );
  });
});
