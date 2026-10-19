import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../../src/compile.js";
import { buildContainer } from "../../src/core.js";
import { DECLARATION } from "../../src/declarations.js";
import { breaking, lintFiles } from "../../src/lint.js";
import { handleMessage } from "../../src/mcp.js";
import { RECIPE } from "../../src/recipe.js";
import { rewriteReplicated } from "../../src/replicated.js";
import { Copy, person } from "./copy.js";

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

const APP = { "index.html": '<!doctype html><title>Plain</title><script type="module" src="app.js"></script>', "app.js": "const db = await window.dai.openDatabase();\n" };

/**
 * What each door that builds or checks a document says of a schema: the
 * finding ids `dai check` and check_dai_app report, and what the compiler,
 * create_dai_app and the paste box's build throw (buildContainer, which the
 * paste box's compiler and the desktop app's wrap unchanged).
 */
async function doors(schema: string): Promise<{ check: string[]; mcpCheck: string; build: string; mcpCreate: string; pasteBox: string }> {
  const files = { ...APP, "schema.sql": schema };
  const thrown = (p: Promise<unknown>): Promise<string> => p.then(() => "built", (e: Error) => String(e?.message ?? e));
  const mcp = async (name: string): Promise<string> => {
    const response = await handleMessage(
      { root: mkdtempSync(join(tmpdir(), "dai-cs-mcp-")) },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { files, appName: "Plain" } } },
    );
    const result = response?.result as { content: { text: string }[]; isError?: boolean } | undefined;
    return `${result?.isError ? "refused" : "ok"}: ${result?.content[0]?.text ?? JSON.stringify(response?.error)}`;
  };
  return {
    check: breaking(lintFiles(files)).map((f) => f.id),
    mcpCheck: await mcp("check_dai_app"),
    build: await thrown(buildFrom(files)),
    mcpCreate: await mcp("create_dai_app"),
    pasteBox: await thrown(
      buildContainer({
        files: Object.fromEntries(Object.entries(files).map(([n, t]) => [n, new TextEncoder().encode(t)])),
        appName: "Plain",
        template: readFileSync(join(repo, "dist/template.html"), "utf8"),
        runtime: readFileSync(join(repo, "dist/dai-runtime.js"), "utf8"),
      }),
    ),
  };
}

/**
 * 1b-H2(b), the review's own probes: a declaration was read loosely, so a
 * line naming something that is not a column made every save of the group
 * throw, `LAT LNG` coupled nothing on lowercase columns, and `rowid` logged
 * this copy's hidden rowid as a cell. Every door now refuses a -- dai: line it
 * cannot read exactly, with one message, and the runtime ignores one.
 */
test("1b-H2(b): every door refuses a -- dai: line it cannot read exactly, with one message; exact declarations pass", async () => {
  const table = (decl: string, extra = ""): string =>
    `CREATE TABLE IF NOT EXISTS places (\n  id INTEGER PRIMARY KEY,\n  lat REAL, lng REAL, "the spot" TEXT, amount INTEGER ${decl}\n${extra});\n`;
  const refused = [
    table("-- dai:coupled lat lng: the position"),
    table("-- dai:coupled LAT LNG"),
    table("-- dai:coupled rowid lat lng"),
    table("-- dai:coupled lat lng (the position)"),
    table("-- dai:coupled lat"),
    table("-- dai:couple lat lng"),
    table("-- DAI:coupled lat lng"),
    table("-- dai:consequential amount, lat"),
    table("-- dai:coupled lat lng", "  -- dai:coupled lng amount\n"),
    `${table("")}-- dai:coupled lat lng\n`,
  ];
  for (const schema of refused) {
    const seen = await doors(schema);
    expect(seen.check, schema).toEqual([DECLARATION.id]);
    expect(seen.mcpCheck, schema).toContain(DECLARATION.what);
    for (const door of [seen.build, seen.mcpCreate, seen.pasteBox]) {
      expect(door, schema).toContain(DECLARATION.what);
      expect(door, schema).toContain(DECLARATION.fix);
    }
  }
  for (const schema of [table("-- dai:coupled lat lng"), table('-- dai:coupled lng "the spot"', "  -- dai:consequential amount\n"), table("-- just a note: dai:coupled lat")]) {
    const seen = await doors(schema);
    expect(seen.check, schema).toEqual([]);
    for (const door of [seen.build, seen.pasteBox]) expect(door, schema).toBe("built");
    expect(seen.mcpCreate, schema).toMatch(/^ok/);
  }
});

test("1b-H2(b): the runtime ignores a declaration it cannot read exactly, and a save over its columns succeeds", async () => {
  for (const [decl, update] of [
    ["-- dai:coupled lat lng: the position", "UPDATE places SET lat = 1"],
    ["-- dai:coupled LAT LNG", "UPDATE places SET lat = 1"],
    ["-- dai:coupled rowid lat lng", "UPDATE places SET lat = 1"],
  ] as const) {
    const c = await Copy.open(await person());
    c.db.exec(`CREATE TABLE places (id INTEGER PRIMARY KEY, lat REAL, lng REAL ${decl}\n); CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);`);
    c.db.exec("INSERT INTO places (lat, lng) VALUES (0, 0)");
    c.save();
    expect(c.changes.declaredOf("places"), decl).toEqual({ coupled: [], consequential: [] });
    c.db.exec(`${update}; INSERT INTO notes (body) VALUES ('same save')`);
    expect(c.save()?.ops, decl).toBe(2);
    expect(c.written().map((w) => JSON.parse(w)[2]), "no runtime column is logged as a cell").not.toContain("rowid");
    c.close();
  }
});

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
  const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "Chess", policyLayer: true });
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

/**
 * 1b-M1 and 1b-L5, the review's own reading: one-shape was refused by dai
 * check and check_dai_app only. create_dai_app refused three findings and
 * compiled, the desktop app and the paste box never linted schema.sql, and the
 * compiler never linted, so a marked schema built into the policy layer on
 * the model's own path. And the scan allowed only spaces and tabs, while the
 * policy layer's rewrite trims each line: a BOM, a no-break space or a form
 * feed hid the marker from the lint and not from the rewrite.
 */
test("one shape at every entry point: each door refuses the markers, in every spelling the policy layer reads, with the lint's message", async () => {
  const notes = "CREATE TABLE notes (body TEXT);\n";
  for (const schema of [
    `-- dai:replicated\n${notes}`,
    `-- dai:profile session max_parties=2\n-- dai:replicated\n${notes}`,
    `﻿-- dai:replicated\n${notes}`,
    ` -- dai:replicated\n${notes}`,
    `-- dai:replicated\n${notes}`,
    `\f-- dai:replicated\n${notes}`,
  ]) {
    expect(rewriteReplicated(schema).tables, `the policy layer reads ${JSON.stringify(schema.slice(0, 24))}`).toEqual(["notes"]);
    const seen = await doors(schema);
    const named = JSON.stringify(schema.slice(0, 24));
    expect(seen.check, named).toContain("one-shape");
    expect(seen.mcpCheck, named).toContain("Its schema marks a table as shared");
    for (const door of [seen.build, seen.mcpCreate, seen.pasteBox]) {
      expect(door, named).toContain("Its schema marks a table as shared");
      expect(door, named).toContain("Remove every -- dai:replicated");
    }
  }
});

test("one shape: the documents built through the policy layer still build, through their own path and no other", async () => {
  for (const dir of ["examples/receipts", "examples/tic-tac-toe", "examples/request", "tests/fixture/chess"]) {
    const sourceDir = join(repo, dir);
    await expect(compileDirectory({ sourceDir, root: repo, appName: "Old" }), dir).rejects.toThrow(/marks a table as shared/);
    const built = await compileDirectory({ sourceDir, root: repo, appName: "Old", policyLayer: true });
    expect(built.manifest.replication?.tables.length, dir).toBeGreaterThan(0);
    expect(built.manifest.replication?.tables, dir).not.toContain("_cs_log");
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
