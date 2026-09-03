import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildContainer } from "../src/core.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The example the walkthrough shows and the command line compiles.
 *
 * Read from the repository, because that is where it lives now: the component
 * imports these same files with ?raw, so a test that kept its own copy could
 * pass while the site handed out something else.
 */
function applicationOnScreen(): Record<string, Uint8Array> {
  const dir = resolve(repo, "examples/tasks");
  const encoder = new TextEncoder();
  return Object.fromEntries(
    ["index.html", "app.css", "app.js"].map((name) => [
      name,
      encoder.encode(readFileSync(resolve(dir, name), "utf8")),
    ]),
  );
}

/**
 * The website hands visitors a file and tells them to double-click it. This
 * opens the file the same way, drives it, and fails if it does not work.
 *
 * It exists because it caught exactly that: the sample loaded `app.js` as a
 * classic script while the code used top-level `await`, so every download was
 * an app that mounted and then did nothing.
 */
test("the app the walkthrough hands out actually runs", async ({ page }) => {
  const built = await buildContainer({
    files: applicationOnScreen(),
    template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
    runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
    appName: "Tasks",
    wasm: readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm")),
    glue: readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs")),
  });

  const file = resolve(mkdtempSync(resolve(tmpdir(), "dai-maker-")), "tasks.dai.html");
  writeFileSync(file, built.html);

  const failures: string[] = [];
  page.on("console", (message) => message.type() === "error" && failures.push(message.text()));
  page.on("pageerror", (error) => failures.push(String(error)));

  await page.goto(pathToFileURL(file).href);
  const app = page.frameLocator("iframe");

  // The seeded rows, which also prove SQLite booted and the schema ran. The
  // heading is not evidence: it is in the static HTML and renders even when the
  // application has died, which is how an earlier version of this test passed
  // against an app that did nothing at all.
  await expect(app.locator(".task")).toHaveCount(4, { timeout: 20_000 });

  await app.locator("#what").fill("Buy milk");
  await app.locator("#what").press("Enter");
  await expect(app.locator(".task")).toHaveCount(5);

  await app.locator('.task:has-text("Buy milk") .check').check();
  await expect(app.locator('.task:has-text("Buy milk")')).toHaveClass(/is-done/);

  // Filtering is a query, so this exercises the database rather than the DOM.
  await app.locator('button[data-filter="active"]').click();
  await expect(app.locator('.task:has-text("Buy milk")')).toHaveCount(0);

  await app.locator('button[data-filter="done"]').click();
  await expect(app.locator('.task:has-text("Buy milk")')).toHaveCount(1);

  // The site's claim is that a real database lives inside the file. This is
  // where that stops being a claim: the version comes from sqlite_version() and
  // the size from the serialised database, so neither can be true unless it is.
  await expect(app.locator("#engine-label")).toHaveText(/SQLite \d+\.\d+.* rows .* KB in this file/);

  // The "this is the source, not the app" notice must stay out of the way here:
  // it exists for somebody opening the folder directly, and showing it inside a
  // working container would be worse than the blank page it replaced.
  await expect(app.locator("#needs-container")).toBeHidden();
  await expect(app.locator(".shell")).toBeVisible();

  expect(failures.filter((text) => !/favicon/i.test(text))).toEqual([]);
});
