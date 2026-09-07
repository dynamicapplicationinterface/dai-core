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

/** Clears the report and the captured clipboard, so a second share is awaited on its own. */
async function resetShare(page: Page): Promise<void> {
  await page.evaluate(() => {
    const report = document.getElementById("report");
    if (report) report.textContent = "";
    (window as unknown as { __copied?: string }).__copied = undefined;
  });
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
    const link = (await copied())!;
    expect(link).toMatch(/^http:\/\/localhost:5175\/#a=/);
    expect(presigned).toBe(0);

    // Somebody following it, in a browser that has never seen this page,
    // goes straight to the card. The chooser — "Open a file" — is not a
    // screen a link should ever show, not even for a frame.
    const theirs = await page.context().browser()!.newContext();
    const fresh = await theirs.newPage();
    await fresh.goto(link);
    await expect(fresh.locator("html")).toHaveClass(/arriving/);
    await expect(fresh.locator("#open")).toBeHidden();
    await expect(fresh.locator("#card")).toBeVisible({ timeout: 30_000 });
    await expect(fresh.locator("#open")).toBeHidden();

    // And a link that names nothing this page can open hands the chooser back.
    // A fresh load, not a same-document hash change.
    await fresh.goto("about:blank");
    await fresh.goto(`${RUNNER_URL}#k=${"a".repeat(43)}`);
    await expect(fresh.locator("#report")).toContainText(/does not say which document/);
    await expect(fresh.locator("#open")).toBeVisible();
    await theirs.close();
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

    // The sidecar carries the name, and an icon travels: the card is what a
    // message shows, the same as for any app a phone shares.
    await page.click("#more");
    await page.click("#send");
    await expect(page.locator("#send-sub")).toContainText("Sealed with a key");
    await expect(page.locator("#send-preview")).toHaveCount(0);
    await page.click("#send-go");
    await expect(page.locator("#report")).toContainText(/Link copied/, { timeout: 60_000 });
    const link = (await copied())!;
    const match = /\/d\/([0-9a-f]{64})#h=([0-9a-f]{64})&k=([A-Za-z0-9_-]{43})$/.exec(link);
    expect(match, link).toBeTruthy();
    const hash = match![1]!;
    expect(puts.has(hash)).toBe(true);
    expect(puts.has(`${hash}.png`)).toBe(true);
    const sidecar = JSON.parse(puts.get(`${hash}.json`)!.toString("utf8")) as { preview?: { name: string; icon?: boolean }; retire?: string };
    expect(sidecar.preview).toEqual({ name: "Big one", icon: true });
    // Sealed: the store holds ciphertext, not the document.
    expect(puts.get(hash)!.toString("latin1")).not.toContain("dai-payload");
    // And the record beside it carries the digest of a retire token, never the token.
    expect(sidecar).toHaveProperty("retire", expect.stringMatching(/^[0-9a-f]{64}$/));

    // Shared through the store, so the sheet now offers to take it back.
    await resetShare(page);
    await page.click("#more");
    await page.click("#send");
    await expect(page.locator("#send-retire")).toBeVisible();
    await expect(page.locator("#send-retire")).toHaveText(/Stop the link I shared before/);
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

/**
 * What goes is what the sender sees — and, when they choose, none of it.
 *
 * Autosave lands shortly after the last edit. A share packaged inside that
 * window used to send the state before the edit; now the host asks the app
 * to flush and waits. And a blank copy is the same app with an empty
 * database: a template, sent without the sender's entries.
 */
test.describe("what a share carries", () => {
  test("an edit made the instant before sharing is in the link; a blank copy carries none", async ({ browser, page }) => {
    test.slow();
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { compileDirectory } = await import("../src/compile.js");
    const source = mkdtempSync(join(tmpdir(), "dai-share-state-"));
    writeFileSync(
      join(source, "schema.sql"),
      "CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, done INTEGER NOT NULL DEFAULT 0);\n" +
        "INSERT INTO jobs (id) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM jobs);",
      "utf8",
    );
    writeFileSync(
      join(source, "index.html"),
      [
        '<!doctype html><meta charset="utf-8">',
        '<dai-rows query="SELECT id, done FROM jobs ORDER BY id">',
        "  <template>",
        '    <p><button id="tick" type="button" data-run="UPDATE jobs SET done = 1 - done WHERE id = :id">tick</button>',
        '    <span id="state" data-text="done"></span></p>',
        "  </template>",
        "</dai-rows>",
        '<script type="module" src="./dai-kit.js"></script>',
      ].join("\n"),
      "utf8",
    );
    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Jobs" });
    const file = join(source, "jobs.dai.html");
    writeFileSync(file, built.html, "utf8");

    await page.goto(RUNNER_URL);
    await openFile(page, file);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    const copied = await captureClipboard(page);
    const app = page.frameLocator("#cartridge").frameLocator("#dai-app");
    await expect(app.locator("#state")).toHaveText("0", { timeout: 30_000 });

    // Tick, and share at once — inside the autosave window.
    await app.locator("#tick").click();
    await expect(app.locator("#state")).toHaveText("1");
    await page.click("#more");
    await page.click("#send");
    await page.click("#send-go");
    await expect(page.locator("#report")).toContainText(/Link copied/, { timeout: 30_000 });
    const withData = (await copied())!;

    // Then a blank copy.
    await resetShare(page);
    await page.click("#more");
    await page.click("#send");
    await page.locator("#send-with-data").uncheck();
    await expect(page.locator("#send-note")).toContainText("none of your entries");
    await page.click("#send-go");
    await expect(page.locator("#report")).toContainText(/Link copied/, { timeout: 30_000 });
    const blank = (await copied())!;
    expect(blank).not.toBe(withData);

    // Opened elsewhere, each says what it carries.
    for (const [link, expected] of [[withData, "1"], [blank, "0"]] as const) {
      const other = await browser.newContext();
      const fresh = await other.newPage();
      await fresh.goto(link);
      await fresh.locator("#card-open").click({ timeout: 60_000 });
      await expect(fresh.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
      const theirs = fresh.frameLocator("#cartridge").frameLocator("#dai-app");
      await expect(theirs.locator("#state")).toHaveText(expected, { timeout: 30_000 });
      await other.close();
    }
  });
});
