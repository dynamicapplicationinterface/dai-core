import type { BrowserContext, Page } from "@playwright/test";

/**
 * Why an offline-reload test does not run on WebKit.
 *
 * Cutting the network and then navigating cannot be driven on WebKit through
 * Playwright, by either route into it: offline emulation crashes the driver on
 * the navigation ("WebKit encountered an internal error",
 * microsoft/playwright#34450, #27337), and aborting the network with a route
 * instead blocks the reload ("page.reload: Blocked by Web Inspector"). Both are
 * the Playwright/WebKit driver, not the product: the offline-serving property is
 * real and is verified on Chromium and Firefox, where the same test runs. Stated
 * here, and skipped by name in each test, rather than hidden in a project filter
 * — a green suite that silently skips the engine users are on is the false
 * comfort this week exists to end.
 */
export const WEBKIT_CANNOT_DRIVE_OFFLINE_NAV =
  "WebKit: Playwright cannot drive a reload while the network is cut — offline " +
  "emulation crashes the driver (playwright#34450, #27337) and route interception " +
  "blocks the reload. Offline serving is verified on Chromium and Firefox.";

/**
 * Cut the network off, and record anything that actually tried to reach it.
 *
 * What "a held document opens offline" claims is that nothing reaches the
 * network — the service worker serves it all from cache. An aborting route
 * enforces that: any request the worker does not answer from cache is aborted
 * rather than allowed to quietly succeed over the network, so the test is really
 * offline. And `requestfailed` records exactly those aborted requests — the ones
 * that escaped the cache — while a request the worker serves never fails and
 * never appears. Assert `reached` is empty and a held open that starts fetching
 * something fails loudly with the URL, rather than passing because the cache
 * happened to cover it. (Recording every request the route *sees* would instead
 * over-count: `context.route` sees the main-frame navigation even when the
 * worker serves it from cache, so it can never be empty on a reload.)
 *
 * It also sidesteps a Playwright/WebKit driver bug: navigating with offline
 * emulation on crashes the driver with "WebKit encountered an internal error"
 * (microsoft/playwright#34450, #27337). The property was always "nothing reached
 * the network"; offline emulation was only ever one way to produce it, and the
 * one way WebKit cannot drive.
 *
 * `context.route`, not `page.route`: these requests are the service worker's, and
 * a page route never sees a worker's requests (see tests/README.md and
 * scripts/check-routes.mjs).
 */
export async function cutTheNetwork(
  context: BrowserContext,
  page: Page,
): Promise<{ reached: string[] }> {
  const reached: string[] = [];
  page.on("requestfailed", (request) => reached.push(request.url()));
  await context.route("**/*", (route) => route.abort());
  return { reached };
}
