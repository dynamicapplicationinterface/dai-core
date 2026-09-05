import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = resolve(repo, "tests/fixture/fixture.dai.html");
const RUNNER_URL = "http://localhost:5175/";

const read = (path: string): string => readFileSync(resolve(repo, path), "utf8");

/**
 * Integrations are for the second use, never the first (backlog 3.6).
 *
 * `share_target`, `file_handlers` and the desktop file association are all
 * worth having, and all of them are the same mistake if they arrive first: a
 * person who was sent a document and is told to install something before they
 * can read it has been handed a chore, not a document. The whole claim of this
 * format is that the thing you were sent already works.
 *
 * So the rule is a rule about ordering, and this is what keeps it true — the
 * copy drifts one helpful sentence at a time, and each of those sentences
 * looks reasonable on its own.
 */
test.describe("nothing is installed before the first document opens", () => {
  test("the manifest keeps its integrations, and none of them is the way in", () => {
    const manifest = JSON.parse(read("apps/runner/public/manifest.webmanifest")) as {
      share_target?: unknown;
      file_handlers?: unknown;
      start_url?: string;
    };

    // They exist — this is not an argument for having fewer of them.
    expect(manifest.share_target, "share_target should still be offered").toBeTruthy();
    expect(manifest.file_handlers, "file_handlers should still be offered").toBeTruthy();

    // And every one of them is reachable only once the app is installed,
    // which is a thing somebody does after their document has already run.
    expect(manifest.start_url).toBeTruthy();
  });

  test("the card offers no install, and the install bar is not on screen at load", async ({
    page,
  }) => {
    await page.goto(RUNNER_URL);

    // Nothing on the first screen asks anybody to install anything.
    await expect(page.locator("#install")).toBeHidden();

    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });

    // The card is the last screen before a document runs, and the moment a
    // prompt would be most effective and least honest.
    await expect(page.locator("#install")).toBeHidden();
    const card = await page.locator("#card").innerText();
    expect(card.toLowerCase()).not.toContain("install");
    expect(card.toLowerCase()).not.toContain("home screen");

    // Only after it has run is there anything to keep. (Whether the bar then
    // appears is the browser's call — 1.3 owns that; what is asserted here is
    // that nothing asked before.)
    await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  });

  test("the page that tells somebody how to open one says it needs nothing, first", () => {
    const open = read("website/open.md");

    // The instruction that works with nothing installed has to come before
    // every offer to install something, on the page a person lands on holding
    // a file they cannot read.
    const nothing = open.toLowerCase().indexOf("nothing to install");
    expect(nothing, "open.md should say the page needs nothing").toBeGreaterThan(-1);

    for (const later of ["Add it to your home screen", "install [the desktop app]"]) {
      const at = open.indexOf(later);
      expect(at, `open.md should still mention: ${later}`).toBeGreaterThan(-1);
      expect(at, `"${later}" must come after "nothing to install"`).toBeGreaterThan(nothing);
    }

    // The desktop page is an install page, so it says what it is for — but it
    // opens by saying a file already works without it.
    const desktop = read("website/desktop.md");
    expect(desktop.slice(0, 600)).toContain("nothing installed");
  });
});
