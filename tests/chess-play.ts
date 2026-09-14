import { expect, type FrameLocator } from "@playwright/test";

/**
 * Plays a move on the chess fixture the way a person does: pick the piece up,
 * see it picked up, choose where it goes, then play it.
 *
 * One helper, imported by every spec that plays chess, because four specs each
 * kept their own copy and the copies drifted. The chess app replays the last
 * move on the frame after it starts and ignores a tap while that replay runs,
 * so a tap straight after an open can land in nothing. Under load the replay
 * runs long, and the old helper — tap, tap, then wait on Play — waited fifteen
 * seconds on a button that could never enable. That was fixed in one copy
 * (mailbox-link-e2e) and failed again in another (mailbox-mechanism) on
 * Firefox in CI. See tests/README.md, "The rule for waiting".
 *
 * The piece is tapped again only if it is not already highlighted: tapping a
 * picked-up piece puts it down.
 */
export async function play(app: FrameLocator, from: string, to: string): Promise<void> {
  const piece = app.locator(`[data-square="${from}"]`);
  await expect(async () => {
    if ((await piece.getAttribute("aria-selected")) !== "true") await piece.click();
    await expect(piece).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await app.locator(`[data-square="${to}"]`).click();
  await expect(app.locator("#play-move")).toBeEnabled({ timeout: 15_000 });
  await app.locator("#play-move").click();
}
