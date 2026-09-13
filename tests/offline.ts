import type { BrowserContext, Page } from "@playwright/test";

/**
 * Why an offline-reload test does not run on WebKit.
 *
 * Cutting the network and then navigating cannot be driven on WebKit through
 * Playwright, by either route into it. `context.setOffline(true)` — the faithful
 * cut this file uses on Chromium and Firefox — crashes the driver on the
 * navigation ("WebKit encountered an internal error", microsoft/playwright#34450,
 * #27337). The alternative, aborting every request with a route, does not crash
 * but blocks the reload instead ("page.reload: Blocked by Web Inspector") — and
 * it is not faithful anyway (it leaves `navigator.onLine` true; see below). Both
 * are the Playwright/WebKit driver, not the product: the offline-serving property
 * is real and stays verified on Chromium and Firefox, where the same test runs.
 * Stated here, and skipped by name in each test, rather than hidden in a project
 * filter — a green suite that silently skips the engine users are on is the false
 * comfort this week exists to end.
 */
export const WEBKIT_CANNOT_DRIVE_OFFLINE_NAV =
  "WebKit: Playwright cannot drive a navigation while the network is cut — " +
  "setOffline crashes the driver (playwright#34450, #27337) and an aborting route " +
  "blocks the reload. Offline serving is verified on Chromium and Firefox.";

/**
 * Cut the network off, and record anything that actually tried to reach it.
 *
 * What "a held document opens offline" claims is that nothing reaches the
 * network — the service worker serves it all from cache. `context.setOffline`
 * produces that faithfully: it sets `navigator.onLine` false, so the browser and
 * the worker do not even attempt a request they would otherwise make, and
 * `requestfailed` records any request that tried the network anyway. A worker
 * that serves from cache fires nothing; a held open that reaches past the cache
 * fires with the URL. Assert `reached` is empty and such an open fails loudly,
 * rather than passing because the cache happened to cover it.
 *
 * Not `context.route` with an aborting handler. A route leaves `onLine` true, so
 * the browser still believes it is online and revalidates cached resources over
 * the network — on Firefox that turns the engine (sqlite3.wasm/.mjs) into two
 * requests the abort catches, even though the app runs from cache. The route
 * measured "the browser tried to revalidate", not "the open needed the network".
 * setOffline is the honest cut; it just cannot be driven on WebKit — see
 * WEBKIT_CANNOT_DRIVE_OFFLINE_NAV.
 */
export async function cutTheNetwork(
  context: BrowserContext,
  page: Page,
): Promise<{ reached: string[] }> {
  const reached: string[] = [];
  page.on("requestfailed", (request) => reached.push(request.url()));
  await context.setOffline(true);
  return { reached };
}
