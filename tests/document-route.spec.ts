import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * The opener works from a document's own address, not only from the root.
 *
 * `/d/<id>` and `/p/<id>` are the addresses people are actually given — a
 * shared link, a home-screen icon, the page with the Get button on it. At the
 * edge they rewrite to the opener's own page, so the app is the same app; what
 * differs is `location.pathname`.
 *
 * That difference shipped a bug. `loadMergeModule` resolved
 * `runtime/dai-merge.js` against `location.href` rather than `document.baseURI`,
 * so from `/d/<id>` it asked for `/d/runtime/dai-merge.js`, got a 404, and the
 * push of the write rules was skipped — silently, because the failure was
 * caught and discarded. The application then refused its own first write with
 * `WRITE_SURFACE_UNAVAILABLE`, a code from inside the frame about a decision
 * the host had made, and the person saw it on a phone.
 *
 * Every test opened from the root, where `location.href` and `document.baseURI`
 * agree, so every test passed. This one does not open from the root.
 */
test.describe("a document opened at its own address", () => {
  test.slow();

  let container: string;

  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-route-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
  });

  test("loads its runtime from the site root, and can write", async ({ page }) => {
    /*
     * The edge rewrite, reproduced: `/d/<id>` serves the opener's page. The
     * page carries `<base href="/">`, so everything it asks for should still
     * resolve to the root — which is exactly the claim under test.
     */
    const shell = await (await fetch(RUNNER_URL)).text();
    await page.route("**/d/**", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      await route.fulfill({ status: 200, contentType: "text/html", body: shell });
    });

    const asked: string[] = [];
    page.on("request", (request) => asked.push(new URL(request.url()).pathname));

    await page.goto(`${RUNNER_URL}d/8f14e45fceea167a5a36dedd4bea2543`);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").waitFor({ timeout: 60_000 });
    await page.locator("#card-open").click();

    /*
     * Booting is the assertion. The application seeds a practice board before
     * it shows anything, and seeding is a replicated write — so a visible
     * board means the rules arrived and the write surface answered.
     */
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });

    // And the exact failure, named: asked for at the root, never under /d/. The
    // merge module is fetched by digest (`dai-merge.<sha256>.js`) so a stale cache
    // cannot answer with an older module; what matters here is that it is fetched
    // from the site root, not resolved relative to /d/ where it would 404.
    expect(asked.filter((path) => path.includes("/d/runtime/"))).toEqual([]);
    expect(
      asked.some((path) => /^\/runtime\/dai-merge\.[0-9a-f]{64}\.js$/.test(path)),
      `the write rules were never fetched from the site root: ${JSON.stringify(asked)}`,
    ).toBe(true);

    // A move, because "it booted" and "it can write" are different claims.
    await app(page).locator("[data-new-game]:visible").first().click();
    await app(page).locator("#setup-you").fill("Ada");
    await app(page).locator("#setup-them").fill("Bo");
    await app(page).locator("#new-game-form button[type=submit]").click();
    await app(page).locator('[data-square="e2"]').click();
    await app(page).locator('[data-square="e4"]').click();
    await expect(app(page).locator("#play-move")).toBeEnabled({ timeout: 30_000 });
    await app(page).locator("#play-move").click();
    await expect(app(page).locator("#move-history")).toContainText("e4", { timeout: 30_000 });
  });

  test("every runtime asset resolves against the base, not the address", () => {
    /*
     * The shape, so the next one is caught before a phone finds it.
     *
     * `<base href="/">` is what makes a sub-path work, and it only helps code
     * that resolves against `document.baseURI`. A fetch written against
     * `location.href` works perfectly from the root and breaks at every other
     * address — which is the hardest kind of bug to see from a test suite that
     * starts at the root.
     */
    const source = readFileSync(resolve(repo, "apps/runner/src/main.ts"), "utf8");
    const offenders = source
      .split("\n")
      .map((line, index) => ({ line, at: index + 1 }))
      .filter(({ line }) => /new URL\(\s*["'`](?!\/)[^"'`]+["'`]\s*,\s*location\.href/.test(line))
      .map(({ at }) => `apps/runner/src/main.ts:${at}`);

    expect(
      offenders,
      "A relative path resolved against `location.href` is resolved against the " +
        "address the person is on. Runtime assets live at the site root and the page " +
        "carries `<base href=\"/\">`, so resolve against `document.baseURI` — as the " +
        "engine, the confusables table and the roots all do.",
    ).toEqual([]);
  });
});
