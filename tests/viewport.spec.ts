import { expect, test } from "@playwright/test";

const RUNNER_URL = "http://localhost:5175/";

/**
 * How much of the screen an application gets.
 *
 * Three attempts, each measured off a screenshot of the next failure.
 *
 * `inset: 0` is the layout viewport, which in a Safari tab runs on underneath
 * the toolbars: the bottom fifth of every application sat behind the bar.
 * `100dvh` fixed the tab and left a home-screen app 96pt short. Dropping the
 * safe-area padding left it 62pt short — exactly the top inset, on an iPhone
 * 16 Pro at 402x874pt — which says what `100dvh` is there: 874 - 62 = 812.
 *
 * No viewport unit in that context means "what is on the screen".
 * `visualViewport.height` does, in both: it excludes a browser's toolbars and
 * it is the whole screen when there are none. A test browser has no toolbars
 * inside the page, so what these hold is that the page is sized from that
 * measurement rather than from a unit, and that nothing is left over.
 */
test.describe("how much of the screen an application gets", () => {
  test("the page is sized from the viewport a person can actually see", async ({ page }) => {
    await page.goto(RUNNER_URL);
    const seen = await page.evaluate(() => {
      const box = document.body.getBoundingClientRect();
      return {
        set: document.documentElement.style.getPropertyValue("--app-height"),
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        visible: Math.round(window.visualViewport?.height ?? window.innerHeight),
        bottomPad: getComputedStyle(document.body).paddingBottom,
      };
    });
    // Set before the first paint, from the visual viewport, not from a unit.
    expect(seen.set).toBe(`${seen.visible}px`);
    expect(seen.top).toBe(0);
    expect(seen.bottom).toBe(seen.visible);
    // Nothing carved off the bottom: the application reaches the edge.
    expect(seen.bottomPad).toBe("0px");
  });

  test("it follows the viewport when that changes, which is what a rotation is", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect
      .poll(async () =>
        page.evaluate(() => ({
          set: document.documentElement.style.getPropertyValue("--app-height"),
          visible: Math.round(window.visualViewport?.height ?? window.innerHeight),
        })),
      )
      .toEqual({ set: "390px", visible: 390 });
  });

  test("an open document reaches the bottom edge", async ({ page }) => {
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

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    const frame = await page.evaluate(() => {
      const box = document.getElementById("cartridge")!.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        visible: Math.round(window.visualViewport?.height ?? window.innerHeight),
      };
    });
    // Top edge to bottom edge: no strip above it, nothing left under it.
    expect(frame.top).toBe(0);
    expect(frame.bottom).toBe(frame.visible);
  });
});
