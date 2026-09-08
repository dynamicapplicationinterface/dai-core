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
        () => /doc-manifests|^data:/.test(document.querySelector('link[rel="manifest"]')?.getAttribute("href") ?? ""),
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

  /*
   * What a phone test found: iOS names a home-screen icon from the manifest
   * the page linked when it loaded, and nothing set afterwards. So the
   * worker has to serve the document's manifest at a real address and link
   * it into the shell at load whenever the address names the document.
   */
  test("at the document's own address, the page loads already describing it", async ({ page, context }) => {
    test.slow();
    await page.goto(RUNNER_URL);
    await openFile(page, CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    const uuid = await page.evaluate(
      () => (window as unknown as { __runner: { loaded: { manifest: { documentUuid: string } } } }).__runner.loaded.manifest.documentUuid,
    );
    const name = await page.title();

    // The manifest is a real file the worker serves, and it launches into
    // this document.
    await page.waitForFunction(
      () => (document.querySelector('link[rel="manifest"]')?.getAttribute("href") ?? "").includes("doc-manifests"),
      undefined,
      { timeout: 60_000 },
    );
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 60_000 });
    const manifest = await page.evaluate(async (id) => {
      const r = await fetch(`/doc-manifests/${id}.webmanifest`);
      return { status: r.status, body: (await r.json()) as { name: string; start_url: string; icons: { src: string }[] } };
    }, uuid);
    expect(manifest.status).toBe(200);
    expect(manifest.body.name).toBe(name);
    expect(manifest.body.start_url).toContain(`u=${uuid}`);
    expect(manifest.body.icons.some((icon) => icon.src.includes("doc-icons"))).toBe(true);

    // A fresh load at that address: the HTML itself — before any script runs
    // — carries the document's name, icon and manifest.
    const fresh = await context.newPage();
    await fresh.goto(RUNNER_URL);
    await fresh.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 60_000 });
    const html = await fresh.evaluate(async (address) => (await fetch(address)).text(), manifest.body.start_url);
    expect(html).toContain(`<title>${name}</title>`);
    expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${name}" />`);
    // And the first paint is the document's: its name in the header, the
    // chooser hidden, before any script runs. No flash of the opener.
    expect(html).toContain('<body class="launching"');
    expect(html).toContain(`<span id="title">${name}</span>`);
    expect(html).toContain(`<p id="launch-name">${name}</p>`);
    expect(html).toContain(`/doc-manifests/${uuid}.webmanifest`);
    expect(html).toContain("/doc-icons/");

    // And the page opens the document itself, not the library.
    await fresh.goto(manifest.body.start_url);
    await expect(fresh.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(fresh).toHaveTitle(name);

    // The manifest's icon needs no fetch: iOS reads the manifest through the
    // worker but fetches icons outside it, and a letter tile was the result.
    expect(manifest.body.icons[0]!.src).toMatch(/^data:image\/png;base64,/);
  });

  test("a document too big for a chat link still fits in its icon", async ({ browser, page }) => {
    /*
     * The first custom app somebody kept was bigger than a chat link allows,
     * and its icon landed on "open the file once". An icon's address is read
     * by the operating system, not a chat, so it has its own cap.
     */
    test.slow();
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { compileDirectory } = await import("../src/compile.js");
    const { INLINE_CAP } = await import("../src/link.js");
    // Random bytes defeat the carrier's compression, so this stays big.
    const filler = Buffer.from(crypto.getRandomValues(new Uint8Array(60 * 1024))).toString("base64");
    const dir = mkdtempSync(join(tmpdir(), "dai-bigicon-"));
    writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><p>big</p><!-- ${filler} -->`, "utf8");
    const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "Big one" });
    const file = join(dir, "big.dai.html");
    writeFileSync(file, built.html, "utf8");

    await page.goto(RUNNER_URL);
    await openFile(page, file);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await page.waitForFunction(
      () => (document.querySelector('link[rel="manifest"]')?.getAttribute("href") ?? "").includes("doc-manifests"),
      undefined,
      { timeout: 60_000 },
    );
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 60_000 });
    const start = await page.evaluate(async () => {
      const href = document.querySelector('link[rel="manifest"]')!.getAttribute("href")!;
      return ((await (await fetch(href)).json()) as { start_url: string }).start_url;
    });
    expect(start).toContain("#a=");
    expect(start.length).toBeGreaterThan(INLINE_CAP);

    const empty = await browser.newContext();
    const launched = await empty.newPage();
    await launched.goto(start);
    await expect(launched.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(launched).toHaveTitle("Big one");
    await empty.close();
  });

  test("an icon opens its document on a device that holds nothing, without asking again", async ({ browser, page }) => {
    /*
     * An iOS home-screen app starts with storage of its own and nothing in
     * it. The icon's address carries the document (an inline link) and the
     * id the person made the icon for; that pairing is the consent, and the
     * card is not shown a second time.
     */
    test.slow();
    await page.goto(RUNNER_URL);
    await openFile(page, CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await page.waitForFunction(
      () => (document.querySelector('link[rel="manifest"]')?.getAttribute("href") ?? "").includes("doc-manifests"),
      undefined,
      { timeout: 60_000 },
    );
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 60_000 });
    const start = await page.evaluate(async () => {
      const href = document.querySelector('link[rel="manifest"]')!.getAttribute("href")!;
      return ((await (await fetch(href)).json()) as { start_url: string }).start_url;
    });
    expect(start).toContain("#a=");

    const empty = await browser.newContext();
    const launched = await empty.newPage();
    await launched.goto(start);
    await expect(launched.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(launched.locator("#card-open")).toBeHidden();
    await empty.close();
  });
});
