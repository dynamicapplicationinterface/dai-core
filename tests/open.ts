import type { Page } from "@playwright/test";

/**
 * Opens a file in the opener the way a person does.
 *
 * Since 1.2 the launch card is keyed on familiarity rather than on carrier: a
 * document this device has not seen before lands on the card however it
 * arrived, a file the person picked included. So "choose a file" is two
 * gestures the first time and one every time after, and a test that only did
 * the first would sit waiting for a mount that is waiting for a click.
 *
 * This waits for whichever comes first — the card, the mount, or a refusal —
 * and presses Open if it is the card. A test that wants to assert on the card
 * itself should not use this; it should look at the card.
 */
export async function openFile(
  page: Page,
  file: Parameters<Page["setInputFiles"]>[1],
): Promise<void> {
  await page.setInputFiles("#file", file);
  const outcome = page.locator("#card-open:visible, body.loaded, #report.error").first();
  await outcome.waitFor({ timeout: 60_000 }).catch(() => {
    /* Nothing happened in time; the caller's own assertion will say so. */
  });
  const open = page.locator("#card-open");
  if (await open.isVisible()) await open.click();
}
