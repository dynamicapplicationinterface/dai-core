import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

  /*
   * The immutability trigger's column list comes from parsing the author's
   * declarations, and the build now holds it against the columns SQLite reports
   * (`checkTriggerCoverage`), so a column the parser misses is a refused build
   * rather than a column that can be edited in place. These are the
   * declarations a comma-splitting parser would get wrong — commas inside a
   * type, a default, a check — and they must build, every column covered.
   */
  test("a shared table with commas inside its declarations builds, every column covered", async () => {
    const dir = app(
      "-- dai:replicated\nCREATE TABLE IF NOT EXISTS ledger (\n" +
        "  amount DECIMAL(10, 2) NOT NULL,\n" +
        "  memo TEXT DEFAULT 'rent, June',\n" +
        "  kind TEXT NOT NULL CHECK (kind IN ('in', 'out')),\n" +
        "  note TEXT -- after the last column, as D5 allows\n" +
        ");\n",
    );
    const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "x" });
    expect(built.html.length).toBeGreaterThan(0);
  });

  test("a comment after a column's comma does not hide the next column from the trigger", async () => {
    // Tic-tac-toe's own shape, and the one that shipped wrong: each comment
    // sits after the comma, so it opens the next item — with a comma and an
    // apostrophe inside for good measure. Built, the check holds every column.
    const dir = app(
      "-- dai:replicated\nCREATE TABLE IF NOT EXISTS marks (\n" +
        "  game_id TEXT NOT NULL,     -- the games row's entity, as hex\n" +
        "  turn    INTEGER NOT NULL,  -- 1-based; X plays odd turns, O even\n" +
        "  cell    INTEGER NOT NULL   /* 0..8, left to right */\n" +
        ");\n",
    );
    const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "x" });
    expect(built.html.length).toBeGreaterThan(0);
  });

  test("the chess foil, wrong on purpose, is refused at build", async () => {
    // `examples/chess-foil` is the schema a person should not write, kept to be
    // read and linted, never opened. Its `moves` ends in a UNIQUE table
    // constraint, and the rewrite appends the replication columns after it,
    // which SQLite will not load (backlog D20) — so the build refuses it rather
    // than sealing a document that would fail on open.
    const refused = await compileDirectory({ sourceDir: join(repo, "examples", "chess-foil"), root: repo, appName: "foil" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(CompileError);
  });

  test("every example that ships shared tables passes the coverage check", async () => {
    // Found, not listed, so an example added later is covered without anyone
    // remembering to add it here. The foil is the one exception, above.
    const shared = readdirSync(join(repo, "examples")).filter((name) => {
      const schema = join(repo, "examples", name, "schema.sql");
      return name !== "chess-foil" && existsSync(schema) && readFileSync(schema, "utf8").includes("dai:replicated");
    });
    expect(shared.length, "at least one example ships shared tables").toBeGreaterThan(0);
    for (const example of shared) {
      const built = await compileDirectory({ sourceDir: join(repo, "examples", example), root: repo, appName: example }).catch(
        (error: unknown) => {
          throw new Error(`examples/${example} is refused at build: ${(error as Error).message}`);
        },
      );
      expect(built.html.length, example).toBeGreaterThan(0);
    }
  });

  test("an ordinary schema is left to the author, as before", async () => {
    // Not executed: a plain schema is sealed exactly as written, and this change
    // is about what the compiler adds, not about the author's own SQL.
    const dir = app("CREATE TABLE IF NOT EXISTS notes (body TEXT);\n");
    const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "x" });
    expect(built.html.length).toBeGreaterThan(0);
  });
});
