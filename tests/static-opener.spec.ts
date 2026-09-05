import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ISOLATION_CLAUSES, verifyClaim } from "../src/host-profile.js";

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
      const file = join(dist, path === "/" ? "index.html" : path.replace(/^\/+/, ""));

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
    await page.setInputFiles("#file", probe);
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
    await page.setInputFiles("#file", probe);
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
