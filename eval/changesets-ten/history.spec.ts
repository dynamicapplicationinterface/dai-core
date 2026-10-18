/**
 * History growth at 1,000 saves, through the real runtime (R-O, Build 1).
 * Measured and recorded; compaction is Build 3.
 *
 * The workout log (apps/02-workout) is compiled, opened in the real host and
 * driven through its own form 1,000 times: "Add to log" 900 times, and the
 * newest entry's Delete button every tenth time. Each action waits for its
 * save to be written. Before and after: the stored file's size, what each part
 * of it holds (SQLite's dbstat, on the runtime's own engine), and the time
 * from a refresh to the log drawn, at 1x and 4x CPU (median of five).
 */
import { mkdirSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { compileDirectory } from "../../src/compile.js";
import { boot, deserialize } from "../../tests/changesets/copy.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const SAVES = Number(process.env.DAI_HISTORY_SAVES ?? 1000);

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const app = (page: Page) => page.frameLocator("iframe").frameLocator("iframe");

async function stored(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(async () => {
    const runner = (window as Any).__runner;
    const held = await runner.loadStored(runner.loaded.manifest.documentUuid);
    return held ? [...held] : null;
  });
  return Uint8Array.from(bytes ?? []);
}

async function parts(bytes: Uint8Array): Promise<Any> {
  const sqlite3 = await boot();
  const db = new sqlite3.oo1.DB(":memory:", "c");
  deserialize(sqlite3, db, bytes);
  const rows = db.selectObjects("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC") as Any[];
  const of = (test: (n: string) => boolean) => rows.filter((r) => test(String(r.name))).reduce((s, r) => s + Number(r.bytes), 0);
  const result = {
    file: bytes.byteLength,
    app: of((n) => !/^(_dai|_cs_|sqlite_)/.test(n)),
    cells: of((n) => /^(sqlite_autoindex_)?_cs_(cell|sup|seen|ingested|flag|held|keys)/.test(n)),
    logAndAuthorship: of((n) => /^(sqlite_autoindex_)?(_cs_log|_dai_)/.test(n)),
    payload: Number(db.selectValue("SELECT coalesce(sum(length(payload)), 0) FROM _cs_log")),
    logRows: Number(db.selectValue("SELECT count(*) FROM _cs_log")),
    appRows: Number(db.selectValue("SELECT count(*) FROM lifts")),
    largest: rows.slice(0, 6).map((r) => ({ name: r.name, bytes: Number(r.bytes) })),
  };
  db.close();
  return result;
}

const saves = (page: Page): Promise<number> => page.evaluate(() => Number((window as Any).__runner.savesWritten ?? 0));

async function openTimes(page: Page): Promise<Any> {
  const result: Any = {};
  const cdp = await page.context().newCDPSession(page);
  for (const rate of [1, 4]) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      await page.reload();
      // Drawn: an entry of the log, with its own Delete button, is on screen.
      await expect(app(page).locator('button[aria-label="Delete this entry"]').first()).toBeVisible({ timeout: 120_000 });
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    result[`${rate}x`] = { medianMs: times[2], all: times };
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  return result;
}

test("history at 1,000 saves on the workout log", async ({ page }) => {
  test.setTimeout(4 * 60 * 60 * 1000);
  const scratch = mkdtempSync(join(tmpdir(), "dai-history-"));
  cpSync(join(here, "apps", "02-workout"), join(scratch, "src"), { recursive: true });
  const built = await compileDirectory({ sourceDir: join(scratch, "src"), root: repo, appName: "Workout log" });
  const file = join(scratch, "workout.dai.html");
  writeFileSync(file, built.html, "utf8");
  page.on("dialog", (d) => void d.accept().catch(() => {}));
  await page.goto("http://localhost:5175/");
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const ui = app(page);
  await expect(ui.locator("dai-form").first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => saves(page), { timeout: 60_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2000);
  const created = { parts: await parts(await stored(page)), opens: await openTimes(page) };

  const took: number[] = [];
  for (let i = 1; i <= SAVES; i++) {
    const before = await saves(page);
    const t0 = Date.now();
    if (i % 10 === 0) {
      await ui.locator('button[aria-label="Delete this entry"]').first().click();
    } else {
      // Every field: the kit clears the form after a submit, and these are required.
      await ui.locator('input[name="exercise"]').fill(`Lift ${i}`);
      await ui.locator('input[name="sets"]').fill("3");
      await ui.locator('input[name="reps"]').fill("8");
      await ui.locator('input[name="weight"]').fill(String(100 + (i % 50)));
      await ui.locator("dai-form button").first().click();
    }
    await expect.poll(() => saves(page), { timeout: 60_000 }).toBeGreaterThan(before);
    took.push(Date.now() - t0);
  }
  await page.waitForTimeout(2000);
  const after = { parts: await parts(await stored(page)), opens: await openTimes(page) };
  took.sort((a, b) => a - b);
  const result = {
    saves: SAVES,
    created,
    after,
    growth: Number((after.parts.file / created.parts.file).toFixed(2)),
    perAppByte: Number((after.parts.file / after.parts.app).toFixed(1)),
    actionToSavedMs: { median: took[Math.floor(took.length / 2)], p95: took[Math.floor(took.length * 0.95)] },
  };
  writeFileSync(join(out, "history.json"), JSON.stringify(result, null, 1) + "\n");
  console.log(JSON.stringify(result));
});
