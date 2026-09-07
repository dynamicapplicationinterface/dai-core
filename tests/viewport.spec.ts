import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * How much of the screen an application gets.
 *
 * A home-screen launch on an iPhone ended 62pt above the bottom of the phone,
 * and three formulations of the body's height — `inset: 0`, `100dvh`,
 * `visualViewport.height` — each measured off a screenshot, each came back
 * exactly 62pt short. A unit cannot be wrong three ways by the same amount.
 * The viewport was: with `apple-mobile-web-app-status-bar-style` set to
 * black-translucent, iOS paints the page under the status bar and reports a
 * viewport one status bar shorter than the web view, anchored at the top.
 * Nothing the page can measure sees the last 62pt.
 *
 * So the load-bearing part of the fix is a tag that is not there, and the
 * first test here is that it stays not there. The rest hold the sizing that is
 * right once the viewport is honest: `100dvh`, which in a browser tab ends
 * above the toolbar and in a home-screen app is the web view, top to bottom.
 * A test browser has no toolbars inside the page, so what these can hold is
 * that the page is exactly the viewport and that nothing is left over.
 */
test.describe("how much of the screen an application gets", () => {
  test("the page does not ask for a translucent status bar", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveCount(0);
    // The manifest's display: standalone is what makes a home-screen icon an
    // app; the pre-manifest tag went with the other one, so there is one way
    // to say it.
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveCount(0);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  });

  test("the page is exactly the viewport", async ({ page }) => {
    await page.goto(RUNNER_URL);
    const seen = await page.evaluate(() => {
      const box = document.body.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        visible: Math.round(window.innerHeight),
        bottomPad: getComputedStyle(document.body).paddingBottom,
      };
    });
    expect(seen.top).toBe(0);
    expect(seen.bottom).toBe(seen.visible);
    // Nothing carved off the bottom: the application reaches the edge.
    expect(seen.bottomPad).toBe("0px");
  });

  test("it follows the viewport when that changes, which is what a rotation is", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect
      .poll(async () => page.evaluate(() => Math.round(document.body.getBoundingClientRect().height)))
      .toBe(390);
  });

  test("an open document reaches the bottom edge, and the strip above it is its colour", async ({ page }) => {
    const source = mkdtempSync(join(tmpdir(), "dai-viewport-"));
    writeFileSync(
      join(source, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta name="theme-color" content="#123456"><p id="app">here</p>',
      "utf8",
    );
    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Edge" });
    const file = join(source, "edge.dai.html");
    writeFileSync(file, built.html, "utf8");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(RUNNER_URL);
    // The chooser's own colour, one tag per scheme.
    await expect(page.locator('meta[name="theme-color"][media]')).toHaveCount(2);

    await page.setInputFiles("#file", file);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    const frame = await page.evaluate(() => {
      const box = document.getElementById("cartridge")!.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        visible: Math.round(window.innerHeight),
      };
    });
    // Top edge to bottom edge: no strip above it, nothing left under it.
    expect(frame.top).toBe(0);
    expect(frame.bottom).toBe(frame.visible);

    // The one edge it cannot paint — a phone's status bar, drawn by the
    // system from this page's theme-color — is the application's colour, and
    // in either scheme: one tag, no media condition.
    const tags = page.locator('meta[name="theme-color"]');
    await expect(tags).toHaveCount(1);
    await expect(tags).toHaveAttribute("content", "#123456");
    await expect(tags).not.toHaveAttribute("media", /.+/);
  });

  test("an application that declared no colour is measured, and the strip above it is what it painted", async ({ page }) => {
    const source = mkdtempSync(join(tmpdir(), "dai-ground-"));
    writeFileSync(
      join(source, "index.html"),
      '<!doctype html><meta charset="utf-8"><style>.page{background:rgb(250, 247, 239);min-height:100vh}</style>' +
        '<div class="page"><p id="app">here</p></div>',
      "utf8",
    );
    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Cream" });
    const file = join(source, "cream.dai.html");
    writeFileSync(file, built.html, "utf8");

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // The colour is on a wrapper, not on body: what is read is the first
    // background at the top left corner, which is what a person sees there.
    const tags = page.locator('meta[name="theme-color"]');
    await expect(tags).toHaveCount(1, { timeout: 30_000 });
    await expect(tags).toHaveAttribute("content", "rgb(250, 247, 239)");
    // And the page's own ground, which is what the system paints the status
    // bar from, on the root element rather than only on body.
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
      .toBe("rgb(250, 247, 239)");

    // Remembered, under the document's id and the colour scheme, because a
    // phone's status bar takes the page's colour as the page first appears,
    // and a colour that arrives after the app has drawn was measured to be
    // too late. The next launch at the document's own address paints it in
    // the head, before layout: on the root, and as the first theme-color
    // tag - first, which is what tells it apart from the one main.ts adds
    // at the end once the app has reported in.
    const key = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("dai:ground:")));
    expect(key).toMatch(/^dai:ground:[0-9a-f-]{36}:light$/);
    const uuid = key!.split(":")[2];
    await page.goto(`${RUNNER_URL}?doc=${uuid}`);
    const early = await page.evaluate(() => {
      const first = document.head.querySelector('meta[name="theme-color"]');
      return {
        ground: document.documentElement.style.getPropertyValue("--app-ground"),
        content: first?.getAttribute("content"),
        media: first?.getAttribute("media"),
      };
    });
    expect(early).toEqual({ ground: "rgb(250, 247, 239)", content: "rgb(250, 247, 239)", media: null });

    // And with nothing remembered - a home-screen app on iOS has storage of
    // its own, so an icon's first launch finds none - the colour rides in
    // the icon's own address, and is painted from there just the same.
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${RUNNER_URL}?doc=${uuid}&ground=${encodeURIComponent("rgb(250, 247, 239)")}`);
    const carried = await page.evaluate(() => ({
      ground: document.documentElement.style.getPropertyValue("--app-ground"),
      content: document.head.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    }));
    expect(carried).toEqual({ ground: "rgb(250, 247, 239)", content: "rgb(250, 247, 239)" });
  });
});
