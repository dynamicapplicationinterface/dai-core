import { defineConfig } from "vite";

/**
 * The Studio is an ordinary online web app. The air-gap rules apply to the
 * containers it produces, not to the tool that produces them — it fetches the
 * SQLite engine and the esbuild WASM binary from its own origin at startup.
 */
export default defineConfig({
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
  optimizeDeps: { exclude: ["esbuild-wasm"] },
});
