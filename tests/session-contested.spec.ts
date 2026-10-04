import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";

/**
 * A contested seat is repaired by a new session, said, and moved to (R14;
 * docs/format.md#roster-declared, SESSION-CONTESTED-SEAT).
 *
 * No seat is reseated: the creator's seat row declares the roster once. So when
 * two copies' asks for one open seat reach the creator's copy together, its kit
 * seats neither, closes that session (the creator writes nothing there again)
 * and starts a new one in its place, says so in its own words, and fires
 * dai:kit-new-session; tic-tac-toe moves the game there and offers its invite.
 *
 * Ada starts a game. Bo and Cy each open her file and ask for the open seat.
 * Cy takes Bo's file into his copy, so it holds both asks, and sends it to Ada.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const SENTENCE =
  "Two devices answered this invite, so nobody could take the seat. A new game has been started in its place; share its invite with the one person who should play.";

const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

async function firstOpen(page: Page, file: string): Promise<FrameLocator> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const app = appIn(page);
  await expect(app.locator("#app")).toBeVisible({ timeout: 60_000 });
  return app;
}

async function takeIn(page: Page, file: string): Promise<void> {
  await page.setInputFiles("#file", file);
  await expect(page.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
  await page.locator("#card-open").click();
}

async function saveOut(page: Page, to: string): Promise<string> {
  await page.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as { __runner: { exportContainer(): Promise<void> } }).__runner.exportContainer());
  const download = await downloading;
  writeFileSync(to, readFileSync(await download.path()));
  return to;
}

/** How many copies asked for an open seat of a session, as this copy holds the asks. */
const asks = (app: FrameLocator): Promise<number> =>
  app.locator("#app").evaluate(() =>
    Number(
      (window as any).daiKit.db.selectObjects(
        "SELECT count(DISTINCT b._r_replica) AS n FROM _dai_binding_current b JOIN _dai_open_seat s ON s.session = b._r_session AND s.seat = b.seat",
      )[0].n,
    ),
  );

test("two asks for one open seat: the creator's kit sets the session aside, says so, and the game moves to a new one", async ({ browser }) => {
  test.slow();
  const scratch = mkdtempSync(join(tmpdir(), "dai-session-contested-"));
  const built = await compileDirectory({ sourceDir: join(repo, "examples", "tic-tac-toe"), root: repo, appName: "Tic-tac-toe" });
  const container = join(scratch, "ttt.dai.html");
  writeFileSync(container, built.html, "utf8");
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ acceptDownloads: true })));
  const [pageA, pageB, pageC] = await Promise.all(contexts.map((c) => c.newPage()));

  // Ada starts a game, and sends her file.
  const appA = await firstOpen(pageA!, container);
  await appA.locator("#you").fill("Ada");
  await appA.locator("#them").fill("Bo");
  await appA.locator("#new-game button[type=submit]").click();
  await expect(appA.locator("#app")).toContainText("Ada", { timeout: 30_000 });
  const a1 = await saveOut(pageA!, join(scratch, "a1.dai.html"));

  // Bo and Cy each open it, and each asks for the open seat.
  const appB = await firstOpen(pageB!, a1);
  const appC = await firstOpen(pageC!, a1);
  await expect.poll(() => asks(appB), { timeout: 30_000, message: "Bo asked" }).toBe(1);
  await expect.poll(() => asks(appC), { timeout: 30_000, message: "Cy asked" }).toBe(1);
  // Cy takes Bo's copy in: his copy holds both asks, and goes to Ada in one file.
  const b1 = await saveOut(pageB!, join(scratch, "b1.dai.html"));
  await takeIn(pageC!, b1);
  await expect.poll(() => asks(appC), { timeout: 30_000, message: "Cy's copy holds both asks" }).toBe(2);
  const c1 = await saveOut(pageC!, join(scratch, "c1.dai.html"));

  // Ada's copy takes both asks in one merge: her kit seats neither, sets the
  // session aside, and says so, once.
  const said = appA.locator("[data-dai-contested]");
  await expect(said, "nothing is said before a contest").toHaveCount(0);
  await takeIn(pageA!, c1);
  await expect(said, "the kit names the cause and the way on").toContainText(SENTENCE, { timeout: 60_000 });
  await expect(said).toHaveCount(1);
  const old = await said.getAttribute("data-dai-contested");
  const facts = () =>
    appA.locator("#app").evaluate((_app, s) => {
      const db = (window as any).daiKit.db;
      const of = (sql: string, bind: unknown[] = []) => db.selectObjects(sql, bind).map((r: { s: string }) => r.s);
      return {
        closed: of("SELECT lower(hex(session)) AS s FROM _dai_closed"),
        held: of("SELECT lower(hex(replica)) AS s FROM _dai_holder WHERE lower(hex(session)) = ?", [s]).length,
        games: of("SELECT lower(hex(_r_session)) AS s FROM games_current ORDER BY _r_lc"),
        mine: of("SELECT lower(hex(session)) AS s FROM _dai_creator ORDER BY seq"),
      };
    }, old);
  const seen = await facts();
  expect(seen.closed, "the contested session is closed by its creator").toEqual([old]);
  expect(seen.held, "and nobody but Ada holds a seat in it").toBe(1);
  expect(seen.mine.length, "Ada started a new session").toBe(2);
  expect(seen.games, "and the game moved there").toEqual([old, seen.mine[1]]);
  await expect(appA.locator("#seat-text")).toContainText("Two people opened your invite");
  await expect(appA.locator("#fresh-invite")).toBeVisible();

  // The kit seats again on every merge; the contested session it closed is
  // left alone, so nothing is set aside twice.
  await appA.locator("#app").evaluate(() => window.dispatchEvent(new CustomEvent("dai:merged", { detail: { applied: 0 } })));
  await expect(said).toHaveCount(1);
  expect((await facts()).mine.length, "no third session").toBe(2);

  for (const context of contexts) await context.close();
});
