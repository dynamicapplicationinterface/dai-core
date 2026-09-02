import { defineConfig } from "vite";

/**
 * The Studio is an ordinary online web app. The air-gap rules apply to the
 * containers it produces, not to the tool that produces them — it fetches the
 * SQLite engine and the esbuild WASM binary from its own origin at startup.
 */
/**
 * The 14 MB esbuild binary and the 865 KB SQLite engine are content-hashed by
 * the build, so their URLs change whenever their bytes do. That makes them safe
 * to treat as immutable — a client should never revalidate them.
 *
 * These headers cover dev and preview only. A real deployment must set the same
 * policy at its CDN or origin server; Vite cannot do it for you there.
 */
const IMMUTABLE = { "Cache-Control": "public, max-age=31536000, immutable" };

export default defineConfig({
  server: { port: 5174, strictPort: true, headers: IMMUTABLE },
  preview: { port: 5174, strictPort: true, headers: IMMUTABLE },
  optimizeDeps: { exclude: ["esbuild-wasm"] },
  build: {
    // Hashed filenames are what make the immutable policy correct.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: { assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
});
