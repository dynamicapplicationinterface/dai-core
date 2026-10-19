import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../../src/compile.js";
import { breaking, lintFiles } from "../../src/lint.js";
import { RECIPE } from "../../src/recipe.js";
import { rewriteReplicated } from "../../src/replicated.js";

/**
 * Authoring under R-O: one shape. A document with no session policy is built
 * with the changeset log declared for it; the author writes ordinary tables
 * and chooses nothing. A document with a session policy (the chess fixture)
 * builds through the policy layer as before.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function buildFrom(files: Record<string, string>): Promise<Awaited<ReturnType<typeof compileDirectory>>> {
  const src = join(mkdtempSync(join(tmpdir(), "dai-cs-authoring-")), "src");
  mkdirSync(src, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(src, name), text);
  return compileDirectory({ sourceDir: src, root: repo, appName: "Plain" });
}

test("a document with no session policy is built with the changeset log declared, under the authorship layer", async () => {
  const built = await buildFrom({
    "index.html": "<!doctype html><title>Plain</title><p id=app>hi</p>",
    "schema.sql": "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n",
  });
  expect(built.manifest.replication?.tables).toEqual(["_cs_log"]);
  expect(built.manifest.requires).toEqual(["authorship", "replicated"]);
  expect(built.manifest.session).toBeUndefined();
  // The author's schema.sql comes back as written: the log is the runtime's, not theirs.
  expect(new TextDecoder().decode(built.archive["app/schema.sql"])).not.toContain("_cs_log");
});

test("X1: a table with no primary key is given an explicit ranged key column at compile; the author's schema.sql comes back as written", async () => {
  const schema = "CREATE TABLE IF NOT EXISTS marks (body TEXT, at TEXT, CHECK (body <> ''));\nCREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT);\n";
  const built = await buildFrom({ "index.html": "<!doctype html><title>Plain</title><p id=app>hi</p>", "schema.sql": schema });
  const html = new TextDecoder().decode(built.archive["app/index.html"]);
  expect(html).toMatch(/CREATE TABLE IF NOT EXISTS marks \(_dai_id INT NOT NULL ON CONFLICT REPLACE DEFAULT \(dai_id\('marks'\)\) PRIMARY KEY, body TEXT/);
  expect(html, "a table with a key of its own is left alone").toContain("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT);");
  expect(new TextDecoder().decode(built.archive["app/schema.sql"])).toBe(schema);
});

test("the chess fixture builds through the policy layer unchanged: its own replicated tables, its session, no log", async () => {
  const dir = join(repo, "tests", "fixture", "chess");
  const declared = rewriteReplicated(readFileSync(join(dir, "schema.sql"), "utf8"));
  const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "Chess" });
  expect(built.manifest.replication?.tables).toEqual([...declared.tables].sort());
  expect(built.manifest.replication?.tables).not.toContain("_cs_log");
  expect(built.manifest.session).toBeDefined();
  expect(built.manifest.requires).toEqual(["authorship", "replicated", "session"]);
});

test("an id the application chooses as a literal is a lint finding with a fix", () => {
  const findings = lintFiles({
    "index.html":
      '<!doctype html><script type="application/sql">INSERT INTO notes (id, body) VALUES (42, \'chosen\');</script>',
    "schema.sql": "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n",
  });
  const finding = findings.find((f) => f.id === "literal-id");
  expect(finding, "the literal id is found").toBeDefined();
  expect(finding!.fix).toMatch(/[Oo]mit the id/);
  expect(
    lintFiles({
      "index.html": '<!doctype html><script type="application/sql">INSERT INTO notes (body) VALUES (\'chosen\');</script>',
      "schema.sql": "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n",
    }).some((f) => f.id === "literal-id"),
    "an omitted id is not",
  ).toBe(false);
});

test("a -- dai:replicated table or a session marker in an authored document is refused, with the one-shape message", () => {
  const app = { "index.html": '<!doctype html><script type="module" src="app.js"></script>', "app.js": "const db = await window.dai.openDatabase();\n" };
  for (const schema of [
    "-- dai:replicated\nCREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n",
    "-- dai:replicated author=creator\nCREATE TABLE asks (id INTEGER PRIMARY KEY, body TEXT);\n",
    "-- dai:profile session max_parties=2\nCREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n",
  ]) {
    const refused = breaking(lintFiles({ ...app, "schema.sql": schema })).filter((f) => f.id === "one-shape");
    expect(refused, schema).toHaveLength(1);
    expect(refused[0]!.file).toBe("schema.sql");
    expect(refused[0]!.why).toMatch(/ordinary tables/);
    expect(refused[0]!.fix).toMatch(/Remove/);
  }
  for (const schema of [
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n",
    "CREATE TABLE places (\n  id INTEGER PRIMARY KEY,\n  lat REAL, lng REAL -- dai:coupled lat lng\n);\n",
    "CREATE TABLE entries (\n  id INTEGER PRIMARY KEY,\n  amount INTEGER -- dai:consequential amount\n);\n",
    "-- notes about dai:replicated tables, in prose\nCREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n",
  ]) {
    expect(lintFiles({ ...app, "schema.sql": schema }).map((f) => f.id), schema).not.toContain("one-shape");
  }
});

test("the model file teaches one shape: no shape choice, no replicated surface, seeds run once", () => {
  expect(RECIPE).not.toContain("Will anybody but the person who made this change its data?");
  expect(RECIPE).not.toMatch(/\bpassable\b/i);
  expect(RECIPE).not.toContain("-- dai:replicated");
  expect(RECIPE).not.toContain("window.dai.replicated");
  expect(RECIPE).not.toMatch(/state the decision in a comment at the top of schema\.sql/);
  expect(RECIPE).toMatch(/run once, when the document is created/);
});
