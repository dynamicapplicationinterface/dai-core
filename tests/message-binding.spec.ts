import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = dirname(fileURLToPath(import.meta.url));

/**
 * A message is acted on only when it came from the window it could have come
 * from.
 *
 * The host side of the bridge was bound to source, nonce and request id. The
 * shell's own listener for its frame was not: a save request, a verdict on
 * whether somebody's data may be overwritten, a claim that the application had
 * mounted, and an isolation report saying every boundary held were all acted
 * on whoever sent them. A page that frames a container — or opens one in a tab
 * it keeps a handle to — is in a position to send all four, and to reach the
 * application inside it.
 *
 * The fixture host is that page. It answers no handshake, so the container
 * stays out of host mode and a forged save takes the shell's own path, which
 * replies to whoever asked. Silence is therefore the assertion: before these
 * checks went in, each of these produced an answer.
 */
const HOST = "http://localhost:5175/forge/host.html";

const APP = [
  '<!doctype html><meta charset="utf-8">',
  '<p id="app">starting</p>',
  '<p id="mode">no</p>',
  '<script type="module">',
  "  const out = document.getElementById('app');",
  "  const mode = document.getElementById('mode');",
  "  mode.textContent = window.dai.appMode ? 'yes' : 'no';",
  "  window.dai.onAppModeChange((active) => { mode.textContent = active ? 'yes' : 'no'; });",
  "  try {",
  "    const db = await window.dai.openDatabase();",
  // schema.sql declares the shape, which is what makes the shell's dai:schema
  // branch live; the kit is what would normally run it, and this application
  // does not use the kit, so it creates its own table.
  "    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)');",
  "    db.exec(\"INSERT INTO t (id) VALUES (1)\");",
  "    out.textContent = 'opened ' + db.selectObjects('SELECT count(*) AS n FROM t')[0].n;",
  "  } catch (error) { out.textContent = 'failed ' + error.message; }",
  "</script>",
].join("\n");

/**
 * Builds a container that declares a schema and serves it beside the fixture.
 *
 * The schema matters: without a declaration the shell's `dai:schema` branch is
 * never live, and a test of a branch that cannot run is not a test.
 */
async function serve(): Promise<void> {
  const source = mkdtempSync(join(tmpdir(), "dai-forge-"));
  writeFileSync(join(source, "index.html"), APP, "utf8");
  writeFileSync(
    join(source, "schema.sql"),
    "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY);",
    "utf8",
  );

  const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Forge" });

  const served = resolve(repo, "apps", "runner", "dist", "forge");
  mkdirSync(served, { recursive: true });
  writeFileSync(join(served, "container.dai.html"), built.html, "utf8");
  writeFileSync(
    join(served, "host.html"),
    readFileSync(join(here, "fixture", "forging-host.html"), "utf8"),
    "utf8",
  );
}

test.describe("the shell acts only on messages from its own frame", () => {
  test("a window that is not the frame is ignored, five ways", async ({ page }) => {
    test.slow();
    await serve();

    const downloads: string[] = [];
    page.on("download", (download) => downloads.push(download.suggestedFilename()));

    await page.goto(HOST);

    /*
     * The genuine path first, and it is the more important half.
     *
     * "opened 1" means the application mounted under the shell, asked whether
     * its data was safe to open, and was answered — the same `dai:schema`
     * exchange a forgery is about to be refused. A suite that only proved
     * forgeries are ignored would pass just as well with the whole bridge
     * broken.
     */
    const app = page.frameLocator("#shell").frameLocator("#dai-app");
    await expect(app.locator("#app")).toHaveText("opened 1", { timeout: 60_000 });
    await expect(app.locator("#mode")).toHaveText("no");

    /*
     * Everything the shell had to say, said. The handshake arrives up to three
     * times by design — the document is written rather than navigated to, so
     * the frame signals on several events — and all of them are long past by
     * the time the database has been opened. What matters is that nothing more
     * arrives after this line.
     */
    const before = await page.evaluate(
      () => (window as unknown as { seen: unknown[] }).seen.length,
    );
    expect(before).toBeGreaterThan(0);

    await page.evaluate(() => {
      const forge = (window as unknown as { forgeToShell: (d: unknown) => void }).forgeToShell;
      const toApp = (window as unknown as { forgeToApp: (d: unknown) => void }).forgeToApp;

      // A save nobody asked for. Answered, before the check, to whoever asked.
      forge({ type: "dai:save", id: "forged-save", sqlite: null, method: "download" });

      // A question about whether somebody's data may be written over.
      forge({ type: "dai:schema", id: "forged-schema", actual: null });

      // A claim that the application is on screen, which stops the stall watch
      // and makes the shell report a finished boot to its host again.
      forge("dai:ready");

      // An isolation report saying a boundary held, which the shell would
      // forward to its host with the host's own profile attached — the check
      // in host-profile.spec.ts is worth nothing if this is repeated.
      forge({
        type: "dai:isolation-report",
        suite: "dai-isolation",
        version: 1,
        results: [{ id: "popup", status: "blocked" }],
      });

      // And the other direction: the application told it is in app mode, by a
      // window that is not its shell.
      toApp({ type: "dai:appmode", active: true });
    });

    // Long enough for any of the five to have produced its answer.
    await page.waitForTimeout(2500);

    const fresh = await page.evaluate(
      (from) => (window as unknown as { seen: unknown[] }).seen.slice(from),
      before,
    );

    // Not one word in reply: no save result, no schema verdict, no second
    // report of a finished boot, no isolation report repeated.
    expect(
      fresh,
      `the shell answered a window that is not its frame: ${JSON.stringify(fresh)}`,
    ).toEqual([]);
    // And nothing was written to disk on the strength of it.
    expect(downloads).toEqual([]);

    // The application was not told something only its shell can tell it…
    await expect(app.locator("#mode")).toHaveText("no");
    // …and is still running, still holding what it wrote.
    await expect(app.locator("#app")).toHaveText("opened 1");
  });
});
