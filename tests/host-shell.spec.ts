import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { HOST_SHELL_META, hostShell, parseContainer } from "../src/container.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * The host runs its own shell, never the publisher's.
 *
 * A container carries its own bootloader, and both hosts used to load the
 * container's document into a frame that shares the host's origin. That
 * bootloader is verified only against its own sealed copy — proof the
 * publisher wrote it, and nothing else. A publisher who wrote a hostile one
 * had the opener's origin: its library, its pinned keys, its OPFS.
 *
 * This builds exactly such a container — a shell with one extra script that
 * writes to the origin it runs in — and shows two things: opened by
 * double-click, where there is no host, the script runs (so the test is
 * measuring something); opened in the opener, it does not run, the frame
 * holds a shell the host built, and the application still works.
 */
const hostile = (): { file: string; template: string } => {
  const dir = mkdtempSync(join(tmpdir(), "dai-hostile-"));
  const template = readFileSync(resolve(repo, "dist/template.html"), "utf8").replace(
    /<meta charset[^>]*>/i,
    (tag) =>
      tag +
      // Stamped with the nonce, as a publisher's own template may be, so the
      // shell's policy lets it run — this is what a publisher can do.
      '<script nonce="<!--DAI_NONCE-->">' +
      'try{localStorage.setItem("hostile-shell","ran")}catch(e){}' +
      'document.title="HOSTILE";' +
      "</script>",
  );
  const templatePath = join(dir, "template.html");
  writeFileSync(templatePath, template, "utf8");
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><meta charset="utf-8"><p id="app">benign application</p>',
    "utf8",
  );
  return { file: dir, template: templatePath };
};

test.describe("a hostile publisher shell", () => {
  test("runs by double-click, where there is no host to protect", async ({ page }) => {
    const { file, template } = hostile();
    const built = await compileDirectory({ sourceDir: file, root: repo, appName: "Hostile", templatePath: template });
    const out = join(file, "hostile.dai.html");
    writeFileSync(out, built.html, "utf8");

    await page.goto(pathToFileURL(out).href);
    // The publisher's script ran: the shell is the publisher's here, by design.
    await expect(page).toHaveTitle("HOSTILE");
  });

  test("does not run in the opener, and the application still does", async ({ page }) => {
    const { file, template } = hostile();
    const built = await compileDirectory({ sourceDir: file, root: repo, appName: "Hostile", templatePath: template });
    const out = join(file, "hostile.dai.html");
    writeFileSync(out, built.html, "utf8");

    await page.goto(RUNNER_URL);
    await page.evaluate(() => localStorage.removeItem("hostile-shell"));
    await openFile(page, out);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });

    const outer = page.frameLocator("#cartridge");
    // The frame holds a shell this host built…
    await expect(outer.locator('meta[name="dai-shell"][content="host"]')).toHaveCount(1);
    // …the publisher's script is not in it and did not run…
    await expect(outer.locator("title")).not.toHaveText("HOSTILE");
    expect(await page.evaluate(() => localStorage.getItem("hostile-shell"))).toBeNull();
    // …and the application mounted under the host's bootloader.
    await expect(outer.frameLocator("#dai-app").locator("#app")).toHaveText("benign application", {
      timeout: 30_000,
    });
  });
});

test.describe("hostShell", () => {
  test("wraps a verified archive in the host's template and marks it", async () => {
    const { file, template } = hostile();
    const built = await compileDirectory({ sourceDir: file, root: repo, appName: "Hostile", templatePath: template });
    const parsed = parseContainer(built.html);
    const shell = await hostShell(parsed, {
      template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
      runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
    });
    expect(shell).toContain(HOST_SHELL_META);
    expect(shell).not.toContain("HOSTILE");
    // The same archive, byte for byte, is inside.
    const again = parseContainer(shell);
    expect(Object.keys(again.archive).sort()).toEqual(Object.keys(parsed.archive).sort());
    for (const name of Object.keys(parsed.archive)) {
      expect(Buffer.from(again.archive[name]!).equals(Buffer.from(parsed.archive[name]!)), name).toBe(true);
    }
  });
});
