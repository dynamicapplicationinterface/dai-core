import { createReadStream, existsSync, mkdtempSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { publish } from "../src/store.js";
import { HINT_KEY } from "../src/link.js";
import { fsStore } from "../src/store-fs.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = resolve(repo, "conformance", "signing-key.pem");
const RUNNER_URL = "http://localhost:5175/";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

/**
 * An icon whose document is gone (D50).
 *
 * The OS keeps a home-screen icon and its `start_url` after every
 * script-writable store has been swept, so an icon launched for a document the
 * library does not hold is the one signal a wipe leaves. What it may say
 * depends on the platform, and these hold the split:
 *
 * - Where the icon shares storage with the browser (Android, desktop), the
 *   document was here when the icon was made, so "isn't on this device any
 *   more" is true — for a wipe and for a removal alike.
 * - On iOS the icon has storage of its own, and its first launch looks exactly
 *   like a wiped one. Nothing in the page can tell them apart: a marker saying
 *   "launched before" would live in the storage the wipe reaches. So iOS gets
 *   the sentence that is true in both cases, and never "any more".
 * - In a tab, the address is not an icon launch, and gets the neutral one too.
 *
 * In every case the old promise — "it will be here every time after that" — is
 * gone. It was being repeated at exactly the moment it had been broken.
 *
 * A fresh browser context is a wiped device: same icon address, empty storage.
 */

/** Launched as an installed app: `standalone()` reads display-mode first. */
async function asInstalled(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) =>
      query.includes("display-mode: standalone")
        ? ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList)
        : real(query)) as typeof window.matchMedia;
  });
}

async function wipedDevice(browser: Browser, options: { installed: boolean; iphone?: boolean }): Promise<Page> {
  const context = await browser.newContext(options.iphone ? { userAgent: IPHONE } : {});
  const page = await context.newPage();
  if (options.installed) await asInstalled(page);
  return page;
}

/** The address an icon for a file-borne document launches into, as `launchAddress()` writes it. */
const FILE_ICON = `${RUNNER_URL}?name=Chores#${HINT_KEY}=00000000-0000-0000-0000-000000000000`;

test.describe("an icon for a document that arrived as a file", () => {
  test("on a device whose icon shares storage, says the document is not here any more", async ({ browser }) => {
    const page = await wipedDevice(browser, { installed: true });
    await page.goto(FILE_ICON);

    const slot = page.locator("#slot");
    await expect(slot).toContainText("Chores isn't on this device any more.", { timeout: 30_000 });
    await expect(slot).toContainText("If you still have the file, open it here and this icon will open it again.");
    await expect(slot).not.toContainText("every time after that");
    await page.context().close();
  });

  test("on iOS, where a first launch looks the same as a wipe, never says 'any more'", async ({ browser }) => {
    const page = await wipedDevice(browser, { installed: true, iphone: true });
    await page.goto(FILE_ICON);

    const slot = page.locator("#slot");
    await expect(slot).toContainText("This icon is for Chores, and it isn't on this device.", { timeout: 30_000 });
    await expect(slot).not.toContainText("any more");
    await expect(slot).not.toContainText("every time after that");
    await page.context().close();
  });

  test("in a tab, the address is not an icon launch, and gets the neutral sentence", async ({ browser }) => {
    const page = await wipedDevice(browser, { installed: false });
    await page.goto(FILE_ICON);

    const slot = page.locator("#slot");
    await expect(slot).toContainText("This icon is for Chores, and it isn't on this device.", { timeout: 30_000 });
    await expect(slot).not.toContainText("any more");
    await page.context().close();
  });
});

async function serve(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "/").split("?")[0]!.slice(1));
    const file = join(root, name);
    if (!name || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404, { "access-control-allow-origin": "*" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test.describe("an icon for a document that came by a store link", () => {
  test("launched on a wiped device, fetches the document again and says so on the card", async ({ browser }) => {
    /*
     * D56. The icon's hint was `u=<uuid>`, and `u` is also the store-URL field
     * of a reference link, so the icon's address lost the store and
     * `referenceFrom` read the uuid as a URL and gave up: the wiped device
     * showed the file-icon sentence, to someone who never had a file. This
     * test ran marked as an expected failure until the hint got a key of its
     * own; the mark came off in the same commit as the fix.
     */
    test.slow();
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/chore-chart"),
      root: repo,
      appName: "Chore chart",
      signingKey: KEY,
      allowTestKey: true,
    });
    const root = mkdtempSync(join(tmpdir(), "dai-store-"));
    const store = await serve(root);
    try {
      const { sealed } = await publish(built.html, fsStore({ root, baseUrl: store.origin }), RUNNER_URL);
      const link =
        `${RUNNER_URL}#h=${sealed.hash}` +
        `&u=${encodeURIComponent(`${store.origin}/${sealed.hash}`)}&k=${sealed.key}`;

      // The device that made the icon: opens the link, and describes the
      // document in a manifest whose start_url is what the home screen keeps.
      const before = await (await browser.newContext()).newPage();
      await before.goto(link);
      await before.locator("#card-open").click({ timeout: 60_000 });
      await expect(before.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
      let start = "";
      await expect
        .poll(
          async () => {
            start = await before.evaluate(async () => {
              const href = document.querySelector('link[rel="manifest"]')?.getAttribute("href");
              if (!href || !href.includes("doc-manifests")) return "";
              const response = await fetch(href).catch(() => null);
              return response?.ok ? ((await response.json()) as { start_url: string }).start_url : "";
            });
            return start;
          },
          { timeout: 60_000 },
        )
        .not.toBe("");
      await before.context().close();

      // The same icon, after the wipe: its start_url, in empty storage.
      const after = await wipedDevice(browser, { installed: true });
      const said: string[] = [];
      after.on("console", (message) => said.push(message.text()));
      await after.goto(start);

      const returning = after.locator("#card-returning");
      await expect(returning, `slot said: ${await after.locator("#slot").textContent().catch(() => "")}`).toBeVisible({
        timeout: 60_000,
      });
      await expect(returning).toHaveText("Chore chart wasn't on this device any more, so it was fetched again from its link.");
      // Open stays the one action.
      await expect(after.locator("#card-open")).toBeVisible();
      await after.context().close();
    } finally {
      await new Promise<void>((done) => store.server.close(() => done()));
    }
  });

  test("a /d/ link with no store in it: the icon, launched on a wiped device, fetches the document again", async ({
    browser,
  }) => {
    /*
     * The form the production opener makes: `/d/<hash>#k=<key>`, no `u=`, the
     * store implied. The icon's hint is then the only `u` in its fragment. This
     * is the case D56 needed run rather than read, because it decides whether
     * every link icon in the field is affected or only those naming a store.
     *
     * Run unmarked first, 17 September: it failed, and the wiped device showed
     * the file-icon sentence with nothing fetched, so every link icon was
     * affected. Held as an expected failure until the fix, which removed the
     * mark in the same commit.
     */
    test.slow();
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/chore-chart"),
      root: repo,
      appName: "Chore chart",
      signingKey: KEY,
      allowTestKey: true,
    });
    const root = mkdtempSync(join(tmpdir(), "dai-store-"));
    const store = await serve(root);
    // The default store, pointed at this one, for both devices (see storeConfig()).
    const pointAtStore = (origin: string) => ({
      presignUrl: `${origin}/presign-unused`,
      publicBase: `${origin}/`,
    });
    try {
      const { sealed } = await publish(built.html, fsStore({ root, baseUrl: store.origin }), RUNNER_URL);
      // `h` is required in every reference fragment; the path must agree with it.
      const link = `${RUNNER_URL}d/${sealed.hash}#h=${sealed.hash}&k=${sealed.key}`;

      const before = await (await browser.newContext()).newPage();
      await before.addInitScript((config) => {
        (window as unknown as { __daiStore: unknown }).__daiStore = config;
      }, pointAtStore(store.origin));
      await before.goto(link);
      await before.locator("#card-open").click({ timeout: 60_000 });
      await expect(before.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
      let start = "";
      await expect
        .poll(
          async () => {
            start = await before.evaluate(async () => {
              const href = document.querySelector('link[rel="manifest"]')?.getAttribute("href");
              if (!href || !href.includes("doc-manifests")) return "";
              const response = await fetch(href).catch(() => null);
              return response?.ok ? ((await response.json()) as { start_url: string }).start_url : "";
            });
            return start;
          },
          { timeout: 60_000 },
        )
        .not.toBe("");
      await before.context().close();
      console.log(`D56 /d/ icon start_url: ${start.replace(sealed.key, "<key>")}`);

      const after = await wipedDevice(browser, { installed: true });
      await after.addInitScript((config) => {
        (window as unknown as { __daiStore: unknown }).__daiStore = config;
      }, pointAtStore(store.origin));
      await after.goto(start);
      await expect(after.locator("#card-returning")).toBeVisible({ timeout: 60_000 });
      await after.context().close();
    } finally {
      await new Promise<void>((done) => store.server.close(() => done()));
    }
  });

  test("an ordinary link, opened for the first time, carries no such sentence", async ({ browser }) => {
    // The guard the other way: a first meeting is a first meeting.
    test.slow();
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/chore-chart"),
      root: repo,
      appName: "Chore chart",
      signingKey: KEY,
      allowTestKey: true,
    });
    const root = mkdtempSync(join(tmpdir(), "dai-store-"));
    const store = await serve(root);
    try {
      const { sealed } = await publish(built.html, fsStore({ root, baseUrl: store.origin }), RUNNER_URL);
      const link =
        `${RUNNER_URL}#h=${sealed.hash}` +
        `&u=${encodeURIComponent(`${store.origin}/${sealed.hash}`)}&k=${sealed.key}`;
      const page = await wipedDevice(browser, { installed: true });
      await page.goto(link);
      await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
      await expect(page.locator("#card-returning")).toBeHidden();
      await page.context().close();
    } finally {
      await new Promise<void>((done) => store.server.close(() => done()));
    }
  });
});
