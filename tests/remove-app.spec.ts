import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { encodeInline } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const HOST = {
  template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
  runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
};

/**
 * Removing a document, and what is left standing.
 *
 * The head script hides the chooser's pitch and its button when the address
 * names a document, so a link never flashes "Open a file" on its way to the
 * card. Nothing took that class off again once a document had opened — so
 * removing the document from a home-screen app left the chooser on screen
 * with everything on it hidden: an empty page, black in dark mode, with
 * nothing to press. The person who found it had to close the app.
 */
async function linkFor(): Promise<string> {
  const source = mkdtempSync(join(tmpdir(), "dai-remove-"));
  writeFileSync(
    join(source, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta name="description" content="A small list"><p id="app">here</p>',
    "utf8",
  );
  const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Small list" });
  return encodeInline(built.html, HOST);
}

test.describe("removing a document from this device", () => {
  test("gives the chooser back, rather than an empty screen", async ({ page }) => {
    test.slow();
    const value = await linkFor();
    await page.goto(`${RUNNER_URL}#a=${value}`);
    await page.reload();

    // Arriving by a link: the chooser is out of the way before the first paint.
    await expect(page.locator("html")).toHaveClass(/arriving/);
    await expect(page.locator("#open")).toBeHidden();

    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    // Once something is open the class has done its work and comes off.
    await expect(page.locator("html")).not.toHaveClass(/arriving/);

    page.once("dialog", (dialog) => {
      // The question says what removing does and what it cannot do.
      expect(dialog.message()).toContain("home screen");
      void dialog.accept();
    });
    await page.click("#more");
    await page.click("#remove");

    // Back at a chooser somebody can actually use, and told what happened.
    await expect(page.locator("body")).not.toHaveClass(/loaded/, { timeout: 30_000 });
    await expect(page.locator("#open")).toBeVisible();
    await expect(page.locator("#report")).toContainText(/was removed/);
  });

  test("the chooser is not on screen while a document is opening", async ({ page }) => {
    // It used to dim to 0.6 while a document was read and mounted, which is
    // the same thing as staying on screen: somebody opening an app saw the
    // pitch and a blue button flash between the screen they answered and the
    // app they answered it for.
    //
    // The invariant is that the chooser's own pitch (#open) does not linger
    // while a document is opening — true across both the familiarity card and
    // the mount. The earlier version asserted the transient `busy` class on
    // #slot instead, which is present only for the milliseconds of the pre-card
    // ingest and, on the card path, not at all before Open is pressed: an
    // implementation detail that happened to be observable, and a flake once the
    // card became a legitimate step. Assert the invariant, not the detail.
    const source = mkdtempSync(join(tmpdir(), "dai-busy-"));
    // Unique body per run, so the document is unfamiliar to whatever device the
    // test lands on and deterministically takes the familiarity-card path — its
    // uuid follows its bytes. Without this the flow forked on leftover storage.
    const token = Math.random().toString(36).slice(2);
    writeFileSync(join(source, "index.html"), `<!doctype html><meta charset="utf-8"><p id="app">here ${token}</p>`, "utf8");
    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Quiet" });
    const file = join(source, "quiet.dai.html");
    writeFileSync(file, built.html, "utf8");

    await page.goto(RUNNER_URL);
    await expect(page.locator("#open")).toBeVisible();
    await page.setInputFiles("#file", file);

    // An unfamiliar document lands on the familiarity card first (see
    // tests/open.ts); the chooser's pitch is already gone. Its Open begins the
    // mount, through which the pitch stays gone.
    const cardOpen = page.locator("#card-open");
    await cardOpen.click({ timeout: 30_000 });

    // Nothing of the opener's own pitch shows while the document opens, and it
    // opens: the application reaches the screen.
    await expect(page.locator("#open")).toBeHidden();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });
    await expect(page.locator("#open")).toBeHidden();
  });
});
