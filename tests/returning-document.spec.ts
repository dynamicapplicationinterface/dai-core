import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * A document that comes back.
 *
 * Everything the carriers do is distribution: one person makes a document and
 * others receive it. Correspondence is the document returning — a move made
 * and sent back, to somebody who already holds the same document. Two people
 * playing chess by link is the whole of it, and it is the case that was never
 * tested.
 *
 * What a person saw: the move never arrived. The same link in a private window
 * showed it, which says the arriving data was read and then discarded in
 * favour of what this device had already stored.
 */
async function board(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dai-correspondence-"));
  writeFileSync(
    join(dir, "schema.sql"),
    "CREATE TABLE IF NOT EXISTS moves (n INTEGER PRIMARY KEY, san TEXT NOT NULL);",
    "utf8",
  );
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta name="description" content="A game by post">' +
      '<p id="app">…</p><button id="move">Move</button>' +
      '<script type="module">\n' +
      "const db = await window.dai.openDatabase();\n" +
      "const draw = () => {\n" +
      "  const rows = db.selectObjects('SELECT san FROM moves ORDER BY n');\n" +
      "  document.getElementById('app').textContent = rows.map((r) => r.san).join(' ') || 'no moves';\n" +
      "};\n" +
      "document.getElementById('move').onclick = () => {\n" +
      "  const next = db.selectValue('SELECT COALESCE(MAX(n), 0) + 1 FROM moves');\n" +
      "  db.exec({ sql: 'INSERT INTO moves (n, san) VALUES (?, ?)', bind: [next, 'move' + next] });\n" +
      "  draw();\n" +
      "};\n" +
      "draw();\n" +
      "</script>",
    "utf8",
  );
  const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "Postal Chess" });
  const file = join(dir, "chess.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

/** Waits for a save that happened after this call, not one from before it. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById("save-state");
    if (el) el.textContent = "";
  });
  await expect(page.locator("#save-state")).toHaveText(/Saved/, { timeout: 30_000 });
  // The library write follows the OPFS write inside the same lock.
  await page.waitForTimeout(600);
}

/** Answers the launch card if one appears, and waits until the app is running. */
async function through(page: Page): Promise<boolean> {
  const card = page.locator("#card-open");
  await card.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
  const shown = await card.isVisible();
  if (shown) await card.click();
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  return shown;
}

const inside = (page: Page) => page.frameLocator("#cartridge").frameLocator("#dai-app");

/** Opens a file and waits for the application to be running. */
async function open(page: Page, file: string): Promise<void> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await through(page);
  await expect(inside(page).locator("#app")).toBeVisible({ timeout: 60_000 });
}

/** Shares the open document and returns the link that reached the clipboard. */
async function shareLink(page: Page): Promise<string> {
  await page.evaluate(() => {
    (window as unknown as { __copied?: string }).__copied = undefined;
    navigator.clipboard.writeText = async (text: string) => {
      (window as unknown as { __copied?: string }).__copied = text;
    };
  });
  await page.click("#more");
  await page.click("#send");
  await page.click("#send-go");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied), {
      timeout: 60_000,
    })
    .toBeTruthy();
  return (await page.evaluate(
    () => (window as unknown as { __copied?: string }).__copied,
  )) as string;
}

test.describe("a move sent back to somebody who has the app", () => {
  test("arrives, instead of being replaced by what this device already had", async ({ browser }) => {
    test.slow();
    const file = await board();

    // Her device: she has the game and makes a move.
    const hers = await browser.newContext();
    const alice = await hers.newPage();
    await open(alice, file);
    await inside(alice).locator("#move").click();
    await expect(inside(alice).locator("#app")).toHaveText("move1");
    // Saved, so the share carries it rather than the state it opened with.
    await settled(alice);
    const link = await shareLink(alice);
    await hers.close();

    // His device: the same game, already open, with no moves in it.
    const his = await browser.newContext();
    const bob = await his.newPage();
    await open(bob, file);
    await expect(inside(bob).locator("#app")).toHaveText("no moves");

    // Her link, followed on his device — the app is the one he already has,
    // and the only thing that changed is the data.
    await bob.goto("about:blank");
    await bob.goto(link);
    // Answered if it appears, so the data underneath can be looked at on its
    // own. Whether it should appear at all is the next test.
    await through(bob);

    // Her move, not his empty board. This is what failed: his stored database
    // was mounted over hers, and the move was silently dropped.
    await expect(inside(bob).locator("#app")).toHaveText("move1", { timeout: 60_000 });
    await his.close();
  });

  test("a link older than what this device holds does not roll it back", async ({ browser }) => {
    test.slow();
    const file = await board();

    // He shares the board before either of them has moved.
    const his = await browser.newContext();
    const bob = await his.newPage();
    await open(bob, file);
    const stale = await shareLink(bob);

    // Then plays two moves of his own.
    await inside(bob).locator("#move").click();
    await inside(bob).locator("#move").click();
    await expect(inside(bob).locator("#app")).toHaveText("move1 move2");
    await settled(bob);

    // The old link, opened again — a message scrolled back to, or sent twice.
    // What he has is newer, and newer wins: a game does not go backwards.
    await bob.goto("about:blank");
    await bob.goto(stale);
    await through(bob);
    await expect(inside(bob).locator("#app")).toHaveText("move1 move2", { timeout: 60_000 });
    await his.close();
  });
});
