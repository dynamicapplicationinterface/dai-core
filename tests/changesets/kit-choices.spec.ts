import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "../fixtures.js";
import { compileDirectory } from "../../src/compile.js";

/**
 * What Build 2a's ten cold apps reached for in the kit, through the real
 * runtime (the data in the worker, R-Y). All ten put data-run on a plain
 * button and data-when on whatever they wanted hidden; the kit does both, and
 * the model file now shows them. Two needed a select filled from a table:
 * one redesigned around it, one wrote its own script. The kit now fills one:
 * <select data-options="SELECT id, name FROM people">, value then label.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER_URL = "http://localhost:5175/";

const INDEX = `<!doctype html>
<html><head><meta charset="utf-8"><title>Chores</title></head>
<body>
<script type="application/sql">
INSERT INTO people (name) VALUES ('Ada'), ('Bo');
INSERT INTO chores (title, person_id) SELECT 'Dishes', id FROM people WHERE name = 'Ada';
</script>
<dai-form id="person" run="INSERT INTO people (name) VALUES (:name)">
  <input name="name" required><button type="button">Add person</button>
</dai-form>
<dai-form id="chore" run="INSERT INTO chores (title, person_id) VALUES (:title, :person_id)">
  <input name="title" required>
  <select name="person_id" data-options="SELECT id, name FROM people ORDER BY name"><option value="">Who?</option></select>
  <button type="button">Add chore</button>
</dai-form>
<dai-rows id="chores" query="SELECT c.id, c.title, p.name AS who, c.done FROM chores c JOIN people p ON p.id = c.person_id ORDER BY c.id">
  <template><li><span class="title" data-text="title"></span> <span class="who" data-text="who"></span>
    <button class="done" type="button" data-run="UPDATE chores SET done = 1 WHERE id = :id">Done</button>
    <label class="mark" data-when="done">done</label></li></template>
</dai-rows>
<script type="module" src="./dai-kit.js"></script>
</body></html>
`;

async function open(page: Page): Promise<FrameLocator> {
  const src = join(mkdtempSync(join(tmpdir(), "dai-kit-choices-")), "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "index.html"), INDEX);
  writeFileSync(
    join(src, "schema.sql"),
    "CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\nCREATE TABLE IF NOT EXISTS chores (id INTEGER PRIMARY KEY, title TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES people(id), done INTEGER NOT NULL DEFAULT 0);\n",
  );
  const built = await compileDirectory({ sourceDir: src, root: repo, appName: "Chores" });
  const file = join(src, "..", "chores.dai.html");
  writeFileSync(file, built.html, "utf8");
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const app = page.frameLocator("iframe").frameLocator("iframe");
  await expect(app.locator("html")).toHaveAttribute("data-dai-kit", "ready", { timeout: 60_000 });
  return app;
}

const choices = (app: FrameLocator): Promise<string[]> =>
  app.locator("#chore select option").evaluateAll((os) => os.map((o) => `${(o as HTMLOptionElement).value}:${o.textContent}`).map((s) => s.replace(/^\d+:/, "#:")));

test.describe("the kit, as the cold apps used it", () => {
  test.slow();

  test("a select is filled from its query, keeps what is chosen across a redraw, and the form sends its value", async ({ page }) => {
    const app = await open(page);
    await expect.poll(() => choices(app), { timeout: 30_000 }).toEqual([":Who?", "#:Ada", "#:Bo"]);

    await app.locator("#chore select").selectOption({ label: "Bo" });
    await app.locator("#person input").fill("Cy");
    await app.locator("#person button").click();
    await expect.poll(() => choices(app), { timeout: 30_000, message: "a new person is a new choice" }).toEqual([":Who?", "#:Ada", "#:Bo", "#:Cy"]);
    expect(await app.locator("#chore select").evaluate((s) => (s as HTMLSelectElement).selectedOptions[0]?.textContent), "the choice survived the redraw").toBe("Bo");

    await app.locator("#chore input").fill("Bins");
    await app.locator("#chore button").click();
    await expect(app.locator("#chores li").last().locator(".who")).toHaveText("Bo", { timeout: 30_000 });
  });

  test("data-run on a plain button runs when it is clicked, and data-when shows any element", async ({ page }) => {
    const app = await open(page);
    const row = app.locator("#chores li").first();
    await expect(row.locator(".mark")).toBeHidden();
    await row.locator("button.done").click();
    await expect(row.locator(".mark")).toBeVisible({ timeout: 30_000 });
  });
});
