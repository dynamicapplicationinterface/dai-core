import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * The tables in schema.sql exist for every app, kit or not.
 *
 * The recipe promised schema.sql "runs first when the file opens". It did —
 * when the app loaded the kit, which is what ran the block the compiler
 * injects. An app written against window.dai alone got a database with no
 * tables and failed on its first read: a person's first custom app, a
 * watch-order deck, did exactly that and "nothing worked". Now the runtime
 * runs the document's SQL when the database opens, schema first, seeds
 * after, each once.
 */
test.describe("schema.sql without the kit", () => {
  test("the tables are there on the first read, the seed rows once, and a write survives a reload", async ({ page }) => {
    test.slow();
    const dir = mkdtempSync(join(tmpdir(), "dai-schema-run-"));
    writeFileSync(join(dir, "schema.sql"), "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n", "utf8");
    writeFileSync(
      join(dir, "index.html"),
      [
        '<!doctype html><meta charset="utf-8">',
        '<script type="application/sql">',
        "  INSERT INTO settings (key, value) SELECT 'mode', 'recommended' WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'mode');",
        "</script>",
        '<p id="out">—</p><button id="bump" type="button">bump</button>',
        '<script type="module">',
        "  const db = await window.dai.openDatabase();",
        "  const draw = () => { document.getElementById('out').textContent = db.selectObjects('SELECT key, value FROM settings ORDER BY key').map((r) => r.key + '=' + r.value).join(','); };",
        "  document.getElementById('bump').onclick = () => { db.exec({ sql: \"INSERT INTO settings (key, value) VALUES ('bumped', '1') ON CONFLICT(key) DO UPDATE SET value = value || '1'\" }); draw(); };",
        "  draw();",
        "</script>",
      ].join("\n"),
      "utf8",
    );
    const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "Plain" });
    const file = join(dir, "plain.dai.html");
    writeFileSync(file, built.html, "utf8");

    await page.goto(RUNNER_URL);
    await openFile(page, file);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    const app = page.frameLocator("#cartridge").frameLocator("#dai-app");
    // No kit on the page, and the first read works, seed included.
    await expect(app.locator("#out")).toHaveText("mode=recommended", { timeout: 30_000 });

    // A write, saved with nothing pressed, and the seed not doubled on reopen.
    await app.locator("#bump").click();
    await expect(app.locator("#out")).toHaveText("bumped=1,mode=recommended");
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });
    const again = page.frameLocator("#cartridge").frameLocator("#dai-app");
    await expect(again.locator("#out")).toHaveText("bumped=1,mode=recommended", { timeout: 30_000 });
  });
});
