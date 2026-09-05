import { expect, test } from "@playwright/test";

const RUNNER_URL = "http://localhost:5175/";
const SITE_URL = "http://localhost:5176/";
const LINE = "Send an app like you send a document.";

/**
 * One sentence, everywhere somebody meets this for the first time.
 *
 * A person who has been sent a file has no idea what category of thing they
 * are holding, and every surface that answers that question with different
 * words makes it a different thing each time. So it is one sentence, written
 * once, on the card and on the page a file leads to.
 *
 * And three words that are ours rather than theirs. "Runtime", "PWA" and
 * "opener" all name something real, and none of them names it from where the
 * reader is standing — somebody who was sent a file is not looking for a
 * runtime.
 */
const OURS = [/\bruntimes?\b/i, /\bPWAs?\b/i, /\bopeners?\b/i];

test.describe("the sentence a stranger is met with", () => {
  test("stands on the card", async ({ page }) => {
    await page.goto(RUNNER_URL);
    // Present in the markup rather than raised by a code path, so it is on the
    // card whichever carrier put the card up.
    await expect(page.locator("#card-line")).toHaveText(LINE);
  });

  test("stands on the page a file leads to", async ({ page }) => {
    await page.goto(`${SITE_URL}open.html`);
    await expect(page.locator("body")).toContainText(LINE);
  });

  test("that page says nothing in our words", async ({ page }) => {
    await page.goto(`${SITE_URL}open.html`);
    // The visible text only. Link targets and code samples are not what
    // somebody reads.
    const words = await page.locator("main").innerText();
    for (const ours of OURS) {
      expect(words, `"${ours}" is our word, not theirs`).not.toMatch(ours);
    }
  });

  test("the message a shared document travels in carries it", async () => {
    // Read from the source, because the share sheet is the one surface a test
    // cannot open: this is the text handed to it.
    const { readFileSync } = await import("node:fs");
    const main = readFileSync("apps/runner/src/main.ts", "utf8");
    expect(main).toContain(`const STANDING_LINE = "${LINE}";`);
    expect(main).toContain("${STANDING_LINE}");
  });
});
