import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { resealContainer, verifyContainer } from "../src/container.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "dist", "bin.js");

/**
 * What happens when the code and the data disagree, in a real browser.
 *
 * Everything the container can check has already passed by this point: the
 * digests match and the signature is valid, because the container is exactly
 * what its publisher sealed. The mismatch is between an application and a
 * database, and SQLite does not object to it — it creates what is missing,
 * ignores what it does not recognise, and reports nothing.
 *
 * These drive the whole path: build version one, use it, rebuild with a
 * changed schema, and open the old data with the new code.
 */
const SCHEMA_V1 = "CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL);";
const SCHEMA_V2 =
  "CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);";

/** An application that opens the database and reports what it found. */
const APP = `<!doctype html>
<meta charset="utf-8">
<title>Tasks</title>
<p id="out">starting</p>
<script type="module">
  const out = document.getElementById("out");
  try {
    const db = await window.dai.openDatabase();
    db.exec("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
    db.exec("INSERT INTO tasks (title) VALUES ('a month of work')");
    const rows = [];
    db.exec({ sql: "SELECT count(*) FROM tasks", rowMode: "array", resultRows: rows });
    // Handed out so a test can stage this document's data under a different
    // version of the application, which is the case worth checking.
    window.__database = Array.from(window.dai.exportDatabase(db));
    out.textContent = "open:" + rows[0][0];
  } catch (error) {
    out.textContent = "refused:" + String(error && error.message ? error.message : error);
  }
</script>`;

function build(schema: string, migrations: Record<string, string>, args: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "dai-runtime-schema-"));
  writeFileSync(join(dir, "index.html"), APP);
  writeFileSync(join(dir, "schema.sql"), schema);

  if (Object.keys(migrations).length > 0) {
    mkdirSync(join(dir, "migrations"), { recursive: true });
    for (const [name, sql] of Object.entries(migrations)) {
      writeFileSync(join(dir, "migrations", name), sql);
    }
  }

  const out = join(dir, "app.dai.html");
  execFileSync(process.execPath, [cli, "build", dir, "-o", out, "--quiet", ...args], {
    encoding: "utf8",
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out;
}

/** Opens a container and returns what the application reported. */
async function run(page: Page, container: string): Promise<string> {
  await page.goto(pathToFileURL(container).href);
  const app = page.frameLocator("#dai-app").frameLocator("iframe").first();
  // The application runs two frames down: the shell mounts the container's own
  // frame, which mounts the application.
  const out = page.frameLocator("#dai-app").locator("#out");
  await expect(out).not.toHaveText("starting", { timeout: 30_000 });
  void app;
  return (await out.textContent()) ?? "";
}

test.describe("opening data with the code that expects it", () => {
  test.slow();

  test("a first version opens its own empty document", async ({ page }) => {
    const one = build(SCHEMA_V1, {});
    expect(await run(page, one)).toMatch(/^open:/);
  });

  test("refuses old data under a version that cannot account for it", async ({ page }) => {
    /*
     * The container is intact and correctly signed — this is not tampering. It
     * is version two's code meeting version one's data, which is what happens
     * when somebody asks an assistant for a change and opens the file they
     * already had.
     *
     * The data is taken from a running version one, so the database carries the
     * stamp version one wrote, exactly as a month-old document would.
     */
    const one = build(SCHEMA_V1, {});
    expect(await run(page, one)).toBe("open:1");

    const written = (await page
      .frameLocator("#dai-app")
      .locator("#out")
      .evaluate(() => (window as unknown as { __database: number[] }).__database)) as number[];
    expect(written.length).toBeGreaterThan(0);

    // Version two, built without a migration — which the gate would refuse, so
    // this is a container from somewhere the gate never ran.
    const two = build(SCHEMA_V2, {});
    const container = await verifyContainer(readFileSync(two, "utf8"));
    const resealed = await resealContainer(container, new Uint8Array(written));

    const staged = join(mkdtempSync(join(tmpdir(), "dai-staged-")), "app.dai.html");
    writeFileSync(staged, resealed.html);

    const report = await run(page, staged);
    expect(report).toMatch(/^refused:/);
    expect(report).toContain("different version");
  });

  test("a migration brings the data forward", async ({ page }) => {
    const one = build(SCHEMA_V1, {});
    const two = build(
      SCHEMA_V2,
      { "001-add-done.sql": "ALTER TABLE tasks ADD COLUMN done INTEGER NOT NULL DEFAULT 0;" },
      ["--upgrade-of", one],
    );

    expect(await run(page, two)).toMatch(/^open:/);
  });
});
