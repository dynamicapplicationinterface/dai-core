import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { encodeInline } from "../src/link.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

const HOST = {
  template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
  runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
};

/**
 * The two G0 vectors about the launch hint and the icon.
 *
 * `#u=<uuid>` says which document an address is probably for, so that "do I
 * already have this?" can be answered without decompressing a payload or
 * asking a store. It is a hint and never an identity, and these hold the two
 * places that distinction is load-bearing.
 */

/** A document, and the UUID the compiler gave it. */
async function build(app: string, name: string) {
  const built = await compileDirectory({
    sourceDir: resolve(repo, `examples/${app}`),
    root: repo,
    appName: name,
  });
  const { parseContainer } = await import("../src/container.js");
  return { html: built.html, uuid: parseContainer(built.html).manifest.documentUuid };
}

test.describe("the hint only says which entry to try", () => {
  test("fragment-uuid-mismatch-is-first-sighting", async ({ page }) => {
    test.slow();

    /*
     * A link whose hint names one document and whose payload is another.
     *
     * The hint is unverified by construction: it rides in a fragment anybody
     * can edit, and it is read before anything is decompressed. So the rule
     * that makes it safe is that the mounted document's manifest decides what
     * the document is. A reader that trusted the hint would open a stranger's
     * payload into the data section of whatever entry the hint named — which
     * is somebody else's document handing itself your rows.
     *
     * The observable form of "first sighting" is the launch card: a document
     * nobody has consented to does not mount on its own.
     */
    const held = await build("chore-chart", "Chore chart");
    const other = await build("packing-list", "Beach trip");
    expect(other.uuid).not.toBe(held.uuid);

    // The first document is genuinely held, so the entry the hint names exists
    // and has a data section. Without this the test would pass for the
    // uninteresting reason that there was nothing to reuse.
    await page.goto(RUNNER_URL);
    await openFile(page, {
      name: "chore-chart.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(held.html, "utf8"),
    });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // Now a link carrying the *other* document, hinted as the held one.
    const value = await encodeInline(other.html, HOST);
    await page.goto(`${RUNNER_URL}#a=${value}&u=${held.uuid}`);
    await page.reload();

    // The card, not a mount: this is a document this device has not seen.
    const card = page.locator("#card-open");
    await card.waitFor({ state: "visible", timeout: 60_000 });
    await expect(page.locator("body")).not.toHaveClass(/loaded/);

    // And it is described as itself, not as the document the hint named.
    await expect(page.locator("#card-name")).toHaveText(/beach trip/i);
    await expect(page.locator("#card-name")).not.toHaveText(/chore/i);

    // Opening it is allowed — the person asked. What must not happen is that
    // it arrives already carrying the held document's rows.
    await card.click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(
      page.frameLocator("#cartridge").frameLocator("#dai-app").locator("body"),
    ).not.toContainText(/chore/i, { timeout: 60_000 });
  });

  test("a hint naming nothing this device holds is simply ignored", async ({ page }) => {
    // The other half of "only a hint": a wrong guess costs nothing. An address
    // for a document that is not here opens the chooser, not an error and not
    // somebody else's document.
    await page.goto(`${RUNNER_URL}#u=3f2504e0-4f89-41d3-9a0c-0305e82c3301`);
    await expect(page.locator("#open")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });
});

test.describe("an icon for a document this device holds", () => {
  test("install-held-document-opens-offline", async ({ page, context }) => {
    test.slow();

    /*
     * What a home-screen icon is for.
     *
     * The icon's address is the document's own — `#u=<uuid>` beside whatever
     * else it carries — and launching it must open the copy on this device
     * rather than fetch anything. Offline is how that is proved: a launch that
     * quietly needed the network would pass every online test and fail on a
     * train, which is the one situation the whole format exists for.
     */
    const held = await build("chore-chart", "Chore chart");

    await page.goto(RUNNER_URL);
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 60_000,
    });
    await openFile(page, {
      name: "chore-chart.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(held.html, "utf8"),
    });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // The icon's address, launched with nothing available to fetch.
    await context.setOffline(true);
    await page.goto(`${RUNNER_URL}#u=${held.uuid}`);
    await page.reload();

    // Straight in: a document this device holds is not a document from a
    // stranger, so there is no card to press through.
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(
      page.frameLocator("#cartridge").frameLocator("#dai-app").locator("body"),
    ).toContainText(/chore/i, { timeout: 60_000 });
  });

  test("the offer to keep it appears only for a document that is held", async ({ page }) => {
    /*
     * "Offered only when held" is a UI state, not an API call.
     *
     * iOS has no install event to hook, so nothing here can trigger an
     * install; what the opener controls is whether it *asks*. On the chooser,
     * with nothing open, there is nothing to add to a home screen and the
     * control is not there to press.
     */
    await page.goto(RUNNER_URL);
    await expect(page.locator("#open")).toBeVisible({ timeout: 60_000 });
    // The menu that holds the offer is itself hidden until something is open.
    await expect(page.locator("#more")).toBeHidden();
  });
});
