import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = resolve(here, "fixture/fixture.dai.html");
const RUNNER_URL = "http://localhost:5175/";

/**
 * Handing a document back to the thing that wrote it.
 *
 * The opener used to offer "Look inside first" beside Get, which opened the
 * playground with the same bytes. It is gone from the open screen: Get is how
 * somebody looks inside, and the screen before it is about the app rather
 * than about the format. The playground still reads a container on the site,
 * and the handoff it travels by is held by tests/handoff-tab.
 */
test.describe("handing this app back to an assistant", () => {
  test("copies the source, the identity, and what to do with them", async ({
    page,
    context,
    browserName,
  }) => {
    test.slow();
    // Reading the clipboard back needs a permission only chromium implements.
    // The affordance itself works everywhere — this is the assertion that
    // cannot be made elsewhere, not the feature that cannot run there.
    test.skip(browserName !== "chromium", "clipboard-read is chromium-only in Playwright");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    await page.click("#more");
    await page.click("#modify");
    await expect(page.locator("#report")).toContainText("Copied the source", { timeout: 60_000 });

    const copied = await page.evaluate(() => navigator.clipboard.readText());

    // The instructions come first: the person pastes the whole thing, and the
    // first reader is a model.
    expect(copied).toContain("change it as I describe");
    expect(copied).toMatch(/supersedes: "[0-9a-f-]{36}"/);
    expect(copied).toContain("existing data come across");

    // Then the source, in the form the parser reads.
    expect(copied).toContain("dai bundle v1");
    expect(copied).toContain("--- file: index.html");
    // The host's engine is not the app, and is not what anybody wants to edit.
    expect(copied).not.toContain("sqlite3.wasm");

    const { parseBundle } = await import("../src/bundle.js");
    const bundle = parseBundle(copied.slice(copied.indexOf("dai bundle v1")));
    expect(bundle.documentUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.files["index.html"]).toBeTruthy();
    expect(bundle.warnings).toEqual([]);
  });
});
