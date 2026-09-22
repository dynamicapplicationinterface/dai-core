import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { HINT_KEY } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/**
 * A copy already on the device is moved to its own address on iOS too.
 *
 * iOS names a home-screen icon from the manifest the page was linked with when
 * it loaded. The reload that puts the page at the document's own address was
 * decided in `ingest` alone, so a document opened from this device's library —
 * an icon, a resume, a merge — stayed wherever the page was, and Add to Home
 * Screen there made the opener's icon. A phone read "iOS reload: not reached".
 *
 * WebKit only: this is the iPhone's path, and an iPhone's user agent on another
 * engine tests that engine, not the phone.
 */
test.skip(({ browserName }) => browserName !== "webkit", "the iOS reload is an iPhone's: WebKit only");

/** The name and start_url of the manifest the page is linked with, read the way the page itself would not need to. */
async function linkedManifest(page: Page): Promise<{ name?: string; start_url?: string }> {
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  if (!href) return {};
  if (href.startsWith("data:")) {
    const comma = href.indexOf(",");
    const head = href.slice(0, comma);
    const body = href.slice(comma + 1);
    const text = head.endsWith(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
    return JSON.parse(text) as { name?: string; start_url?: string };
  }
  // Answered by the worker, so read through a page it controls, not from outside.
  const reader = await page.context().newPage();
  await reader.goto(new URL(href, page.url()).href);
  const text = await reader.evaluate(() => document.body.innerText);
  await reader.close();
  return JSON.parse(text) as { name?: string; start_url?: string };
}

test.describe("opening a copy already on an iPhone", () => {
  test.slow();

  test("the page ends at the document's address, linked with its manifest, and says which way it came", async ({
    browser,
  }) => {
    const built = await compileDirectory({
      sourceDir: join(repo, "examples", "packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const uuid = built.manifest.documentUuid;
    const file = join(mkdtempSync(join(tmpdir(), "dai-ios-relaunch-")), "trip.dai.html");
    writeFileSync(file, built.html, "utf8");

    const device = await browser.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });
    const page = await device.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "iPhone", configurable: true });
    });

    // First open, from a file: the ingest path. It keeps the copy and reloads.
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
    await expect(page, "the first open lands at the document's address").toHaveURL(
      new RegExp(`#.*${HINT_KEY}=${uuid}`),
      { timeout: 60_000 },
    );
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // Back to the opener's own address, the way a phone comes back to it: the
    // document open last time is resumed from the library, not from a file.
    await page.goto(RUNNER_URL);
    await expect(page, "the resumed copy is moved to its own address").toHaveURL(
      new RegExp(`#.*${HINT_KEY}=${uuid}`),
      { timeout: 60_000 },
    );
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#launch")).toBeHidden({ timeout: 60_000 });

    const manifest = await linkedManifest(page);
    expect(manifest.name, "the manifest this load was linked with is the document's").toBe("Beach trip");
    expect(manifest.start_url ?? "", "and it launches into this document").toContain(`${HINT_KEY}=${uuid}`);

    const line = page.locator("#sheet-arrival");
    await expect(line, "the panel names the path that opened it").toContainText(
      "opened from the document open last time, resumed",
      { timeout: 15_000 },
    );
    await expect(line).toContainText("iOS reload: taken on the load before this one");
    await expect(line).not.toContainText("not reached");

    await device.close();
  });
});
