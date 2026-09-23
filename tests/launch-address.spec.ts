import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { createServer, type Server } from "node:http";
import { compileDirectory } from "../src/compile.js";
import { publish } from "../src/store.js";
import { fsStore } from "../src/store-fs.js";
import { HINT_KEY, inlineLink } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/**
 * What a home-screen icon launches into never carries the document.
 *
 * The address is built from the link the document arrived by, and for an
 * inline link that address *is* the document: the whole payload sits in its
 * fragment. So the manifest the worker serves — the one iOS reads the
 * `start_url` from — carried a copy of the document, and the icon would open
 * that snapshot rather than the copy on the device, which has been written to
 * since. A phone read one on e1f9b45.
 *
 * A launch address is the origin, the colour, and the document's id. The
 * library resolves the id; a device that no longer holds it says so (D51/D53)
 * rather than importing the snapshot again.
 *
 * WebKit with an iPhone's user agent: this is the icon's path.
 */
test.skip(({ browserName }) => browserName !== "webkit", "the icon's address is an iPhone's: WebKit only");

/** The manifest the worker served this load, read from inside the page it controls. */
async function servedManifest(page: Page): Promise<{ name?: string; start_url?: string }> {
  /*
   * The document's own manifest, not the opener's. The page is described once
   * the document is up, so this waits for the swap rather than reading whatever
   * the head was linked with at load.
   */
  await expect
    .poll(() => page.locator('link[rel="manifest"]').getAttribute("href"), { timeout: 30_000 })
    .toMatch(/doc-manifests|^data:/);
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  if (!href) throw new Error("no manifest linked");
  if (href.startsWith("data:")) {
    const comma = href.indexOf(",");
    return JSON.parse(decodeURIComponent(href.slice(comma + 1))) as { name?: string; start_url?: string };
  }
  /*
   * From the cache the page wrote it to, falling back to asking for it. The
   * worker serves this address from that same cache; a page that the worker is
   * not yet controlling — a first load at /d/<hash> — cannot fetch it at all.
   */
  return page.evaluate(async (address) => {
    const hit = await caches.match(address);
    if (hit) return hit.json();
    return (await fetch(address)).json();
  }, href) as Promise<{ name?: string; start_url?: string }>;
}

async function iphone(browser: Parameters<Parameters<typeof test>[1]>[0]["browser"]): Promise<Page> {
  const device = await browser.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });
  const page = await device.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "iPhone", configurable: true });
  });
  return page;
}

/** A plain file server for the store, as the icon tests use. */
async function serve(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const name = (request.url ?? "/").split("?")[0].replace(/^\//, "");
    try {
      const bytes = readFileSync(join(root, name));
      response.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
      response.end(bytes);
    } catch {
      response.writeHead(404, { "access-control-allow-origin": "*" });
      response.end("not found");
    }
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test.describe("the address a home-screen icon launches into", () => {
  test.slow();

  test("after an inline arrival, carries the id and not the document", async ({ browser }) => {
    const built = await compileDirectory({
      sourceDir: join(repo, "examples", "packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const link = await inlineLink(built.html, RUNNER_URL, {
      template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
      runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
    });
    if (!link) throw new Error("expected an inline link");
    const uuid = built.manifest.documentUuid;

    const page = await iphone(browser);
    await page.goto(link);
    await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#launch")).toBeHidden({ timeout: 60_000 });

    const manifest = await servedManifest(page);
    const start = manifest.start_url ?? "";
    console.log(`INLINE start_url (${start.length} chars): ${start}`);
    expect(start, "the id, so the library can find the document").toContain(`${HINT_KEY}=${uuid}`);
    expect(start, "no document in it").not.toContain("#a=");
    expect(start, "and no key in it").not.toMatch(/[#&]k=/);
    expect(
      start.length,
      `an address, not a document (it was ${start.length} characters: ${start.slice(0, 80)}…)`,
    ).toBeLessThan(200);

    /*
     * And what it opens is this device's copy. Something is written here that
     * the link's snapshot cannot have — the icon's address is then followed in
     * a page of its own, and the writing is there.
     */
    const app = page.frameLocator("#cartridge").frameLocator("#dai-app");
    await app.getByPlaceholder("Don't forget").fill("Sun hat");
    await app.getByRole("button", { name: "Add" }).click();
    await expect(app.getByText("Sun hat")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_000);

    const icon = await page.context().newPage();
    await icon.goto(new URL(start, RUNNER_URL).href);
    await expect(icon.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    const opened = icon.frameLocator("#cartridge").frameLocator("#dai-app");
    await expect(
      opened.getByText("Sun hat"),
      "the copy on this device, written to since it arrived — not the link's snapshot",
    ).toBeVisible({ timeout: 60_000 });

    await page.context().close();
  });

  test("after a store arrival, keeps the path and the key that fetch it again", async ({ browser }) => {
    /*
     * The other half of the rule. A document that came from a store has a way
     * back in — its `/d/<hash>` path and the key beside it — and that is how
     * an icon for it works on a device that no longer holds it (D50/D56). Both
     * are short, so both stay; what never survives is a payload.
     */
    const built = await compileDirectory({
      sourceDir: join(repo, "examples", "packing-list"),
      root: repo,
      appName: "Beach trip",
      signingKey: resolve(repo, "conformance", "signing-key.pem"),
      allowTestKey: true,
    });
    const root = mkdtempSync(join(tmpdir(), "dai-store-launch-"));
    const server = await serve(root);
    try {
      const { sealed } = await publish(built.html, fsStore({ root, baseUrl: server.origin }), RUNNER_URL);
      const link = `${RUNNER_URL}d/${sealed.hash}#h=${sealed.hash}&k=${sealed.key}`;

      const page = await iphone(browser);
      // The default store, pointed at this one (see storeConfig()).
      await page.addInitScript((config) => {
        (window as unknown as { __daiStore: unknown }).__daiStore = config;
      }, { presignUrl: server.origin + "/presign-unused", publicBase: server.origin + "/" });
      await page.goto(link);
      await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
      if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
      await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

      const manifest = await servedManifest(page);
      const start = manifest.start_url ?? "";
      console.log(`STORE start_url (${start.length} chars): ${start}`);
      expect(start, "the path the worker serves").toContain(`/d/${sealed.hash}`);
      expect(start, "the key that opens what the store holds").toContain(`k=${sealed.key}`);
      expect(start, "and the id, for the copy on this device").toContain(`${HINT_KEY}=${built.manifest.documentUuid}`);
      expect(start, "no document in it").not.toContain("#a=");
      await page.context().close();
    } finally {
      server.server.close();
    }
  });
});
