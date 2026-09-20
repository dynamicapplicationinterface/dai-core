import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { publish } from "../src/store.js";
import { fsStore } from "../src/store-fs.js";

/**
 * A probe, not a test: which manifest is live on the page, from load through
 * mount, for an iPhone opening a /d/ chess link. It asserts nothing and prints
 * a timeline, so it runs only when asked for:
 *
 *   PROBE_ICON=1 npx playwright test tests/probe-icon-manifest.spec.ts --project=webkit
 *
 * Every change to the manifest link, apple-touch-icon and app title is logged
 * with the manifest's own name and start_url, beside every main-frame
 * navigation, then the arrival line (worker build, arrived manifest, iOS
 * reload) the opener shows beside D49.
 *
 * - PROBE_EDGE=1 puts production's edge (apps/runner/middleware.ts) in front.
 * - PROBE_WARM=1 lets the worker take control of the opener before the link.
 * - PROBE_OLD_SW=<file> serves that worker (stamped PROBE_OLD_SW_BUILD) for
 *   every /sw.js request, so an old worker controls and cannot update:
 *   `git show 2055c00:apps/runner/public/sw.js > old-sw.js`.
 *
 * Written for the iOS icon that opened the bare opener (19 September). On
 * WebKit it did not reproduce under any of the three switches; the arrival
 * line is how the phone says what it saw instead.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = resolve(repo, "conformance", "signing-key.pem");
const RUNNER_URL = "http://localhost:5175/";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

async function serve(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "/").split("?")[0]!.slice(1));
    const file = join(root, name);
    if (!name || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404, { "access-control-allow-origin": "*" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

/** Production's edge in front of the local opener: /d/ and /p/ through the real middleware. */
async function edge(oldWorker?: string): Promise<{ server: Server; origin: string }> {
  const middleware = (await import("../apps/runner/middleware.js")).default;
  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    if (oldWorker && path.split("?")[0] === "/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" });
      response.end(oldWorker);
      return;
    }
    try {
      const upstream = /^\/(d|p)\/[0-9a-f]{64}\/?(\?.*)?$/i.test(path)
        ? await middleware(new Request(`http://localhost:${(server.address() as { port: number }).port}${path}`))
        : await fetch(`http://localhost:5175${path}`, { headers: { accept: request.headers.accept ?? "*/*" } });
      const headers: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (k !== "content-encoding" && k !== "content-length" && k !== "transfer-encoding") headers[k] = v;
      });
      response.writeHead(upstream.status, headers);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      response.writeHead(502).end(String(e));
    }
  });
  await new Promise<void>((listening) => server.listen(0, listening));
  return { server, origin: `http://localhost:${(server.address() as { port: number }).port}` };
}

test("probe: the manifest live on an iPhone /d/ chess open", async ({ browser }) => {
  test.skip(!process.env.PROBE_ICON, "a probe: run with PROBE_ICON=1");
  test.setTimeout(180_000);
  const built = await compileDirectory({
    sourceDir: join(repo, "tests", "fixture", "chess"),
    root: repo,
    appName: "Velvet Chess",
    signingKey: KEY,
    allowTestKey: true,
  });
  const root = mkdtempSync(join(tmpdir(), "dai-store-"));
  const store = await serve(root);
  const log: string[] = [];
  process.env.DAI_STORE_PUBLIC_BASE = `${store.origin}/`;
  // PROBE_OLD_SW=<file>: that worker is the only one this origin ever serves,
  // stamped with its commit, so it installs, controls, and cannot be replaced.
  const oldWorker = process.env.PROBE_OLD_SW
    ? readFileSync(process.env.PROBE_OLD_SW, "utf8").replace('"__DAI_BUILD__"', `"${process.env.PROBE_OLD_SW_BUILD ?? "old-worker"}"`)
    : undefined;
  const front = process.env.PROBE_EDGE || oldWorker ? await edge(oldWorker) : undefined;
  const opener = front ? `${front.origin}/` : RUNNER_URL;
  log.push(`opener: ${opener}`);
  const t0 = Date.now();
  try {
    const { sealed } = await publish(built.html, fsStore({ root, baseUrl: store.origin }), opener);
    const link = `${opener}d/${sealed.hash}#h=${sealed.hash}&k=${sealed.key}`;
    const context = await browser.newContext({ userAgent: IPHONE });
    const page = await context.newPage();
    await page.addInitScript((config) => {
      (window as unknown as { __daiStore: unknown }).__daiStore = config;
    }, { presignUrl: `${store.origin}/presign-unused`, publicBase: `${store.origin}/` });
    await page.exposeFunction("__probe", (line: string) => log.push(`${String(Date.now() - t0).padStart(6)}ms ${line}`));
    await page.addInitScript(() => {
      const say = (window as unknown as { __probe: (l: string) => void }).__probe;
      const describe = async (why: string) => {
        const m = document.querySelector('link[rel="manifest"]')?.getAttribute("href") ?? "(none)";
        const icon = document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") ?? "(none)";
        const name = document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content") ?? "(none)";
        let inside = "";
        try {
          const r = await fetch(m);
          const j = (await r.json()) as { name?: string; start_url?: string; icons?: { src: string }[] };
          inside = ` => name=${j.name} start_url=${(j.start_url ?? "").replace(/k=[^&]+/, "k=<key>")} icons=[${(j.icons ?? []).map((i) => i.src.slice(0, 48)).join(", ")}]`;
        } catch (e) {
          inside = ` => (fetch failed: ${String(e).slice(0, 60)})`;
        }
        say(`${why} | url=${location.pathname}${location.search}${location.hash.replace(/k=[^&]+/, "k=<key>")} | title="${document.title}" app-title="${name}" | manifest=${m.slice(0, 90)}${inside} | touch-icon=${icon.slice(0, 60)}`);
      };
      const watch = () => {
        void describe("as loaded");
        new MutationObserver((records) => {
          for (const r of records) {
            const el = r.target as Element;
            if (r.type === "attributes" && el.matches?.('link[rel="manifest"], link[rel="apple-touch-icon"], meta[name="apple-mobile-web-app-title"]')) {
              void describe(`CHANGED ${el.tagName.toLowerCase()} ${el.getAttribute("rel") ?? el.getAttribute("name")}`);
            }
            if (r.type === "childList") {
              for (const n of [...r.addedNodes, ...r.removedNodes]) {
                const e = n as Element;
                if (e.matches?.('link[rel="manifest"], link[rel="apple-touch-icon"]')) void describe(`ADDED/REMOVED ${e.getAttribute("rel")}`);
              }
            }
          }
        }).observe(document.head, { attributes: true, childList: true, subtree: true, attributeFilter: ["href", "content"] });
      };
      if (document.head) watch();
      else document.addEventListener("DOMContentLoaded", watch);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) log.push(`${String(Date.now() - t0).padStart(6)}ms NAVIGATED ${frame.url().replace(/k=[^&]+/, "k=<key>")}`);
    });
    page.on("console", (m) => {
      if (/manifest|describ|keep|icon|reload/i.test(m.text())) log.push(`${String(Date.now() - t0).padStart(6)}ms console: ${m.text().slice(0, 160)}`);
    });
    if (process.env.PROBE_WARM) {
      await page.goto(opener);
      await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 30_000 });
      log.push(`${String(Date.now() - t0).padStart(6)}ms WARM: worker controls the opener`);
    }
    await page.goto(link);
    const card = page.locator("#card-open");
    await card.waitFor({ timeout: 30_000 }).then(() => card.click()).catch(() => log.push("(no card)"));
    await page.locator("body.loaded").waitFor({ timeout: 60_000 }).catch(() => log.push("(never loaded)"));
    log.push(`${String(Date.now() - t0).padStart(6)}ms body.loaded`);
    await page.waitForTimeout(8_000);
    await page.evaluate(() => (window as unknown as { __probe: (l: string) => void }).__probe("--- final state follows"));
    await page.evaluate(async () => {
      const m = document.querySelector('link[rel="manifest"]')?.getAttribute("href");
      (window as unknown as { __probe: (l: string) => void }).__probe(
        `ARRIVAL LINE: ${document.getElementById("chooser-arrival")?.textContent ?? "(no slot)"}
FINAL manifest=${m} | caches=${(await caches.keys()).join(",")} | controller=${navigator.serviceWorker?.controller?.scriptURL ?? "none"}`,
      );
    });
    await page.waitForTimeout(500);
    await context.close();
  } finally {
    await new Promise<void>((done) => store.server.close(() => done()));
    if (front) await new Promise<void>((done) => front.server.close(() => done()));
    console.log("PROBE LOG\n" + log.join("\n"));
  }
});
