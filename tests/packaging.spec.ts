import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  bin?: Record<string, string>;
};

/**
 * What has to be true of the published package for the command line and the MCP
 * server to work on somebody else's machine.
 *
 * These are the checks that only fail after publishing, which is the worst time
 * to find out. The SQLite engine was a devDependency until it was caught here:
 * everything passed locally, because the repository has it, while an installed
 * copy would have produced containers with no database at all — silently, since
 * a missing engine is a warning rather than an error.
 */
test.describe("the published package", () => {
  test("ships the SQLite engine as a real dependency", () => {
    expect(
      manifest.dependencies?.["@sqlite.org/sqlite-wasm"],
      "the engine must be a dependency: an installed copy has no devDependencies, " +
        "so the CLI would build containers with no database",
    ).toBeDefined();
    expect(manifest.devDependencies?.["@sqlite.org/sqlite-wasm"]).toBeUndefined();
  });

  test("declares both executables", () => {
    expect(manifest.bin?.dai).toBeDefined();
    expect(manifest.bin?.["dai-mcp"]).toBeDefined();
  });

  test("ships the shell and the bootloader", () => {
    // They are emitted into dist/ by the build and resolved relative to the
    // installed module. Without them every compile fails at the first step.
    expect(manifest.files).toContain("dist");
    for (const asset of ["dist/template.html", "dist/dai-runtime.js"]) {
      expect(() => readFileSync(resolve(repo, asset)), `${asset} is missing`).not.toThrow();
    }
  });

  test("keeps its runtime dependencies to what the format needs", () => {
    // A format whose claim is self-containment should not arrive with a tree of
    // packages behind it. Two is the budget: the zip implementation and the
    // database engine.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@sqlite.org/sqlite-wasm",
      "fflate",
    ]);
  });
});
