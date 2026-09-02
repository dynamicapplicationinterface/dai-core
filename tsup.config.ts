import { defineConfig } from "tsup";

export default defineConfig([
  // The Vite plugin itself (Node).
  {
    entry: ["src/index.ts", "src/core.ts"],
    format: ["esm", "cjs"],
    outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node18",
    platform: "node",
    // Provides __dirname in the ESM output so the template can be resolved at runtime.
    shims: true,
    external: ["vite"],
  },
  // The browser bootloader, bundled to a single IIFE (fflate inlined) and
  // injected verbatim into the container. It must never fetch anything.
  {
    entry: { "dai-runtime": "src/runtime/bootloader.ts" },
    format: ["iife"],
    outExtension: () => ({ js: ".js" }),
    clean: false,
    minify: true,
    sourcemap: false,
    target: "es2018",
    platform: "browser",
    // template.html ships beside the compiled JS; it is read at runtime.
    onSuccess: "node scripts/copy-template.mjs",
  },
]);
