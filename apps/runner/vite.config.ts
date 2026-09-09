import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Records which commit a build came from.
 *
 * Production is promoted from main automatically, so "is the fix live" is a
 * question about whether a deploy has landed yet. Without this the only way to
 * answer it is to grep the deployed bundle for a string and hope the right one
 * changed, which produced two confident wrong answers in one evening.
 *
 * `environment` comes from Vercel and is what distinguishes a preview that was
 * never promoted from the deployment actually serving people — they are
 * identical from outside.
 */
function commitId(): string {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ??
    (() => {
      try {
        return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
      } catch {
        return "unknown";
      }
    })()
  );
}

function stamp(): Plugin {
  return {
    name: "dai-version-stamp",
    apply: "build",
    /*
     * Into the page, not only into a file beside it.
     *
     * The stamp is read on two screens, and one of them is the chooser, which
     * a person reaches with no network and nothing opened. A fetch for it also
     * costs the guarantee that opening a document you already have asks the
     * network for nothing at all — that is not theoretical, it broke the test
     * that holds it. Nothing here needs the bundle, so it is known at
     * transform time and the page carries it.
     *
     * version.json is still written: `npm run deploys` asks a deployment what
     * it is over HTTP, and cannot read a meta tag out of a bundle.
     */
    transformIndexHtml(html) {
      const commit = commitId().slice(0, 7);
      const built = new Date().toISOString().slice(0, 10);
      const environment = process.env.VERCEL_ENV ?? "local";
      // Named only when it is not production: the case worth catching is a
      // preview that was never promoted, and those look identical otherwise.
      const where = environment === "production" ? "" : ` · ${environment}`;
      return html.replace(
        /<meta name="dai-build" content="[^"]*" \/>/,
        `<meta name="dai-build" content="${commit} · ${built}${where}" />`,
      );
    },
    closeBundle() {
      const commit = commitId();

      /*
       * The worker's cache is named by this commit. A worker whose bytes never
       * change is never reinstalled, and its precached shell page is served
       * cache-first forever — which is how a phone stayed two deploys behind
       * production. Asserted, not hoped: a stamp that finds no marker and
       * writes the file back unchanged is the silent no-op this repository
       * has been bitten by before.
       */
      const workerPath = join(import.meta.dirname, "dist", "sw.js");
      const worker = readFileSync(workerPath, "utf8");
      const MARKER = '"__DAI_BUILD__"';
      if (!worker.includes(MARKER)) {
        throw new Error(
          `dist/sw.js carries no ${MARKER} marker; the cache name would never change ` +
            "across deploys. See the note above CACHE in apps/runner/public/sw.js.",
        );
      }
      writeFileSync(workerPath, worker.replace(MARKER, JSON.stringify(commit)), "utf8");

      writeFileSync(
        join(import.meta.dirname, "dist", "version.json"),
        JSON.stringify(
          {
            commit,
            builtAt: new Date().toISOString(),
            environment: process.env.VERCEL_ENV ?? "local",
          },
          null,
          2,
        ) + "\n",
      );
    },
  };
}

/**
 * The runner must be served over HTTPS (or localhost) for a service worker to
 * register at all. Preview is what the tests drive, since a dev server serves
 * unbundled modules that a cache-first worker would happily freeze.
 */
/**
 * The headers production sends, so the preview the tests drive sends them too.
 *
 * Without this, a test proved the handoff between the website and the opener
 * worked — against two servers that sent no headers at all. Production sent
 * Cross-Origin-Opener-Policy: same-origin on both, which severs a popup from
 * the page that opened it, and the opener never received a thing.
 */
function productionHeaders(): Record<string, string> {
  const config = JSON.parse(readFileSync(join(import.meta.dirname, "vercel.json"), "utf8")) as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const all = config.headers.find((rule) => rule.source === "/(.*)");
  return Object.fromEntries((all?.headers ?? []).map((h) => [h.key, h.value]));
}

/**
 * Puts the SQLite engine on this origin, where the opener can offer it.
 *
 * A document may be published without its engine, for a host that already
 * holds that exact copy (spec §6.2). Holding it means having the bytes to
 * serve, and these are the bytes the compiler puts in a container: the same
 * file from the same package, so the digests match and the offer is accepted.
 *
 * Copied rather than imported because @sqlite.org/sqlite-wasm does not expose
 * the raw .wasm through its exports map. Staged rather than committed because
 * it is a build output of a dependency — the same reason the desktop app
 * stages its own, under the same /runtime prefix.
 */
function engine(): Plugin {
  return {
    name: "dai-stage-engine",
    buildStart() {
      const repo = join(import.meta.dirname, "../..");
      const out = join(import.meta.dirname, "public/runtime");
      mkdirSync(out, { recursive: true });
      const files = {
        "sqlite3.wasm": join(repo, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"),
        "sqlite3.mjs": join(repo, "node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs"),
        /*
         * The merge, held by the host and never by a document.
         *
         * A document must not be able to supply its own: the rules about what
         * merges and what is refused are the host's, and a document shipping
         * its own copy could accept rows this one refuses. So it is staged
         * here beside the engine, travels the same §6.2 supply route, and the
         * frame imports it only when a merge is actually asked for.
         *
         * The same file the conformance fixtures import, deliberately, so
         * "the frame ran what three readers agreed on" is about identical
         * bytes and not about two builds of one source.
         */
        "dai-merge.js": join(repo, "dist/dai-merge.js"),
      };
      for (const [name, from] of Object.entries(files)) copyFileSync(from, join(out, name));
    },
  };
}

/**
 * Names the confusable table in the page, so the worker precaches it.
 *
 * The table is content-hashed (spec §9.6) and the worker learns asset names
 * from index.html; a prefetch link is the honest way to say "this page will
 * want that file" without the page fetching it before it is needed.
 */
function tableLink(): Plugin {
  return {
    name: "dai-confusables-link",
    transformIndexHtml(html) {
      const id = readFileSync(join(import.meta.dirname, "../../src/confusables-id.ts"), "utf8")
        .match(/CONFUSABLES_ID = "([0-9a-f]+)"/)?.[1];
      if (!id) return html;
      return html.replace("</head>", `  <link rel="prefetch" href="./confusables.${id}.json">\n</head>`);
    },
  };
}

export default defineConfig({
  /*
   * Absolute, because one document is served at more than one path.
   *
   * A reference link is `/d/<id>`, and the opener itself answers there — the
   * host rewrites the path to the same index.html rather than redirecting, so
   * a link previews and opens without a forwarding page. Relative asset paths
   * would then resolve under `/d/` and 404, which is exactly how the first
   * attempt at this failed.
   *
   * The cost is that a mirror must be served from a domain root, or rewrite
   * `/d/*` itself. `?d=<id>` and the any-host link form work from anywhere.
   */
  base: "/",
  plugins: [stamp(), engine(), tableLink()],
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true, headers: productionHeaders() },
  build: { outDir: "dist", emptyOutDir: true },
});
