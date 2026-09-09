import { defineConfig } from "tsup";

export default defineConfig([
  // The Vite plugin itself (Node).
  {
    entry: ["src/index.ts", "src/core.ts", "src/container.ts", "src/link.ts", "src/inline.ts", "src/p256.ts", "src/kit.ts", "src/store.ts", "src/unfurl.ts", "src/store-fs.ts", "src/store-s3.ts", "src/store-presigned.ts", "src/env.ts", "src/test-keys.ts", "src/x509.ts", "src/identity.ts", "src/sender.ts", "src/compile.ts", "src/replicated.ts", "src/replicated-rows.ts", "src/replicated-frame.ts", "src/cli.ts", "src/bin.ts", "src/browser.ts", "src/lint.ts", "src/recipe.ts", "src/format.ts", "src/cbor.ts", "src/cose.ts", "src/mcp.ts", "src/mcp-bin.ts"],
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
  /*
   * The merge, as one self-contained module.
   *
   * The frame that owns the database is serialized with `toString()` and
   * cannot reference an import, so the merge reaches it as a module the host
   * supplies — the same route §6.2 already uses for the engine. This is the
   * file that travels, and the conformance fixtures import this one too, so
   * "the frame ran what the fixtures ran" is a statement about identical bytes
   * rather than about two builds of one source.
   *
   * `splitting: false` matters: the library build emits a thin re-export over
   * a shared chunk, which is two files and the wrong two — the chunk carries
   * other modules' code as well.
   */
  {
    entry: { "dai-merge": "src/replicated-rows.ts" },
    format: ["esm"],
    outExtension: () => ({ js: ".js" }),
    splitting: false,
    clean: false,
    minify: false,
    sourcemap: false,
    dts: false,
    target: "es2020",
    platform: "browser",
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
    // The template must be copied before the assets module embeds it.
    onSuccess: "node scripts/copy-template.mjs && node scripts/embed-assets.mjs",
  },
]);
