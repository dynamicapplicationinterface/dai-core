import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";

/**
 * The seat attacks that only a page can run: the bootloader's write gates.
 *
 * The rest of the set is `tests/seat-attacks.spec.ts`, which runs on node
 * alone; this file holds the cases that go through the runtime in a document
 * frame, so it runs on every engine. A test marked test.fail is a hole still
 * open; its note names the entry whose fix flips it.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

async function openChess(page: Page): Promise<void> {
  const built = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
  const file = join(mkdtempSync(join(tmpdir(), "dai-seat-gate-")), "chess.dai.html");
  writeFileSync(file, built.html, "utf8");
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
}

test("cold review 4: a move for a seat the session does not declare is refused by the gate, not written and dropped", async ({ page }) => {
  test.slow();
  await openChess(page);
  // A session, this copy's ask for its open seat, and a move for a value its
  // creator's seat row does not declare: no seat is reseated (R14), so a value
  // outside the roster is no seat anyone can hold or wait in.
  const out = await app(page)
    .locator("#app")
    .evaluate(() => {
      const w = window as any;
      const db = w.daiKit.db;
      const r = w.dai.replicated;
      const bytes = (h: string) => w.daiKit.seatBytes(h);
      const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      const made = r.session.create();
      r.session.join(made.session, made.seat);
      const other = hex(crypto.getRandomValues(new Uint8Array(16)));
      const open = db.selectObjects("SELECT lower(hex(seat)) AS s FROM _dai_open_seat WHERE lower(hex(session)) = ?", [made.session]);
      let error = "";
      try {
        r.insert(
          "moves",
          { seat: bytes(other), game_id: "g", ply: 1, color: "b", from_sq: "e7", to_sq: "e5", promotion: null, san: "UNDECLARED", draw_offer: 0 },
          made.session,
        );
      } catch (e) {
        error = String((e as Error)?.message ?? e);
      }
      const n = (sql: string) => db.selectObjects(sql).length;
      return {
        declared: open.map((s: { s: string }) => s.s),
        seat: made.seat,
        other,
        error,
        stored: n("SELECT 1 FROM moves WHERE san = 'UNDECLARED'"),
      };
    });
  expect(out.declared, "the open seats are the ones the creator's seat row declares").toEqual([out.seat]);
  expect(out.declared).not.toContain(out.other);
  expect(out.error, "the gate refuses the move, by name").toMatch(/SEAT_NOT_HELD/);
  expect(out.stored, "and nothing is written").toBe(0);
});
