import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { INLINE_CAP, decodeInline, inlineFrom } from "../src/link.js";
import { linkFor, lastLine, type Host } from "../src/sender.js";
import { fsStore } from "../src/store-fs.js";
import { referenceFrom } from "../src/store.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(repo, "dist/bin.js");

const HOST: Host = {
  template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
  runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
};

const engine = await (async () => {
  const { sha256Hex } = await import("../src/core.js");
  const held = new Map<string, Uint8Array>();
  for (const file of ["sqlite3.wasm", "index.mjs"]) {
    const bytes = new Uint8Array(readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist", file)));
    held.set(await sha256Hex(bytes), bytes);
  }
  return (digest: string) => held.get(digest);
})();

/** A document too big for a fragment: a file the host cannot rebuild. */
async function large() {
  const source = mkdtempSync(join(tmpdir(), "dai-big-"));
  writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><p>big</p>', "utf8");
  writeFileSync(join(source, "noise.bin"), (await import("node:crypto")).randomBytes(200_000));
  return compileDirectory({ sourceDir: source, root: repo, appName: "Big" });
}

/**
 * The sender's last line is the link (backlog 2.5).
 *
 * A door that produces a file and stops has not finished the job: the file is
 * the thing, and the link is how it reaches somebody holding a phone. Inline
 * whenever the document fits, because that link depends on nothing; a store
 * only for what does not fit; and where neither is possible, a sentence saying
 * so rather than a link that will be cut in transit.
 */
test.describe("what link a document gets", () => {
  test("a small document gets an inline link that opens back into it", async () => {
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Beach trip",
    });

    const handoff = await linkFor(built.html, { host: HOST });
    expect(handoff.kind).toBe("inline");
    if (handoff.kind !== "inline") return;

    expect(handoff.link.startsWith("https://opendai.app/#a=")).toBe(true);
    expect(handoff.bytes).toBeLessThan(INLINE_CAP);

    // Not a link-shaped string: the document comes back out of it.
    const value = inlineFrom(new URL(handoff.link).hash)!;
    expect(await decodeInline(value, HOST, engine)).toBe(built.html);

    // And the sentence a door ends with is the link, last.
    expect(lastLine(handoff).trim().endsWith(handoff.link)).toBe(true);
  });

  test("a document too big for a fragment is refused a link, with the reason", async () => {
    test.slow();
    const big = await large();
    const handoff = await linkFor(big.html, { host: HOST });
    expect(handoff.kind).toBe("none");
    if (handoff.kind !== "none") return;
    expect(handoff.why).toMatch(/too|at most|kB/i);
    // The number is the document's, so the sentence is about this document.
    expect(handoff.why).toMatch(/\d+ kB/);
  });

  test("with a store configured, the same document gets a reference link", async () => {
    test.slow();
    const big = await large();
    const root = mkdtempSync(join(tmpdir(), "dai-store-"));
    const handoff = await linkFor(big.html, {
      host: HOST,
      store: fsStore({ root, baseUrl: "https://store.example" }),
    });

    expect(handoff.kind).toBe("reference");
    if (handoff.kind !== "reference") return;

    // Both forms, and both read by the grammar the opener uses.
    const url = new URL(handoff.link);
    expect(referenceFrom(url.pathname, url.search, url.hash)).toMatchObject({
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const any = new URL(handoff.anyHost);
    expect(referenceFrom(any.pathname, any.search, any.hash)?.url).toBe(`https://store.example/${
      referenceFrom(url.pathname, url.search, url.hash)!.hash
    }`);
    // Short enough to send, unlike the document.
    expect(handoff.bytes).toBeLessThan(200);
  });

  test("inline is preferred even when a store is configured", async () => {
    // A store is a dependency; a fragment is not. A document that fits should
    // never be put in one.
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Beach trip",
    });
    const root = mkdtempSync(join(tmpdir(), "dai-store-"));
    const handoff = await linkFor(built.html, { host: HOST, store: fsStore({ root }) });
    expect(handoff.kind).toBe("inline");
  });
});

test.describe("the doors that hand a document over", () => {
  test("dai build ends with the link, and --no-link leaves it out", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "dai-cli-")), "trip.dai.html");
    const withLink = spawnSync(process.execPath, [cli, "build", resolve(repo, "examples/packing-list"), "-o", out, "-n", "Beach trip"], { encoding: "utf8" });
    const lines = withLink.stdout.trim().split("\n");
    expect(lines[lines.length - 1]).toMatch(/^https:\/\/opendai\.app\/#a=/);

    const without = spawnSync(process.execPath, [cli, "build", resolve(repo, "examples/packing-list"), "-o", out, "-n", "Beach trip", "--no-link"], { encoding: "utf8" });
    expect(without.stdout).not.toMatch(/#a=/);
  });

  test("the opener a link points at can be told", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "dai-cli-")), "trip.dai.html");
    const run = spawnSync(
      process.execPath,
      [cli, "build", resolve(repo, "examples/packing-list"), "-o", out, "-n", "Beach trip", "--opener", "https://dai.example"],
      { encoding: "utf8" },
    );
    expect(run.stdout).toMatch(/https:\/\/dai\.example\/#a=/);
  });

  test("create_dai_app ends with the link", async () => {
    const { handleMessage } = await import("../src/mcp.js");
    const root = mkdtempSync(join(tmpdir(), "dai-mcp-"));
    const response = (await handleMessage(
      { root },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_dai_app",
          arguments: {
            appName: "Notes",
            files: { "index.html": '<!doctype html><meta charset="utf-8"><p>notes</p>' },
          },
        },
      },
    )) as { result: { content: { text: string }[] } };

    const said = response.result.content[0]!.text;
    // The file is reported, and the last thing said is the link.
    expect(said).toMatch(/Wrote /);
    expect(said.trim().split("\n").pop()).toMatch(/^https:\/\/opendai\.app\/#a=/);
  });
});

/**
 * Every share path carries the link to this document (backlog 2.6).
 *
 * The message a shared document travels in used to name the opener's address.
 * That told a recipient where to go and nothing about what they had: they
 * still had to find the attachment and hand it over. A link to the document
 * is the whole thing.
 */
test.describe("the share sheet", () => {
  test("the message carries a link that opens this document", async ({ page }) => {
    test.slow();
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Beach trip",
    });

    await page.goto("http://localhost:5175/");
    // Stand in for the share sheet, which a test cannot open, and keep what it
    // was handed. Installed before the page scripts run.
    await page.addInitScript(() => {
      const w = window as unknown as { __shared?: { title?: string; text?: string }; navigator: Navigator };
      // A phone: the share sheet is the save path there, and a desktop is sent
      // to a file picker instead. See apps/runner/src/platform.ts.
      Object.defineProperty(w.navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
        configurable: true,
      });
      Object.defineProperty(w.navigator, "canShare", { value: () => true, configurable: true });
      Object.defineProperty(w.navigator, "share", {
        value: async (data: { title?: string; text?: string }) => {
          w.__shared = data;
        },
        configurable: true,
      });
    });
    await page.reload();
    await page.setInputFiles("#file", { name: "trip.dai.html", mimeType: "text/html", buffer: Buffer.from(built.html) });
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    await page.evaluate(() =>
      (window as unknown as { __runner: { exportContainer: () => Promise<void> } }).__runner.exportContainer(),
    );
    const shared = await page.evaluate(() => (window as unknown as { __shared?: { text?: string } }).__shared);

    // A link to the document, not an address to visit.
    expect(shared?.text).toContain("#a=");
    expect(shared?.text).toContain("Tap to open it");
    expect(shared?.text).not.toMatch(/Open it at opendai\.app/);

    // And it is this document: the fragment decodes back to what was opened.
    const value = /#a=([A-Za-z0-9_-]+)/.exec(shared!.text!)![1]!;
    expect(await decodeInline(value, HOST, engine)).toBe(built.html);
  });
});
