import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = resolve(here, "fixture/fixture.dai.html");
const RUNNER_URL = "http://localhost:5175/";

/**
 * The card is keyed on familiarity, not on carrier.
 *
 * The question the card answers is "what is this thing", and that question is
 * the same whether the document came by mail or by a file chooser. So a
 * document this device has not met before lands on the card however it
 * arrived, and a document already kept here under the same key opens without
 * one — which is what the third open behaving like an app means (1.3).
 *
 * Both halves are asserted, because a rule with only one side tested is a rule
 * that can quietly become "always" or "never".
 */
test.describe("the card, keyed on familiarity", () => {
  test("a file the person picked lands on the card the first time", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);

    await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
    // Not mounted until asked. The card is the ask.
    await expect(page.locator("body")).not.toHaveClass(/loaded/);

    await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  });

  test("the same document, picked again, opens with no card", async ({ page }) => {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // Closed and chosen again: now a document this device keeps, under the
    // key it was first seen with.
    await page.click("#more");
    await page.locator("#eject").click();
    await expect(page.locator("body")).not.toHaveClass(/loaded/);

    await page.setInputFiles("#file", CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#card")).toBeHidden();
  });

  test("the card reads the same from a link as from a file", async ({ browser }) => {
    // The same document by two carriers, each on a device that has not seen
    // it. What differs may only be the line saying where it came from.
    const read = async (page: import("@playwright/test").Page) => ({
      name: await page.locator("#card-name").textContent(),
      publisher: await page.locator("#card-publisher").textContent(),
      claims: await page.locator("#card-claims").innerText(),
    });

    const byFile = await browser.newContext();
    const one = await byFile.newPage();
    await one.goto(RUNNER_URL);
    await one.setInputFiles("#file", CONTAINER);
    await expect(one.locator("#card-open")).toBeVisible({ timeout: 60_000 });
    const fromFile = await read(one);
    await byFile.close();

    // A second device, which is a second context: nothing carried over.
    const { readFileSync } = await import("node:fs");
    const { encodeInline } = await import("../src/link.js");
    const value = await encodeInline(readFileSync(CONTAINER, "utf8"));
    const byLink = await browser.newContext();
    const two = await byLink.newPage();
    // A fresh navigation with the fragment already in it, so the script runs
    // once. Reloading would be a second sighting, and the card would say so.
    await two.goto(`${RUNNER_URL}#a=${value}`);
    await expect(two.locator("#card-open")).toBeVisible({ timeout: 60_000 });
    const fromLink = await read(two);
    await byLink.close();

    expect(fromLink).toEqual(fromFile);
  });
});
