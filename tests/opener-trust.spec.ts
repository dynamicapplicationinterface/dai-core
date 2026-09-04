import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * Whose document is this?
 *
 * Verification proves nothing has changed since a container was signed. It
 * cannot prove who signed it: somebody who alters a container can replace the
 * key and re-sign, and every check then passes against their key. The desktop
 * host has remembered which key a document was first opened with for a while;
 * the app people actually carry did not.
 *
 * It matters more here than there. This app takes containers from a link, and
 * an address that can serve an update is an address that can serve an
 * impersonation.
 */
const pem = (): string =>
  generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

/** The same document — same identity — signed by whichever key it is given. */
function sign(uuid: string, key: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dai-trust-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.html"), body);

  const keyPath = join(dir, "key.pem");
  writeFileSync(keyPath, key);

  const out = join(dir, "app.dai.html");
  execFileSync(
    process.execPath,
    [join(repo, "dist", "bin.js"), "build", join(dir, "src"), "-o", out, "--uuid", uuid, "-k", keyPath, "--quiet"],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  return out;
}

const UUID = "6f1b7d3a-2c48-4f9e-9b21-0c5d7e8a4b10";

test.describe("the opener remembers who signed a document", () => {
  test.slow();

  test("refuses a copy signed by a different publisher", async ({ page }) => {
    const original = sign(UUID, pem(), "<!doctype html><title>Notes</title><p>the original");
    // Mathematically valid, correctly signed — by somebody else.
    const impostor = sign(UUID, pem(), "<!doctype html><title>Notes</title><p>an impostor");

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", original);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });

    await page.locator("#eject").click();
    await page.setInputFiles("#file", impostor);

    await expect(page.locator("#report")).toContainText(/different publisher/i, {
      timeout: 30_000,
    });
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("opens the same document again when the key has not changed", async ({ page }) => {
    // The pin must not be a tax on ordinary use: a document opened twice is the
    // common case, and a host that questioned it would teach people to ignore
    // the warning that matters.
    const key = pem();
    const first = sign(UUID, key, "<!doctype html><title>Notes</title><p>one");
    const again = sign(UUID, key, "<!doctype html><title>Notes</title><p>one");

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", first);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });

    await page.locator("#eject").click();
    await page.setInputFiles("#file", again);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });
  });

  test("notices a signature stripped from a document that had one", async ({ page }) => {
    const signed = sign(UUID, pem(), "<!doctype html><title>Notes</title><p>signed");

    const dir = mkdtempSync(join(tmpdir(), "dai-trust-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.html"), "<!doctype html><title>Notes</title><p>bare");
    const bare = join(dir, "bare.dai.html");
    execFileSync(
      process.execPath,
      [join(repo, "dist", "bin.js"), "build", join(dir, "src"), "-o", bare, "--uuid", UUID, "--quiet"],
      { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
    );

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", signed);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });

    await page.locator("#eject").click();
    await page.setInputFiles("#file", bare);

    await expect(page.locator("#report")).toContainText(/not signed at all/i, { timeout: 30_000 });
  });
});
