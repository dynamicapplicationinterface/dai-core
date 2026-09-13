import type { Page } from "@playwright/test";

/**
 * Reload the page in a way WebKit's driver survives.
 *
 * `page.reload()` intermittently crashes WebKit's Playwright driver —
 * "page.reload: WebKit encountered an internal error" — which fails the test as
 * an engine defect rather than anything the product did. A fresh navigation to
 * the same URL re-runs the page identically: the same request, the same service
 * worker, the same offline behaviour when the network is off (the worker serves
 * the shell from cache either way) — without going through the reload path that
 * crashes.
 *
 * Only WebKit is diverted. Chromium and Firefox reload exactly as before, so a
 * test that passes on them is unchanged; this is a driver work-around, scoped to
 * the one driver that needs it, not a change to what any test exercises.
 */
export async function reloadPage(
  page: Page,
  options?: Parameters<Page["reload"]>[0],
): Promise<void> {
  if (page.context().browser()?.browserType().name() === "webkit") {
    await page.goto(page.url(), options);
    return;
  }
  await page.reload(options);
}
