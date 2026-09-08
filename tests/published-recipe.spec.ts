import { expect, test } from "@playwright/test";
import { API, CSS_VARS, RECIPE, RECIPE_AS_PROMPT } from "../src/recipe.js";

const SITE_URL = "http://localhost:5176/";

/**
 * What the website publishes for a model is what a model is told.
 *
 * The recipe reaches a model two ways: the MCP server hands it over with the
 * tools, and the website publishes it for anybody working with an assistant
 * that has no connection to the server. Two copies of instructions is two
 * copies that drift, and a reader has no way of knowing which one the model
 * followed — so both come from one constant, and these hold them to it.
 */
test.describe("the recipe, as published", () => {
  test("/recipe.txt is the text the server hands a model, byte for byte", async ({ request }) => {
    const response = await request.get(new URL("recipe.txt", SITE_URL).href);
    expect(response.status()).toBe(200);
    expect((await response.text()).trim()).toBe(RECIPE_AS_PROMPT.trim());
  });

  test("/llms.txt points at it and lists the surface", async ({ request }) => {
    const response = await request.get(new URL("llms.txt", SITE_URL).href);
    expect(response.status()).toBe(200);
    const text = await response.text();

    // The index's job: send a model to the full text rather than to a page it
    // would have to scrape.
    expect(text).toContain("/recipe.txt");
    expect(text).toContain("/docs/writing-apps");

    // Every call and every custom property, so a model reading only this index
    // still knows what exists.
    for (const entry of API) expect(text, entry.call).toContain(entry.call);
    for (const entry of CSS_VARS) expect(text, entry.name).toContain(entry.name);
  });

  test("every custom property the site publishes is one the recipe teaches", async () => {
    // The prose above the table is where a model actually learns these. A
    // property listed only in the table would be a promise the recipe never
    // made.
    for (const entry of CSS_VARS) expect(RECIPE, entry.name).toContain(entry.name);
  });

  test("the surface named in the recipe is the surface the runtime gives", async () => {
    // Not a spelling check: these are the calls the website tells people to
    // write, so a name here that the runtime does not define is a page sending
    // somebody to a method that does not exist.
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const runtime = readFileSync(resolve(repo, "src/runtime/bootloader.ts"), "utf8");

    for (const entry of API) {
      const method = /window\.dai\.([A-Za-z]+)/.exec(entry.call)?.[1];
      if (!method) continue;
      expect(runtime, `${method} is published but the runtime defines no such thing`).toMatch(
        new RegExp(`\\b${method}\\b`),
      );
    }
  });
});
