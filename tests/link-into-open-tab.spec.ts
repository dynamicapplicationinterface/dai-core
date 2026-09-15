import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { inlineLink } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const HOST = {
  template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
  runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
};

/** A small document that says which one it is, as an inline link to this opener. */
async function linkTo(name: string, marker: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dai-open-tab-"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta name="description" content="${name}"><p id="marker">${marker}</p>`,
    "utf8",
  );
  const built = await compileDirectory({ sourceDir: dir, root: repo, appName: name });
  const link = await inlineLink(built.html, RUNNER_URL, HOST);
  if (!link) throw new Error("expected an inline link");
  return link;
}

/**
 * A link followed in a tab that already shows a document.
 *
 * Two inline links to this opener differ only after the `#`, so following the
 * second from a tab showing the first is a same-document navigation: no load,
 * no script runs again. The opener listened for that but returned whenever a
 * document was open, so the address changed and the screen did not — the first
 * document stayed up under a link for the second, and nothing said so. The same
 * silence as a second invite showing the old game, by a different door.
 */
test("a second document's link, followed in a tab showing the first, opens the second", async ({ page }) => {
  const first = await linkTo("First", "the first document");
  const second = await linkTo("Second", "the second document");
  const app = page.frameLocator("#cartridge").frameLocator("#dai-app");

  await page.goto(first);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(app.locator("#marker")).toHaveText("the first document", { timeout: 60_000 });

  // Same page, new fragment: the navigation a person makes by following the
  // second link here. Nothing reloads unless the opener makes it.
  await page.goto(second);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(app.locator("#marker")).toHaveText("the second document", { timeout: 60_000 });
});
