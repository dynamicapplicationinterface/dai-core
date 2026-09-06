import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = resolve(here, "fixture/fixture.dai.html");
const RUNNER_URL = "http://localhost:5175/";

/**
 * Looking inside a document before running it (backlog 1.5).
 *
 * The card says what a document claims about itself and what this host will
 * not let any document do. Neither of those is what is actually in the
 * archive, and until now somebody who wanted to know that had one option:
 * believe the card. The playground reads the same bytes, recomputes every
 * digest, checks the signature — and never mounts anything, which is why it is
 * a separate page and not a tab in this one.
 *
 * The document goes tab to tab by postMessage: no upload, no server, nothing
 * on the network.
 */
test.describe("look inside, before opening", () => {
  test("hands the same bytes to the playground, which reads them and does not run them", async ({
    page,
    context,
  }) => {
    test.slow();

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", CONTAINER);

    // The card is up, and offers the way to check rather than take its word.
    const inspect = page.locator("#card-inspect");
    await expect(inspect).toBeVisible({ timeout: 60_000 });

    const [playground] = await Promise.all([
      context.waitForEvent("page"),
      inspect.click(),
    ]);
    await playground.waitForLoadState("domcontentloaded");

    // Same bytes, read on the other side: the file name and the verdict the
    // playground computed for itself.
    await expect(playground.locator(".file-meta")).toContainText("fixture", {
      timeout: 60_000,
    });

    // And it did not run it. The runner's frame is the thing that mounts a
    // document, and the playground has no such thing.
    expect(await playground.locator("#dai-app").count()).toBe(0);
    await expect(playground.locator("body")).not.toHaveClass(/loaded/);

    // The card is still up in the first tab: looking inside decided nothing.
    await expect(page.locator("#card")).toBeVisible();
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });
});

/**
 * "Modify this app" (backlog 4.2).
 *
 * Somebody has a document that works and wants one thing different about it.
 * Without a way to get the source back out, the only route is describing the
 * whole application again — and what comes back is a *different* document:
 * new identity, no succession, empty database. It looks right until they open
 * it and last month's entries are gone.
 *
 * So the sheet puts the sealed source on the clipboard, in the bundle form,
 * with the header that makes the next build a successor — and a sentence
 * saying what to do with it, because a header nobody is told about is a header
 * nobody uses.
 */
test.describe("handing this app back to an assistant", () => {
  test("copies the source, the identity, and what to do with them", async ({ page, context }) => {
    test.slow();
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
