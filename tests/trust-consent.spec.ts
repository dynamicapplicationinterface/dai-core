import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ejectFrom } from "./open.js";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const KEY_A = resolve(repo, "conformance/trust-publisher-a-key.pem");
const KEY_B = resolve(repo, "conformance/trust-publisher-b-key.pem");

/**
 * A pin is a decision, and it is the person's to make.
 *
 * The opener used to record which key a document was first seen with the
 * moment the document was read — before the card, before anybody had agreed
 * to anything. A review found what that allows. The identity of a document is
 * public: it is in every link's sidecar and in every copy of the file. So a
 * stranger builds a container with that identity under their own key, and gets
 * the target to *load* — not open — a link to it. From then on the genuine
 * document is refused as "signed by a different publisher… treat it as an
 * impersonation", and because the stranger's copy was never kept there is no
 * Delete to reach the pin. The trust signal was inverted, permanently, by a
 * link nobody tapped.
 *
 * This holds the rule that closes it: seeing is not agreeing. Only Open pins.
 */

/** Two copies of one document — same identity — signed by two publishers. */
async function twoCopies(): Promise<{ theirs: string; ours: string; uuid: string }> {
  const uuid = crypto.randomUUID();
  const dir = mkdtempSync(join(tmpdir(), "dai-consent-"));
  const build = async (key: string, name: string) => {
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/chore-chart"),
      root: repo,
      appName: "Chore chart",
      documentUuid: uuid,
      signingKey: key,
      manifestVersion: 3,
    });
    const path = join(dir, name);
    writeFileSync(path, built.html, "utf8");
    return path;
  };
  return { theirs: await build(KEY_B, "theirs.dai.html"), ours: await build(KEY_A, "ours.dai.html"), uuid };
}

async function isPinned(page: import("@playwright/test").Page, uuid: string): Promise<boolean> {
  return page.evaluate(
    (id) =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open("dai_runner_storage");
        open.onsuccess = () => {
          const get = open.result.transaction("pins", "readonly").objectStore("pins").get(id);
          get.onsuccess = () => resolve(get.result !== undefined);
          get.onerror = () => resolve(false);
        };
        open.onerror = () => resolve(false);
      }),
    uuid,
  );
}

test.describe("trust is pinned by opening, not by looking", () => {
  test("a stranger's copy that was shown and closed does not poison the real one", async ({ page }) => {
    test.slow();
    const { theirs, ours, uuid } = await twoCopies();

    // The stranger's copy arrives and reaches the card. The person does not
    // press Open; they close the tab, or the link was never for them.
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", theirs);
    await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
    expect(await isPinned(page, uuid), "looking must not pin").toBe(false);

    // The genuine document arrives. It is a first sighting, not a mismatch.
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", ours);
    await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#report")).not.toContainText(/different publisher|impersonation/);

    // Opened: now it is remembered, under the genuine key.
    await page.click("#card-open");
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    expect(await isPinned(page, uuid), "opening pins").toBe(true);

    // And from here the stranger's copy is what reads as the impersonation,
    // which is the way round it should be.
    await ejectFrom(page);
    await page.setInputFiles("#file", theirs);
    await expect(page.locator("#report")).toContainText(/different publisher/, { timeout: 60_000 });
    await expect(page.locator("#card-open")).toBeHidden();
  });

  test("a document kept in the library is still checked on every launch", async ({ page }) => {
    test.slow();
    const { theirs, ours, uuid } = await twoCopies();

    // Opened once, so it is kept and pinned.
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", ours);
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await ejectFrom(page);

    // The stranger's copy is refused, and nothing about the kept one changes.
    await page.setInputFiles("#file", theirs);
    await expect(page.locator("#report")).toContainText(/different publisher/, { timeout: 60_000 });
    // Launched the way an icon launches it: by its id.
    await page.goto(`${RUNNER_URL}?doc=${uuid}`);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  });
});
