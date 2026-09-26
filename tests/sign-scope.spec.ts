import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { canonicalHeader } from "../src/replicated-batch.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * The host signs only for the document that is open now (cold review of
 * identity step 3, finding 1).
 *
 * A document's own code is untrusted. If the host remembered which document it
 * last agreed to sign for and checked a header against that, then after a
 * person opened a shared document and then any other one, the second
 * document's code could ask for a header naming the first and get it signed
 * with the person's key: a forged move, in their name, in a game they are in.
 * Here the second document is a few lines of script that asks for exactly that,
 * through the path any document's code has (the frame's own sign message, which
 * its shell relays). The host must refuse.
 */
test("a document's code cannot get a header for another document signed", async ({ page }) => {
  test.slow();

  // A: a shared document this device writes to, so the host has signed for it.
  const chess = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
  const dir = mkdtempSync(join(tmpdir(), "dai-sign-scope-"));
  const chessFile = join(dir, "chess.dai.html");
  writeFileSync(chessFile, chess.html, "utf8");
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", chessFile);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
  const documentA = (await page.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid)) as string;
  const author = Buffer.from((await page.evaluate(() => (window as any).__runner.authorId())) as string, "base64url");

  // B: any other document, whose code asks for a header naming A.
  const header = canonicalHeader({
    version: 1,
    document: documentA,
    author: new Uint8Array(author),
    lc: 1,
    digest: new Uint8Array(32).fill(7),
  });
  const source = mkdtempSync(join(tmpdir(), "dai-forger-"));
  writeFileSync(
    join(source, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>Forger</title><p id="out">asking</p><script src="forge.js"></script>',
    "utf8",
  );
  writeFileSync(
    join(source, "forge.js"),
    `const header = Uint8Array.from(${JSON.stringify([...header])});
window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "dai:signed" || data.id !== "forge") return;
  document.getElementById("out").textContent = data.sig ? "signed" : "refused: " + (data.error || "");
});
window.parent.postMessage({ type: "dai:sign", id: "forge", header, seq: 1 }, "*");
`,
    "utf8",
  );
  const forger = await compileDirectory({ sourceDir: source, root: repo, appName: "Forger" });
  const forgerFile = join(dir, "forger.dai.html");
  writeFileSync(forgerFile, forger.html, "utf8");

  await page.setInputFiles("#file", forgerFile);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const out = app(page).locator("#out");
  await expect(out, "the forger's question was answered").not.toHaveText("asking", { timeout: 30_000 });
  await expect(out, "and not with a signature over another document's header").toHaveText(/^refused/);
});
