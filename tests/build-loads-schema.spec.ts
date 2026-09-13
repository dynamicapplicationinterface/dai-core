import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { CompileError, compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The build loads the rewritten schema, so a document that would not open is
 * never sealed (backlog D5, second half).
 *
 * A comment after a shared table's last column once rewrote to invalid SQL,
 * built clean, and failed on the device of whoever opened it. That instance is
 * fixed; this closes the category: whatever the rewrite produces is executed
 * in a real engine at build.
 */
function app(schema: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dai-build-loads-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title><p>x</p>");
  writeFileSync(join(dir, "schema.sql"), schema);
  return dir;
}

test.describe("the build loads the schema it seals", () => {
  test("a shared table that rewrites but will not load is refused at build, with SQLite's reason", async () => {
    // The author's own column text is carried into the rewrite as written; an
    // incomplete clause survives the rewrite and fails only in SQLite.
    const dir = app("-- dai:replicated\nCREATE TABLE IF NOT EXISTS t (\n  a TEXT NOT NULL REFERENCES\n);\n");
    const refused = await compileDirectory({ sourceDir: dir, root: repo, appName: "x" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(CompileError);
    expect((refused as Error).message).toContain("does not load in SQLite");
  });

  test("a session schema that loads still builds", async () => {
    const dir = app(
      "-- dai:profile session max_parties=2\n-- dai:replicated\nCREATE TABLE IF NOT EXISTS t (\n  a TEXT NOT NULL -- a comment after the last column\n);\n",
    );
    const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "x" });
    expect(built.html.length).toBeGreaterThan(0);
  });

  test("an ordinary schema is left to the author, as before", async () => {
    // Not executed: a plain schema is sealed exactly as written, and this change
    // is about what the compiler adds, not about the author's own SQL.
    const dir = app("CREATE TABLE IF NOT EXISTS notes (body TEXT);\n");
    const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "x" });
    expect(built.html.length).toBeGreaterThan(0);
  });
});
