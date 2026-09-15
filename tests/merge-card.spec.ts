import { expect, test, type Page } from "@playwright/test";

const RUNNER_URL = "http://localhost:5175/";

/**
 * What the launch card offers when another copy of a document arrives.
 *
 * One action, and it says what it does. This host keeps one copy of each
 * document, so "open another copy of something I have" can only mean adding
 * what it carries to mine, or replacing mine with it — and replacing is never
 * what anybody asked for. The card used to offer both *Merge into my copy* and
 * *Open as a separate copy*; the second made no separate copy, and a person
 * following a second invite pressed it and played a whole game in the old one.
 *
 * Draft 1 §8.2 still holds: the host must not merge without the person
 * choosing it. Pressing a button that says *Open in my copy* is that choice;
 * what must never happen is a merge from a key pressed on a card nobody has
 * read, so focus does not land on the action.
 *
 * These drive the real `showCard`. An earlier version re-created its logic in
 * the test, which is how a test keeps passing after the code it copied changes.
 */
async function card(page: Page, sibling: unknown): Promise<void> {
  await page.goto(RUNNER_URL);
  await page.evaluate(
    ([kin]) => {
      const w = window as unknown as {
        __merged?: boolean;
        __opened?: boolean;
        __runner: { showCard(input: unknown): Promise<void> };
      };
      w.__merged = false;
      w.__opened = false;
      void w.__runner
        .showCard({
          name: "Velvet Chess",
          does: ["Play a friend at your own pace"],
          size: 900000,
          dataBytes: 0,
          createdAt: new Date().toISOString(),
          publisher: { state: "anonymous" },
          applied: [],
          from: "From a link.",
          ...(kin ? { sibling: kin } : {}),
          onMerge: () => {
            w.__merged = true;
          },
        })
        .then(() => {
          w.__opened = true;
        });
    },
    [sibling],
  );
  await expect(page.locator("#card")).toBeVisible();
}

const outcome = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __merged?: boolean; __opened?: boolean };
    return { merged: Boolean(w.__merged), opened: Boolean(w.__opened) };
  });

test.describe("when another copy of this document arrives", () => {
  test("a copy of something already here offers one action, and it merges", async ({ page }) => {
    await card(page, { offer: true });
    await expect(page.locator("#card-open")).toHaveText("Open in my copy");
    await expect(page.locator("#card-merge"), "no second button offering what the first one does").toHaveCount(0);
    await expect(page.locator("#card-sibling")).toContainText("nothing you have is replaced");
    await page.locator("#card-open").click();
    await expect.poll(() => outcome(page)).toEqual({ merged: true, opened: false });
  });

  test("a refusal is a sentence, and the ordinary action opens", async ({ page }) => {
    /*
     * A refusal to merge is not a refusal to open. A card that reported a
     * merge unavailable and stopped would have told somebody their document
     * was broken when nothing is wrong with it.
     */
    await card(page, {
      offer: false,
      why: "This document is replaced as a whole rather than merged. The newer copy wins.",
    });
    await expect(page.locator("#card-sibling")).toBeVisible();
    await expect(page.locator("#card-sibling")).toContainText(/replaced as a whole/i);
    await expect(page.locator("#card-open")).not.toHaveText("Open in my copy");
    await page.locator("#card-open").click();
    await expect.poll(() => outcome(page)).toEqual({ merged: false, opened: true });
  });

  test("an ordinary document says nothing about merging", async ({ page }) => {
    // Nothing about merging appears for a document this device has never seen.
    await card(page, null);
    await expect(page.locator("#card-sibling")).toBeHidden();
    await expect(page.locator("#card-open")).toHaveText("Get");
    await page.locator("#card-open").click();
    await expect.poll(() => outcome(page)).toEqual({ merged: false, opened: true });
  });

  test("the merge is never taken by a key nobody meant", async ({ page }) => {
    /*
     * Draft 1 §8.2: the host must not merge without the person choosing it.
     * The weakest form of that promise is that pressing return on a card
     * somebody has not read merges nothing.
     */
    await card(page, { offer: true });
    const focused = await page.evaluate(() => document.activeElement?.id ?? "");
    expect(focused).not.toBe("card-open");
    await page.keyboard.press("Enter");
    expect(await outcome(page)).toEqual({ merged: false, opened: false });
  });
});
