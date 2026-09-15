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
/**
 * What a failed request's error text says it was, per engine.
 *
 * A request that tried the network while it is cut fails with an offline or
 * unreachable error. A request the browser or the page cancelled fails with an
 * abort. The first is a leak; the second is not, and counting it as one cost a
 * day (backlog D29): every Firefox "escape" D29 recorded was `NS_BINDING_ABORTED`,
 * an icon load cancelled and made again, while a genuine offline fetch fails
 * `NS_ERROR_OFFLINE` (Firefox) or `net::ERR_FAILED` (Chromium). Held by
 * `tests/offline-detector.spec.ts`, which drives both kinds on each engine.
 */
export const TRIED_THE_NETWORK: readonly RegExp[] = [
  /^NS_ERROR_OFFLINE$/,
  /^NS_ERROR_(UNKNOWN_HOST|CONNECTION_REFUSED|NET_RESET|NET_INTERRUPT|NET_TIMEOUT)$/,
  /^net::ERR_(FAILED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_RESET|ADDRESS_UNREACHABLE|NETWORK_CHANGED)$/,
];
export const CANCELLED: readonly RegExp[] = [/^NS_BINDING_ABORTED$/, /^net::ERR_ABORTED$/];

export interface NetworkCut {
  /** Requests that tried the network, plus any whose error this file does not recognize. */
  reached: string[];
  /** Requests cancelled by the browser or the page: named, never silently dropped. */
  setAside: string[];
  /** Failures whose error text is in neither list. Counted as reached, so they fail loudly. */
  unrecognized: string[];
  /** Everything above, for a failure message. */
  summary(): string;
}

/**
 * Sorts a failure by its error text. An error this file does not recognize is
 * counted as reached: a new engine or error must make the guard louder, never
 * quieter, and `unrecognized` says which error to add to a list above.
 */
export function classify(errorText: string): "reached" | "cancelled" | "unrecognized" {
  if (CANCELLED.some((pattern) => pattern.test(errorText))) return "cancelled";
  if (TRIED_THE_NETWORK.some((pattern) => pattern.test(errorText))) return "reached";
  return "unrecognized";
}

export async function cutTheNetwork(context: BrowserContext, page: Page): Promise<NetworkCut> {
  const cut: NetworkCut = {
    reached: [],
    setAside: [],
    unrecognized: [],
    summary: () =>
      [
        `reached the network: ${cut.reached.length ? cut.reached.join(", ") : "nothing"}`,
        `set aside as cancelled: ${cut.setAside.length ? cut.setAside.join(", ") : "nothing"}`,
        ...(cut.unrecognized.length ? [`unrecognized errors (add to tests/offline.ts): ${cut.unrecognized.join(", ")}`] : []),
      ].join("; "),
  };
  page.on("requestfailed", (request) => {
    const code = request.failure()?.errorText ?? "";
    const named = `${request.url()} (${code || "no error text"})`;
    const kind = classify(code);
    if (kind === "cancelled") {
      cut.setAside.push(named);
      // In the passing output too: if cancellations ever become the symptom of
      // something real, the count is sitting in the log.
      console.log(`offline: set aside a cancelled load, ${named}`);
      return;
    }
    cut.reached.push(named);
    if (kind === "unrecognized") cut.unrecognized.push(named);
  });
  await context.setOffline(true);
  return cut;
}
