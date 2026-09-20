import { expect, type Frame, type Page } from "@playwright/test";
import { FRAME_PUBLIC } from "../src/frame.js";

/** The application's own frame: main → shell → app. */
export const appFrameOf = (page: Page): Frame => {
  const frame = page.frames().find((f) => f.parentFrame()?.parentFrame() === page.mainFrame());
  if (!frame) throw new Error("app frame not found (main → shell → app)");
  return frame;
};

/**
 * Waits until this copy has taken in its first merge from its mailbox.
 *
 * A copy that has just been pointed at the relay pulls, merges and redraws. A
 * test that taps in that window is racing the redraw: before D79 the tap was
 * lost outright, and the app now holds the redraw back while a pointer is down,
 * so the race is no longer a failure — it is still a race, and what a test means
 * by "the other player's rows are here" is this, not a sleep.
 */
export async function firstMailboxMerge(page: Page, timeout = 30_000): Promise<void> {
  await appFrameOf(page).evaluate((merged) => {
    const held = window as unknown as { __merges?: number };
    if (held.__merges !== undefined) return;
    held.__merges = 0;
    window.addEventListener(merged, (event) => {
      if ((event as CustomEvent).detail?.via === "mailbox") held.__merges = (held.__merges ?? 0) + 1;
    });
  }, FRAME_PUBLIC.MERGED);
  await expect
    .poll(() => appFrameOf(page).evaluate(() => (window as unknown as { __merges?: number }).__merges ?? 0), { timeout })
    .toBeGreaterThan(0);
}
