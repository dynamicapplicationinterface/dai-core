import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { parseBundle } from "../src/bundle.js";
import { EXAMPLE_APPS } from "../src/generated/examples.js";
import { breaking, lintFiles } from "../src/lint.js";
import { RECIPE } from "../src/recipe.js";
import { rewriteReplicated } from "../src/replicated.js";
import { createEntity } from "../src/replicated-rows.js";
import {
  APP_REFUSALS,
  CONSTRAINTS,
  CONSTRAINT_BY_ID,
  MARKERS,
  SHAPES,
  SURFACE,
  VIEWS,
  type Anchor,
} from "../src/rules.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(resolve(repo, path), "utf8").replace(/\r\n/g, "\n");

/**
 * The constraints in src/rules.ts, held to the code, the model file and the
 * examples.
 *
 * This is the half of "one source" that stops the source itself going stale.
 * Generating the pages and the model file from rules.ts keeps them agreeing
 * with each other; these keep rules.ts agreeing with what the runtime does.
 * The recipe fell behind the code once already, silently, because nothing
 * connected a sentence to the line it described. Here every constraint names
 * that line, and a line that moves fails a test.
 */

const ID_SHAPED = /\b(?:SHAPE|SHARED|SESSION|NO|KIT|STORE|MODULE|ONE|SHARE|SCHEMA|SEED|WRITE|MIGRATE|TIMES|ICON|DESCRIBE|EDGE|TOP|LOOK|HANDOVER)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

function everyAnchor(): { owner: string; anchor: Anchor }[] {
  return [
    ...CONSTRAINTS.flatMap((c) => c.anchors.map((anchor) => ({ owner: c.id, anchor }))),
    ...SURFACE.map((s) => ({ owner: s.call, anchor: s.anchor })),
    ...VIEWS.map((v) => ({ owner: v.name, anchor: v.anchor })),
    ...MARKERS.map((m) => ({ owner: m.marker, anchor: m.anchor })),
    ...APP_REFUSALS.map((r) => ({ owner: r.code, anchor: r.anchor })),
  ];
}

test.describe("every constraint is tied to the code it depends on", () => {
  test("ids are unique and shaped like ids", () => {
    const ids = CONSTRAINTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id, id).toMatch(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/);
      // An id the cross-reference scan cannot see would be an id nobody can check.
      expect(id.match(ID_SHAPED)?.[0], `${id} is not matched by ID_SHAPED`).toBe(id);
    }
  });

  test("every anchor is still true", () => {
    // All of them at once: a list stopping at the first stale anchor hides the rest.
    const stale = everyAnchor()
      .filter(({ anchor }) => !read(anchor.file).includes(anchor.contains))
      .map(({ owner, anchor }) => `${owner}: ${anchor.file} no longer contains ${JSON.stringify(anchor.contains)}`);
    expect(stale).toEqual([]);
  });

  test("every constraint has an anchor, a rule and a reason", () => {
    for (const c of CONSTRAINTS) {
      expect(c.anchors.length, c.id).toBeGreaterThan(0);
      expect(c.rule.length, c.id).toBeGreaterThan(20);
      expect(c.why.length, c.id).toBeGreaterThan(20);
      expect(c.shapes.length, c.id).toBeGreaterThan(0);
    }
  });

  test("a constraint enforced by the lint names findings the lint defines", () => {
    const lint = read("src/lint.ts");
    for (const c of CONSTRAINTS) {
      const byLint = c.enforced.includes("lint");
      expect(Boolean(c.lint?.length), `${c.id}: enforced by lint iff it names lint ids`).toBe(byLint);
      for (const id of c.lint ?? []) {
        const defined = lint.includes(`id: "${id}"`) || lint.includes(`"${id}": {`);
        expect(defined, `${c.id} cites lint finding ${id}, which src/lint.ts does not define`).toBe(true);
      }
    }
  });

  test("every constraint named anywhere is one that exists", () => {
    const sources = [
      ...CONSTRAINTS.flatMap((c) => [c.rule, c.why]),
      ...APP_REFUSALS.flatMap((r) => [r.when, r.then]),
      ...SURFACE.map((s) => s.does),
      read("src/lint.ts"),
      read("examples/chess-foil/README.md"),
      RECIPE,
    ];
    for (const text of sources) {
      for (const name of text.match(ID_SHAPED) ?? []) {
        expect(CONSTRAINT_BY_ID.has(name), `${name} is cited but no constraint has that id`).toBe(true);
      }
    }
  });

  test("every shape has constraints, and every shared shape's example exists", () => {
    for (const shape of SHAPES) {
      expect(CONSTRAINTS.some((c) => c.shapes.includes(shape.id)), shape.id).toBe(true);
      if (shape.example) expect(readdirSync(resolve(repo, shape.example)).length, shape.example).toBeGreaterThan(0);
    }
  });
});

test.describe("the model file carries every constraint", () => {
  test("every id, rule and reason is in it, word for word", () => {
    for (const c of CONSTRAINTS) {
      expect(RECIPE, c.id).toContain(`[${c.id}]`);
      expect(RECIPE, `${c.id} rule`).toContain(c.rule);
      expect(RECIPE, `${c.id} why`).toContain(c.why);
    }
  });

  test("every call, view, marker and refusal is in it", () => {
    for (const s of SURFACE) expect(RECIPE, s.call).toContain(s.call);
    for (const v of VIEWS) expect(RECIPE, v.name).toContain(`- ${v.name} `);
    for (const m of MARKERS) expect(RECIPE, m.marker).toContain(m.marker);
    for (const r of APP_REFUSALS) expect(RECIPE, r.code).toContain(r.code);
  });

  test("the shape is decided before any constraint, and every shape is named", () => {
    const shape = RECIPE.indexOf("FIRST, THE SHAPE");
    const constraints = RECIPE.indexOf("THE CONSTRAINTS");
    expect(shape).toBeGreaterThan(-1);
    expect(shape).toBeLessThan(constraints);
    for (const s of SHAPES) expect(RECIPE, s.id).toContain(s.title.toUpperCase());
  });

  test("the gaps the old recipe had are stated", () => {
    // The backlog's L3 exit, as a grep that cannot silently fall behind again.
    for (const needle of [
      "_current",
      "_conflicts",
      "_r_conflicted",
      '"dai:merged"',
      'via === "carrier"',
      "-- dai:profile session max_parties=N",
      "session.create()",
      "session.join(session, seat)",
      "session.close(session)",
      "session.reseat(session)",
      "contested",
    ]) {
      expect(RECIPE, needle).toContain(needle);
    }
  });

  test("its examples are the examples on disk, as bundles a reader accepts", () => {
    execFileSync(process.execPath, [join(repo, "scripts", "build-docs.mjs"), "--check"], { cwd: repo });
    const start = RECIPE.indexOf("COMPLETE EXAMPLES");
    const fences = RECIPE.slice(start).split("```text\n").slice(1).map((chunk) => "```text\n" + chunk.slice(0, chunk.indexOf("```") + 3));
    expect(fences.length).toBe(EXAMPLE_APPS.length);
    for (const [index, app] of EXAMPLE_APPS.entries()) {
      const bundle = parseBundle(`${fences[index]}\n`);
      expect(bundle.name).toBe(app.name);
      for (const [name, text] of Object.entries(app.files)) {
        expect(bundle.files[name]?.replace(/\n$/, ""), `${app.dir}/${name}`).toBe(read(`${app.dir}/${name}`).replace(/\n$/, ""));
      }
    }
  });
});

function filesOf(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(resolve(repo, dir))) {
    if (/\.(?:html?|m?js|sql|css)$/i.test(name)) files[name] = read(`${dir}/${name}`);
  }
  return files;
}

test.describe("the lint holds applications to the shared-table constraints", () => {
  test("the correct applications pass", () => {
    for (const dir of ["examples/packing-list", "examples/receipts", "examples/tic-tac-toe", "tests/fixture/chess"]) {
      const findings = breaking(lintFiles(filesOf(dir)));
      expect(findings.map((f) => `${f.file}: ${f.id}`), dir).toEqual([]);
    }
  });

  test("the chess foil fails for exactly the lessons its README names", () => {
    const ids = breaking(lintFiles(filesOf("examples/chess-foil"))).map((f) => f.id).sort();
    expect(ids).toEqual(["shared-base-read", "shared-no-merge-listener", "shared-raw-write", "shared-table-constraint"]);
  });

  const shared = "-- dai:replicated\nCREATE TABLE IF NOT EXISTS items (name TEXT NOT NULL);\n";

  test("a kit write control against a shared table is caught", () => {
    const ids = lintFiles({
      "schema.sql": shared,
      "index.html":
        '<dai-form run="INSERT INTO items (name) VALUES (:name)"><input name="name"></dai-form>' +
        '<script type="module">addEventListener("dai:merged", () => {});</script>',
    }).map((f) => f.id);
    expect(ids).toContain("shared-raw-write");
  });

  test("a sentence that mentions a shared table is not a read", () => {
    const ids = lintFiles({
      "schema.sql": shared,
      "app.js": '// the list is derived from items every time\naddEventListener("dai:merged", () => {});\n',
    }).map((f) => f.id);
    expect(ids).not.toContain("shared-base-read");
  });

  test("a read of the table itself is caught, and a read of its view is not", () => {
    const base = lintFiles({ "schema.sql": shared, "app.js": 'db.selectObjects("SELECT name FROM items"); "dai:merged";' });
    const view = lintFiles({ "schema.sql": shared, "app.js": 'db.selectObjects("SELECT name FROM items_current"); "dai:merged";' });
    expect(base.map((f) => f.id)).toContain("shared-base-read");
    expect(view.map((f) => f.id)).not.toContain("shared-base-read");
  });

  test("an application that edits shared rows and never shows a conflict is caught", () => {
    const ids = lintFiles({
      "schema.sql": shared,
      "app.js": 'window.dai.replicated.change("items", e, { name: "x" }); addEventListener("dai:merged", () => {});',
    }).map((f) => f.id);
    expect(ids).toContain("shared-conflicts-unshown");
  });

  test("a document with no shared table is not held to any of this", () => {
    const ids = lintFiles({
      "schema.sql": "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT UNIQUE);\n",
      "index.html": '<dai-form run="INSERT INTO items (name) VALUES (:name)"></dai-form>',
    }).map((f) => f.id);
    expect(ids.filter((id) => id.startsWith("shared-"))).toEqual([]);
  });
});

/**
 * The claims the constraints make about behavior, run against the engine.
 *
 * Each was established by running it before it was written down; these keep
 * running it, so the sentence and the behavior cannot part.
 */
test.describe("what the constraints claim, run against the rewrite", () => {
  const open = (schema: string): DatabaseSync => {
    const db = new DatabaseSync(":memory:");
    db.exec(rewriteReplicated(schema).sql);
    return db;
  };
  const failure = (fn: () => void): string => {
    try {
      fn();
    } catch (error) {
      return (error as Error).message;
    }
    return "(no error)";
  };

  test("SHARED-KIT-READS: a kit-style INSERT fails, and UPDATE and DELETE are refused by name", () => {
    const db = open("-- dai:replicated\nCREATE TABLE IF NOT EXISTS items (name TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);\n");
    expect(failure(() => db.exec("INSERT INTO items (name) VALUES ('milk')"))).toContain("NOT NULL constraint failed: items._r_replica");
    db.exec("INSERT INTO items (name, _r_replica, _r_seq, _r_lc, _r_entity) VALUES ('seed', randomblob(16), 1, 1, randomblob(16))");
    expect(failure(() => db.exec("UPDATE items SET done = 1 - done"))).toContain("REPLICATED_TABLE_IMMUTABLE");
    expect(failure(() => db.exec("DELETE FROM items"))).toContain("REPLICATED_TABLE_IMMUTABLE");
  });

  test("SHARED-NO-TRAILING-COMMENT: a comment on the last shared column still breaks the rewrite", () => {
    // A known defect, documented rather than fixed here (backlog D5). When the
    // rewrite is fixed this fails — and the constraint and the lint check that
    // work around it come out in the same change.
    const commented = "-- dai:replicated\nCREATE TABLE IF NOT EXISTS t (\n  a TEXT NOT NULL,\n  b TEXT NOT NULL -- note\n);\n";
    expect(failure(() => open(commented))).toContain('near "_r_replica": syntax error');
    expect(failure(() => open(commented.replace(" -- note", "")))).toBe("(no error)");
    expect(lintFiles({ "schema.sql": commented }).map((f) => f.id)).toContain("shared-trailing-comment");
    const earlierOnly = commented.replace(" -- note", "").replace("NOT NULL,", "NOT NULL, -- fine here");
    expect(lintFiles({ "schema.sql": earlierOnly }).map((f) => f.id)).not.toContain("shared-trailing-comment");
    expect(failure(() => open(earlierOnly))).toBe("(no error)");
  });

  test("SESSION-ROW-CARRIES-SESSION: an insert without its session is refused, with one it is written", () => {
    const db = open("-- dai:profile session max_parties=2\n-- dai:replicated\nCREATE TABLE IF NOT EXISTS items (name TEXT NOT NULL);\n");
    db.exec("INSERT INTO _dai_replica (id, seq, lc) VALUES (randomblob(16), 0, 0)");
    const rows = {
      all: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
      run: (sql: string, params: unknown[] = []) => {
        db.prepare(sql).run(...(params as never[]));
      },
    };
    const entity = () => new Uint8Array(randomBytes(16));
    expect(failure(() => createEntity(rows, "items", entity(), { name: "x" }))).toContain("carries no session");
    createEntity(rows, "items", entity(), { name: "x" }, new Uint8Array(randomBytes(16)));
    expect((db.prepare("SELECT count(*) AS n FROM items_current").get() as { n: number }).n).toBe(0);
    // Written, and not admitted: no seat was minted, so the row's author is no
    // member — which is SESSION-MEMBERSHIP's point about _current.
    expect((db.prepare("SELECT count(*) AS n FROM items").get() as { n: number }).n).toBe(1);
  });
});
