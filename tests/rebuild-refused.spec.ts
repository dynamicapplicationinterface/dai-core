import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { ejectFrom } from "./open.js";
import { compileDirectory } from "../src/compile.js";

/**
 * A publisher key, because an unsigned container cannot say which build it is
 * and this whole test is about telling two builds apart. The author of an app
 * people install signs it; that is the case under test.
 */
async function signingKey(dir: string): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const path = join(dir, "key.pem");
  const wrapped = pkcs8.toString("base64").replace(/(.{64})/g, "$1\n");
  writeFileSync(path, ["-----BEGIN PRIVATE KEY-----", wrapped, "-----END PRIVATE KEY-----", ""].join("\n"), "utf8");
  return path;
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("#cartridge").frameLocator("#dai-app");

/**
 * Whether the library says this device has written something of its own into
 * the document it holds — the precondition of the refusal under test.
 *
 * Read rather than inferred from a count of saves: a save can carry the
 * document's setup and a person's first rows together, so "more than one save"
 * is not the same question and answers it wrongly.
 */
const wroteHere = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open("dai_runner_storage");
        open.onsuccess = () => {
          try {
            const all = open.result.transaction("cartridges", "readonly").objectStore("cartridges").getAll();
            all.onsuccess = () => {
              resolve((all.result as { wrote?: boolean }[]).some((row) => row.wrote === true));
              open.result.close();
            };
            all.onerror = () => resolve(false);
          } catch {
            resolve(false);
          }
        };
        open.onerror = () => resolve(false);
      }),
  );

/**
 * Opens a file and waits for whichever of the three things happens: a card to
 * press, a document mounted, or a refusal on screen. A refusal shows no card,
 * so waiting for one is waiting for something that is never coming.
 */
async function openFrom(page: Page, file: string): Promise<void> {
  /*
   * The last outcome is cleared first, or this waits on it: a refusal leaves
   * `#report.error` standing, so the wait below matched immediately, clicked
   * nothing, and the next open looked like it had silently failed.
   */
  await page.evaluate(() => {
    const report = document.getElementById("report");
    if (report) {
      report.textContent = "";
      report.classList.remove("error");
    }
  });
  // Emptied first: choosing the same file twice is not a change, so the second
  // choice raised no event and nothing happened at all — which reads exactly
  // like an open that silently failed.
  await page.setInputFiles("#file", []);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open:visible, body.loaded, #report.error").first().waitFor({ timeout: 60_000 });
  if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
}

/**
 * An author's rebuild under the same id is not an update (D85).
 *
 * The id is the document, so a second build carrying the same
 * `documentUuid` is not a new version of the app — it is a second copy of the
 * same document, and what arrives with it is a database. The opener used to
 * decide between the two by their stamps: the rebuild is stamped now, the
 * person's log was stamped this morning, so the rebuild won and the rows in it
 * — usually none — replaced the log, with nothing said.
 *
 * Succession is the only update: a new id, a signed `supersedes`, adopted under
 * the key this device already pinned, with the rows carried across
 * (`succession.spec.ts`). This holds the other half: what happens where that is
 * missing.
 */
test.describe("a rebuild under the same id, arriving over somebody's entries", () => {
  test.slow();

  /**
   * The app's source, and the two builds made from it.
   *
   * The second build is made **after** the person has written, which is the
   * order it happens in: somebody uses their app for a week and the author
   * ships a new version on Friday. Built before, as the first version of this
   * test did, it carries an older stamp than the log and is simply kept out —
   * which is a different case with a different sentence, and not the one this
   * is about.
   */
  async function twoBuilds(): Promise<{ first: string; rebuild: () => Promise<string> }> {
    const source = mkdtempSync(join(tmpdir(), "dai-rebuild-"));
    writeFileSync(
      join(source, "schema.sql"),
      "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, what TEXT NOT NULL);\n",
      "utf8",
    );
    writeFileSync(
      join(source, "index.html"),
      // The shape the succession spec uses, which is known to drive the kit:
      // a form that writes a row, a value that counts them, and the save
      // element, which hides itself once there is nothing left to write.
      [
        '<!doctype html><meta charset="utf-8"><title>Logbook</title>',
        '<p>count <dai-value id="count" query="SELECT count(*) FROM entries"></dai-value></p>',
        '<dai-form run="INSERT INTO entries (what) VALUES (:what)"><input name="what" id="what" required><button id="add">Add</button></dai-form>',
        '<dai-save id="save">Save</dai-save>',
        '<script type="module" src="./dai-kit.js"></script>',
      ].join("\n"),
      "utf8",
    );

    const keyFile = await signingKey(source);
    const one = await compileDirectory({ sourceDir: source, root: repo, appName: "Logbook", signingKey: keyFile });
    const first = join(source, "logbook.dai.html");
    writeFileSync(first, one.html, "utf8");

    /*
     * The rebuild: the author changes the app and ships it under the same id.
     * A changed page, so the two builds really are different applications —
     * which is what tells an author's new version from the person's own
     * install file coming back, since both carry the same empty database.
     */
    const rebuild = async (): Promise<string> => {
      writeFileSync(
        join(source, "index.html"),
        [
          '<!doctype html><meta charset="utf-8"><title>Logbook</title>',
          "<p>Logbook, version two</p>",
          '<p>count <dai-value id="count" query="SELECT count(*) FROM entries"></dai-value></p>',
          '<dai-form run="INSERT INTO entries (what) VALUES (:what)"><input name="what" id="what" required><button id="add">Add</button></dai-form>',
          '<dai-save id="save">Save</dai-save>',
          '<script type="module" src="./dai-kit.js"></script>',
        ].join("\n"),
        "utf8",
      );
      const two = await compileDirectory({
        sourceDir: source,
        root: repo,
        appName: "Logbook",
        documentUuid: one.manifest.documentUuid,
        signingKey: keyFile,
      });
      const path = join(source, "logbook-v2.dai.html");
      writeFileSync(path, two.html, "utf8");
      expect(two.manifest.documentUuid, "the same document, by id").toBe(one.manifest.documentUuid);
      return path;
    };
    return { first, rebuild };
  }

  test("is refused, and the log is still there", async ({ browser }) => {
    const { first, rebuild } = await twoBuilds();
    const device = await browser.newContext();
    const page = await device.newPage();
    const saves: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("dai:")) saves.push(message.text());
    });

    // Installed, and used: two entries, written and on this device.
    await page.goto(RUNNER_URL);
    await openFrom(page, first);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    for (const what of ["squats", "rows"]) {
      await app(page).locator("#what").fill(what);
      await app(page).locator("#add").click();
    }
    await expect(app(page).locator("#count")).toHaveText("2", { timeout: 30_000 });
    /*
     * Written down, not just on screen. The save element hides itself once
     * there is nothing left to write, which is the kit's own signal that the
     * autosave has landed, and the breadcrumb count is the opener's side of
     * the same fact — above one, because the first save every copy makes is
     * the document's setup SQL, which is not something anybody would miss.
     * Waiting only for that first save is what the first version of this test
     * did, and it was waiting for the wrong thing.
     */
    await expect(app(page).locator("#save")).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(() => wroteHere(page), {
        timeout: 30_000,
        message: "this device has written something of its own",
      })
      .toBe(true);

    // The author's rebuild arrives, carrying the empty database every build
    // has. Closed first, because a file is opened from the chooser — the same
    // way the person would meet it.
    /*
     * Built now, after the log exists — the order it happens in — and opened
     * while their app is open, which is how somebody meets a file a friend or
     * an author has just sent them.
     */
    const rebuilt = await rebuild();
    await openFrom(page, rebuilt);

    // Refused, in one sentence, before anything is opened.
    const said = page.locator("#report");
    await expect(said).toContainText("did not come from the one on this device", { timeout: 60_000 });
    await expect(said).toContainText("nothing was opened and nothing here was changed");
    // And it points at what an update is, rather than leaving a dead end.
    await expect(said).toContainText("A new version from the same author keeps your entries");
    await expect(page.locator("body"), "their app is still the one on screen").toHaveClass(/loaded/);

    /*
     * And what is on screen is theirs: both entries, in the copy that was
     * already open. "Nothing here was changed" is a sentence the person can
     * check by looking, so this test checks it the same way.
     */
    await expect(app(page).locator("#count"), "the entries survived the refusal").toHaveText("2", {
      timeout: 30_000,
    });
    await device.close();
  });

  test("a rebuild arriving at a copy nobody has written to still opens", async ({ browser }) => {
    /*
     * The guard on the refusal. It is about what would be lost, not about the
     * stamps: where this device holds nothing anybody wrote, the later copy
     * opens as it always has — which is also how opening the same file twice
     * has always behaved.
     */
    const { first, rebuild } = await twoBuilds();
    const device = await browser.newContext();
    const page = await device.newPage();

    await page.goto(RUNNER_URL);
    await openFrom(page, first);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(app(page).locator("#count")).toHaveText("0", { timeout: 30_000 });

    const rebuilt = await rebuild();
    await ejectFrom(page);
    await openFrom(page, rebuilt);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.locator("#report")).not.toContainText("did not come from the one on this device");
    await device.close();
  });
});
