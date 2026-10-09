import { readFileSync, writeFileSync } from "node:fs";
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
