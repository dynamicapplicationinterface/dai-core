import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = resolve(here, "fixture/fixture.dai.html");
const RUNNER_URL = "http://localhost:5175/";

/**
 * The runner is the installable half of the mobile story: a container cannot
 * install itself, because file:// forbids service workers and manifests. These
 * tests cover the console, not the cartridge.
 */
test.describe("runner shell", () => {
  test("is installable: manifest, icons and iOS standalone tags", async ({ page }) => {
    const response = await page.goto(RUNNER_URL);
    expect(response?.ok()).toBe(true);

    const manifestHref = await page.getAttribute('link[rel="manifest"]', "href");
    expect(manifestHref).toBeTruthy();

    const manifest = await page.evaluate(async (href) => {
      const res = await fetch(href!);
      return res.json();
    }, manifestHref);

    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBeTruthy();
    // A 512px icon and a maskable variant are what Android needs to install.
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(
      manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable"),
    ).toBe(true);

    // iOS reads none of the above; it needs its own tags.
    expect(await page.getAttribute('meta[name="apple-mobile-web-app-capable"]', "content")).toBe(
      "yes",
    );
    expect(await page.getAttribute('link[rel="apple-touch-icon"]', "href")).toContain(".png");

    // The icons must actually exist and be real PNGs, not 404 pages.
    for (const icon of [
      "./icons/icon-192.png",
      "./icons/icon-512.png",
      "./icons/apple-touch-icon.png",
    ]) {
      const probe = await page.request.get(new URL(icon, RUNNER_URL).href);
      expect(probe.ok(), icon).toBe(true);
      expect((await probe.body()).subarray(1, 4).toString("latin1"), icon).toBe("PNG");
    }
  });

  test("registers a service worker and serves the shell offline", async ({ page, context }) => {
    await page.goto(RUNNER_URL);

    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });

    // The real test of an offline player: cut the network entirely.
    await context.setOffline(true);
    await page.reload();

    await expect(page.locator("#open")).toBeVisible();
    expect(await page.title()).toBe("DAI Runner");

    await context.setOffline(false);
  });
});

test.describe("cartridge ingestion", () => {
  test("runs a container chosen from the file picker", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.goto(RUNNER_URL);
    await expect(page.locator("#cartridge")).toBeHidden();

    await page.setInputFiles("#file", CONTAINER);

    await expect(page.locator("body")).toHaveClass(/loaded/);
    await expect(page.locator("#cartridge")).toBeVisible();
    await expect(page.locator("#badge")).toContainText("fixture");

    // The container boots inside the runner exactly as it would on a desktop:
    // its own bootloader mounts its own frame, nested inside the runner's.
    const container = page.frameLocator("#cartridge");
    await expect(container.locator("#dai-app")).toBeAttached();
    const app = container.frameLocator("#dai-app");
    await expect(app.locator("#app")).toHaveText("ready dai-shared dai-shared:lazy");

    expect(errors).toEqual([]);
  });

  test("reports the publisher fingerprint it verified", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);

    // The fixture is signed, so the runner must say so rather than staying mute
    // about provenance.
    await expect(page.locator("#badge")).toContainText("signed");

    const state = await page.evaluate(() => {
      const runner = (window as unknown as { __runner: { loaded: unknown } }).__runner;
      const loaded = runner.loaded as {
        manifest: { documentUuid: string };
        publicKeyFingerprint?: string;
        database: Uint8Array;
      };
      return {
        uuid: loaded.manifest.documentUuid,
        fingerprint: loaded.publicKeyFingerprint,
        databaseBytes: loaded.database.length,
      };
    });

    expect(state.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(state.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(state.databaseBytes).toBe(0);
  });

  test("refuses a container whose payload was tampered with", async ({ page }) => {
    await page.goto(RUNNER_URL);

    // Swap an entry without touching the manifest: the digests no longer match.
    const original = readFileSync(CONTAINER, "utf8");
    const payload = original.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim();
    const archive = unzipSync(Buffer.from(payload, "base64"));
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>pwned");

    const tampered = original.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );

    await page.setInputFiles("#file", {
      name: "tampered.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(tampered, "utf8"),
    });

    await expect(page.locator("#report")).toHaveClass(/error/);
    await expect(page.locator("#report")).toContainText("has been modified");
    // Nothing may mount: refusing after showing the app would be pointless.
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("refuses a container whose bootloader was rewritten", async ({ page }) => {
    await page.goto(RUNNER_URL);

    // The payload is left untouched and every digest still matches. Only the
    // outer shell changed — which the container cannot detect about itself,
    // because its own check runs inside the code that was rewritten.
    const original = readFileSync(CONTAINER, "utf8");
    const tampered = original.replace(
      'content="required"',
      'content="advisory"',
    );
    expect(tampered).not.toBe(original);

    await page.setInputFiles("#file", {
      name: "reshelled.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(tampered, "utf8"),
    });

    await expect(page.locator("#report")).toHaveClass(/error/);
    await expect(page.locator("#report")).toContainText("does not match the sealed copy");
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("refuses a file that is not a container at all", async ({ page }) => {
    await page.goto(RUNNER_URL);

    await page.setInputFiles("#file", {
      name: "notes.html",
      mimeType: "text/html",
      buffer: Buffer.from("<!doctype html><body>just a page", "utf8"),
    });

    await expect(page.locator("#report")).toContainText("no DAI payload");
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("ejects cleanly and can load another container", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);

    await page.click("#eject");
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
    await expect(page.locator("#eject")).toBeHidden();

    // The input is cleared on eject, so re-choosing the same file still fires.
    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/);
  });
});
