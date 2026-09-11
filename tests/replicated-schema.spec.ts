import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { MANIFEST_ENTRY, type ContainerManifest } from "../src/core.js";
import { parseContainer } from "../src/container.js";
import { ReplicationError, rewriteReplicated } from "../src/replicated.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function versionOf(sourceDir: string, appName: string): Promise<ContainerManifest> {
  const built = await compileDirectory({ sourceDir, root: repoRoot, appName });
  return JSON.parse(
    new TextDecoder().decode(parseContainer(built.html).archive[MANIFEST_ENTRY]!),
  ) as ContainerManifest;
}

/**
 * The compiler's rewrite, on its own.
 *
 * The shape is testable before any merge exists, and it is worth testing there:
 * every convergence property later rests on the key, the triggers and the
 * views being exactly what docs/replicated-tables.md §4 says. A merge that
 * converges over the wrong schema converges on the wrong answer.
 *
 * These check the text the compiler emits. Whether SQLite accepts it, and what
 * it does with it, is the next slice.
 */

const CASES = `-- dai:replicated
CREATE TABLE cases (
  title  TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  notes  TEXT
);
`;

test.describe("a table nobody declared", () => {
  test("is returned exactly as written", () => {
    // Every document that exists today goes through this untouched. A rewrite
    // that reformatted an undeclared schema would change its digest and demand
    // a migration for nothing.
    const plain = "CREATE TABLE notes (\n  body TEXT\n);\n";
    const out = rewriteReplicated(plain);
    expect(out.sql).toBe(plain);
    expect(out.tables).toEqual([]);
  });

  test("a marker that is not immediately above a table declares nothing", () => {
    // Only whitespace may separate the two. A comment further up is a comment.
    const stray = `-- dai:replicated

CREATE TABLE first (a TEXT);
CREATE TABLE second (b TEXT);
`;
    expect(rewriteReplicated(stray).tables).toEqual(["first"]);

    const detached = `-- dai:replicated
CREATE TABLE first (a TEXT);

CREATE TABLE second (b TEXT);
`;
    expect(rewriteReplicated(detached).tables).toEqual(["first"]);
  });

  test("the marker inside a string is a string", () => {
    // The scanner is quote-aware for the same reason normaliseSchema is:
    // replicating a table because of a word in a DEFAULT would be silent and
    // permanent.
    const sneaky = `CREATE TABLE notes (
  body TEXT DEFAULT '-- dai:replicated'
);
`;
    expect(rewriteReplicated(sneaky).tables).toEqual([]);
  });
});

test.describe("a declared table", () => {
  test("keeps the author's columns and adds the replication ones", () => {
    const { sql, tables } = rewriteReplicated(CASES);
    expect(tables).toEqual(["cases"]);

    // The author's columns, untouched.
    expect(sql).toContain("title  TEXT NOT NULL");
    expect(sql).toContain("status TEXT NOT NULL DEFAULT 'open'");

    // And the ones §4 requires, including the one that is always NULL at
    // Level 1 so that Level 2 needs no migration (T1-D7).
    for (const column of [
      "_r_replica",
      "_r_seq",
      "_r_lc",
      "_r_entity",
      "_r_parents",
      "_r_deleted",
      "_r_superseded",
      "_r_sig",
    ]) {
      expect(sql, column).toContain(column);
    }
    expect(sql).toContain("PRIMARY KEY (_r_replica, _r_seq)");
    expect(sql).toContain("WITHOUT ROWID");
  });

  test("there is no wall clock in the row (T1-D1)", () => {
    // Draft 1 carried an advisory RFC 3339 stamp. An unused column that looks
    // authoritative is a trap: the first person to sort by it gets an answer,
    // and across devices with skewed clocks the answer is wrong.
    expect(rewriteReplicated(CASES).sql).not.toContain("_r_ts");
  });

  test("the append-only triggers leave the flag writable, and only upward", () => {
    const { sql } = rewriteReplicated(CASES);

    // Column-scoped, not blanket: maintaining _r_superseded is an update, and
    // Draft 1's blanket BEFORE UPDATE would have made D5 impossible (T1-D10).
    expect(sql).toContain("BEFORE UPDATE OF");
    expect(sql).not.toMatch(/BEFORE UPDATE ON cases\s+BEGIN/);

    /*
     * The author's columns are named too, and that is not decoration.
     *
     * SQLite has no "update of anything except", so the only way to leave one
     * column writable is to list every other one. The first version listed
     * only the _r_ columns, and an in-place edit of a title was permitted —
     * which makes a replicated table not append-only, and at Level 2 would
     * invalidate a signature over a row that still looked intact. The text of
     * the trigger read correctly; running it against SQLite is what found it.
     */
    expect(sql).toMatch(
      /BEFORE UPDATE OF\s+title, status, notes, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_sig ON cases/,
    );

    // And the flag only rises. Two hosts with the same rows and different
    // flags never reconcile, so clearing one is refused.
    expect(sql).toContain("cases__superseded_monotonic");
    expect(sql).toContain("WHEN OLD._r_superseded = 1 AND NEW._r_superseded = 0");
    expect(sql).toContain("ROW_REJECTED");
  });

  test("heads come from the flag, not from a scan of every row's parents", () => {
    const { sql } = rewriteReplicated(CASES);
    expect(sql).toContain(
      "CREATE VIEW IF NOT EXISTS cases_heads AS\n  SELECT * FROM cases WHERE _r_superseded = 0",
    );
    // Draft 1 walked json_each over every row on every read; D5 replaced it.
    expect(sql).not.toMatch(/CREATE VIEW cases_heads[\s\S]*?json_each/);
  });

  test("current counts every head when it reports a conflict, not the live ones", () => {
    /*
     * The amendment to T1-D3, and the bug it caught.
     *
     * A tombstone and a change, both heads: one live head, so a count of live
     * heads reads 0 and the person is shown their edit with nothing saying
     * somebody had deleted it. The count is over all heads.
     */
    const { sql } = rewriteReplicated(CASES);
    expect(sql).toContain(
      "(SELECT count(*) FROM cases_heads x WHERE x._r_entity = h._r_entity) > 1",
    );
    expect(sql).not.toContain(
      "WHERE x._r_entity = h._r_entity AND x._r_deleted = 0) > 1",
    );
  });

  test("the pick under conflict is a total order (T1-D6)", () => {
    // Highest clock, then replica, then seq. Two heads from the same replica
    // for one entity are reachable, so the 2.1.1 pair is not total.
    expect(rewriteReplicated(CASES).sql).toContain(
      "ORDER BY y._r_lc DESC, hex(y._r_replica) ASC, y._r_seq ASC",
    );
  });

  test("the document-level tables are emitted once, however many tables are declared", () => {
    const two = `${CASES}\n-- dai:replicated\nCREATE TABLE visits (\n  note TEXT\n);\n`;
    const { sql, tables } = rewriteReplicated(two);
    expect(tables).toEqual(["cases", "visits"]);
    expect(sql.match(/CREATE TABLE IF NOT EXISTS _dai_replica\b/g)).toHaveLength(1);
    expect(sql.match(/CREATE TABLE IF NOT EXISTS _dai_replicas\b/g)).toHaveLength(1);
    // No pubkey at Level 1; it returns in Track 2.
    expect(sql).not.toContain("pubkey");
  });

  test("the whole schema runs twice, because that is what an open does", () => {
    /*
     * The kit executes every `<script type="application/sql">` block before
     * anything draws — on *every* open, not the first. So a schema that is not
     * idempotent opens a fresh document once and refuses to open it ever
     * again, and the refusal lands on the second person to touch the file.
     *
     * That shipped. `CREATE TABLE _dai_replica` had no `IF NOT EXISTS`, and no
     * unit test saw it because each one builds a new in-memory database and
     * runs the schema exactly once. The assertions above name the clause; this
     * one asks the engine, which is the only thing that can answer.
     */
    const two = `${CASES}\n-- dai:replicated\nCREATE TABLE visits (\n  note TEXT\n);\n`;
    const { sql } = rewriteReplicated(two);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(sql);
      expect(() => db.exec(sql)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

test.describe("the default build path emits the version the spec says it emits", () => {
  /*
   * `default-build-emits-declared-version` — T1-D25.
   *
   * The version came to mean one capability's storage shape, not a generation
   * of the format: a replicated build emits 4 because it carries the `_r_`
   * columns, and a plain build stays at 3 because it does not. That was true in
   * the code and in the deployed chess container for weeks while T1-D24
   * described the opposite — and nothing complained, because the readers accept
   * 2, 3 and 4, so every document opened either way. A correct design masking a
   * wrong belief about it: the same shape as a CI job that cancels rather than
   * fails, green by the absence of a verdict.
   *
   * The check that catches it is the one the correction was settled by, so it
   * is a test rather than a technique: build both kinds through the default
   * path and read the version back off the manifest. No override — the point is
   * what the path emits on its own, which is what production came from.
   */
  test("a replicated build is version 4, a plain build is version 3", async () => {
    const replicated = await versionOf(resolve(repoRoot, "tests/fixture/chess"), "Chess");
    expect(replicated.manifestVersion).toBe(4);
    expect(replicated.requires).toEqual(["replicated"]);

    const dir = mkdtempSync(join(tmpdir(), "dai-plain-"));
    writeFileSync(
      join(dir, "index.html"),
      '<!doctype html><meta charset="utf-8"><p id="app">plain</p>',
      "utf8",
    );
    const plain = await versionOf(dir, "Plain");
    expect(plain.manifestVersion).toBe(3);
    // A plain document declares nothing and moves no reader that already opened
    // it — which is why the bump was cheap and rode only the replicated branch.
    expect(plain.requires).toBeUndefined();
    expect(plain.replication).toBeUndefined();
  });
});

test.describe("what the compiler refuses", () => {
  const refusal = (sql: string): ReplicationError => {
    try {
      rewriteReplicated(sql);
    } catch (error) {
      return error as ReplicationError;
    }
    throw new Error("should have refused");
  };

  test("an author column using the reserved prefix", () => {
    const bad = "-- dai:replicated\nCREATE TABLE cases (\n  _r_mine TEXT\n);\n";
    expect(refusal(bad).code).toBe("REPLICATION_SCHEMA_INVALID");
    expect(refusal(bad).message).toMatch(/reserved/i);
  });

  test("an author's own primary key", () => {
    // The table is keyed by (_r_replica, _r_seq). A second identity would be
    // unique per copy and collide on merge.
    const bad = "-- dai:replicated\nCREATE TABLE cases (\n  id TEXT PRIMARY KEY\n);\n";
    expect(refusal(bad).code).toBe("REPLICATION_SCHEMA_INVALID");
    expect(refusal(bad).message).toMatch(/PRIMARY KEY/);
  });

  test("AUTOINCREMENT, which two copies would both advance", () => {
    const bad = "-- dai:replicated\nCREATE TABLE cases (\n  n INTEGER AUTOINCREMENT\n);\n";
    expect(refusal(bad).code).toBe("REPLICATION_SCHEMA_INVALID");
    expect(refusal(bad).message).toMatch(/merged/i);
  });

  test("but the same words inside a string are allowed", () => {
    // A DEFAULT that mentions a primary key is not a primary key.
    const fine = "-- dai:replicated\nCREATE TABLE cases (\n  note TEXT DEFAULT 'PRIMARY KEY'\n);\n";
    expect(() => rewriteReplicated(fine)).not.toThrow();
  });
});
