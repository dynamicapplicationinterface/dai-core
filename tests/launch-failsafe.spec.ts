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
