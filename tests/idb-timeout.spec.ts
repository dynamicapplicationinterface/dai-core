import { expect, test } from "@playwright/test";

const RUNNER_URL = "http://localhost:5175/";

/**
 * A wedged IndexedDB never hangs the launch.
 *
 * `openIdb` opened a fresh connection on every call and closed none. On iOS
 * Safari the leaked connections accumulate until `indexedDB.open` stops firing
 * any event — not onsuccess, not onerror, not onblocked — and the library read
 * that every launch does then waits forever with no error. A phone reported a
 * launch stalled at exactly that step, "reading the library".
 *
 * The root fix is a single cached connection, which the storage suite covers by
 * still passing. This covers the other half: the bound that makes a wedge
 * survivable whatever its cause. `indexedDB.open` is replaced with one that
 * never answers, and the library read must still settle — to an empty list,
 * within the timeout — rather than hang, and it must leave a line in the log
 * the details panel reads.
 */
test.describe("a wedged IndexedDB", () => {
  test.slow();
  test.use({ serviceWorkers: "block" });

  test("times out to an empty library instead of hanging the launch", async ({ page }) => {
    await page.addInitScript(() => {
      // A request object that never fires any event, as the iOS bug leaves it.
      const wedged = () => ({}) as IDBOpenDBRequest;
      try {
        Object.defineProperty(window, "indexedDB", {
          configurable: true,
          value: { open: wedged, deleteDatabase: wedged },
        });
      } catch {
        /* If it cannot be overridden here, the assertion below will say so. */
      }
    });

    await page.goto(RUNNER_URL);

    // The library read goes through openIdb, which now cannot succeed. It must
    // resolve — to nothing — within the 5s bound and a margin, not hang.
    const started = Date.now();
    const result = await page.evaluate(async () => {
      const items = await (
        window as unknown as { __runner: { listLibrary(): Promise<unknown[]> } }
      ).__runner.listLibrary();
      return { length: items.length };
    });
    const elapsed = Date.now() - started;

    expect(result.length).toBe(0);
    expect(elapsed).toBeLessThan(9000);

    // And the failure is on the record, so the details panel shows it rather
    // than an empty "errors (0)".
    const logged = await page.evaluate(
      () => (window as unknown as { __daiLog?: string[] }).__daiLog ?? [],
    );
    expect(logged.some((line) => /idb: open timed out/.test(line))).toBe(true);
  });
});
