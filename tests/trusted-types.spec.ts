import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { parseContainer } from "../src/container.js";
import { wantsTrustedTypes } from "../src/core.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(repo, "dist/bin.js");
const RUNNER_URL = "http://localhost:5175/";
const DIRECTIVE = "require-trusted-types-for 'script'";

function shellPolicy(html: string): string {
  const shell = new TextDecoder().decode(parseContainer(html).archive["runtime/container.html"]);
  return /Content-Security-Policy" content="([^"]*)"/.exec(shell)?.[1] ?? "";
}

/**
 * Trusted Types (spec §4.2): the control that `strict-dynamic` stood in for.
 *
 * With a public nonce, a stored value pushed through innerHTML, document.write,
 * srcdoc or createContextualFragment executes. The directive makes those sinks
 * refuse a plain string. It costs a kit-only application nothing — the kit
 * touches no sink — so those are sealed with it on; an application with
 * JavaScript of its own is left alone and told by `dai check` where its sinks
 * are.
 */
test.describe("Trusted Types", () => {
  test("a kit-only app is sealed with the directive, and runs under it", async ({ page }) => {
    test.slow();
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    expect(shellPolicy(built.html)).toContain(DIRECTIVE);
    expect(shellPolicy(built.html)).toContain("trusted-types dai-shell dai-frame");

    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", { name: "trip.dai.html", mimeType: "text/html", buffer: Buffer.from(built.html) });
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // The app drew from the database and takes a click: both sinks the
    // runtime uses went through their policies, and the kit needed none.
    const app = page.frameLocator("#cartridge").frameLocator("#dai-app");
    await expect(app.locator("h1")).toHaveText("Beach trip", { timeout: 60_000 });
    const before = await app.locator("dai-value").first().textContent();
    await app.locator(".item").first().click();
    await expect(app.locator("dai-value").first()).not.toHaveText(before ?? "", { timeout: 30_000 });
  });

  test("an app with its own JavaScript is left alone, and dai check names the sink", async () => {
    const source = mkdtempSync(join(tmpdir(), "dai-tt-"));
    writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><div id="out"></div><script type="module" src="./app.js"></script>', "utf8");
    writeFileSync(join(source, "app.js"), 'document.getElementById("out").innerHTML = "<b>hi</b>";\n', "utf8");
    expect(wantsTrustedTypes({ "index.html": new Uint8Array(), "app.js": new Uint8Array() })).toBe(false);

    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Sinky" });
    expect(shellPolicy(built.html)).not.toContain(DIRECTIVE);

    const check = spawnSync(process.execPath, [cli, "check", source, "--json"], { encoding: "utf8" });
    const report = JSON.parse(check.stdout) as { ok: boolean; findings: { id: string }[]; advice: { id: string }[] };
    // Advice, not a refusal: the app builds, and is told where its sink is.
    expect(report.ok).toBe(true);
    expect(report.findings.map((f) => f.id)).not.toContain("trusted-types-sink");
    expect(report.advice.map((f) => f.id)).toContain("trusted-types-sink");
  });

  test("the decision is a function of the files alone", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    // Kit include and SQL blocks are not "JavaScript of its own".
    expect(wantsTrustedTypes({
      "index.html": enc('<script type="application/sql">SELECT 1</script><script type="module" src="./dai-kit.js"></script>'),
      "dai-kit.js": enc("kit"),
    })).toBe(true);
    // An inline module is.
    expect(wantsTrustedTypes({ "index.html": enc('<script type="module">const x = 1;</script>') })).toBe(false);
    // So is any other script file.
    expect(wantsTrustedTypes({ "index.html": enc("<p>hi</p>"), "lib/util.js": enc("export {}") })).toBe(false);
  });
});
