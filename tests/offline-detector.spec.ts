import { expect, test } from "@playwright/test";
import { classify, cutTheNetwork, WEBKIT_CANNOT_DRIVE_OFFLINE_NAV } from "./offline.js";

const RUNNER_URL = "http://localhost:5175/";

/**
 * The offline guard counts what it means, on each engine it runs on.
 *
 * `cutTheNetwork` is what every offline test trusts to say "nothing reached the
 * network". It used to count every failed request, so a load the browser
 * cancelled read as a leak, and a day went on chasing an icon whose load had
 * been cancelled and made again (backlog D29). Now it sorts failures by their
 * error text, and a change that loosens that sort is exactly the change that
 * needs proving both ways — a guard that ignores too much is as broken as one
 * that fires on everything. So each engine drives a genuine offline fetch (must
 * be caught, with an error the file recognizes) and a cancelled one (must be set
 * aside, and seen to happen, so "not counted" cannot pass because nothing
 * happened at all).
 */
test.describe("the offline guard", () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === "webkit", WEBKIT_CANNOT_DRIVE_OFFLINE_NAV);
    await page.goto(RUNNER_URL);
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 60_000 });
  });

  test("catches a request that genuinely tried the network, by an error it recognizes", async ({ page, context }) => {
    const net = await cutTheNetwork(context, page);
    const path = `/never-cached-${Math.random().toString(36).slice(2)}`;
    // Nothing has cached this address, so with the network cut it has to try
    // the network and fail there.
    await page.evaluate(async (url) => {
      await fetch(url, { cache: "no-store" }).catch(() => undefined);
    }, path);

    await expect.poll(() => net.reached.some((line) => line.includes(path)), { timeout: 10_000 }).toBe(true);
    // Recognized, not caught by falling through: if an engine starts returning
    // an error this file does not know, that is a list to update, and this is
    // where it is noticed.
    expect(net.unrecognized, net.summary()).toEqual([]);
    expect(net.setAside.some((line) => line.includes(path)), "a genuine attempt is never set aside").toBe(false);
  });

  test("sets aside a cancelled load, and says so", async ({ page, context, browserName }) => {
    const net = await cutTheNetwork(context, page);
    /*
     * A load the worker answers, cancelled in flight — the shape of the icon
     * loads D29 counted. It has to be a request that has started (offline, an
     * uncached one fails at once with an offline error, which is the other
     * test's case), so these are precached addresses, asked for exactly.
     *
     * The engines report cancellation differently, measured on 15 September:
     * Chromium reports a fetch the page aborts, every time, as net::ERR_ABORTED.
     * Firefox reports nothing for a page's own abort, and reports
     * NS_BINDING_ABORTED only for a load a navigation cuts off — about one in
     * three, which is why D29 was intermittent. So on Firefox the *setup* is
     * repeated until a cancellation happens, up to eight navigations of four
     * loads each. The check is not repeated: the first cancellation that
     * appears must be set aside and must not be counted as reached.
     */
    const cancellable = ["/runtime/sqlite3.wasm", "/runtime/sqlite3.mjs", "/icons/icon-512.png", "/icons/icon-192.png"];
    const mine = (line: string) => cancellable.some((path) => line.includes(`localhost:5175${path} `));
    if (browserName === "chromium") {
      await page.evaluate(async (url) => {
        const controller = new AbortController();
        const pending = fetch(url, { signal: controller.signal }).catch(() => undefined);
        controller.abort();
        await pending;
      }, cancellable[0]!);
    } else {
      for (let attempt = 0; attempt < 8 && !net.setAside.some(mine); attempt++) {
        await page.evaluate((paths) => {
          for (const path of paths) {
            if (path.endsWith(".png")) {
              const img = document.createElement("img");
              img.src = path;
              document.body.append(img);
            } else {
              void fetch(path).catch(() => undefined);
            }
          }
        }, cancellable);
        await page.reload();
        await page.waitForTimeout(300);
      }
    }

    await expect
      .poll(() => net.setAside.some(mine), {
        timeout: 10_000,
        message: `no cancelled load was seen as set aside: ${net.summary()}`,
      })
      .toBe(true);
    expect(net.reached.some(mine), net.summary()).toBe(false);
  });

  test("sorts the error texts the way the engines were measured to report them", () => {
    // What the probe measured on 15 September, per engine.
    expect(classify("NS_ERROR_OFFLINE")).toBe("reached");
    expect(classify("net::ERR_FAILED")).toBe("reached");
    expect(classify("net::ERR_INTERNET_DISCONNECTED")).toBe("reached");
    expect(classify("NS_BINDING_ABORTED")).toBe("cancelled");
    expect(classify("net::ERR_ABORTED")).toBe("cancelled");
    // Anything else is counted as reached, so a new error fails loudly.
    expect(classify("SOMETHING_NEW")).toBe("unrecognized");
  });
});
