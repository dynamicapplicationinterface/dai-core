#!/usr/bin/env node
/**
 * Captures the website's screenshots from a real container.
 *
 * The site's argument is that these files work; illustrating that with a
 * drawing would undercut it. So every image on the site is a photograph of the
 * running application, taken from a container compiled moments earlier by the
 * same command line a visitor would use.
 *
 * Reproducible on purpose: the app will change, and screenshots that can only
 * be retaken by hand quietly stop matching the thing they show.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { compileDirectory } from "../dist/compile.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shots = resolve(root, "website/public/shots");
mkdirSync(shots, { recursive: true });

const built = await compileDirectory({
  sourceDir: resolve(root, "examples/tasks"),
  root,
  appName: "Tasks",
});

const staged = resolve(shots, ".tasks.dai.html");
writeFileSync(staged, built.html, "utf8");

// Twice the pixels, so the images stay sharp on the displays this audience uses.
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1160, height: 760 },
  deviceScaleFactor: 2,
});

async function shot(name, { dark = false, prepare } = {}) {
  const page = await context.newPage();
  if (dark) await page.emulateMedia({ colorScheme: "dark" });

  await page.goto(pathToFileURL(staged).href);

  // The container's own controls belong to the runtime, not to the application.
  // Leaving them in a product shot advertises the plumbing.
  await page.addStyleTag({ content: "#dai-app-mode { display: none !important; }" });

  const app = page.frameLocator("iframe");
  await app.locator(".task").first().waitFor({ timeout: 30_000 });
  if (prepare) await prepare(app, page);

  // The container's own chrome is cropped out: it belongs to the runtime, not
  // to the application, and the site frames these images itself.
  await page.locator("iframe").screenshot({ path: resolve(shots, `${name}.png`) });
  await page.close();
  console.log(`  ${name}.png`);
}

console.log("Captured:");

await shot("app-light");
await shot("app-dark", { dark: true });

await shot("app-compose", {
  prepare: async (app) => {
    await app.locator("#what").click();
    await app.locator("#what").fill("Book the venue");
    await app.locator("#compose-tags").fill("urgent, venue");
    await app.locator("#what").click();
  },
});

await shot("app-empty", {
  prepare: async (app) => {
    await app.locator('button[data-filter="done"]').click();
    await app.locator(".task").first().waitFor();
    // Clearing the finished work is the only route to a genuinely empty list.
    await app.locator("#clear").click();
  },
});

await browser.close();

// The container was scaffolding. Leaving it in public/ would publish an
// unsigned copy of the app next to the images of it.
rmSync(staged, { force: true });

console.log(`Written to website/public/shots.`);
