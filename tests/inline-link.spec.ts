import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { readFileSync } from "node:fs";
import { INLINE_CAP, decodeInline, encodeInline, inlineFrom, inlineLink } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/** The same host the opener ships: what the sender may leave out is what this can rebuild. */
const engine = await (async () => {
  const { sha256Hex } = await import("../src/core.js");
  const held = new Map<string, Uint8Array>();
  for (const file of ["sqlite3.wasm", "index.mjs"]) {
    const bytes = new Uint8Array(readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist", file)));
    held.set(await sha256Hex(bytes), bytes);
  }
  return (digest: string) => held.get(digest);
})();

const HOST = {
  template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
  runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
};

/**
 * A document carried in the address bar.
 *
 * A browser executes URLs, not files, so the link is how a document is met on
 * first contact. The smallest possible link is one that carries the whole
 * document: no store to be down, no address to expire, nothing to fetch. And
 * because everything after the `#` stays in the browser, the document is in
 * the link and nowhere else — not in this origin's logs, not in a proxy's.
 */
test.describe("a document in the link", () => {
  test("goes out and comes back exactly", async () => {
    // A real document, because the carrier sends the document's parts and
    // rebuilds the host's: there is nothing to rebuild around a bare page.
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const value = await encodeInline(built.html, HOST);

    // base64url, so nothing in it needs escaping in an address and nothing is
    // lost to a client that trims a trailing `=`.
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    // The same file, not an equivalent one.
    expect(await decodeInline(value, HOST, engine)).toBe(built.html);
  });

  test("the fragment is read only when it carries a document", () => {
    expect(inlineFrom("#handoff")).toBeUndefined();
    expect(inlineFrom("")).toBeUndefined();
    expect(inlineFrom("#a=")).toBeUndefined();
    // Not a fragment this understands: refusing here is what stops a half-read
    // address becoming a half-read document.
    expect(inlineFrom("#a=has spaces")).toBeUndefined();
    expect(inlineFrom("#a=AAbb-_09")).toBe("AAbb-_09");
  });

  test("the sender is stopped rather than handed a truncated document", async () => {
    // A document that cannot be made small: a megabyte of noise in a file the
    // host has no copy of. A link cut in transit arrives as a document that
    // will not open and nothing to say why, so the sender is told instead.
    const source = mkdtempSync(join(tmpdir(), "dai-big-"));
    writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><p>big</p>', "utf8");
    writeFileSync(join(source, "noise.bin"), (await import("node:crypto")).randomBytes(200_000));
    const big = await compileDirectory({ sourceDir: source, root: repo, appName: "Big" });
    expect(await inlineLink(big.html, RUNNER_URL, HOST)).toBeUndefined();

    const small = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const link = await inlineLink(small.html, "https://opendai.app/", HOST);
    expect(link).toBe(`https://opendai.app/#a=${await encodeInline(small.html, HOST)}`);
    // The whole point of the compact carrier: a real app in a few kilobytes.
    expect(link!.length).toBeLessThan(4 * 1024);
  });

  test("a real app opens from a link with the network switched off", async ({ page, context }) => {
    test.slow();

    /*
     * The whole claim, on a real application rather than a page that paints.
     *
     * Thin, because the engine is the one thing that must not travel twice:
     * the opener holds it, so the link carries the application and its data
     * and nothing else. Offline, because a link that needs the network is a
     * link with a dependency, and the point of putting the document in the
     * address bar is that it has none.
     */
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/chore-chart"),
      root: repo,
      appName: "Chore chart",
    });
    const value = await encodeInline(built.html, HOST);

    // Warm the opener and its worker, which is the one thing that does have to
    // have happened once. Everything after this is from the cache.
    await page.goto(RUNNER_URL);
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 60_000,
    });

    await context.setOffline(true);
    /*
     * Reloaded, not merely navigated.
     *
     * Adding a fragment to the address the page is already on is a
     * same-document navigation: nothing reloads and no script runs again. That
     * is exactly what happens to a person who pastes a link into a tab this
     * app is already open in, which the opener now handles on its own — but
     * this test is about the fresh open, so it forces one.
     */
    await page.goto(`${RUNNER_URL}#a=${value}`);
    await page.reload();

    // The card first: a document from a link is a document from a stranger,
    // and nothing mounts until somebody asks for it.
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // And it ran, with no network at all: the engine came from this app's own
    // cache, and the application from the address bar.
    await expect(
      page.frameLocator("#cartridge").frameLocator("#dai-app").locator("body"),
    ).toContainText(/chore/i, { timeout: 60_000 });
  });

  test("a link cut in transit says so, rather than failing silently", async ({ page }) => {
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const value = await encodeInline(built.html, HOST);

    await page.goto(`${RUNNER_URL}#a=${value.slice(0, Math.floor(value.length / 2))}`);
    await page.reload();

    // The likely cause named, because the alternative reading — that this
    // opener is broken — is the one somebody reaches on their own.
    await expect(page.locator("#report")).toContainText(/shortened|wrapped|damaged/i, {
      timeout: 30_000,
    });
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
  });

  test("a link pasted into a tab already open still opens", async ({ page }) => {
    test.slow();

    // A fragment added to the address a page is already on reloads nothing and
    // runs no script, so without a listener the paste does nothing at all and
    // the person is looking at an empty chooser with their link in the bar.
    const source = mkdtempSync(join(tmpdir(), "dai-pasted-"));
    writeFileSync(
      join(source, "index.html"),
      '<!doctype html><meta charset="utf-8"><title>Pasted</title><p id="app">pasted</p>',
      "utf8",
    );
    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Pasted" });
    const value = await encodeInline(built.html, HOST);

    await page.goto(RUNNER_URL);
    await expect(page.locator("#card")).toBeHidden();

    await page.evaluate((fragment) => {
      location.hash = `a=${fragment}`;
    }, value);

    await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
    await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  });
});
