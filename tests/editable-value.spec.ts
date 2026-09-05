import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Changing a value, not only adding and ticking one.
 *
 * The kit could add a row and toggle one, and could not change a value in
 * place: a `data-run` carried the row it was drawn from and the attributes
 * written into the document, never the thing in front of the person. So a
 * packing list could tick an item off and could not change the dates of the
 * trip, and the dates sat in the page as text nobody could touch.
 *
 * Two halves, one attribute. `data-text` fills a control's value rather than
 * its text, and `:typed` carries what was typed back into the statement.
 */
test.describe("a value somebody can type over", () => {
  test("shows what is stored, and stores what is typed", async ({ page }) => {
    test.slow();

    const source = mkdtempSync(join(tmpdir(), "dai-typed-"));
    writeFileSync(
      join(source, "schema.sql"),
      "CREATE TABLE IF NOT EXISTS trip (id INTEGER PRIMARY KEY, dates TEXT NOT NULL);",
      "utf8",
    );
    writeFileSync(
      join(source, "index.html"),
      `<!doctype html><html><head><meta charset="utf-8"><title>Trip</title></head><body>
<script type="application/sql">INSERT OR IGNORE INTO trip (id, dates) VALUES (1, 'Sat 14 - Sun 22');</script>
<dai-rows query="SELECT id, dates FROM trip WHERE id = 1">
  <template>
    <input id="dates" data-text="dates" data-run="UPDATE trip SET dates = :typed WHERE id = 1" />
  </template>
</dai-rows>
<p>now: <dai-value id="echo" query="SELECT dates FROM trip WHERE id = 1"></dai-value></p>
<script type="module" src="./dai-kit.js"></script>
</body></html>`,
      "utf8",
    );

    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Trip" });
    const file = join(source, "trip.dai.html");
    writeFileSync(file, built.html, "utf8");

    await page.goto(pathToFileURL(file).href);
    const app = page.frameLocator("iframe");

    // The reading half: the box shows what is in the database, rather than
    // sitting empty with the text hidden where nobody can see it.
    await expect(app.locator("#dates")).toHaveValue("Sat 14 - Sun 22", { timeout: 60_000 });

    await app.locator("#dates").fill("Fri 3 - Mon 6");
    await app.locator("#dates").blur();

    // The writing half: it went to the database, not just to the box. Read
    // back through a separate view, so this cannot pass on the typing alone.
    await expect(app.locator("#echo")).toHaveText("Fri 3 - Mon 6", { timeout: 30_000 });
  });
});
