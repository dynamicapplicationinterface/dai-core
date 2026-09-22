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
/** Small enough for an inline link, and declares no colour. */
const FIXTURE = resolve(repo, "tests", "fixture", "fixture.dai.html");
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
 * WebKit, because this is the iPhone's path. Firefox too, for one thing only:
 * it runs the `hashchange` from the relaunch's own fragment write before the
 * reload lands, which is where the page used to hear itself as a link and
 * reload a second time (review of 454e2db, Q1.1). Counted here on both.
 */
test.skip(
  ({ browserName }) => browserName === "chromium",
  "the iOS reload is an iPhone's: WebKit, and Firefox for the order its hashchange runs in",
);

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
  // Answered by the worker, so read from inside the page it controls. (Opened
  // in a tab of its own, Firefox downloads a manifest rather than showing it.)
  return page.evaluate(async (address) => (await fetch(address)).json(), href) as Promise<{
    name?: string;
    start_url?: string;
  }>;
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

    // Every load of the page from here on, counted: one relaunch is one load.
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });

    // First open, from a file: the ingest path. It keeps the copy and reloads.
    await page.goto(RUNNER_URL);
    loads = 0;
    await page.setInputFiles("#file", file);
    await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
    await expect(page, "the first open lands at the document's address").toHaveURL(
      new RegExp(`#.*${HINT_KEY}=${uuid}`),
      { timeout: 60_000 },
    );
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#sheet-arrival"), "the settled load, the one after the reload").toContainText(
      "iOS reload: taken on the load before this one",
      { timeout: 30_000 },
    );
    // Long enough for a second reload, which followed the first by a save.
    await page.waitForTimeout(3_000);
    expect(loads, "the first open's relaunch is exactly one load").toBe(1);

    // Back to the opener's own address, the way a phone comes back to it: the
    // document open last time is resumed from the library, not from a file.
    // Counted from before the visit: the visit itself is one load, the relaunch one more.
    loads = 0;
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
    await page.waitForTimeout(3_000);
    expect(loads, "the visit and the resume's relaunch: two loads, not three").toBe(2);

    await device.close();
  });

  test("a relaunch that moves only the fragment is exactly one load", async ({ browser }) => {
    /*
     * The fragment-only case. A document small enough for an inline link, whose
     * colour is not learned in the rehearsal, has a launch address that differs
     * from the page's only after the `#` — so the relaunch is a fragment change
     * and then a reload. The page used to hear that change as a link arriving
     * while a document was open, save, and reload a second time (the retry in
     * runner.spec, "the offer is per document").
     */
    const device = await browser.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });
    const page = await device.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "iPhone", configurable: true });
    });
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });
    const heardAsLink: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("a link arrived while a document was open")) heardAsLink.push(message.text());
    });

    await page.goto(RUNNER_URL);
    loads = 0;
    await page.setInputFiles("#file", FIXTURE);
    await page.locator("#card-open:visible, body.loaded").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
    await expect(page.locator("#sheet-arrival"), "the settled load, the one after the reload").toContainText(
      "iOS reload: taken on the load before this one",
      { timeout: 60_000 },
    );
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    expect(new URL(page.url()).pathname + new URL(page.url()).search, "only the fragment moved").toBe("/");
    await page.waitForTimeout(3_000);
    expect(heardAsLink, "the page's own fragment write is not a link arriving").toEqual([]);
    expect(loads, "the relaunch is exactly one load").toBe(1);

    await device.close();
  });

  test("a second document opened on the same page gets its own reload and its own manifest", async ({ browser }) => {
    /*
     * The loop guard was the page's, not the document's: after the reload for
     * A, every later open on that page was refused one, so B opened at A's
     * address with A's manifest linked — and Add to Home Screen made A's icon
     * for B (review of 454e2db, Q1.2).
     */
    const compile = async (appName: string) => {
      const out = await compileDirectory({ sourceDir: join(repo, "examples", "packing-list"), root: repo, appName });
      const file = join(mkdtempSync(join(tmpdir(), "dai-ios-second-")), "doc.dai.html");
      writeFileSync(file, out.html, "utf8");
      return { file, uuid: out.manifest.documentUuid };
    };
    const a = await compile("Beach trip");
    const b = await compile("Ski trip");
    expect(b.uuid).not.toBe(a.uuid);

    const device = await browser.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });
    const page = await device.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "iPhone", configurable: true });
    });
    // A document this device has never seen always asks: the card, pressed as a person does.
    const open = async (file: string) => {
      await page.setInputFiles("#file", file);
      await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
      await page.locator("#card-open").click();
      await expect(page.locator("#card-open")).toBeHidden({ timeout: 60_000 });
    };

    await page.goto(RUNNER_URL);
    await open(a.file);
    await expect(page.locator("#sheet-arrival")).toContainText("iOS reload: taken on the load before this one", {
      timeout: 60_000,
    });
    expect(page.url()).toMatch(new RegExp(`[#&]${HINT_KEY}=${a.uuid}`));

    // A is put away, on this same page, and B is opened here.
    await page.evaluate(() => (window as unknown as { __runner: { eject(): void } }).__runner.eject());
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
    await open(b.file);

    await expect(page, "B is moved to its own address").toHaveURL(new RegExp(`[#&]${HINT_KEY}=${b.uuid}`), {
      timeout: 60_000,
    });
    await expect(page.locator("#sheet-arrival"), "by a reload of its own").toContainText(
      "iOS reload: taken on the load before this one",
      { timeout: 60_000 },
    );
    await expect(page.locator("#sheet-arrival")).toContainText("opened from a file or a link, opened here");
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    const manifest = await linkedManifest(page);
    expect(manifest.name, "B's manifest is the one linked, not A's").toBe("Ski trip");

    await device.close();
  });

  test("a load that lost its hint on the way relaunches once, not for ever", async ({ browser }) => {
    /*
     * The guard that stops a relaunch relaunching was held for one document,
     * read from the hint in the address the reload landed on. An address that
     * loses its fragment on the way has no hint: the guard could not match, the
     * page was not where it meant to be, and it relaunched again — 24 loads in
     * 20 seconds, measured in the cold review of 025166c. A load that was
     * itself a relaunch never relaunches again, whatever its address says.
     */
    const out = await compileDirectory({ sourceDir: join(repo, "examples", "packing-list"), root: repo, appName: "Beach trip" });
    const file = join(mkdtempSync(join(tmpdir(), "dai-ios-nohint-")), "trip.dai.html");
    writeFileSync(file, out.html, "utf8");

    const device = await browser.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });
    const page = await device.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "iPhone", configurable: true });
    });
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
    await page.locator("#card-open").click();
    await expect(page.locator("#sheet-arrival")).toContainText("iOS reload: taken on the load before this one", {
      timeout: 60_000,
    });

    // From here every load arrives with its hint gone, as a lost fragment leaves it.
    await page.addInitScript(() => {
      if (location.hash.includes("opener-doc=")) {
        const kept = location.hash.replace(/[#&]opener-doc=[^&]*/, "").replace(/^&/, "#");
        history.replaceState(null, "", location.pathname + location.search + (kept === "#" ? "" : kept));
      }
    });
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });
    await page.goto(RUNNER_URL);
    await page.waitForTimeout(20_000);
    expect(loads, "the visit and one relaunch, and then it stops").toBe(2);
  });
});
