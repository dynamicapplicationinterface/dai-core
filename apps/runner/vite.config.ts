import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Records which commit a build came from.
 *
 * Production here is promoted by hand, so "is the fix live" is a question
 * somebody has to ask several times a day. Without this the only way to answer
 * it is to grep the deployed bundle for a string and hope the right one
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
export default defineConfig({
  base: "./",
  plugins: [stamp()],
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
