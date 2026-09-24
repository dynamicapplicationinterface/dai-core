import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { authorIdOf, showAuthorId, verifySignature } from "../src/identity.js";
import { canonicalHeader, rowsDigest, type BatchEntry } from "../src/replicated-batch.js";
import { play } from "./chess-play.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * What leaves the device is signed (docs/identity.md, step 3: seal on leave).
 *
 * The real runtime, the real host key: a person plays a move, the document
 * saves, and what the save holds is checked from outside the page with the
 * library's own canonical functions. No own row is still pending, every header's
 * digest is its rows, every signature verifies, and the key it verifies under
 * fingerprints to the author, which is this device's host key.
 */
test("a saved document's rows are sealed, and every batch verifies under this device's key", async ({ page }) => {
  test.slow();
  const built = await compileDirectory({
    sourceDir: join(repo, "tests", "fixture", "chess"),
    root: repo,
    appName: "Velvet Chess",
  });
  const file = join(mkdtempSync(join(tmpdir(), "dai-sealed-leave-")), "velvet-chess.dai.html");
  writeFileSync(file, built.html, "utf8");

  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const ui = app(page);
  await expect(ui.locator("#app")).toBeVisible({ timeout: 60_000 });
  await ui.locator("[data-new-game]:visible").first().click();
  await ui.locator("#setup-you").fill("Ada");
  await ui.locator("#setup-them").fill("Bo");
  await ui.locator('input[name="color"][value="w"]').check();
  await ui.locator("#new-game-form button[type=submit]").click();
  const before = await page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0));
  await play(ui, "e2", "e4");
  // The save after the move is the leave this is about.
  await expect.poll(() => page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0)), { timeout: 30_000 })
    .toBeGreaterThan(before);

  const author = (await page.evaluate(() => (window as any).__runner.authorId())) as string;
  const document = (await page.evaluate(() => (window as any).__runner.loaded?.manifest?.documentUuid ?? null)) as string | null;

  // Everything the checks need, out of the page as plain arrays.
  const held = await ui.locator("#app").evaluate(() => {
    const db = (window as any).daiKit.db;
    const plain = (v: unknown) => (v instanceof Uint8Array ? { bytes: [...v] } : v);
    const me = db.selectObjects("SELECT id FROM _dai_replica")[0].id as Uint8Array;
    const tables = db
      .selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .map((r: any) => String(r.name))
      .filter((name: string) => {
        const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => c.name);
        return cols.includes("_r_replica") && cols.includes("_r_batch");
      });
    const rows: { table: string; row: Record<string, unknown> }[] = [];
    let pending = 0;
    for (const t of tables) {
      for (const r of db.selectObjects(`SELECT * FROM "${t}" WHERE _r_replica = ?`, [me])) {
        if (r._r_batch == null) pending += 1;
        rows.push({ table: t, row: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])) });
      }
    }
    const headers = db
      .selectObjects("SELECT * FROM _dai_batch")
      .map((h: any) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, plain(v)])));
    return { pending, rows, headers };
  });

  const bytes = (v: unknown): Uint8Array => Uint8Array.from((v as { bytes: number[] }).bytes);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  expect(held.pending, "no row of this device's is left pending after a save").toBe(0);
  expect(held.headers.length, "the save carries signed headers").toBeGreaterThan(0);
  expect(document, "the document's id, which every header signs").toBeTruthy();

  for (const header of held.headers) {
    const id = bytes(header["id"]);
    const entries: BatchEntry[] = held.rows
      .filter((r) => r.row["_r_batch"] && hex(bytes(r.row["_r_batch"])) === hex(id))
      .map(({ table, row }) => ({
        table,
        row: {
          _r_replica: bytes(row["_r_replica"]),
          _r_seq: Number(row["_r_seq"]),
          _r_lc: Number(row["_r_lc"]),
          _r_entity: bytes(row["_r_entity"]),
          _r_parents: String(row["_r_parents"]),
          _r_deleted: Number(row["_r_deleted"]),
          ...(row["_r_session"] ? { _r_session: bytes(row["_r_session"]) } : {}),
          columns: Object.fromEntries(
            Object.entries(row)
              .filter(([k]) => !k.startsWith("_r_"))
              .map(([k, v]) => [k, v && typeof v === "object" && "bytes" in (v as object) ? bytes(v) : v]),
          ),
        },
      }));
    expect(entries.length, `batch ${hex(id)} covers rows`).toBeGreaterThan(0);
    expect(hex(await rowsDigest(entries)), "the header's digest is its rows").toBe(hex(bytes(header["digest"])));
    const pub = bytes(header["pub"]);
    expect(showAuthorId(await authorIdOf(pub)), "the key fingerprints to this device's author").toBe(author);
    expect(showAuthorId(bytes(header["author"]))).toBe(author);
    const signed = canonicalHeader({
      version: Number(header["version"]),
      document: document!,
      author: bytes(header["author"]),
      lc: Number(header["lc"]),
      digest: bytes(header["digest"]),
    });
    expect(await verifySignature(pub, signed, bytes(header["sig"])), "the signature verifies").toBe(true);
  }
});
