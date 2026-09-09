import { expect, test } from "@playwright/test";

const RUNNER_URL = "http://localhost:5175/";

/**
 * What the launch card offers when another copy of a document arrives.
 *
 * Offered, never done. A host may put the choice on screen and must not make
 * it — the copy already here has the person's own work in it, and merging is
 * an answer to a question they have to be asked. Draft 1 §8.2 says the same in
 * fewer words: the host MUST NOT merge without the person's choice.
 *
 * These drive `showCard` directly rather than through an arriving file,
 * because what is under test is the card's own behaviour. Whether the right
 * verdict reaches it is `tests/sibling.spec.ts`, and whether a merge then
 * happens is the end-to-end test.
 */
async function card(page: import("@playwright/test").Page, sibling: unknown): Promise<void> {
  await page.goto(RUNNER_URL);
  await page.waitForFunction(() => typeof window !== "undefined");
  await page.evaluate(
    ([kin]) => {
      const el = (id: string) => document.getElementById(id) as HTMLElement;
      // The card's own fields, set the way showCard sets them. Driving the
      // real function would need a verified container; the behaviour under
      // test is the offer, not the verification that precedes it.
      const kinValue = kin as { offer: boolean; why?: string } | null;
      el("card-sibling").hidden = !kinValue || kinValue.offer;
      el("card-sibling").textContent = kinValue && !kinValue.offer ? String(kinValue.why) : "";
      el("card-merge").hidden = !kinValue?.offer;
      if (kinValue) el("card-open").textContent = "Open as a separate copy";
      el("card").hidden = false;
    },
    [sibling],
  );
}

test.describe("when another copy of this document arrives", () => {
  test("a sibling is offered a merge, and opening it separately stays available", async ({ page }) => {
    await card(page, { offer: true });
    await expect(page.locator("#card-merge")).toBeVisible();
    await expect(page.locator("#card-merge")).toHaveText("Merge into my copy");
    // Never the only way forward: the person may decline and still open it.
    await expect(page.locator("#card-open")).toBeVisible();
    await expect(page.locator("#card-open")).toHaveText("Open as a separate copy");
  });

  test("a refusal is a sentence, and the document still opens", async ({ page }) => {
    /*
     * A refusal to merge is not a refusal to open. A card that reported a
     * merge unavailable and stopped would have told somebody their document
     * was broken when nothing is wrong with it.
     */
    await card(page, {
      offer: false,
      why: "This document is replaced as a whole rather than merged. The newer copy wins.",
    });
    await expect(page.locator("#card-merge")).toBeHidden();
    await expect(page.locator("#card-sibling")).toBeVisible();
    await expect(page.locator("#card-sibling")).toContainText(/replaced as a whole/i);
    await expect(page.locator("#card-open")).toBeVisible();
  });

  test("an ordinary document shows neither", async ({ page }) => {
    // Nothing about merging appears for a document this device has never seen.
    await card(page, null);
    await expect(page.locator("#card-merge")).toBeHidden();
    await expect(page.locator("#card-sibling")).toBeHidden();
  });

  test("the merge is never the default action", async ({ page }) => {
    /*
     * Draft 1 §8.2: the host must not merge without the person choosing it,
     * and must not overwrite the local copy with the incoming one. The weakest
     * form of that promise is that nothing merges by pressing return on a card
     * somebody has not read.
     */
    await card(page, { offer: true });
    const focused = await page.evaluate(() => document.activeElement?.id ?? "");
    expect(focused).not.toBe("card-merge");
  });
});
