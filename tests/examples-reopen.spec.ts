import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { BATCH_FORMAT_VERSION } from "../src/replicated-batch.js";
import { play } from "./chess-play.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * Every replicated example on batch format version 2 (identity step 7).
 *
 * Each is built by the ordinary build path, opened in the real host, and given
 * one row by clicking. The test waits for what a reopen reads, the stored
 * database, to hold that row sealed; then reopens and finds the row on screen
 * and, in the stored copy, still sealed under a version 2 header. The manifest
 * declares `authorship` (docs/format.md, `version-declared`).
 *
 * The examples without replicated tables (packing-list, chore-chart,
 * meal-plan, tasks) have no batches, so nothing in them is sealed.
 */

interface Example {
  /** The example's id: its folder's name, which is what a test title is found by. */
  id: string;
  dir: string;
  name: string;
  /** Visible once app.js has started. */
  ready: string;
  /** Writes one row by clicking, and waits until the page shows it. */
  write(ui: FrameLocator): Promise<void>;
  /** Visible after a reopen when the row is present. */
  shown(ui: FrameLocator): Promise<void>;
  /** The row, as SQL over the stored database: one row with its `_r_batch`. */
  row: string;
}

const EXAMPLES: Example[] = [
  {
    id: "tic-tac-toe",
    dir: "examples/tic-tac-toe",
    name: "Tic-tac-toe",
    ready: "#new-game",
    async write(ui) {
      await ui.locator("#you").fill("Ada");
      await ui.locator("#them").fill("Bo");
      await ui.locator("#new-game button[type=submit]").click();
      await ui.locator("#board .cell").nth(0).click();
      await expect(ui.locator("#board .cell").nth(0)).toHaveText("X", { timeout: 30_000 });
    },
    async shown(ui) {
      await expect(ui.locator("#board .cell").nth(0)).toHaveText("X", { timeout: 60_000 });
    },
    row: "SELECT _r_batch FROM marks WHERE cell = 0 AND turn = 1",
  },
  {
    id: "request",
    dir: "examples/request",
    name: "Request",
    ready: "#new-request",
    async write(ui) {
      await ui.locator("#new-from").fill("Ada");
      await ui.locator("#new-title").fill("Onboarding details");
      await ui.locator("#new-request button[type=submit]").click();
      await ui.locator("#prompt").fill("Which start date works for you?");
      await ui.locator("#add-question button[type=submit]").click();
      await expect(ui.locator("#questions")).toContainText("Which start date works for you?", { timeout: 30_000 });
    },
    async shown(ui) {
      await expect(ui.locator("#questions")).toContainText("Which start date works for you?", { timeout: 60_000 });
    },
    row: "SELECT _r_batch FROM questions WHERE prompt = 'Which start date works for you?'",
  },
  {
    id: "receipts",
    dir: "examples/receipts",
    name: "Receipts",
    ready: "#entry",
    async write(ui) {
      // Ready means app.js has run: start-up fills in today's date.
      await expect(ui.locator("#spent-on")).not.toHaveValue("", { timeout: 60_000 });
      await ui.locator("#store").fill("Grocer");
      await ui.locator("#amount").fill("30");
      await ui.locator("#paid-by").fill("Ada");
      await ui.locator("#save-entry").click();
      await expect(ui.locator("#list")).toContainText("Grocer", { timeout: 30_000 });
    },
    async shown(ui) {
      await expect(ui.locator("#list")).toContainText("Grocer", { timeout: 60_000 });
    },
    row: "SELECT _r_batch FROM receipts WHERE store = 'Grocer'",
  },
  {
    id: "chess",
    dir: "tests/fixture/chess",
    name: "Velvet Chess",
    ready: "#app",
    async write(ui) {
      await ui.locator("[data-new-game]:visible").first().click();
      await ui.locator("#setup-you").fill("Ada");
      await ui.locator("#setup-them").fill("Bo");
      await ui.locator('input[name="color"][value="w"]').check();
      await ui.locator("#new-game-form button[type=submit]").click();
      await play(ui, "e2", "e4");
      await expect(ui.locator('[data-square="e4"]')).toHaveAttribute("aria-label", /^e4, white pawn/i, { timeout: 30_000 });
    },
    async shown(ui) {
      await expect(ui.locator('[data-square="e4"]')).toHaveAttribute("aria-label", /^e4, white pawn/i, { timeout: 60_000 });
      await expect(ui.locator('[data-square="e2"]')).toHaveAttribute("aria-label", /^e2, empty/);
    },
    row: "SELECT _r_batch FROM moves WHERE from_sq = 'e2' AND to_sq = 'e4'",
  },
];

/** What the stored database says about the row: absent, pending, or sealed under a header of some version. */
function inspect(bytes: Uint8Array, rowSql: string): { row: "absent" | "pending" | "sealed"; version: number | null; versions: number[] } {
  const dir = mkdtempSync(join(tmpdir(), "dai-reopen-db-"));
  const path = join(dir, "stored.sqlite");
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = '_dai_batch'").get()) return { row: "absent", version: null, versions: [] };
    const versions = (db.prepare("SELECT DISTINCT version FROM _dai_batch ORDER BY version").all() as { version: number }[])
      .map((r) => Number(r.version));
    const rows = db.prepare(rowSql).all() as { _r_batch: Uint8Array | null }[];
    if (rows.length === 0) return { row: "absent", version: null, versions };
    const batch = rows[0]!._r_batch;
    if (batch == null) return { row: "pending", version: null, versions };
    const header = db.prepare("SELECT version FROM _dai_batch WHERE id = ?").get(batch) as { version: number } | undefined;
    return { row: "sealed", version: header ? Number(header.version) : null, versions };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function stored(page: Page, uuid: string): Promise<Uint8Array> {
  const bytes = await page.evaluate(async (id) => {
    const runner = (window as unknown as { __runner: { loadStored(u: string): Promise<Uint8Array | null> } }).__runner;
    const held = await runner.loadStored(id);
    return held ? [...held] : null;
  }, uuid);
  if (!bytes) throw new Error("no stored database yet");
  return Uint8Array.from(bytes);
}

test.describe("the replicated examples, on batch format version 2", () => {
  for (const example of EXAMPLES) {
    test(`${example.id}: mounts, writes a row, saves, and reopens with the row present and sealed`, async ({ page }) => {
      test.slow();
      const built = await compileDirectory({ sourceDir: join(repo, example.dir), root: repo, appName: example.name });
      const file = join(mkdtempSync(join(tmpdir(), `dai-reopen-${example.id}-`)), `${example.id}.dai.html`);
      writeFileSync(file, built.html, "utf8");

      await page.goto(RUNNER_URL);
      await page.setInputFiles("#file", file);
      await page.locator("#card-open").click({ timeout: 60_000 });
      const ui = app(page);
      await expect(ui.locator(example.ready)).toBeVisible({ timeout: 60_000 });

      const manifest = (await page.evaluate(() => (window as any).__runner.loaded?.manifest ?? null)) as
        | { documentUuid: string; requires?: string[] }
        | null;
      expect(manifest?.requires ?? [], "the signed manifest declares authorship").toContain("authorship");
      const uuid = manifest!.documentUuid;

      await example.write(ui);

      // A save asked is not a save written: wait for what a reopen reads to hold the row sealed.
      await expect
        .poll(async () => inspect(await stored(page, uuid).catch(() => new Uint8Array()), example.row).row, {
          timeout: 60_000,
          message: "the stored database holds the row, sealed",
        })
        .toBe("sealed");

      // Reopen, as a refresh does: the host mounts its stored copy.
      await page.reload();
      const again = app(page);
      await example.shown(again);

      const after = inspect(await stored(page, uuid), example.row);
      expect(after.row, "the row is present and sealed after the reopen").toBe("sealed");
      expect(after.version, "its header is version 2").toBe(BATCH_FORMAT_VERSION);
      expect(after.versions, "every header the copy holds is version 2").toEqual([BATCH_FORMAT_VERSION]);
      expect(BATCH_FORMAT_VERSION).toBe(2);
    });
  }
});
