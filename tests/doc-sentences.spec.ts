import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type BrowserContext } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const SENTENCE =
  "This document can be read here but not changed: this device's key could not be read. Reload the page to try again.";

/**
 * A sentence for someone looking at a document is said over it (backlog D169).
 *
 * `#report` is the chooser's line, and an open document covers it: a refusal
 * said there after the mount is on no screen, and the person looks at a
 * document that refuses their writes with nothing in view to say why. Forced
 * here with the key read failing, by name, as person-key-read does; what is
 * under test is where the sentence lands, so it is asserted exactly, visible,
 * and topmost where it is drawn.
 */
test.use({ viewport: { width: 390, height: 844 } });

async function failKeyReads(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      if (key === "dai:person-key") throw new DOMException("The key store is not answering.", "UnknownError");
      return get.call(this, key);
    } as typeof IDBObjectStore.prototype.get;
  });
}

test("a document that can be read here but not changed says so over the document, where a person sees it", async ({ browser }, info) => {
  test.slow();
  const built = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
  const file = join(mkdtempSync(join(tmpdir(), "dai-doc-sentences-")), "velvet-chess.dai.html");
  writeFileSync(file, built.html, "utf8");

  const context = await browser.newContext();
  await failKeyReads(context);
  const page = await context.newPage();
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

  const note = page.locator("#doc-note");
  await expect(note).toHaveText(SENTENCE, { timeout: 30_000 });
  await expect(note).toBeVisible();
  await expect(note, "a refusal, in the refusal's color").toHaveClass(/error/);
  const onTop = await page.evaluate(() => {
    const el = document.getElementById("doc-note")!;
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.width / 2, rect.bottom - 8);
    return hit === el || el.contains(hit);
  });
  expect(onTop, "nothing is drawn over the sentence").toBe(true);
  await page.screenshot({ path: info.outputPath("doc-sentence.png") });
  await context.close();
});
