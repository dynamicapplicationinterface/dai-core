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

/** The file an application declares its shape in, and where its migrations go. */
export const SCHEMA_FILE = "schema.sql";
export const MIGRATIONS_DIR = "migrations/";

async function digestOf(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const asText = (value: Uint8Array | string): string =>
  typeof value === "string" ? value : new TextDecoder().decode(value);

/**
 * The declaration an application's files make, or none.
 *
 * Reads `schema.sql` and `migrations/*.sql` out of the files being sealed and
 * stamps the chain. Works on the files map rather than on a directory so that
 * every door — the command line, the browser, the desktop app, the MCP server
 * — declares the same way. It lived in the command-line door alone for a
 * while, which meant the gate that exists to stop a model's version two
 * destroying a person's version one never ran for anything a model made
 * through the website: the population it was for.
 *
 * An author writes SQL and a file name; every digest here is computed. Asking
 * somebody to write the hash of their own schema into a migration header would
 * be asking them to get it wrong.
 *
 * `previous` is the declaration of the container this build upgrades, when
 * there is one. A migration's ends were fixed by the build that introduced it;
 * re-deriving them would rewrite history whenever an old migration was edited.
 */
export async function declareSchema(
  files: Record<string, Uint8Array | string>,
  previous: SchemaDeclaration | undefined,
): Promise<SchemaDeclaration | undefined> {
  const source = files[SCHEMA_FILE];
  if (source === undefined) return undefined;

  const digest = await digestOf(normaliseSchema(asText(source)));

  const names = Object.keys(files)
    .filter((name) => name.startsWith(MIGRATIONS_DIR) && name.endsWith(".sql"))
    .map((name) => name.slice(MIGRATIONS_DIR.length))
    .filter((name) => !name.includes("/"))
    .sort();

  const known = new Map((previous?.migrations ?? []).map((entry) => [entry.version, entry]));
  const migrations: MigrationRecord[] = [];
  const fresh: { version: number; sql: string }[] = [];

  for (const name of names) {
    const version = migrationVersion(name);
    const sql = asText(files[MIGRATIONS_DIR + name] as Uint8Array | string);
    const recorded = known.get(version);
    if (recorded) migrations.push({ ...recorded, sql });
    else fresh.push({ version, sql });
  }

  if (fresh.length > 1) {
    throw new SchemaError(
      `This build adds ${fresh.length} migrations at once, and a migration records the ` +
        `schema it starts from and the one it produces — which cannot be known for the ` +
        `steps in between. Build once per migration.`,
    );
  }

  if (fresh.length === 1) {
    const start = previous?.digest;
    if (!start) {
      throw new SchemaError(
        `A migration needs a schema to migrate from, and this build has nothing to ` +
          `compare against. Pass the container it upgrades, or delete the migration if ` +
          `this is a first build.`,
      );
    }
    migrations.push({ version: fresh[0]!.version, from: start, to: digest, sql: fresh[0]!.sql });
  }

  const declaration: SchemaDeclaration = { digest, migrations };
  checkBuild(previous, declaration);
  return declaration;
}

/**
 * Puts the declared schema into the page, so it runs before anything reads.
 *
 * The kit executes every `<script type="application/sql">` in document order
 * before the elements draw. With the schema declared in its own file the
 * CREATE TABLE statements would otherwise have to be written twice — once to
 * declare, once to run — and two copies drift. So the compiler writes the
 * declaration in as the first such block. An application that runs its own
 * CREATE TABLE IF NOT EXISTS as well loses nothing; one that never used the
 * kit ignores an unexecuted script type, as the browser does.
 */
export function injectSchema(indexHtml: string, schemaSql: string): string {
  const block =
    '<script type="application/sql" data-dai="schema">\n' +
    schemaSql.replace(/<\/script/gi, "<\\/script").trim() +
    "\n</script>";
  const head = /<head(\s[^>]*)?>/i.exec(indexHtml);
  if (head) {
    const at = head.index + head[0].length;
    return indexHtml.slice(0, at) + "\n" + block + indexHtml.slice(at);
  }
  const body = /<body(\s[^>]*)?>/i.exec(indexHtml);
  if (body) {
    const at = body.index + body[0].length;
    return indexHtml.slice(0, at) + "\n" + block + indexHtml.slice(at);
  }
  return block + "\n" + indexHtml;
}
