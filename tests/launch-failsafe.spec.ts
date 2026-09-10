import { expect, test } from "@playwright/test";

const RUNNER_URL = "http://localhost:5175/";

/**
 * The launch screen is never a dead end.
 *
 * A document is launched by loading the page at its own address and letting the
 * splash stand until it mounts. When that load is the programmatic relaunch to
 * `#u=` — set the hash, reload — it can fail to complete on iOS Safari, and the
 * splash then sits forever: the screen hung, which reads as a broken app.
 *
 * The fail-safe turns that into one tap. A few seconds after the splash appears
 * with nothing mounted, it reveals a sentence and a *Tap to open* control whose
 * click is a plain navigation to the launch address — a real user gesture,
 * which completes where the programmatic relaunch did not.
 *
 * The stall itself only arises in two iOS-only paths a desktop run cannot
 * enter: the service worker injects the `launching` class for a home-screen
 * launch, and the relaunch is platform-gated. So the mechanism is armed here
 * through the same `__runner` hook the card is drawn through, and what is
 * asserted is the contract that holds on the device: after the wait the control
 * appears, and pressing it navigates to the address it was given.
 */
test.describe("the launch fail-safe", () => {
  test.slow();
  test.use({ serviceWorkers: "block" });

  test("a stalled splash reveals Tap to open, and the tap navigates to the launch address", async ({
    page,
  }) => {
    await page.goto(RUNNER_URL);

    // The splash, standing with nothing mounted — the state the SW leaves a
    // home-screen launch in — and the guard armed at the address the relaunch
    // was trying to reach.
    const target = `${RUNNER_URL}#u=00000000-0000-4000-8000-000000000000`;
    await page.evaluate((to) => {
      document.body.classList.add("launching");
      (window as unknown as { __runner: { guardLaunch(t: string): void } }).__runner.guardLaunch(to);
    }, target);

    // Nothing yet: the control is for a stall, not for a launch still in its
    // first second.
    await expect(page.locator("#launch-open")).toBeHidden();

    // After the wait, the sentence and the control.
    await expect(page.locator("#launch-open")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#launch-stall-note")).toBeVisible();
    await expect(page.locator("#launch-open")).toHaveText("Tap to open");
    // The splash reaches assistive technology now that it holds the one control.
    await expect(page.locator("#launch")).toHaveAttribute("aria-hidden", "false");

    // The gesture: a plain navigation to the launch address.
    await page.locator("#launch-open").click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(
      "#u=00000000-0000-4000-8000-000000000000",
    );
  });

  test("Show details reports the step, the address, the worker, the build, and the error ring", async ({
    page,
  }) => {
    await page.goto(RUNNER_URL);

    // An error thrown before the panel opens must be in the ring: the head
    // script installs the capture on the first line, so a screenshot taken
    // minutes later still holds what went wrong at the start.
    await page.evaluate(() => {
      window.dispatchEvent(
        new ErrorEvent("error", { message: "boom-from-the-start", error: new Error("boom-from-the-start") }),
      );
    });

    const target = `${RUNNER_URL}#u=11111111-1111-4111-8111-111111111111`;
    await page.evaluate((to) => {
      document.body.classList.add("launching");
      (window as unknown as { __runner: { guardLaunch(t: string): void } }).__runner.guardLaunch(to);
    }, target);

    await expect(page.locator("#launch-details-toggle")).toBeVisible({ timeout: 15_000 });
    await page.locator("#launch-details-toggle").click();

    const panel = page.locator("#launch-details");
    await expect(panel).toBeVisible();
    // The six things a phone with no inspector cannot otherwise report.
    await expect(panel).toContainText(/build:\s*\S/);
    await expect(panel).toContainText("step:");
    await expect(panel).toContainText("#u=: 11111111-1111-4111-8111-111111111111");
    await expect(panel).toContainText(/library holds it:\s*(yes|no|n\/a)/);
    await expect(panel).toContainText(/service worker controls page:\s*(yes|no|unavailable)/);
    // The error captured before the panel ever opened.
    await expect(panel).toContainText("boom-from-the-start");
  });

  test("showing a card takes the launch splash down, so the card is reachable", async ({ page }) => {
    /*
     * The bug the trace finally named. On an iOS home-screen launch the
     * service worker paints the splash, and when the launch then needs a
     * decision — a merge offer for a document already held — the card was
     * shown but the splash stayed on top of it. The person could not tap it,
     * and the open waited forever on a tap that could not land; the trace
     * stopped at "showing the launch card". The card must take the splash
     * down, because a card means there is no auto-mount to wait for.
     */
    await page.goto(RUNNER_URL);

    // The launch state, with the stall guard armed as a real launch arms it.
    await page.evaluate(() => {
      document.body.classList.add("launching");
      const runner = window as unknown as {
        __runner: { guardLaunch(t: string): void; showCard(input: unknown): Promise<void> };
      };
      runner.__runner.guardLaunch(location.href);
      void runner.__runner.showCard({
        name: "Velvet Chess",
        does: ["Play a friend at your own pace"],
        size: 900000,
        dataBytes: 0,
        createdAt: new Date().toISOString(),
        publisher: { state: "anonymous" },
        applied: [],
        from: "From a link.",
        sibling: { offer: true },
        onMerge: async () => {},
      });
    });

    // The card is up and the splash is gone.
    await expect(page.locator("#card")).toBeVisible();
    await expect(page.locator("#card-merge")).toBeVisible();
    await expect(page.locator("body")).not.toHaveClass(/launching/);

    // And past the stall threshold, the fail-safe stays quiet: a card is a
    // decision, not a stall, so Tap to open must not appear over it.
    await page.waitForTimeout(8000);
    await expect(page.locator("body")).not.toHaveClass(/launch-stalled/);
    await expect(page.locator("#launch-open")).toBeHidden();
    // The merge control is the top thing at the centre, not the splash.
    const topId = await page.evaluate(() => {
      const el = document.elementFromPoint(
        Math.floor(window.innerWidth / 2),
        Math.floor(window.innerHeight / 2),
      );
      return el?.closest("#card") ? "card" : (el?.id ?? el?.tagName ?? "");
    });
    expect(topId).toBe("card");
  });

  test("a splash that mounts before the wait never shows the control", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.evaluate((to) => {
      document.body.classList.add("launching");
      (window as unknown as { __runner: { guardLaunch(t: string): void } }).__runner.guardLaunch(to);
      // Mounted a moment later: the launch succeeded, which is the common case.
      setTimeout(() => {
        document.body.classList.remove("launching");
        document.body.classList.add("loaded");
      }, 300);
    }, `${RUNNER_URL}#u=abc`);

    // The guard fires well after the mount; because the document loaded, it must
    // do nothing. Waited past the stall threshold to be sure it stays quiet.
    await page.waitForTimeout(8000);
    await expect(page.locator("#launch-open")).toBeHidden();
    await expect(page.locator("body")).not.toHaveClass(/launch-stalled/);
  });
});
