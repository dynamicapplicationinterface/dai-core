import { mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";

/**
 * A close is final for its author (docs/format.md, `close-monotone`, R18): a
 * close of his that counts and any row of his in that session at a higher seq
 * make him an equivocator, and every copy then admits none of his rows. So the
 * runtime refuses an author's own writes in a session after his counting
 * close, through the frame's write path (insert, change, remove), with a named
 * refusal the application can show: no honest application can make its user
 * an equivocator.
 *
 * Ada starts a chess game and plays a move through the document's own write
 * path, then closes the game; every write of hers in it after that is refused
 * by name, and the copy her device stores holds no row of hers in the game
 * above her close.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

test("after her own close, an author's writes in that session are refused by name, and none is stored", async ({ browser }) => {
  test.slow();
  const built = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
  const container = join(mkdtempSync(join(tmpdir(), "dai-closed-writes-")), "chess.dai.html");
  writeFileSync(container, built.html, "utf8");
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", container);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const ui = app(page);
  await expect(ui.locator("#app")).toBeVisible({ timeout: 60_000 });
  await ui.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
  await ui.locator("#setup-you").fill("Ada");
  await ui.locator("#setup-them").fill("Bo");
  await ui.locator('input[name="color"][value="w"]').check();
  await ui.locator("#new-game-form button[type=submit]").click();

  // Her game: the session she created, her seat, the game's entity.
  const game = async (): Promise<{ session: string; seat: string; entity: string } | null> =>
    ui.locator("#app").evaluate(() => {
      const kit = (window as any).daiKit;
      const row = kit.db.selectObjects(
        "SELECT lower(hex(c.session)) AS session, lower(hex(c.seat)) AS seat, lower(hex(g._r_entity)) AS entity " +
          "FROM _dai_creator c JOIN games_current g ON g._r_session = c.session WHERE lower(hex(c.replica)) = ?",
        [kit.author()],
      )[0];
      return row ? { session: String(row.session), seat: String(row.seat), entity: String(row.entity) } : null;
    });
  await expect.poll(game, { timeout: 30_000, message: "Ada's game is written" }).not.toBeNull();
  const { session, seat, entity } = (await game())!;

  /** One write through the frame's write path, from the document's own code: "written", or the refusal. */
  const write = (kind: "insert" | "change" | "remove", target?: string): Promise<string> =>
    ui.locator("#app").evaluate(
      (_app, { kind, session, seat, entity, target }) => {
        const replicated = (window as any).dai.replicated;
        const bytes = Uint8Array.from(seat.match(/../g)!.map((pair: string) => parseInt(pair, 16)));
        const move = { seat: bytes, game_id: entity, ply: 1, color: "w", from_sq: "e2", to_sq: "e4", promotion: null, san: "e4", draw_offer: 0 };
        try {
          if (kind === "insert") return `written ${replicated.insert("moves", move, session)}`;
          if (kind === "change") return `written ${replicated.change("moves", target, { ...move, san: "e4!" }, session)}`;
          return `written ${replicated.remove("moves", target, session)}`;
        } catch (error) {
          return `refused: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
      { kind, session, seat, entity, target },
    );

  // Before her close, the write path takes her move.
  const before = await write("insert");
  expect(before, "a move before the close is written").toMatch(/^written [0-9a-f]{32}$/);
  const moved = before.slice("written ".length);

  // She closes the game, and the close counts.
  await ui.locator("#app").evaluate((_app, s) => (window as any).dai.replicated.session.close(s), session);
  const closedAt = await ui.locator("#app").evaluate(
    (_app, s) => {
      const kit = (window as any).daiKit;
      const closed = kit.db.selectObjects("SELECT 1 FROM _dai_closed WHERE lower(hex(session)) = ?", [s]).length;
      const close = kit.db.selectObjects("SELECT seq FROM _dai_close0 WHERE lower(hex(session)) = ? AND lower(hex(replica)) = ?", [s, kit.author()])[0];
      return closed === 1 && close ? Number(close.seq) : 0;
    },
    session,
  );
  expect(closedAt, "her close counts").toBeGreaterThan(0);

  // After it, every write of hers in the game is refused, by name.
  for (const [kind, target] of [["insert", undefined], ["change", moved], ["remove", moved]] as const) {
    expect(await write(kind, target), `${kind} after her close`).toMatch(/^refused: SESSION_CLOSED\b/);
  }

  // Saved: the stored copy holds no row of hers in the game above her close.
  const uuid = (await page.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid)) as string;
  await page.evaluate(() => (window as any).__runner.exportContainer());
  const bytes = await page.evaluate(async (id) => {
    const stored: Uint8Array | null = await (window as any).__runner.loadStored(id);
    return stored ? [...stored] : null;
  }, uuid);
  expect(bytes, "a stored copy").not.toBeNull();
  const file = join(mkdtempSync(join(tmpdir(), "dai-closed-stored-")), "document.sqlite");
  writeFileSync(file, Uint8Array.from(bytes!));
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const me = (db.prepare("SELECT id FROM _dai_replica").get() as { id: Uint8Array }).id;
    const stored = (db.prepare("SELECT max(_r_seq) AS s FROM _dai_close WHERE _r_replica = ? AND lower(hex(_r_session)) = ?").get(me, session) as { s: number | null }).s;
    expect(stored, "the stored copy holds her close").toBe(closedAt);
    const above: string[] = [];
    for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]) {
      const cols = (db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes("_r_session") || !cols.includes("_r_seq")) continue;
      for (const r of db.prepare(`SELECT _r_seq AS s FROM "${name}" WHERE _r_replica = ? AND lower(hex(_r_session)) = ? AND _r_seq > ?`).all(me, session, closedAt) as { s: number }[]) {
        above.push(`${name}:${r.s}`);
      }
    }
    expect(above, "no row of hers in the game above her close").toEqual([]);
  } finally {
    db.close();
  }

  await context.close();
});
