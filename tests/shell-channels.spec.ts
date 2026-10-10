import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { buildContainer } from "../src/core.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The channels `connect-src` does not govern, closed where the shell can close
 * them (pass C's H11).
 *
 * DNS prefetch is switched off in the shell and in the application's frame.
 * Speculation rules run only with `'inline-speculation-rules'` or a nonce: the
 * policy grants the first to nothing, and the runtime, which stamps its nonce
 * on the application's own inline scripts, leaves a speculation rules script
 * unstamped, so the policy the frame inherits refuses it. WebRTC is not
 * closed: no policy a page sets closes it in a browser host, and the site says
 * so.
 */
test("the shell and the application's frame close DNS prefetch and speculation rules", async ({ page }) => {
  const encoder = new TextEncoder();
  const built = await buildContainer({
    files: {
      "index.html": encoder.encode(
        '<!doctype html><meta charset="utf-8"><p id="out"></p>' +
          '<script type="speculationrules">{"prefetch":[{"source":"list","urls":["https://example.com/"]}]}</script>' +
          "<script>" +
          "const rules = document.querySelector('script[type=speculationrules]');" +
          "const prefetch = document.querySelector('meta[http-equiv=x-dns-prefetch-control]');" +
          "document.getElementById('out').textContent = [String(rules.nonce === ''), prefetch ? prefetch.content : 'none'].join('|');" +
          "</script>",
      ),
    },
    template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
    runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
    appName: "Channels",
  });

  // The shell, as parsed: the switch is in the head, and the policy grants no
  // inline speculation rules.
  await page.goto("about:blank");
  const shell = await page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, "text/html");
    const prefetch = doc.querySelector('meta[http-equiv="x-dns-prefetch-control"]');
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return {
      prefetch: prefetch && doc.head.contains(prefetch) ? prefetch.getAttribute("content") : null,
      csp: csp?.getAttribute("content") ?? "",
    };
  }, built.html);
  expect(shell.prefetch).toBe("off");
  expect(shell.csp).toMatch(/script-src 'nonce-/);
  expect(shell.csp).not.toContain("inline-speculation-rules");

  // The application's frame: its speculation rules script carries no nonce,
  // and the frame has DNS prefetch off too.
  const file = join(tmpdir(), `dai-channels-${Date.now()}.dai.html`);
  writeFileSync(file, built.html, "utf8");
  await page.goto(pathToFileURL(file).href);
  const out = page.frameLocator("iframe").locator("#out");
  await expect(out).toHaveText(/./, { timeout: 30_000 });
  const [unstamped, framePrefetch] = (await out.textContent())!.split("|");
  expect(unstamped, "the speculation rules script carries no nonce").toBe("true");
  expect(framePrefetch, "the frame switches DNS prefetch off").toBe("off");
});

/**
 * A slash before the attribute, run (3-H1). HTML reads `<script/src=…>` as
 * `<script src=…>`, and the stamp wanted a space before `src` and `type`, so
 * it stamped both slash forms: a remote script loaded and ran in the frame,
 * and a speculation rule prefetched. Chromium only: it is the engine that
 * runs speculation rules.
 */
test("a script or a rule after a slash gets no nonce, so neither runs", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "speculation rules are Chromium's; the stamp itself is held in script-tags.spec.ts");
  const hits: { path: string; purpose: string }[] = [];
  let top = "";
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    hits.push({ path, purpose: String(request.headers["sec-purpose"] ?? "") });
    const send = (type: string, body: string, headers: Record<string, string> = {}) => {
      response.writeHead(200, { "content-type": type, ...headers });
      response.end(body);
    };
    if (path === "/beacon.js") return send("text/javascript", "window.beaconRan = true;");
    if (path === "/container.html") return send("text/html", container);
    if (path === "/rules.html") return send("text/html", top, { "content-security-policy": `script-src 'nonce-${nonce}'` });
    return send("text/html", "<p>prefetched</p>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const rule = '{"prefetch":[{"source":"list","urls":["/prefetched.html"]}]}';
  let container = "";
  let nonce = "";
  try {
    const built = await buildContainer({
      files: {
        "index.html": new TextEncoder().encode(
          '<!doctype html><meta charset="utf-8"><p id="out"></p>' +
            `<script/src=//localhost:${port}/beacon.js></script>` +
            `<script/type="speculationrules">${rule}</script>` +
            "<script>" +
            "const rules = document.querySelector('script[type=speculationrules]');" +
            "document.getElementById('out').textContent = JSON.stringify(" +
            "{ ran: Boolean(window.beaconRan), rule: rules.nonce, nonce: document.currentScript.nonce });" +
            "</script>",
        ),
      },
      template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
      runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
      appName: "Slash",
    });
    container = built.html;

    // The frame: classic scripts run in order, so when the last one writes,
    // the remote one has run or been refused.
    await page.goto(`http://localhost:${port}/container.html`);
    const out = page.frameLocator("iframe").locator("#out");
    await expect(out).toHaveText(/ran/, { timeout: 30_000 });
    const frame = JSON.parse((await out.textContent())!) as { ran: boolean; rule: string; nonce: string };
    nonce = frame.nonce;
    expect(nonce, "the frame's own inline script was stamped").not.toBe("");
    expect.soft(frame.ran, "the remote script after a slash ran in the frame").toBe(false);
    expect.soft(hits.filter((hit) => hit.path === "/beacon.js"), "the remote script was fetched").toEqual([]);

    // The rule, as the frame holds it, in a top-level document under the
    // template's script-src: Chromium does not run speculation rules in a
    // subframe, so this is where a nonce on it would show. A rule the test
    // stamps by hand is the control that prefetching works here at all.
    top =
      `<script nonce="${nonce}">window.refused = []; document.addEventListener("securitypolicyviolation", (e) => refused.push(e.sample));</script>` +
      `<script/type="speculationrules"${frame.rule ? ` nonce="${frame.rule}"` : ""}>${rule}</script>` +
      `<script type="speculationrules" nonce="${nonce}">{"prefetch":[{"source":"list","urls":["/control.html"]}]}</script>`;
    await page.goto(`http://localhost:${port}/rules.html`);
    const prefetched = (path: string) => hits.some((hit) => hit.path === path && hit.purpose.includes("prefetch"));
    await expect.poll(() => prefetched("/control.html"), { message: "the control rule prefetched", timeout: 15_000 }).toBe(true);
    await expect
      .poll(async () => prefetched("/prefetched.html") || (await page.evaluate(() => (window as unknown as { refused: string[] }).refused.length > 0)), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(prefetched("/prefetched.html"), "the rule after a slash prefetched").toBe(false);
    expect.soft(frame.rule, "the rule after a slash carries the nonce").toBe("");
  } finally {
    await new Promise((done) => server.close(done));
  }
});
