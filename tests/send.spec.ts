import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const CONTAINER = resolve(repo, "tests/fixture/fixture.dai.html");

/**
 * Send: a link the other person taps and is in the app.
 *
 * A phone test settled what "send a copy" must not be: the file went over
 * iMessage, the recipient tapped it, and Quick Look — which shows HTML and
 * never runs it — put the fallback line in front of them. A document is
 * sent as a link: inside the address when it fits, through the store when it
 * does not, with the preview a decision made where it is visible.
 */

/** The clipboard, captured: no share sheet in a headless browser. */
async function captureClipboard(page: Page): Promise<() => Promise<string | undefined>> {
  await page.evaluate(() => {
    (window as unknown as { __copied?: string }).__copied = undefined;
    navigator.clipboard.writeText = async (text: string) => {
      (window as unknown as { __copied?: string }).__copied = text;
    };
  });
  return () => page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
}

/** A document too big for an address: random bytes defeat the carrier's compression. */
async function bigDocument(prefix: string, withIcon: boolean): Promise<string> {
  const filler = Buffer.from(crypto.getRandomValues(new Uint8Array(60 * 1024))).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (withIcon) {
    writeFileSync(
      join(dir, "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#d9663c"/></svg>',
      "utf8",
    );
  }
  writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><p>big</p><!-- ${filler} -->`, "utf8");
  const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "Big one" });
  const file = join(dir, "big.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

test.describe("sending a document", () => {
  test("a small document travels inside the link, and nothing is uploaded", async ({ page }) => {
    test.slow();
    let presigned = 0;
    await page.route("**/api/presign", (route) => {
      presigned += 1;
      void route.fulfill({ status: 500, body: "{}" });
    });
    await page.goto(RUNNER_URL);
    await openFile(page, CONTAINER);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    const copied = await captureClipboard(page);

    await page.click("#more");
    await page.click("#send");
    await expect(page.locator("#send-sheet")).toBeVisible();
    await expect(page.locator("#send-sub")).toContainText("Nothing is uploaded");
    await page.click("#send-go");
    await expect(page.locator("#report")).toContainText(/Link copied/, { timeout: 30_000 });
    expect(await copied()).toMatch(/^http:\/\/localhost:5175\/#a=/);
    expect(presigned).toBe(0);
  });

  test("a large document goes through the store, sealed, with the preview as decided", async ({ page }) => {
    test.slow();
    const file = await bigDocument("dai-send-", true);

    // A store, played by two routes: the presign endpoint mints a PUT to a
    // fake bucket, and the fake bucket records what arrived.
    const puts = new Map<string, Buffer>();
    await page.route("**/api/presign", async (route) => {
      const body = route.request().postDataJSON() as { hash: string; kind: string };
      const key = body.kind === "sidecar" ? `${body.hash}.json` : body.kind === "icon" ? `${body.hash}.png` : body.hash;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          url: `http://localhost:5175/__bucket/${key}`,
          method: "PUT",
          headers: {},
          href: `https://store.test/${key}`,
        }),
      });
    });
    await page.route("**/__bucket/**", async (route) => {
      const url = new URL(route.request().url());
      puts.set(url.pathname.slice("/__bucket/".length), route.request().postDataBuffer() ?? Buffer.alloc(0));
      await route.fulfill({ status: 200, body: "" });
    });

    await page.goto(RUNNER_URL);
    await openFile(page, file);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    const copied = await captureClipboard(page);

    // Preview on: the sidecar carries the name, and an icon travels.
    await page.click("#more");
    await page.click("#send");
    await expect(page.locator("#send-sub")).toContainText("Sealed with a key");
    await expect(page.locator("#send-preview")).toBeChecked();
    await page.click("#send-go");
    await expect(page.locator("#report")).toContainText(/Link copied/, { timeout: 60_000 });
    const link = (await copied())!;
    const match = /\/d\/([0-9a-f]{64})#h=([0-9a-f]{64})&k=([A-Za-z0-9_-]{43})$/.exec(link);
    expect(match, link).toBeTruthy();
    const hash = match![1]!;
    expect(puts.has(hash)).toBe(true);
    expect(puts.has(`${hash}.png`)).toBe(true);
    const sidecar = JSON.parse(puts.get(`${hash}.json`)!.toString("utf8")) as { preview?: { name: string; icon?: boolean } };
    expect(sidecar.preview).toEqual({ name: "Big one", icon: true });
    // Sealed: the store holds ciphertext, not the document.
    expect(puts.get(hash)!.toString("latin1")).not.toContain("dai-payload");

    // Preview off: a sidecar with no preview, and no icon.
    puts.clear();
    await page.click("#more");
    await page.click("#send");
    await page.locator("#send-preview").uncheck();
    await page.click("#send-go");
    await expect(page.locator("#report")).toContainText(/Link copied/, { timeout: 60_000 });
    const second = /\/d\/([0-9a-f]{64})#/.exec((await copied())!)![1]!;
    const bare = JSON.parse(puts.get(`${second}.json`)!.toString("utf8")) as { preview?: unknown };
    expect(bare.preview).toBeUndefined();
    expect(puts.has(`${second}.png`)).toBe(false);
  });

  test("when the store cannot be reached, the file is offered and the person is told", async ({ page }) => {
    test.slow();
    const file = await bigDocument("dai-send-down-", false);
    await page.route("**/api/presign", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "down" }) }),
    );
    // No save dialog in a headless browser, so the file's fallback is the download.
    await page.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });

    await page.goto(RUNNER_URL);
    await openFile(page, file);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    const download = page.waitForEvent("download", { timeout: 60_000 });
    await page.click("#more");
    await page.click("#send");
    await page.click("#send-go");
    await expect(page.locator("#report")).toContainText(/Sharing the file instead/, { timeout: 60_000 });
    expect((await download).suggestedFilename()).toMatch(/\.dai\.html$/);
  });
});
