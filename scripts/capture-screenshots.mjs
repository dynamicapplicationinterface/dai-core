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

/*
 * The front page's phones.
 *
 * Three apps that are nobody's product: a week of dinners, a chore chart, a
 * packing list. The page's first argument is "you would recognise yourself in
 * one of these", and a task manager — however good — is a thing engineers
 * recognise themselves in. Each is compiled here from examples/ the same way,
 * so what the page shows is what the format makes.
 *
 * Shot at a phone's size because that is where most people who arrive
 * confused are standing.
 */
const phone = await browser.newContext({
  viewport: { width: 390, height: 780 },
  deviceScaleFactor: 2,
});

async function phoneShot(name, dir, appName, { dark = false } = {}) {
  const compiled = await compileDirectory({ sourceDir: resolve(root, "examples", dir), root, appName });
  const file = resolve(shots, `.${dir}.dai.html`);
  writeFileSync(file, compiled.html, "utf8");

  const page = await phone.newPage();
  if (dark) await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(pathToFileURL(file).href);
  await page.addStyleTag({ content: "#dai-app-mode { display: none !important; }" });

  const app = page.frameLocator("iframe");
  // The kit has drawn when a row exists that is not the template it drew from.
  await app.locator("dai-rows > :not(template)").first().waitFor({ timeout: 30_000 });
  // A frame's worth of layout, so a font that arrived late is in the picture.
  await page.waitForTimeout(150);

  await page.locator("iframe").screenshot({ path: resolve(shots, `${name}.png`) });
  await page.close();
  rmSync(file, { force: true });
  console.log(`  ${name}.png`);
}

await phoneShot("home-dinners", "meal-plan", "This week");
await phoneShot("home-chores", "chore-chart", "Chores");
await phoneShot("home-packing", "packing-list", "Beach trip");

// And one of them at a laptop's size, for the beat about it being a file.
{
  const compiled = await compileDirectory({ sourceDir: resolve(root, "examples/meal-plan"), root, appName: "This week" });
  const file = resolve(shots, ".meal-plan-wide.dai.html");
  writeFileSync(file, compiled.html, "utf8");
  const page = await context.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.addStyleTag({ content: "#dai-app-mode { display: none !important; }" });
  await page.frameLocator("iframe").locator("dai-rows > :not(template)").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(150);
  await page.locator("iframe").screenshot({ path: resolve(shots, "home-dinners-wide.png") });
  await page.close();
  rmSync(file, { force: true });
  console.log("  home-dinners-wide.png");
}

await browser.close();

// The container was scaffolding. Leaving it in public/ would publish an
// unsigned copy of the app next to the images of it.
rmSync(staged, { force: true });

console.log(`Written to website/public/shots.`);
