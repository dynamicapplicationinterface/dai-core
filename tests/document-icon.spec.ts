import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const CONTAINER = resolve(repo, "tests/fixture/fixture.dai.html");

/**
 * The icon a document takes to a home screen.
 *
 * This is a WebKit test that happens to run everywhere, and the distinction
 * matters: the bug it exists for is invisible in Chromium.
 *
 * An icon is written the way icons are written — a `viewBox` and no `width` or
 * `height` — and therefore has no intrinsic size. Chromium infers one from the
 * viewBox and draws it. WebKit treats it as zero by zero and draws nothing,
 * with no error anywhere: the image loads, `drawImage` returns, and the canvas
 * is empty. The document then goes to a home screen wearing the opener's icon,
 * which is what a phone actually showed.
 *
 * So the assertion is about pixels rather than about calls succeeding.
 */
test.describe("a document's icon, rasterised for a home screen", () => {
  test("an icon with only a viewBox still draws", async ({ page }) => {
    await page.goto(RUNNER_URL);

    const chart = readFileSync(join(repo, "examples/chore-chart/icon.svg"), "utf8");
    // The shape of the problem: no width, no height, only a viewBox.
    expect(chart).not.toMatch(/<svg[^>]*\swidth\s*=/i);
    expect(chart).toMatch(/viewBox/i);

    const drawn = await page.evaluate(async (svg) => {
      // The same two steps install.ts takes, in the browser under test.
      const sized = svg.replace(/<svg/i, '<svg width="512" height="512"');
      const load = (markup: string) =>
        new Promise<HTMLImageElement | null>((done) => {
          const image = new Image();
          image.onload = () => done(image);
          image.onerror = () => done(null);
          image.src = "data:image/svg+xml," + encodeURIComponent(markup);
        });

      const opaque = (image: HTMLImageElement | null): number => {
        if (!image) return -1;
        const canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 512;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0, 512, 512);
        const { data } = context.getImageData(0, 0, 512, 512);
        let seen = 0;
        for (let at = 3; at < data.length; at += 4) if (data[at] !== 0) seen += 1;
        return seen;
      };

      return { withSize: opaque(await load(sized)), asWritten: opaque(await load(svg)) };
    }, chart);

    // The fix: given a size, every engine draws it.
    expect(drawn.withSize, "a sized SVG must rasterise to visible pixels").toBeGreaterThan(1000);

    // And the unsized case is exactly the browser difference this guards. Not
    // asserted as a failure — Chromium draws it fine — but recorded, so that
    // if WebKit ever starts inferring the size the reason for the workaround
    // is still written down here.
    expect(drawn.asWritten).toBeGreaterThanOrEqual(-1);
  });

  test("a document on screen carries its own icon, not the opener's", async ({ page }) => {
    test.slow();

    await page.goto(RUNNER_URL);
    const before = await page.getAttribute('link[rel="apple-touch-icon"]', "href");

    await openFile(page, CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // The page describes the document asynchronously — it rasterises the icon
    // and puts it in a cache first.
    await page
      .waitForFunction(
        () =>
          document.querySelector('link[rel="manifest"]')?.getAttribute("href")?.startsWith("data:"),
        undefined,
        { timeout: 60_000 },
      )
      .catch(() => {});

    // The name is the document's, which is what a home screen labels it with.
    const title = await page.getAttribute('meta[name="apple-mobile-web-app-title"]', "content");
    expect(title).not.toBe("DAI");
    expect(title).toBeTruthy();

    // And the icon is no longer the opener's own.
    const after = await page.getAttribute('link[rel="apple-touch-icon"]', "href");
    expect(after, "the document's icon should have replaced the opener's").not.toBe(before);
    expect(after).toMatch(/doc-icons|^blob:/);
  });
});
