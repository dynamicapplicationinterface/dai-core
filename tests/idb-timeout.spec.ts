import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const RUNNER_URL = "http://localhost:5175/";
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixture", "fixture.dai.html");

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

  test("a file still opens, as unfamiliar, when IndexedDB never answers", async ({ page }) => {
    // Every storage call waits out its own 5s bound before carrying on, and a
    // first open makes several in a row, so this is slow by construction.
    test.setTimeout(300_000);
    /*
     * The file-open path, which the library read above never reached.
     *
     * The bound on the open promises that a slow database opens a document as
     * unfamiliar rather than not at all. The library read keeps that promise;
     * the trust check and the publisher lookup — the first two storage calls
     * when a file is opened — did not, so the timeout threw straight through
     * them and the person got "This file could not be opened
     * (IDB_OPEN_TIMEOUT)". A first open on a device is the worst case, because
     * that open is the one that creates the database, and it is the one moment
     * somebody new ever sees. Firefox under a full parallel run found it.
     *
     * So: the database never answers, a signed document is opened from a file,
     * and the card must appear, Get must mount it, and the refusal must never
     * be said.
     */
    await page.addInitScript(() => {
      const wedged = () => ({}) as IDBOpenDBRequest;
      try {
        Object.defineProperty(window, "indexedDB", {
          configurable: true,
          value: { open: wedged, deleteDatabase: wedged },
        });
      } catch {
        /* If it cannot be overridden here, the assertions below will say so. */
      }
    });

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", FIXTURE);

    // Unfamiliar, so it asks — and it does ask, rather than refusing.
    await expect(page.locator("#card-open")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("#report")).not.toContainText("could not be opened");
    await page.locator("#card-open").click();

    // Opened, not remembered: the document runs.
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 180_000 });
    await expect(page.locator("#report")).not.toContainText("could not be opened");

    const logged = await page.evaluate(
      () => (window as unknown as { __daiLog?: string[] }).__daiLog ?? [],
    );
    expect(logged.some((line) => /idb: open timed out/.test(line))).toBe(true);
  });
});
