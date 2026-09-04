import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { buildContainer } from "../src/core.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What runs is what was signed.
 *
 * The frame loader rewrites references so that sibling files resolve at an
 * opaque origin. The first version did that by replacing every spelling of
 * every asset name across the whole text of every script — so an application
 * that mentioned its own file name in a string literal ran with a blob URL
 * where the literal had been, and the bytes that executed were not the bytes
 * that had been digested and signed. Found by review.
 *
 * Only module specifiers are rewritten now. This application says its own
 * file names in every other way a script can, and asserts each one arrived
 * exactly as written — while the real imports still resolve.
 */
test("a script's own words are not rewritten; its imports still resolve", async ({ page }) => {
  const encoder = new TextEncoder();
  const built = await buildContainer({
    files: {
      "index.html": encoder.encode(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="./app.css">' +
          '<p id="out"></p><script type="module" src="./app.js"></script>',
      ),
      "app.js": encoder.encode(
        [
          'import { ran } from "./util.js";',
          "// mentions app.css and util.js in a comment",
          'const literal = "app.css";',
          'const relative = "./util.js";',
          "const pattern = /util\\.js/.test(relative);",
          'const asset = new URL("./app.css", import.meta.url).href;',
          "document.getElementById('out').textContent = [literal, relative, String(pattern), ran, asset.startsWith('blob:')].join('|');",
        ].join("\n"),
      ),
      "util.js": encoder.encode('export const ran = "util-ran";'),
      "app.css": encoder.encode("p { color: teal }"),
    },
    template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
    runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
    appName: "Fidelity",
  });

  const file = join(tmpdir(), `dai-fidelity-${Date.now()}.dai.html`);
  writeFileSync(file, built.html, "utf8");

  await page.goto(pathToFileURL(file).href);
  const out = page.frameLocator("iframe").locator("#out");
  await expect(out).toHaveText(/./, { timeout: 30_000 });

  const [literal, relative, pattern, ran, assetIsBlob] = (await out.textContent())!.split("|");
  // The application's own text, byte for byte.
  expect(literal).toBe("app.css");
  expect(relative).toBe("./util.js");
  expect(pattern).toBe("true");
  // And the two real references — a static import and a new URL() asset —
  // resolved inside the frame.
  expect(ran).toBe("util-ran");
  expect(assetIsBlob).toBe("true");
});

test("the bridge refuses to make a nonce without a random source", () => {
  // Sixteen zero bytes is a nonce anyone can guess; the first version fell
  // back to it silently when `crypto` was absent.
  const source = readFileSync(resolve(repo, "src/runtime/bootloader.ts"), "utf8");
  expect(source).toMatch(/no random source in this context/);
  expect(source).not.toMatch(/getRandomValues\?\.\(bytes\)/);
});

test("a save reply is bound to its request and to the host that was asked", () => {
  const boot = readFileSync(resolve(repo, "src/runtime/bootloader.ts"), "utf8");
  const shell = readFileSync(resolve(repo, "apps/runner/src/main.ts"), "utf8");
  // The container checks who answered and which request it was for…
  expect(boot).toMatch(/evt\.source !== window\.parent/);
  expect(boot).toMatch(/data\.requestId !== requestId/);
  // …and the host echoes the id it was given.
  expect(shell).toMatch(/DAI_HOST_SAVE_ACK", status: "ok", requestId/);
});
