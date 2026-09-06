import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import { compileDirectory } from "../src/compile.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * A refusal the shell raises before it has handshaken.
 *
 * Most of the shell's refusals are early ones: the payload, the manifest, a
 * digest, the signature, a missing index.html — all checked before the
 * handshake goes out. The opener used to require the handshake's nonce on a
 * refusal, so every one of those was dropped and the person saw a blank
 * frame under a card that said the document was open. A review found it; this
 * holds the fix. The window a refusal comes from is its identity until a
 * handshake has given the host a nonce to demand.
 *
 * The document here is one the opener's own verifier passes and the shell
 * cannot run: unsigned, with `app/index.html` removed from the archive and
 * from the manifest together, so every digest still agrees and there is
 * simply nothing to mount. The compiler will not build that on purpose, so
 * it is built here by hand.
 */
async function noApplication(): Promise<string> {
  const source = mkdtempSync(join(tmpdir(), "dai-noapp-"));
  writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><p>gone</p>', "utf8");
  const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Hollow" });

  const archive = unzipSync(
    Buffer.from(built.html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
  );
  const manifest = JSON.parse(new TextDecoder().decode(archive["runtime/manifest.json"]!)) as {
    hashes: Record<string, string>;
  };
  delete archive["app/index.html"];
  delete manifest.hashes["app/index.html"];
  archive["runtime/manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));

  const html = built.html.replace(
    /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
    (_m, open: string, close: string) => open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
  );
  const file = join(source, "hollow.dai.html");
  writeFileSync(file, html, "utf8");
  return file;
}

test.describe("a refusal raised before the handshake", () => {
  test("is said by the opener, and the frame comes down", async ({ page }) => {
    test.slow();
    await page.goto(RUNNER_URL);
    await openFile(page, await noApplication());

    // The shell's words, not the opener's guess — and not a blank frame.
    await expect(page.locator("#report")).toContainText(/index\.html/, { timeout: 60_000 });
    await expect(page.locator("#report")).toContainText(/Nothing has been changed or lost/);
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("from a window that is not the cartridge is ignored, before and after a handshake", async ({ page }) => {
    test.slow();
    await page.goto(RUNNER_URL);
    await openFile(page, resolve(repo, "tests/fixture/fixture.dai.html"));
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // The page posting to itself: the source is not the cartridge frame.
    await page.evaluate(() => {
      window.postMessage(
        { type: "DAI_HOST_REFUSED", payload: { reason: "BOOT_FAILED", message: "Forged." } },
        "*",
      );
    });
    // And the cartridge itself, after the handshake, without the nonce it was given.
    const cartridge = page.frames().find((f) => f.url().startsWith("blob:"))!;
    await cartridge.evaluate(() => {
      window.parent.postMessage(
        { type: "DAI_HOST_REFUSED", payload: { sessionNonce: "not-the-one", reason: "BOOT_FAILED", message: "Forged." } },
        "*",
      );
    });
    await page.waitForTimeout(500);
    await expect(page.locator("body")).toHaveClass(/loaded/);
    await expect(page.locator("#report")).not.toContainText(/Forged/);
  });
});
