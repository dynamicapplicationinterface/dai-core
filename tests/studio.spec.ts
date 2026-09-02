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

test.describe("web studio signing", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "compiler seam, not engine coverage");

  test("mints a key in the browser and signs with it", async ({ page }, testInfo) => {
    await page.goto(STUDIO_URL);

    // No identity yet: containers must be honestly reported as unsigned.
    await expect(page.locator("#key-state")).toHaveAttribute("data-signed", "false");

    await page.click("#generate");
    await expect(page.locator("#key-state")).toHaveAttribute("data-signed", "true");
    const shown = await page.textContent("#key-state");
    const fingerprint = shown!.match(/fingerprint ([0-9a-f]{16})/)![1]!;

    await page.click("#compile");
    await expect(page.locator("body")).toHaveAttribute("data-compiled", "true", {
      timeout: 60_000,
    });
    expect(await page.textContent("#status")).toContain(`signed ${fingerprint}`);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#download"),
    ]);
    const savedPath = testInfo.outputPath("signed-studio.dai.html");
    await download.saveAs(savedPath);

    const html = readFileSync(savedPath, "utf8");
    const archive = unzipSync(
      Buffer.from(html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );
    const manifest = JSON.parse(
      Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"),
    );

    expect(manifest.signatureAlgorithm).toBe("ECDSA-P256-SHA256");
    expect(manifest.publicKeyFingerprint).toBe(fingerprint);
    // The private key must not have travelled into the artifact.
    expect(html).not.toContain("PRIVATE KEY");

    // The container must verify itself: a browser-made signature has to satisfy
    // the same bootloader as a compiler-made one.
    await page.goto(`file:///${savedPath.replace(/\\/g, "/")}`);
    const frame = await page
      .locator("#dai-app")
      .elementHandle()
      .then((handle) => handle!.contentFrame());
    expect(frame).not.toBeNull();
    const state = await frame!.evaluate(() => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signature: (window as any).dai.signature as string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fingerprint: (window as any).dai.publicKeyFingerprint as string,
    }));
    expect(state.signature).toBe("valid");
    expect(state.fingerprint).toBe(fingerprint);
  });

  test("keeps the identity across reloads and forgets it on request", async ({ page }) => {
    await page.goto(STUDIO_URL);
    await page.click("#generate");
    // Wait for the identity to settle before reading it: generation and the
    // IndexedDB write are async, so the label lags the click.
    await expect(page.locator("#key-state")).toHaveAttribute("data-signed", "true");
    const first = await page.textContent("#key-state");

    // IndexedDB, not memory: the identity has to outlive the page.
    await page.reload();
    await expect(page.locator("#key-state")).toHaveAttribute("data-signed", "true");
    expect(await page.textContent("#key-state")).toBe(first);

    await page.click("#forget");
    await expect(page.locator("#key-state")).toHaveAttribute("data-signed", "false");
    await page.reload();
    await expect(page.locator("#key-state")).toHaveAttribute("data-signed", "false");
  });

  test("round-trips an exported private key through import", async ({ page }) => {
    await page.goto(STUDIO_URL);
    await page.click("#generate");
    await expect(page.locator("#key-state")).toHaveAttribute("data-signed", "true");
    const original = (await page.textContent("#key-state"))!.match(
      /fingerprint ([0-9a-f]{16})/,
    )![1]!;

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#export-private"),
    ]);
    const pem = readFileSync(await download.path(), "utf8");
    expect(pem).toContain("-----BEGIN PRIVATE KEY-----");

    // Drop the identity, then bring it back from the PEM alone.
    await page.click("#forget");
    await expect(page.locator("#key-state")).toHaveAttribute("data-signed", "false");

    // The import field lives behind a disclosure; open it as a user would.
    await page.click("#identity summary");
    await page.fill("#import-pem", pem);
    await page.click("#import");
    await expect(page.locator("#key-state")).toHaveAttribute("data-signed", "true");

    // Same key means same fingerprint, which is the whole point of backing it up.
    expect(await page.textContent("#key-state")).toContain(original);
  });
});

test.describe("web studio launchers", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "compiler seam, not engine coverage");

  test("offers desktop launchers alongside the container", async ({ page }) => {
    await page.goto(STUDIO_URL);
    await expect(page.locator("#launchers")).toBeHidden();

    await page.click("#compile");
    await expect(page.locator("body")).toHaveAttribute("data-compiled", "true", {
      timeout: 60_000,
    });
    await expect(page.locator("#launchers")).toBeVisible();

    const [bat] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#download-bat"),
    ]);
    expect(bat.suggestedFilename()).toBe("studio-doc.bat");
    const batText = readFileSync(await bat.path(), "utf8");
    expect(batText).toContain('set "DAI_FILE=%~dp0studio-doc.dai.html"');
    expect(batText).toContain("--app=");

    const [command] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#download-command"),
    ]);
    expect(command.suggestedFilename()).toBe("studio-doc.command");
    const commandText = readFileSync(await command.path(), "utf8");
    expect(commandText.startsWith("#!/bin/sh")).toBe(true);
    expect(commandText).toContain('file="$dir/studio-doc.dai.html"');

    // A browser download cannot set the executable bit, so the UI has to say so
    // rather than leaving the user with a file that does nothing when clicked.
    expect(await page.textContent("#launchers")).toContain("chmod +x");
  });
});
