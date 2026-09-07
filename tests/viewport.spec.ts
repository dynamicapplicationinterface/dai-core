import { expect, test } from "@playwright/test";

const RUNNER_URL = "http://localhost:5175/";

/**
 * How much of the screen an application gets.
 *
 * Two formulations, each right in one place and wrong in the other.
 *
 * In a browser tab, `inset: 0` is the layout viewport, which runs on
 * underneath Safari's toolbars: the bottom fifth of every application sat
 * behind the bar and could not be reached. `100dvh` is the viewport actually
 * being shown, and shrinks as the toolbars appear.
 *
 * In a home-screen app it is the other way round, measured off a screenshot of
 * one on an iPhone 16 Pro (402×874pt): 62pt of the opener's grey, a 38pt
 * header, 678pt of application, and 96pt of grey at the bottom — and 96 is
 * 62 + 34, the top inset and the bottom inset both. So `100dvh` there is
 * 874 − 62 = 812, the screen less the top inset already, and padding by the
 * insets inside it subtracts the top one twice.
 *
 * A test browser reports no safe-area insets, so what these hold is the
 * wiring: which formulation each context gets, and that the one for a
 * home-screen app does not subtract a bottom inset at all.
 */
test.describe("how much of the screen an application gets", () => {
  test("in a browser tab the page is the viewport actually shown", async ({ page }) => {
    await page.goto(RUNNER_URL);
    const seen = await page.evaluate(() => {
      const body = document.body;
      const box = body.getBoundingClientRect();
      return {
        standalone: document.documentElement.classList.contains("standalone"),
        top: Math.round(box.top),
        height: Math.round(box.height),
        inner: window.innerHeight,
        bottomPad: getComputedStyle(body).paddingBottom,
      };
    });
    expect(seen.standalone).toBe(false);
    expect(seen.top).toBe(0);
    // `100dvh`, which in a browser with no toolbars is the whole window.
    expect(seen.height).toBe(seen.inner);
  });

  test("launched from a home screen the page is the whole screen, with nothing taken off the bottom", async ({
    page,
  }) => {
    /*
     * The head script sets this class before the first paint when the device
     * says the page was launched from a home screen. Set the same way here,
     * because no test browser can be put into that display mode.
     */
    await page.addInitScript(() => {
      document.documentElement.classList.add("standalone");
    });
    await page.goto(RUNNER_URL);

    const seen = await page.evaluate(() => {
      const body = document.body;
      const box = body.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        inner: window.innerHeight,
        bottomPad: getComputedStyle(body).paddingBottom,
      };
    });

    // The whole screen: top edge to bottom edge, and no inset carved out of
    // the bottom of it. This is the half that was wrong — an application
    // stopped 96pt short of the bottom of the phone.
    expect(seen.top).toBe(0);
    expect(seen.bottom).toBe(seen.inner);
    expect(seen.bottomPad).toBe("0px");
  });

  test("an open document reaches the bottom edge, in both", async ({ page }) => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { compileDirectory } = await import("../src/compile.js");
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    const source = mkdtempSync(join(tmpdir(), "dai-viewport-"));
    writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><p id="app">here</p>', "utf8");
    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Edge" });
    const file = join(source, "edge.dai.html");
    writeFileSync(file, built.html, "utf8");

    for (const standalone of [false, true]) {
      const context = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 } });
      const fresh = await context.newPage();
      if (standalone) {
        await fresh.addInitScript(() => document.documentElement.classList.add("standalone"));
      }
      await fresh.goto(RUNNER_URL);
      await fresh.setInputFiles("#file", file);
      await fresh.locator("#card-open").click({ timeout: 60_000 });
      await expect(fresh.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

      const frame = await fresh.evaluate(() => {
        const el = document.getElementById("cartridge")!;
        return { bottom: Math.round(el.getBoundingClientRect().bottom), inner: window.innerHeight };
      });
      // Nothing between the application and the bottom of the screen.
      expect(frame.bottom, `standalone=${standalone}`).toBe(frame.inner);
      await context.close();
    }
  });
});
