import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const SENTENCE = "The move that arrived couldn't be added to your copy, so your copy is as it was.";

/**
 * The sentence over an open document has a row of its own.
 *
 * It was a pill in the floating controls: on a 390-point screen it wrapped
 * past their height, and its translucent ground let the application's own
 * words show through the sentence — the date line under the title, in the
 * screenshot that filed it (cold review of c424598, Q2.3). A row: full width,
 * opaque, clear of the controls, and the application moves down for it.
 */
test.use({ viewport: { width: 390, height: 844 } });

async function openWithNote(page: Page, badge: boolean): Promise<void> {
  const built = await compileDirectory({
    sourceDir: join(repo, "examples", "packing-list"),
    root: repo,
    appName: "Beach trip",
  });
  const file = join(mkdtempSync(join(tmpdir(), "dai-doc-note-")), "trip.dai.html");
  writeFileSync(file, built.html, "utf8");
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
  await page.locator("#card-open").click();
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  await expect(page.locator("#launch")).toBeHidden({ timeout: 60_000 });
  await page.evaluate(
    ([sentence, withBadge]) => {
      const note = document.getElementById("doc-note")!;
      note.textContent = sentence as string;
      note.hidden = false;
      if (withBadge) {
        const badgeEl = document.getElementById("save-state")!;
        badgeEl.hidden = false;
        badgeEl.dataset.state = "failed";
        badgeEl.textContent = "Not saved";
      }
    },
    [SENTENCE, badge] as const,
  );
}

for (const badge of [false, true]) {
  test(`the sentence is a row of its own, ${badge ? "beside a failed save" : "on its own"}`, async ({ page }) => {
    await openWithNote(page, badge);
    const note = page.locator("#doc-note");
    const box = (await note.boundingBox())!;
    expect(box.x, "the full width of the screen").toBe(0);
    expect(box.width).toBe(390);
    expect(box.height, "one or two lines, not a paragraph").toBeLessThanOrEqual(120);

    // The application starts below it: nothing of the document is behind it.
    const frame = (await page.locator("#cartridge").boundingBox())!;
    expect(frame.y, "the application moved down for the row").toBeGreaterThanOrEqual(box.y + box.height - 1);

    /*
     * The sentence is the topmost thing where it is drawn. Read from the page,
     * because "opaque" and "clear of the controls" are both about what a
     * person's eye lands on, and a hit test is that question asked exactly.
     */
    const onTop = await page.evaluate(() => {
      const note = document.getElementById("doc-note")!;
      const rect = note.getBoundingClientRect();
      const top = Number.parseFloat(getComputedStyle(note).paddingTop);
      const points = [
        [12, rect.top + top + 6],
        [rect.width / 2, rect.top + top + 6],
        [rect.width - 12, rect.bottom - 8],
      ] as const;
      return points.map(([x, y]) => document.elementFromPoint(x, y)?.id ?? "(none)");
    });
    expect(onTop, "the sentence is what is on screen where the sentence is").toEqual([
      "doc-note",
      "doc-note",
      "doc-note",
    ]);

    // And the controls are still reachable, not buried under the row.
    await expect(page.locator("#more")).toBeVisible();
    const more = (await page.locator("#more").boundingBox())!;
    const atMore = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x as number, y as number)?.id ?? "(none)",
      [more.x + more.width / 2, more.y + more.height / 2] as const,
    );
    expect(atMore, "the menu is pressable where it is drawn").toBe("more");
  });
}
