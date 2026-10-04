import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { signedBytes, signedViewOf } from "../src/core.js";

/**
 * Two builds of one document are not merged (docs/format.md,
 * `document-mismatch`, R16): a sibling whose signed-view digest differs from
 * the local copy's is refused whole, nothing taken, `SIGNED_VIEW_MISMATCH`.
 *
 * Chess, built twice under one document id and one publisher key, from two
 * signed manifests (the publisher's name differs, so the signed views hash
 * differently: what two builds declaring another `max_parties` would do).
 * Ada plays on the first, Bo on the second. Bo's copy arrives at Ada's: her
 * host refuses it before the frame is asked, and says so over her document.
 * And the frame's own merge, given the digest Bo's copy was built under,
 * holds its own document's digest to it and refuses the same, with the same
 * sentence. Ada's copy holds no row of Bo's after either.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const SENTENCE =
  "These two copies come from different releases of this app, so their games cannot be combined. Nothing was merged, and your copy is untouched.";
const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

async function firstOpen(page: Page, file: string): Promise<FrameLocator> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const app = appIn(page);
  await expect(app.locator("#app")).toBeVisible({ timeout: 60_000 });
  return app;
}

async function newGame(app: FrameLocator, you: string, them: string): Promise<void> {
  await app.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
  await app.locator("#setup-you").fill(you);
  await app.locator("#setup-them").fill(them);
  await app.locator('input[name="color"][value="w"]').check();
  await app.locator("#new-game-form button[type=submit]").click();
}

/** How many rows this copy holds by `authorB64`, every replicated table. */
const rowsBy = (app: FrameLocator, authorB64: string): Promise<number> =>
  app.locator("#app").evaluate((_app, who) => {
    const db = (window as any).daiKit.db;
    const hex = Array.from(atob(who.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    let n = 0;
    for (const { name } of db.selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")) {
      const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => String(c.name));
      if (!cols.includes("_r_replica")) continue;
      n += Number(db.selectObjects(`SELECT count(*) AS n FROM "${name}" WHERE lower(hex(_r_replica)) = ?`, [hex])[0].n);
    }
    return n;
  }, authorB64);

test("a sibling built from another signed manifest is refused at the host and in the frame, with the sentence", async ({ browser }) => {
  test.slow();
  const scratch = mkdtempSync(join(tmpdir(), "dai-signed-view-"));
  const signing = { signingKey: resolve(repo, "conformance", "signing-key.pem"), allowTestKey: true };
  const first = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess", ...signing });
  const second = await compileDirectory({
    sourceDir: join(repo, "tests", "fixture", "chess"),
    root: repo,
    appName: "Velvet Chess",
    documentUuid: first.manifest.documentUuid,
    publisherName: "Another release",
    ...signing,
  });
  const viewOf = (manifest: Parameters<typeof signedViewOf>[0]): string => createHash("sha256").update(signedBytes(signedViewOf(manifest))).digest("hex");
  expect(viewOf(second.manifest), "two builds, two signed views").not.toBe(viewOf(first.manifest));
  const fileA = join(scratch, "a.dai.html");
  const fileB = join(scratch, "b.dai.html");
  writeFileSync(fileA, first.html, "utf8");
  writeFileSync(fileB, second.html, "utf8");

  const contexts = [await browser.newContext({ acceptDownloads: true }), await browser.newContext({ acceptDownloads: true })];
  const [pageA, pageB] = await Promise.all(contexts.map((c) => c.newPage()));

  // Ada plays on the first build; Bo on the second, and saves his copy out.
  const appA = await firstOpen(pageA!, fileA);
  await newGame(appA, "Ada", "Bo");
  const appB = await firstOpen(pageB!, fileB);
  await newGame(appB, "Bo", "Ada");
  const bo = (await pageB!.evaluate(() => (window as any).__runner.authorId())) as string;
  await expect.poll(() => rowsBy(appB, bo), { timeout: 30_000, message: "Bo's game is written" }).toBeGreaterThan(0);
  await pageB!.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = pageB!.waitForEvent("download", { timeout: 60_000 });
  await pageB!.evaluate(() => (window as any).__runner.exportContainer());
  const boFile = join(scratch, "bo.dai.html");
  writeFileSync(boFile, readFileSync(await (await downloading).path()));

  // At the host: Bo's copy arrives at Ada's and is refused before the frame is asked.
  await pageA!.setInputFiles("#file", boFile);
  await expect(pageA!.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
  await pageA!.locator("#card-open").click();
  await expect(pageA!.locator("#doc-note"), "the host says why").toHaveText(SENTENCE, { timeout: 60_000 });
  expect(await rowsBy(appA, bo), "nothing of Bo's was taken").toBe(0);

  // In the frame: given the digest Bo's copy was built under, its merge refuses the same.
  const uuid = first.manifest.documentUuid;
  const boBytes = (await pageB!.evaluate(async (id) => [...((await (window as any).__runner.loadStored(id)) as Uint8Array)], uuid)) as number[];
  const report = (await pageA!.evaluate(
    ([bytes, view]) => (window as any).__runner.mergeInFrame(bytes, view),
    [boBytes, viewOf(second.manifest)] as const,
  )) as { refused?: string; applied: number };
  expect(report.refused, "the frame refuses the sibling whole").toBe("SIGNED_VIEW_MISMATCH");
  expect(report.applied).toBe(0);
  await expect(pageA!.locator("#doc-note"), "said with the same sentence").toHaveText(SENTENCE);
  expect(await rowsBy(appA, bo), "nothing of Bo's was taken").toBe(0);

  for (const context of contexts) await context.close();
});
