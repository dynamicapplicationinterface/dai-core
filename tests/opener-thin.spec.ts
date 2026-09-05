import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { SUBSTITUTABLE_ENTRIES } from "../src/core.js";
import { parseContainer, thinned } from "../src/container.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = resolve(repo, "conformance", "signing-key.pem");
const RUNNER_URL = "http://localhost:5175/";

/**
 * The opener as a host that holds an engine.
 *
 * The format half of this said a document may be published without its engine
 * and completed by a host that already holds those exact bytes. This is the
 * host. Everything here is about the two things a person would notice: a
 * document a megabyte smaller opens and works, and the copy they save from it
 * is the whole document, not a copy that only runs where it was made.
 *
 * The byte-for-byte comparison is the one that matters. Anything weaker would
 * let a thin document be a lesser edition wearing the same name — you could
 * open it here, save it, mail it, and the recipient would have something the
 * publisher never signed.
 */
async function complete() {
  const source = mkdtempSync(join(tmpdir(), "dai-opener-thin-"));
  writeFileSync(
    join(source, "index.html"),
    // Enough of an application to prove the engine actually ran, rather than
    // that a page painted: the count comes back out of SQLite. Written against
    // the runtime's own primitive rather than the kit, because the kit is a
    // module the app imports by URL and this test is about the engine.
    `<!doctype html><meta charset="utf-8"><title>Thin</title><p id="app">starting</p>
<script type="module">
  const db = await window.dai.openDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS t (n INTEGER)");
  db.exec("INSERT INTO t (n) VALUES (7)");
  const rows = db.selectObjects("SELECT n FROM t");
  document.getElementById("app").textContent = "rows " + rows.length + " n " + rows[0].n;
</script>`,
    "utf8",
  );
  return compileDirectory({
    sourceDir: source,
    root: repo,
    appName: "Thin",
    signingKey: KEY,
    documentUuid: "3c7e91a2-5b4d-4f18-9a26-0d5e8c1b7f43",
  });
}

test.describe("a document published without its engine, in the opener", () => {
  test("opens, runs, and the copy it saves is the complete build", async ({ page }) => {
    test.slow();

    // One build, two forms. Built once and thinned, never built twice: ECDSA
    // draws a fresh nonce, so a second build would be a different document and
    // the comparison below would be unsatisfiable rather than false.
    const fat = await complete();
    const thin = thinned(parseContainer(fat.html));

    expect(thin.length).toBeLessThan(fat.html.length / 2);
    for (const name of SUBSTITUTABLE_ENTRIES) {
      expect(Object.keys(parseContainer(thin).archive)).not.toContain(name);
    }

    /*
     * Catches the file where a computer saves it.
     *
     * "Save a copy" on a desktop goes through the browser's save dialog, which
     * a test cannot answer. Standing in for the dialog is what lets this assert
     * the bytes rather than that a button was clickable — and it is the same
     * code path a person takes, right up to the disk.
     */
    await page.addInitScript(() => {
      const w = window as unknown as { showSaveFilePicker: unknown; __saved?: string };
      w.showSaveFilePicker = async () => ({
        createWritable: async () => ({
          write: (text: string) => {
            w.__saved = text;
          },
          close: async () => {},
        }),
      });
    });

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", {
      name: "Thin.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(thin, "utf8"),
    });

    // Mounted, which means verified — the engine this app holds went in and the
    // whole archive was hashed against the manifest with it.
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // And it ran. The engine is not decoration: this text exists only because
    // SQLite compiled, opened a database and answered a query.
    const app = page.frameLocator("#cartridge").frameLocator("#dai-app");
    await expect(app.locator("#app")).toHaveText("rows 1 n 7", { timeout: 60_000 });

    await page.evaluate(() =>
      (window as unknown as { __runner: { exportContainer: () => Promise<void> } }).__runner.exportContainer(),
    );
    const saved = await page.evaluate(() => (window as unknown as { __saved?: string }).__saved);

    // The whole point. Not an equivalent document, not one this opener rebuilt
    // — the file the publisher's complete build produced.
    expect(saved).toBe(fat.html);
  });

  test("a host with no engine to offer refuses it, and does not call it damage", async ({
    page,
  }) => {
    test.slow();
    const fat = await complete();
    const thin = thinned(parseContainer(fat.html));

    // This opener holds an engine, so the refusal has to be provoked: every
    // request for the staged bytes fails, as it would on a build that never
    // staged them.
    await page.route("**/runtime/sqlite3.*", (route) => route.abort());

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", {
      name: "Thin.dai.html",
      mimeType: "text/html",
      buffer: Buffer.from(thin, "utf8"),
    });

    // Nothing was modified, and saying so would send somebody hunting for an
    // attacker over a file that arrived exactly as it was published.
    await expect(page.locator("#report")).toContainText(/engine/i, { timeout: 60_000 });
    await expect(page.locator("#report")).not.toContainText(/modified/i);
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });
});
