import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ISOLATION_CLAUSES, verifyClaim } from "../src/host-profile.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(repo, "apps/runner/dist");
const probe = resolve(repo, "conformance", "isolation-probe.dai.html");

/**
 * The opener, served by a host that does nothing.
 *
 * The point of an opener that anyone can mirror is that nobody has to run
 * ours: a company can serve the same build off a file share, a person can put
 * it on a static bucket, and a document keeps working if this project stops
 * existing. That is only true if the opener needs nothing from its server —
 * no rewrite rule, no redirect, no header doing security work — and "largely
 * true today" was as far as anyone had checked.
 *
 * So this is a server with no logic in it at all. It maps a path to a file and
 * sends a content type, and sends none of the headers production sends. If any
 * of the isolation depends on one of those, the probe finds it here.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

test.describe("the opener on a host that does nothing", () => {
  test.skip(!existsSync(dist), "run `vite build apps/runner` first");
  test.skip(!existsSync(probe), "run `npm run conformance` to build the probe");

  let server: Server | undefined;
  let origin = "";

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      const path = decodeURIComponent((request.url ?? "/").split("?")[0]!.split("#")[0]!);
      // A directory is index.html, which is the one convention every static
      // host shares. Anything beyond that would be logic.
      /*
       * The one rewrite a mirror needs: `/d/<id>` is the same document as `/`.
       *
       * A reference link names the opener at a path, and the opener reads the
       * id out of `location.pathname` itself. Serving index.html there is all
       * a static host has to do — no function, no redirect, no forwarding
       * page — and it is what makes those links work on a mirror at all.
       */
      const rewritten = /^\/d\/[0-9a-f]{64}\/?$/i.test(path) ? "/" : path;
      const file = join(dist, rewritten === "/" ? "index.html" : rewritten.replace(/^\/+/, ""));

      if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
        response.writeHead(404).end("not here");
        return;
      }

      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(response);
    });

    await new Promise<void>((listening) => server!.listen(0, "127.0.0.1", listening));
    const address = server!.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  });

  test.afterAll(async () => {
    await new Promise<void>((closed) => server?.close(() => closed()));
  });

  test("mounts a document, and the probe finds every claimed clause blocked", async ({ page }) => {
    test.slow();

    await page.goto(origin);
    await openFile(page, probe);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    const handle = await page.waitForFunction(
      () =>
        (window as unknown as { __runner: { isolationReport: unknown } }).__runner.isolationReport,
      undefined,
      { timeout: 60_000 },
    );
    const report = (await handle.jsonValue()) as {
      results: { id: string; status: "blocked" | "allowed" }[];
      hostProfile: string[];
    };

    // The same claim as on the real thing: a mirror that quietly claimed less
    // would be a different host wearing the same build.
    expect(report.hostProfile).toEqual([...ISOLATION_CLAUSES]);

    const verdict = verifyClaim(report.hostProfile, report.results);
    expect(
      verdict.broken,
      `claimed on a plain host but open: ${verdict.broken.join(", ")}`,
    ).toEqual([]);
    expect(verdict.unchecked).toEqual([]);
  });

  test("nothing it asks for needs a rule on the server", async ({ page }) => {
    test.slow();

    // A mirror will not have rewrites, so a 404 here is a file the build
    // expects somebody to configure for — the thing that makes an opener
    // un-mirrorable without anyone noticing.
    const missing: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 404) missing.push(new URL(response.url()).pathname);
    });

    await page.goto(origin);
    await openFile(page, probe);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await page.waitForFunction(
      () =>
        (window as unknown as { __runner: { isolationReport: unknown } }).__runner.isolationReport,
      undefined,
      { timeout: 60_000 },
    );

    expect(missing, `served nothing for: ${missing.join(", ")}`).toEqual([]);
  });
});

/**
 * A reference link on a mirror (backlog 3.3, the half that needs no function).
 *
 * `/d/<id>` is served the opener's own index.html, and the opener reads the id
 * from the path. Nothing else is required: no redirect, no forwarding page, no
 * code at the edge. A host that can run code at the edge adds a preview to the
 * same document; a host that cannot serves it plainly and the link still opens.
 */
test.describe("a /d/ link on a plain static host", () => {
  test.skip(!existsSync(dist), "run `vite build apps/runner` first");

  test("opens the document, with the fragment intact and no preview tags", async ({ page }) => {
    test.slow();
    const { createServer: createStore } = await import("node:http");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { compileDirectory } = await import("../src/compile.js");
    const { publish } = await import("../src/store.js");
    const { fsStore } = await import("../src/store-fs.js");

    // The opener, with the one rewrite; and a store, on its own origin.
    const opener = createServer((request, response) => {
      const path = decodeURIComponent((request.url ?? "/").split("?")[0]!);
      const rewritten = /^\/d\/[0-9a-f]{64}\/?$/i.test(path) ? "/" : path;
      const file = join(dist, rewritten === "/" ? "index.html" : rewritten.replace(/^\/+/, ""));
      if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
        response.writeHead(404).end("not here");
        return;
      }
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(response);
    });
    await new Promise<void>((ok) => opener.listen(0, "127.0.0.1", ok));
    const openerPort = (opener.address() as { port: number }).port;

    const root = mkdtempSync(join(tmpdir(), "dai-store-"));
    const store = createStore((request, response) => {
      const name = decodeURIComponent((request.url ?? "/").slice(1));
      const file = join(root, name);
      if (!name || !existsSync(file)) {
        response.writeHead(404, { "access-control-allow-origin": "*" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
      createReadStream(file).pipe(response);
    });
    await new Promise<void>((ok) => store.listen(0, "127.0.0.1", ok));
    const storeOrigin = `http://127.0.0.1:${(store.address() as { port: number }).port}`;

    try {
      const built = await compileDirectory({
        sourceDir: resolve(repo, "examples/packing-list"),
        root: repo,
        appName: "Beach trip",
      });
      const { sealed } = await publish(built.html, fsStore({ root, baseUrl: storeOrigin }), `http://127.0.0.1:${openerPort}`);

      // The path names the document; the fragment carries the hash, the store
      // and the key, and never leaves the browser.
      const link =
        `http://127.0.0.1:${openerPort}/d/${sealed.hash}` +
        `#h=${sealed.hash}&u=${encodeURIComponent(`${storeOrigin}/${sealed.hash}`)}&k=${sealed.key}`;

      // Nothing may 404 under /d/: every relative URL in the page — the
      // engine, the confusable table, the worker — resolves against the base
      // tag, not against the path the document was served at.
      const missing: string[] = [];
      page.on("requestfailed", (r) => missing.push(new URL(r.url()).pathname));
      await page.goto(link);
      // Served plainly: the placeholder is untouched and the generic tags stand.
      const head = await page.evaluate(() => document.head.innerHTML);
      expect(head).toContain("A DAI app");
      expect(await page.evaluate(() => location.pathname)).toBe(`/d/${sealed.hash}`);

      await page.locator("#card-open").click({ timeout: 60_000 });
      await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
      await expect(page.locator("#title")).toContainText("Beach trip");
      expect(missing, `404 under /d/: ${missing.join(", ")}`).toEqual([]);
    } finally {
      await new Promise<void>((done) => opener.close(() => done()));
      await new Promise<void>((done) => store.close(() => done()));
    }
  });
});
