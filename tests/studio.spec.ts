import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

const STUDIO_URL = "http://localhost:5174/";

/**
 * Drives the in-browser compiler end to end.
 *
 * The point of these tests is the seam: the same `buildContainer` the Vite
 * plugin calls runs inside a browser tab with no server compiling anything, and
 * the container it emits is then opened and executed as its own document.
 *
 * Chromium only — the assertions are about the compiler, not about engine
 * differences, and running a 14 MB esbuild binary on three engines buys nothing.
 */
test.describe("web studio", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "compiler seam, not engine coverage");

  test("compiles TSX and a schema into a downloadable container", async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.goto(STUDIO_URL);
    await page.click("#compile");

    // esbuild's WASM binary is ~14 MB, so first compile is not instant.
    await expect(page.locator("body")).toHaveAttribute("data-compiled", "true", {
      timeout: 60_000,
    });

    const log = await page.textContent("#status");
    expect(log).toContain("transpiling TSX");
    expect(log).toContain("sealing container");
    expect(log).toMatch(/uuid [0-9a-f]{8}-/);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#download"),
    ]);
    expect(download.suggestedFilename()).toBe("studio-doc.dai.html");

    const savedPath = testInfo.outputPath("studio-doc.dai.html");
    await download.saveAs(savedPath);

    const html = readFileSync(savedPath, "utf8");
    const archive = unzipSync(
      Buffer.from(html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );

    // A browser-built container must be indistinguishable from a plugin-built
    // one: same sealed structure, same enforced policy.
    expect(Object.keys(archive).sort()).toEqual([
      "app/app.js",
      "app/index.html",
      "document.sqlite",
      "runtime/container.html",
      "runtime/manifest.json",
      "runtime/sqlite3.mjs",
      "runtime/sqlite3.wasm",
    ]);
    expect(html).toContain('<meta name="dai-integrity" content="required">');

    const manifest = JSON.parse(
      Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"),
    );
    expect(manifest.documentUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    // Unsigned: the Studio holds no private key, and shipping one to a browser
    // would hand every visitor the publisher's identity.
    expect(manifest.signature).toBeUndefined();

    // The TSX must have been transpiled, not passed through.
    const app = Buffer.from(archive["app/app.js"]!).toString("utf8");
    expect(app).not.toContain("const rows: string[]");
    expect(app).toContain("alpha");

    expect(errors).toEqual([]);
  });

  test("the container it produces actually runs", async ({ page }, testInfo) => {
    await page.goto(STUDIO_URL);
    await page.click("#compile");
    await expect(page.locator("body")).toHaveAttribute("data-compiled", "true", {
      timeout: 60_000,
    });

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#download"),
    ]);
    const savedPath = testInfo.outputPath("runnable.dai.html");
    await download.saveAs(savedPath);

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    // Open the artifact as its own document, from disk, as a user would.
    await page.goto(`file:///${savedPath.replace(/\\/g, "/")}`);

    const frame = await page
      .locator("#dai-app")
      .elementHandle()
      .then((handle) => handle!.contentFrame());
    expect(frame).not.toBeNull();

    // The schema ran, the rows inserted, and the engine booted from memory —
    // all from a container compiled in a browser tab.
    await frame!.waitForSelector("#out", { timeout: 30_000 });
    const output = await frame!.textContent("#out");
    expect(output).toContain("items=3");
    expect(output).toMatch(/uuid=[0-9a-f]{8}-/);

    expect(errors).toEqual([]);
  });
});
