import { expect, test } from "@playwright/test";
import {
  SchemaError,
  checkBuild,
  compatibility,
  migrationVersion,
  normaliseSchema,
  type MigrationRecord,
} from "../src/schema.js";

/**
 * The decision that stands between an application and somebody's data.
 *
 * SQLite will happily open a database whose tables do not match what the code
 * expects: it creates what is missing, ignores what it does not recognise, and
 * reports nothing. Every digest in the container still matches, because the
 * container is exactly what was sealed — the incompatibility is between the
 * code and the data, which is a level no checksum reaches.
 *
 * These are written as the cases somebody would actually hit, not as coverage.
 */
const step = (version: number, from: string, to: string): MigrationRecord => ({
  version,
  from,
  to,
  sql: `-- ${version}`,
});

test.describe("normalising a schema", () => {
  test("ignores what SQLite ignores", () => {
    // A digest that moved when a comment did would demand a migration for
    // reformatting, which teaches people to write migrations that do nothing.
    const one = normaliseSchema(`
      -- tasks the person has added
      CREATE TABLE tasks (
        id   INTEGER PRIMARY KEY,
        text TEXT NOT NULL
      );
    `);
    const other = normaliseSchema(
      "create table tasks(id integer primary key,text text not null);",
    );
    expect(one).toBe(other);
  });

  test("does not ignore a changed column", () => {
    expect(normaliseSchema("CREATE TABLE t (a TEXT);")).not.toBe(
      normaliseSchema("CREATE TABLE t (a INTEGER);"),
    );
  });

  test("does not ignore a dropped NOT NULL", () => {
    expect(normaliseSchema("CREATE TABLE t (a TEXT NOT NULL);")).not.toBe(
      normaliseSchema("CREATE TABLE t (a TEXT);"),
    );
  });
});

test.describe("reading a migration's order", () => {
  test("takes the leading number", () => {
    expect(migrationVersion("003-add-tags.sql")).toBe(3);
    expect(migrationVersion("012_widen_title.sql")).toBe(12);
  });

  test("refuses a file that does not say when it runs", () => {
    // Alphabetical order would put "add-tags" before "create-tables", which is
    // a data-loss bug disguised as a naming convention.
    expect(() => migrationVersion("add-tags.sql")).toThrow(SchemaError);
  });
});

test.describe("deciding what to do with a database", () => {
  test("opens one written by the same schema", () => {
    expect(compatibility({ expected: "aa", actual: "aa", migrations: [] })).toEqual({
      status: "current",
    });
  });

  test("stamps one that has never recorded a schema", () => {
    // A database from before schemas were declared. Refusing it would throw
    // away data over a record that was never written.
    expect(compatibility({ expected: "aa", actual: undefined, migrations: [] })).toEqual({
      status: "empty",
    });
  });

  test("runs the migrations that lead where the application expects", () => {
    const verdict = compatibility({
      expected: "cc",
      actual: "aa",
      migrations: [step(1, "zero", "aa"), step(2, "aa", "bb"), step(3, "bb", "cc")],
    });
    expect(verdict.status).toBe("migrate");
    expect(verdict.status === "migrate" && verdict.run.map((m) => m.version)).toEqual([2, 3]);
  });

  test("runs them in order however they were listed", () => {
    const verdict = compatibility({
      expected: "cc",
      actual: "aa",
      migrations: [step(3, "bb", "cc"), step(1, "zero", "aa"), step(2, "aa", "bb")],
    });
    expect(verdict.status === "migrate" && verdict.run.map((m) => m.version)).toEqual([2, 3]);
  });

  test("refuses when the chain does not reach the expected schema", () => {
    // Half a migration path is worse than none: it would leave the data in a
    // shape neither version understands.
    const verdict = compatibility({
      expected: "dd",
      actual: "aa",
      migrations: [step(1, "zero", "aa"), step(2, "aa", "bb")],
    });
    expect(verdict.status).toBe("incompatible");
  });

  test("refuses data written by a version it has never heard of", () => {
    const verdict = compatibility({
      expected: "cc",
      actual: "zz",
      migrations: [step(1, "zero", "aa"), step(2, "aa", "cc")],
    });
    expect(verdict).toEqual({
      status: "incompatible",
      reason:
        "This document's data was written by a version this application does not know how to migrate from.",
    });
  });

  test("refuses a changed schema with no migrations at all", () => {
    const verdict = compatibility({ expected: "bb", actual: "aa", migrations: [] });
    expect(verdict.status).toBe("incompatible");
    expect(verdict.status === "incompatible" && verdict.reason).toContain("no migrations");
  });
});

test.describe("the build gate", () => {
  const declaration = (digest: string, migrations: MigrationRecord[] = []) => ({
    digest,
    migrations,
  });

  test("passes a first build", () => {
    expect(() => checkBuild(undefined, declaration("aa"))).not.toThrow();
  });

  test("passes a rebuild that did not touch the schema", () => {
    expect(() => checkBuild(declaration("aa"), declaration("aa"))).not.toThrow();
  });

  test("fails a changed schema with no migration", () => {
    // The whole point: this is the last moment the problem is cheap, because
    // afterwards it is somebody's month of data.
    let error: unknown;
    try {
      checkBuild(declaration("aa"), declaration("bb"));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as Error).message).toContain("no migration covers the change");
    // And it says what to do, with a file name that will sort correctly.
    expect((error as Error).message).toContain("migrations/001-");
  });

  test("passes a changed schema with a migration that reaches it", () => {
    expect(() =>
      checkBuild(declaration("aa"), declaration("bb", [step(1, "aa", "bb")])),
    ).not.toThrow();
  });

  test("fails when the last migration does not produce the declared schema", () => {
    // The commonest mistake: edit schema.sql, write the migration, forget that
    // the two have to agree.
    expect(() => checkBuild(declaration("aa"), declaration("cc", [step(1, "aa", "bb")])))
      .toThrow(/does not produce the schema/);
  });

  test("fails on two migrations with the same number", () => {
    expect(() =>
      checkBuild(undefined, declaration("bb", [step(1, "zero", "aa"), step(1, "aa", "bb")])),
    ).toThrow(/numbered 1/);
  });

  test("suggests the next free number, not 001, when migrations exist", () => {
    let message = "";
    try {
      checkBuild(declaration("aa"), declaration("cc", [step(1, "aa", "cc")]));
    } catch (error) {
      message = (error as Error).message;
    }
    // That chain is valid, so nothing should have been thrown at all.
    expect(message).toBe("");
  });
});
