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
function stamp(): Plugin {
  return {
    name: "dai-version-stamp",
    apply: "build",
    closeBundle() {
      const commit =
        process.env.VERCEL_GIT_COMMIT_SHA ??
        (() => {
          try {
            return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
          } catch {
            return "unknown";
          }
        })();

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
  base: "./",
  plugins: [stamp(), engine(), tableLink()],
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true, headers: productionHeaders() },
  build: { outDir: "dist", emptyOutDir: true },
});
