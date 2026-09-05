import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { toBase64 } from "../src/core.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

async function pem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return `-----BEGIN PRIVATE KEY-----\n${toBase64(pkcs8).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Version one: notes with a body. Version two adds a `done` flag with a
 * migration; the broken version two changes the table with no migration.
 */
const V1_SCHEMA = "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);";
const V2_SCHEMA =
  "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);";
const BROKEN_SCHEMA = "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);";

function app(extraColumn: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Notes</title></head><body>
<p>count <dai-value id="count" query="SELECT count(*) FROM notes"></dai-value></p>
<p>first <dai-value id="first" query="SELECT body FROM notes ORDER BY id LIMIT 1"></dai-value></p>
${extraColumn ? `<p>done <dai-value id="done" query="SELECT count(*) FROM notes WHERE done = 0"></dai-value></p>` : ""}
<dai-form run="INSERT INTO notes (body) VALUES (:body)"><input name="body" id="body" required><button id="add">Add</button></dai-form>
<dai-save id="save">Save</dai-save>
<script type="module" src="./dai-kit.js"></script>
</body></html>`;
}

interface Built {
  file: { name: string; mimeType: string; buffer: Buffer };
  path: string;
  uuid: string;
}

async function build(options: {
  key: string;
  schema: string;
  extraColumn?: boolean;
  migration?: string;
  upgradeOf?: string;
  supersedes?: string;
  name?: string;
}): Promise<Built> {
  const source = mkdtempSync(join(tmpdir(), "dai-succession-"));
  writeFileSync(join(source, "index.html"), app(options.extraColumn ? "done" : ""), "utf8");
  writeFileSync(join(source, "schema.sql"), options.schema, "utf8");
  if (options.migration) {
    mkdirSync(join(source, "migrations"));
    writeFileSync(join(source, "migrations", "001-done.sql"), options.migration, "utf8");
  }
  const keyFile = join(source, "key.pem");
  writeFileSync(keyFile, options.key, "utf8");
  const built = await compileDirectory({
    sourceDir: source,
    root: repo,
    appName: options.name ?? "Notes",
    signingKey: keyFile,
    upgradeOf: options.upgradeOf,
    supersedes: options.supersedes,
  });
  const path = join(source, "notes.dai.html");
  writeFileSync(path, built.html, "utf8");
  return {
    file: { name: "notes.dai.html", mimeType: "text/html", buffer: Buffer.from(built.html, "utf8") },
    path,
    uuid: built.manifest.documentUuid,
  };
}

async function open(page: Page, built: Built): Promise<void> {
  await page.setInputFiles("#file", built.file);
  const outcome = page.locator("#card-open:visible, body.loaded, #report.error").first();
  await outcome.waitFor({ timeout: 60_000 });
  if (await page.locator("#card-open").isVisible()) await page.locator("#card-open").click();
}

function inside(page: Page) {
  return page.frameLocator("#cartridge").frameLocator("#dai-app");
}

async function close(page: Page): Promise<void> {
  await page.click("#more");
  await page.locator("#eject").click();
  await expect(page.locator("body")).not.toHaveClass(/loaded/);
}

/**
 * Succession: the next version of an application is the same application with
 * the same records, not a stranger with an empty database.
 *
 * The rule under test is the exit criterion word for word: data present, or
 * loud refusal, never silent loss. And the guard that makes adoption safe to
 * offer at all: only under the key this device pinned for the document being
 * replaced.
 */
test.describe("a document that replaces another", () => {
  test("carries the data forward through a migration, and keeps the old one", async ({ page }) => {
    test.slow();
    const key = await pem();

    // v1, used: a note saved into it.
    const v1 = await build({ key, schema: V1_SCHEMA });
    await page.goto(RUNNER_URL);
    await open(page, v1);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await inside(page).locator("#body").fill("buy milk");
    await inside(page).locator("#add").click();
    await expect(inside(page).locator("#count")).toHaveText("1", { timeout: 30_000 });
    await inside(page).locator("#save").click();
    await expect(inside(page).locator("#save")).toHaveText("Saved", { timeout: 30_000 });
    await close(page);

    // v2, built as the upgrade of v1: the compiler names v1 as superseded and
    // gates the schema change on the migration that covers it.
    const v2 = await build({
      key,
      schema: V2_SCHEMA,
      extraColumn: true,
      migration: "ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;",
      upgradeOf: v1.path,
    });
    await page.setInputFiles("#file", v2.file);
    await expect(page.locator("#card-succession")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#card-succession")).toHaveAttribute("data-state", "adopting");
    await expect(page.locator("#card-succession")).toContainText("Replaces Notes");
    await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // Data present, in the new shape.
    await expect(inside(page).locator("#count")).toHaveText("1", { timeout: 60_000 });
    await expect(inside(page).locator("#first")).toHaveText("buy milk");
    await expect(inside(page).locator("#done")).toHaveText("1");
    await close(page);

    // The old one is kept as it was, and opens as it did.
    await open(page, v1);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(inside(page).locator("#count")).toHaveText("1", { timeout: 60_000 });
    await expect(inside(page).locator("#first")).toHaveText("buy milk");
  });

  test("refuses to adopt under a different key, and says so before opening", async ({ page }) => {
    test.slow();
    const acme = await pem();
    const stranger = await pem();

    const v1 = await build({ key: acme, schema: V1_SCHEMA });
    await page.goto(RUNNER_URL);
    await open(page, v1);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await inside(page).locator("#body").fill("secret");
    await inside(page).locator("#add").click();
    await inside(page).locator("#save").click();
    await expect(inside(page).locator("#save")).toHaveText("Saved", { timeout: 30_000 });
    await close(page);

    // Signed by somebody else, claiming to be the next version.
    const impostor = await build({ key: stranger, schema: V1_SCHEMA, supersedes: v1.uuid, name: "Notes" });
    await page.setInputFiles("#file", impostor.file);
    await expect(page.locator("#card-succession")).toHaveAttribute("data-state", "refused", { timeout: 60_000 });
    await expect(page.locator("#card-succession")).toContainText(/different key/);
    await expect(page.locator("#card-succession")).toContainText(/Your data stays where it is/);
    await page.locator("#card-open").click();
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });

    // Opened, empty. Nothing of v1's crossed over.
    await expect(inside(page).locator("#count")).toHaveText("0", { timeout: 60_000 });
  });

  test("refuses loudly when no migration reaches, and loses nothing", async ({ page }) => {
    test.slow();
    const key = await pem();

    const v1 = await build({ key, schema: V1_SCHEMA });
    await page.goto(RUNNER_URL);
    await open(page, v1);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await inside(page).locator("#body").fill("keep me");
    await inside(page).locator("#add").click();
    await inside(page).locator("#save").click();
    await expect(inside(page).locator("#save")).toHaveText("Saved", { timeout: 30_000 });
    await close(page);

    // The compiler would refuse this build with --upgrade-of, because the
    // schema moved with no migration. Built without it and told what it
    // replaces by hand, it is the case a host has to catch at runtime.
    const broken = await build({ key, schema: BROKEN_SCHEMA, supersedes: v1.uuid });
    await page.setInputFiles("#file", broken.file);
    await expect(page.locator("#card-succession")).toHaveAttribute("data-state", "adopting", { timeout: 60_000 });
    await page.locator("#card-open").click();

    // Loud: the shell's refusal reaches the screen, in its words.
    await expect(page.locator("#report")).toContainText(/does not match this version/i, { timeout: 60_000 });
    await expect(page.locator("#report")).toContainText(/Nothing has been changed or lost/);
    await expect(page.locator("body")).not.toHaveClass(/loaded/);

    // And nothing was: v1 still has its note.
    await open(page, v1);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(inside(page).locator("#count")).toHaveText("1", { timeout: 60_000 });
    await expect(inside(page).locator("#first")).toHaveText("keep me");
  });
});
