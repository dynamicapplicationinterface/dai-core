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
});
