import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PROBE_URL = "http://localhost:5175/probe/";

/**
 * The instrument, not the measurement.
 *
 * The persistence result takes a fortnight and a real phone; nothing here can
 * produce it. What a test can hold is that the page reporting it is not
 * quietly broken — because a probe that fails silently costs fourteen days
 * before anybody notices, which is the whole budget.
 *
 * So: the key is really created, really non-extractable, and really signs
 * after a reload rather than merely being present in the record. The PRF half
 * needs an authenticator and is left to the phone.
 */
test.describe("the device probe", () => {
  test("it is served as itself, not as the opener's shell", async ({ page }) => {
    // The service worker treats every navigation as the shell. A page under
    // this origin that is not the opener has to be exempt, or it never loads.
    await page.goto(PROBE_URL);
    await expect(page.locator("h1")).toHaveText("Device probe");
  });

  test("it says which context it is running in", async ({ page }) => {
    // Installed and browser are separate storage on iOS. A result recorded
    // without knowing which one it came from is not a result.
    await page.goto(PROBE_URL);
    await expect(page.locator("#context")).toContainText("browser tab");
  });

  test("a created key signs, and still signs after a reload", async ({ page }) => {
    await page.goto(PROBE_URL);
    await expect(page.locator("#persist")).toContainText("press Create the key");

    await page.locator("#make").click();
    await expect(page.locator("#persist")).toContainText("yes");

    // The reload is the point: a CryptoKey that survives structured cloning
    // into IndexedDB but cannot sign afterwards would read as success to
    // anything that only checked the record was there.
    await page.reload();
    await expect(page.locator("#persist")).toContainText("Still signs");
    await expect(page.locator("#persist")).toContainText("yes");
  });

  test("the stored key cannot be read out of the browser", async ({ page }) => {
    // Held on the same terms a replica key would be. A browser that refuses
    // to store a non-extractable key has to fail here rather than in Track 2.
    await page.goto(PROBE_URL);
    await page.locator("#make").click();
    await expect(page.locator("#persist")).toContainText("Created");

    const extractable = await page.evaluate(async () => {
      const record = await new Promise<{ privateKey: CryptoKey }>((resolve, reject) => {
        const open = indexedDB.open("dai-probe", 1);
        open.onsuccess = () => {
          const request = open.result.transaction("keys", "readonly").objectStore("keys").get("record");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        };
        open.onerror = () => reject(open.error);
      });
      return record.privateKey.extractable;
    });
    expect(extractable).toBe(false);
  });

  test("starting over leaves nothing behind", async ({ page }) => {
    await page.goto(PROBE_URL);
    await page.locator("#make").click();
    await expect(page.locator("#persist")).toContainText("Created");

    await page.locator("#forget").click();
    await expect(page.locator("#persist")).toContainText("none yet");
  });
});

test.describe("the fortnight the measurement needs", () => {
  test("the quiet-period warning appears with the key and not before", async ({ page }) => {
    // Eviction is keyed to site interaction, so opening anything on this
    // origin restarts the clock for that context and nothing in the readout
    // would show it had happened. That is what makes it a banner.
    await page.goto(PROBE_URL);
    await expect(page.locator("#quiet")).toBeHidden();

    await page.locator("#make").click();
    await expect(page.locator("#quiet")).toBeVisible();
    await expect(page.locator("#quiet")).toContainText("opendai.app");

    await page.locator("#forget").click();
    await expect(page.locator("#quiet")).toBeHidden();
  });

  test("the record carries what the result has to be read against", async ({ page }) => {
    // Whether persistence was granted is the variable the finding turns on,
    // and it is stamped at creation rather than read at checking time.
    await page.goto(PROBE_URL);
    await page.locator("#make").click();
    await expect(page.locator("#persist")).toContainText("Storage was");
    await expect(page.locator("#persist")).not.toContainText("not recorded");
    await expect(page.locator("#persist")).toContainText("Browser then");
  });
});

test.describe("which build this is", () => {
  test("the chooser names the commit, where somebody whose document will not open is sitting", async ({
    page,
  }) => {
    // The chooser has no menu, and the person who most needs to report a build
    // id is exactly the one who never gets a document open.
    await page.goto("http://localhost:5175/");
    await expect(page.locator("#chooser-version")).toHaveText(/^[0-9a-f]{7} · \d{4}-\d{2}-\d{2}/);
  });

  test("the menu names it too, for somebody already inside an app", async ({ page }) => {
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/chore-chart"),
      root: repo,
      appName: "Chore chart",
    });
    await page.goto("http://localhost:5175/");
    await openFile(page, {
      name: "chore-chart.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(built.html, "utf8"),
    });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await page.locator("#more").click();
    await expect(page.locator("#sheet-version")).toHaveText(/^[0-9a-f]{7} · /);
  });

  test("it is in the page, not fetched, so it survives having no network", async ({
    page,
    context,
  }) => {
    // The whole reason it moved out of version.json. A build id that needs the
    // network is missing in the one situation somebody reaches for it.
    await page.goto("http://localhost:5175/");
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 60_000,
    });
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator("#chooser-version")).toHaveText(/^[0-9a-f]{7} · /);
  });
});
