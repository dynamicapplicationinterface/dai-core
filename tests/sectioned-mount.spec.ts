import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { compileDirectory } from "../src/compile.js";
import { auditContainer, hostShell, parseContainer } from "../src/container.js";
import { fromBase64, sha256Hex, ZIP_EPOCH } from "../src/core.js";
import { writeContainerFile } from "../src/format.js";
import { openFile } from "./open.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const HOST = {
  template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
  runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
};

/**
 * A sectioned document mounts with its data.
 *
 * The sectioned form keeps the database as its own section, outside the
 * payload and outside the manifest's digests, so a save can rewrite it
 * without touching the publisher's signature. The reader put that section in
 * a field beside the archive — and a host mounts the archive. Every sectioned
 * document opened empty; an app that creates its tables on first open looked
 * fine; and the first autosave wrote the empty database over the real one.
 * This holds the whole way: a real database, written by the runner, wrapped
 * into a sectioned file, opened in a fresh runner, its row still there.
 */

/** A small kit app: one table, one row seeded, one control that changes it. */
async function jobsApp(): Promise<string> {
  const source = mkdtempSync(join(tmpdir(), "dai-sectioned-mount-"));
  writeFileSync(
    join(source, "schema.sql"),
    "CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, done INTEGER NOT NULL DEFAULT 0);\n" +
      "INSERT INTO jobs (id) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM jobs);",
    "utf8",
  );
  writeFileSync(
    join(source, "index.html"),
    [
      '<!doctype html><meta charset="utf-8">',
      '<dai-rows query="SELECT id, done FROM jobs ORDER BY id">',
      "  <template>",
      '    <p><button id="tick" type="button" data-run="UPDATE jobs SET done = 1 - done WHERE id = :id">tick</button>',
      '    <span id="state" data-text="done"></span></p>',
      "  </template>",
      "</dai-rows>",
      '<script type="module" src="./dai-kit.js"></script>',
    ].join("\n"),
    "utf8",
  );
  const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Jobs" });
  const file = join(source, "jobs.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

/** The viewer form, re-wrapped as a sectioned file around `database` — as the compiler's own writer does it. */
async function sectionedFrom(viewerHtml: string, database: Uint8Array): Promise<Uint8Array> {
  const parsed = parseContainer(viewerHtml);
  const hashes: Record<string, string> = {};
  for (const [name, digest] of Object.entries(parsed.manifest.hashes ?? {})) {
    if (name !== "document.sqlite") hashes[name] = digest;
  }
  const payload: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(parsed.archive)) {
    if (name === "runtime/manifest.json" || name === "document.sqlite") continue;
    payload[name] = bytes;
  }
  return writeContainerFile({
    manifest: new TextEncoder().encode(JSON.stringify({ ...parsed.manifest, hashes }, null, 2) + "\n"),
    payload: zipSync(payload, { level: 9, mtime: ZIP_EPOCH }),
    data: database,
  });
}

test.describe("a sectioned document mounts with its data", () => {
  test("the reader puts the data section in the archive, accounted for, and the host shell carries it", async () => {
    const file = await jobsApp();
    const viewer = readFileSync(file, "utf8");
    const database = new Uint8Array(4096);
    database.set(new TextEncoder().encode("SQLite format 3\0"), 0);
    database.fill(7, 100, 4096);
    const sectioned = await sectionedFrom(viewer, database);

    const parsed = parseContainer(sectioned);
    expect(parsed.database).toEqual(database);
    // In the archive a host mounts, under its entry name, with its digest where
    // the runtime's integrity check looks for it.
    expect(parsed.archive["document.sqlite"]).toEqual(database);
    expect(parsed.manifest.hashes["document.sqlite"]).toBe(await sha256Hex(database));
    // The manifest bytes the archive carries agree with the manifest object.
    const carried = JSON.parse(new TextDecoder().decode(parsed.archive["runtime/manifest.json"]!)) as { hashes: Record<string, string> };
    expect(carried.hashes["document.sqlite"]).toBe(await sha256Hex(database));
    // And it still verifies: the signature never covered the database.
    expect((await auditContainer(parsed)).ok).toBe(true);

    // The host's own shell around it carries the database in its payload.
    const shell = await hostShell(parsed, HOST);
    // Read back by the reader, which finds the payload by its element and not
    // by a string the runtime's own source also contains.
    const mounted = parseContainer(shell);
    expect(mounted.archive["document.sqlite"]).toEqual(database);
  });

  test("a row written in one runner is there when the sectioned file opens in another", async ({ browser, page }) => {
    test.slow();
    const file = await jobsApp();

    // Write a row, and let the autosave land, so the kept copy holds it.
    await page.goto(RUNNER_URL);
    await openFile(page, file);
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    const app = page.frameLocator("#cartridge").frameLocator("#dai-app");
    await expect(app.locator("#state")).toHaveText("0", { timeout: 30_000 });
    await app.locator("#tick").click();
    await expect(app.locator("#state")).toHaveText("1");
    await page.waitForTimeout(1500);
    const databaseB64 = await page.evaluate(() => {
      const bytes = (window as unknown as { __runner: { loaded: { archive: Record<string, Uint8Array> } } }).__runner.loaded.archive["document.sqlite"]!;
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    });
    const database = fromBase64(databaseB64);
    expect(database.byteLength).toBeGreaterThan(1024);

    // Wrap that real database in a sectioned file, and open it somewhere new.
    const sectioned = await sectionedFrom(readFileSync(file, "utf8"), database);
    const dir = mkdtempSync(join(tmpdir(), "dai-sectioned-open-"));
    const dai = join(dir, "jobs.dai");
    writeFileSync(dai, sectioned);

    const other = await browser.newContext();
    const fresh = await other.newPage();
    await fresh.goto(RUNNER_URL);
    await openFile(fresh, dai);
    await expect(fresh.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    const theirs = fresh.frameLocator("#cartridge").frameLocator("#dai-app");
    // The row, as it was written — not the seed, not an empty table.
    await expect(theirs.locator("#state")).toHaveText("1", { timeout: 30_000 });
    await other.close();
  });
});
