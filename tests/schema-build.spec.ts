import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "dist", "bin.js");

/**
 * The gate, driven through the command line an author actually uses.
 *
 * The failure it exists to prevent: version one of an application is used for a
 * month, version two changes a table, and the new code opens the old database.
 * SQLite creates what is missing, ignores what it does not recognise, and says
 * nothing — while every digest in the container still matches, because the
 * container is exactly what was sealed.
 *
 * The last moment that is cheap to catch is the build. After it, it is
 * somebody's data.
 */
const SCHEMA_V1 = `
CREATE TABLE tasks (
  id    INTEGER PRIMARY KEY,
  title TEXT NOT NULL
);
`;

const SCHEMA_V2 = `
CREATE TABLE tasks (
  id    INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  done  INTEGER NOT NULL DEFAULT 0
);
`;

interface App {
  dir: string;
  out: string;
}

function app(schema?: string, migrations: Record<string, string> = {}): App {
  const dir = mkdtempSync(join(tmpdir(), "dai-schema-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Tasks</title><p>tasks");
  if (schema) writeFileSync(join(dir, "schema.sql"), schema);

  if (Object.keys(migrations).length > 0) {
    mkdirSync(join(dir, "migrations"), { recursive: true });
    for (const [name, sql] of Object.entries(migrations)) {
      writeFileSync(join(dir, "migrations", name), sql);
    }
  }

  return { dir, out: join(dir, "app.dai.html") };
}

function build(source: App, args: string[] = []): string {
  return execFileSync(
    process.execPath,
    [cli, "build", source.dir, "-o", source.out, "--quiet", ...args],
    { encoding: "utf8", cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function sealed(container: string): { digest: string; migrations: { version: number }[] } | null {
  const html = readFileSync(container, "utf8");
  const payload = /<script[^>]*id="dai-payload"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const archive = unzipSync(Buffer.from(payload, "base64"));
  const entry = archive["runtime/schema.json"];
  return entry ? JSON.parse(new TextDecoder().decode(entry)) : null;
}

test.describe("the schema gate", () => {
  test("seals the declaration where the signature covers it", () => {
    const one = app(SCHEMA_V1);
    build(one);

    const declaration = sealed(one.out);
    expect(declaration).not.toBeNull();
    expect(declaration!.digest).toHaveLength(64);
    expect(declaration!.migrations).toEqual([]);

    rmSync(one.dir, { recursive: true, force: true });
  });

  test("stays out of the way of an application that declares nothing", () => {
    // Every container built before this existed keeps building exactly as it
    // did. A gate that made itself mandatory would be a breaking change
    // wearing a safety jacket.
    const one = app();
    build(one);
    expect(sealed(one.out)).toBeNull();
    rmSync(one.dir, { recursive: true, force: true });
  });

  test("refuses a changed schema with no migration, and says what to write", () => {
    const one = app(SCHEMA_V1);
    build(one);

    const two = app(SCHEMA_V2);
    let message = "";
    try {
      build(two, ["--upgrade-of", one.out]);
    } catch (error) {
      message = String((error as { stderr?: Buffer }).stderr ?? error);
    }

    expect(message).toContain("schema.sql has changed");
    expect(message).toContain("loses data quietly");
    expect(message).toContain("migrations/001-");

    rmSync(one.dir, { recursive: true, force: true });
    rmSync(two.dir, { recursive: true, force: true });
  });

  test("passes the same change once a migration covers it", () => {
    const one = app(SCHEMA_V1);
    build(one);

    const two = app(SCHEMA_V2, {
      "001-add-done.sql": "ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;",
    });
    build(two, ["--upgrade-of", one.out]);

    const declaration = sealed(two.out)!;
    expect(declaration.migrations).toHaveLength(1);
    // The chain records where it starts and where it lands, so a database can
    // be placed in it later. The author wrote neither digest.
    const step = declaration.migrations[0] as unknown as { from: string; to: string };
    expect(step.from).toBe(sealed(one.out)!.digest);
    expect(step.to).toBe(declaration.digest);

    rmSync(one.dir, { recursive: true, force: true });
    rmSync(two.dir, { recursive: true, force: true });
  });

  test("passes a rebuild that did not touch the schema", () => {
    const one = app(SCHEMA_V1);
    build(one);

    const same = app(SCHEMA_V1);
    build(same, ["--upgrade-of", one.out]);

    rmSync(one.dir, { recursive: true, force: true });
    rmSync(same.dir, { recursive: true, force: true });
  });

  test("ignores reformatting, so nobody learns to write empty migrations", () => {
    const one = app(SCHEMA_V1);
    build(one);

    const reformatted = app(`
      -- the things a person has to do
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    `);
    build(reformatted, ["--upgrade-of", one.out]);

    rmSync(one.dir, { recursive: true, force: true });
    rmSync(reformatted.dir, { recursive: true, force: true });
  });

  test("refuses two new migrations in one build", () => {
    // Each records the schema it starts from and the one it produces, and the
    // schema in between was never built, so it cannot be known.
    const one = app(SCHEMA_V1);
    build(one);

    const two = app(SCHEMA_V2, {
      "001-add-done.sql": "ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;",
      "002-again.sql": "CREATE INDEX tasks_done ON tasks (done);",
    });

    let message = "";
    try {
      build(two, ["--upgrade-of", one.out]);
    } catch (error) {
      message = String((error as { stderr?: Buffer }).stderr ?? error);
    }
    expect(message).toContain("Build once per migration");

    rmSync(one.dir, { recursive: true, force: true });
    rmSync(two.dir, { recursive: true, force: true });
  });

  test("refuses a migration file that does not say when it runs", () => {
    const one = app(SCHEMA_V1);
    build(one);

    const two = app(SCHEMA_V2, { "add-done.sql": "ALTER TABLE tasks ADD COLUMN done INTEGER;" });
    let message = "";
    try {
      build(two, ["--upgrade-of", one.out]);
    } catch (error) {
      message = String((error as { stderr?: Buffer }).stderr ?? error);
    }
    expect(message).toContain("must start with a number");

    rmSync(one.dir, { recursive: true, force: true });
    rmSync(two.dir, { recursive: true, force: true });
  });
});
