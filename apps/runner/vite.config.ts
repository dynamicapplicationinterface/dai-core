import { defineConfig } from "vite";

/**
 * The runner must be served over HTTPS (or localhost) for a service worker to
 * register at all. Preview is what the tests drive, since a dev server serves
 * unbundled modules that a cache-first worker would happily freeze.
 */
export default defineConfig({
  base: "./",
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
