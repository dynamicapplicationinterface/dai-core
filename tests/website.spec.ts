import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildContainer } from "../src/core.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pulls the application the walkthrough shows out of the component itself.
 *
 * Reading it from the source rather than restating it here is the whole point:
 * the site promises that the code on screen is the code that gets compiled, so
 * a test that kept its own copy would keep passing while the site shipped
 * something else.
 */
function applicationOnScreen(): { html: string; script: string } {
  const component = readFileSync(
    resolve(repo, "website/components/MakerWalkthrough.vue"),
    "utf8",
  );
  const literal = (name: string): string => {
    const marker = "const " + name + " = ";
    const at = component.indexOf(marker);
    if (at < 0) throw new Error("MakerWalkthrough.vue no longer defines " + name);
    const from = component.indexOf("`", at) + 1;
    const to = component.indexOf("`", from);
    // The component escapes the closing script tag so it can sit in a template
    // literal inside a `<script setup>` block.
    return component.slice(from, to).split("<" + String.fromCharCode(92) + "/script>").join("</script>");
  };
  return { html: literal("APP_SOURCE"), script: literal("APP_SCRIPT") };
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
  const source = applicationOnScreen();

  const built = await buildContainer({
    files: {
      "index.html": new TextEncoder().encode(source.html),
      "app.js": new TextEncoder().encode(source.script),
    },
    template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
    runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
    appName: "My Tasks",
    wasm: readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm")),
    glue: readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs")),
  });

  const file = resolve(mkdtempSync(resolve(tmpdir(), "dai-maker-")), "my-tasks.dai.html");
  writeFileSync(file, built.html);

  const failures: string[] = [];
  page.on("console", (message) => message.type() === "error" && failures.push(message.text()));
  page.on("pageerror", (error) => failures.push(String(error)));

  await page.goto(pathToFileURL(file).href);
  const app = page.frameLocator("iframe");

  await expect(app.locator("h1")).toHaveText("My Tasks", { timeout: 20_000 });

  await app.locator("#what").fill("Buy milk");
  await app.locator("#what").press("Enter");
  await expect(app.locator("li span")).toHaveText("Buy milk");

  // SQLite is doing the work; a checkbox that sticks proves the write landed.
  await app.locator('li input[type="checkbox"]').check();
  await expect(app.locator("li")).toHaveClass(/done/);

  expect(failures.filter((text) => !/favicon/i.test(text))).toEqual([]);
});
