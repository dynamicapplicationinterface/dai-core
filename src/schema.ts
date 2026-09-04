/**
 * Whether an application may open the data it has been handed.
 *
 * The failure this exists to prevent is the one most likely to cost somebody
 * something they cannot get back. An assistant writes version one of an
 * application, a person uses it for a month, then asks for a change; the
 * assistant writes version two with a different table, and the new application
 * opens the old database. SQLite does not object — it creates what is missing,
 * ignores what it does not know about, and the month of data is still in the
 * file while the application behaves as though it never existed.
 *
 * Nothing in the format catches that. Every digest matches, the signature is
 * valid, and the container is exactly what its publisher sealed. The
 * incompatibility is between the code and the data, which is a level no
 * checksum reaches.
 *
 * So an application may declare its schema, and this decides whether that
 * declaration agrees with a database that already exists. Two rules, and they
 * are deliberately strict:
 *
 *   - Identical schemas open.
 *   - A different schema opens only when a migration says how to get there.
 *
 * There is no third case where it opens anyway. "Probably compatible" is how
 * data is lost quietly rather than loudly.
 */

/** What a build records about the shape of its data. Signed, as an entry. */
export interface SchemaDeclaration {
  /** The digest of the normalised schema this application expects. */
  digest: string;
  /** Ordered, ascending, each moving the data from one digest to the next. */
  migrations: MigrationRecord[];
}

export interface MigrationRecord {
  /** Ascending integer taken from the file name: `002-add-tags.sql` is 2. */
  version: number;
  /**
   * The schema this migration expects to find, and the one it leaves behind.
   *
   * Both are recorded rather than inferred from position, because a chain that
   * only knows its own order cannot say where a given database sits in it. The
   * compiler fills them in from the build it is upgrading, so an author writes
   * SQL and a file name and never a digest.
   */
  from: string;
  to: string;
  /** SQL, executed in one transaction. */
  sql: string;
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

/**
 * Reduces a schema to what SQLite would actually enforce.
 *
 * Comments, blank lines, the case of keywords and the amount of whitespace are
 * all invisible to the engine, and a digest that changed when a comment did
 * would demand a migration for reformatting — which teaches people to write a
 * migration that does nothing, which is worse than having no gate at all.
 *
 * Statement order is *not* normalised. Two schemas that create the same tables
 * in a different order will produce different digests, and a migration will be
 * asked for. That is the conservative direction: the cost is one empty
 * migration, and the alternative is deciding that two orderings are equivalent
 * in a language where they sometimes are not.
 */
export function normaliseSchema(sql: string): string {
  return sql
    // Line comments first: a `--` inside a string literal is rare in a schema
    // and the alternative is a SQL parser.
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;])\s*/g, "$1")
    .trim()
    .toLowerCase();
}

/** Reads `003-add-tags.sql` as version 3. Anything else is refused by name. */
export function migrationVersion(fileName: string): number {
  const match = /^(\d+)[-_]/.exec(fileName);
  if (!match) {
    throw new SchemaError(
      `Migration "${fileName}" must start with a number, as in 001-add-tags.sql — ` +
        `the number is the order they run in.`,
    );
  }
  return Number(match[1]);
}

export interface CompatibilityInput {
  /** What the application about to run expects. */
  expected: string;
  /** What the database it has been handed was last written by. */
  actual?: string;
  /** Migrations the application carries, in any order. */
  migrations: MigrationRecord[];
}

export type Compatibility =
  | { status: "current" }
  | { status: "empty" }
  | { status: "migrate"; run: MigrationRecord[] }
  | { status: "incompatible"; reason: string };

/**
 * Decides what to do with a database, without touching one.
 *
 * Separated from anything that can execute SQL so the decision can be tested
 * exhaustively and so the compiler and the runtime reach it the same way. A
 * gate with two implementations is a gate with two answers.
 */
export function compatibility(input: CompatibilityInput): Compatibility {
  // No record of what wrote it: a database this runtime created before schemas
  // were declared, or a fresh one. Stamping it is the only option that does
  // not throw away data on a guess.
  if (!input.actual) return { status: "empty" };
  if (input.actual === input.expected) return { status: "current" };

  const ordered = [...input.migrations].sort((a, b) => a.version - b.version);

  if (ordered.length === 0) {
    return {
      status: "incompatible",
      reason:
        "This document's data was written by a different version of this application, " +
        "and the application carries no migrations.",
    };
  }

  // Walk the chain from where the data actually is. Not finding a starting
  // point is decisive: migrations written for a different one would run
  // against data they were never meant to touch. The first version of this
  // handed back the whole chain in that case — every migration, from the
  // beginning, over data that had already been through some of them.
  const run: MigrationRecord[] = [];
  let position = input.actual;

  for (;;) {
    const next = ordered.find((migration) => migration.from === position);
    if (!next) break;
    run.push(next);
    position = next.to;
    // A chain that returns to where it has been would run for ever. It cannot
    // happen from a compiler-built declaration, and this is not the place to
    // find out that something else built one.
    if (run.length > ordered.length) break;
  }

  if (run.length === 0) {
    return {
      status: "incompatible",
      reason:
        "This document's data was written by a version this application does not " +
        "know how to migrate from.",
    };
  }

  if (position !== input.expected) {
    return {
      status: "incompatible",
      reason: "This application's migrations do not reach the schema it expects.",
    };
  }

  return { status: "migrate", run };
}

/**
 * The build-time gate.
 *
 * Refuses a build whose schema has moved without a migration to match, which is
 * the only moment the problem is cheap. Afterwards it is somebody's data.
 */
export function checkBuild(
  previous: SchemaDeclaration | undefined,
  next: SchemaDeclaration,
): void {
  const versions = next.migrations.map((migration) => migration.version);
  const duplicate = versions.find((version, index) => versions.indexOf(version) !== index);
  if (duplicate !== undefined) {
    throw new SchemaError(
      `Two migrations are numbered ${duplicate}. The number decides the order they run in, ` +
        `so it has to be unique.`,
    );
  }

  const last = [...next.migrations].sort((a, b) => a.version - b.version).pop();
  if (last && last.to !== next.digest) {
    throw new SchemaError(
      "The last migration does not produce the schema this application declares. " +
        "A migration records the schema it results in, so the chain has to end at schema.sql.",
    );
  }

  if (!previous || previous.digest === next.digest) return;

  const verdict = compatibility({
    expected: next.digest,
    actual: previous.digest,
    migrations: next.migrations,
  });

  if (verdict.status === "incompatible") {
    throw new SchemaError(
      "schema.sql has changed since the container this was built from, and no migration " +
        "covers the change. Databases already using that schema would open against an " +
        "application expecting a different one, which SQLite will not complain about and " +
        "which loses data quietly.\n\n" +
        `Add a migration ending at the new schema — for example migrations/${
          (Math.max(0, ...next.migrations.map((migration) => migration.version)) + 1)
            .toString()
            .padStart(3, "0")
        }-describe-the-change.sql — or keep the schema as it was.`,
    );
  }
}
