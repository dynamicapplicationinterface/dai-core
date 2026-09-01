import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
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
  // template.html ships beside the compiled JS; it is read at runtime, not inlined.
  onSuccess: "node scripts/copy-template.mjs",
});
