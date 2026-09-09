import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";

/**
 * Two people playing a game of chess by sending a file back and forth.
 *
 * Every other replicated-tables test holds one piece still and checks it:
 * the write rules against a fixture, the merge against a canonical dump, the
 * card against the verdict it was handed. This one holds nothing still. A
 * real application, compiled by the real compiler, opened twice in the real
 * host, driven by clicking squares — and the only claim is that the two
 * copies agree at the end.
 *
 * That is the gate sentence for Level 1, and it is worth having as an
 * end-to-end precisely because the failures it has already caught were not
 * failures of any single piece. The recipient writing rows under the sender's
 * replica id (T1-D22) was invisible to every unit test: each half was correct
 * and the pair was not. So is the shape of a card that appears on move four,
 * which no merge test can see because merging is not what is wrong.
 *
 * The application is a fixture here, not a dependency. `tests/fixture/chess`
 * is a copy, and it is allowed to be a copy that drifts: what this file tests
 * is the runtime under an application, not this application.
 */

/** The canonical table dump, computed by the test rather than by the runtime.
 *
 * `canonicalDump` would be the obvious thing to call, and it is the thing
 * under test — a comparison it computes for itself proves that it is
 * self-consistent and nothing more. So the rows come straight out of SQLite,
 * blobs hexed, ordered by the key the protocol says identifies a row.
 */
/**
 * The application's own frame.
 *
 * Two deep, and both levels are load-bearing. The host mounts its own shell
 * around the archive it verified — never the publisher's — and that shell in
 * turn puts the application in a sandboxed frame of its own. A test reaching
 * for one `iframe` finds the shell, which has no application in it.
 */
function appIn(page: Page): FrameLocator {
  return page.frameLocator("iframe").frameLocator("iframe");
}

async function dumpOf(page: Page): Promise<string> {
  return appIn(page)
    .locator("body")
    .evaluate(async (body: HTMLElement) => {
    const win = body.ownerDocument.defaultView as unknown as {
      daiKit: { db: { selectObjects(q: string): Record<string, unknown>[] } };
    };
    const out: Record<string, unknown[]> = {};
    for (const table of ["games", "moves", "game_events"]) {
      // Ordered by the key the protocol says identifies a row, so two copies
      // holding the same rows produce the same text whatever order they
      // arrived in.
      const rows = win.daiKit.db.selectObjects(
        `SELECT * FROM ${table} ORDER BY lower(hex(_r_replica)), _r_seq`,
      );
      out[table] = rows.map((row) => {
        const plain: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          plain[key] =
            value instanceof Uint8Array
              ? Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")
              : value;
        }
        return plain;
      });
    }
    return JSON.stringify(out);
  });
}

/** What the person sees: whose move it is, and the moves played so far. */
async function boardState(app: FrameLocator): Promise<{ turn: string; history: string }> {
  return {
    turn: (await app.locator("#turn-title").textContent())?.trim() ?? "",
    history: (await app.locator("#move-history").textContent())?.replace(/\s+/g, " ").trim() ?? "",
  };
}

/** Selects a square, selects another, and commits the move that results. */
async function play(app: FrameLocator, from: string, to: string): Promise<void> {
  await app.locator(`[data-square="${from}"]`).click();
  await app.locator(`[data-square="${to}"]`).click();
  await expect(app.locator("#play-move")).toBeEnabled({ timeout: 15_000 });
  await app.locator("#play-move").click();
}

/** Saves this copy out as a file, the way the Share card does. */
async function saveOut(page: Page, to: string): Promise<string> {
  /*
   * Down the download route, which is a real one: it is what a browser with no
   * `showSaveFilePicker` takes, Safari and Firefox included. The picker route
   * opens a native dialog no test can answer, and stubbing the picker to
   * succeed would be testing a stub. What matters here is the bytes that leave,
   * and both routes write the same ones.
   */
  await page.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.evaluate(() =>
    (window as unknown as { __runner: { exportContainer(): Promise<void> } }).__runner.exportContainer(),
  );
  const download = await downloading;
  writeFileSync(to, readFileSync(await download.path()));
  return to;
}

/** Opens a document for the first time on this device. */
async function firstOpen(page: Page, file: string): Promise<FrameLocator> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").waitFor({ timeout: 60_000 });
  await page.locator("#card-open").click();
  const app = appIn(page);
  await expect(app.locator("#app")).toBeVisible({ timeout: 60_000 });
  return app;
}

test.describe("a game of chess played by exchanging files", () => {
  test.slow();

  let container: string;
  let scratch: string;

  test.beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "dai-chess-"));
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(scratch, "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
  });

  test("both copies end on the same rows, and the card appears once", async ({ browser }) => {
    // Two devices, not two tabs: a merge that only works because both copies
    // share a database has not been tested at all.
    const deviceA: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const deviceB: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const appA = await firstOpen(pageA, container);

    // A starts the game and plays the first move.
    // Several New Game buttons exist across the views; the app seeds a practice
    // board, so the one in the empty state is hidden and the one under the
    // board is not.
    await appA.locator("[data-new-game]:visible").first().click();
    await appA.locator("#setup-you").fill("Ada");
    await appA.locator("#setup-them").fill("Bo");
    await appA.locator('input[name="color"][value="w"]').check();
    await appA.locator("#new-game-form button[type=submit]").click();
    await play(appA, "e2", "e4");

    const afterE4 = join(scratch, "a-e4.dai.html");
    await saveOut(pageA, afterE4);

    // B has never seen this document: the first arrival is an open, not a
    // merge, and the card is the right place for it.
    await pageB.goto(RUNNER_URL);
    await pageB.setInputFiles("#file", afterE4);
    await expect(pageB.locator("#card-open")).toBeVisible({ timeout: 60_000 });
    await expect(pageB.locator("#card-merge")).toBeHidden();
    await pageB.locator("#card-open").click();
    const appB = appIn(pageB);
    await expect(appB.locator("#app")).toBeVisible({ timeout: 60_000 });
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });

    await play(appB, "e7", "e5");
    const afterE5 = join(scratch, "b-e5.dai.html");
    await saveOut(pageB, afterE5);

    /*
     * A's first merge, and the only one it is asked about (T1-D23).
     *
     * §8.2 requires the person to choose, and a choice can be standing. The
     * first arrival asks; the answer is recorded against this document, and
     * only when the merge actually succeeded — consent to something that has
     * never worked is not a choice anybody made knowingly.
     */
    await pageA.setInputFiles("#file", afterE5);
    await expect(pageA.locator("#card-merge")).toBeVisible({ timeout: 60_000 });
    await pageA.locator("#card-merge").click();
    await expect(appA.locator("#move-history")).toContainText("e5", { timeout: 60_000 });

    await play(appA, "g1", "f3");
    const afterNf3 = join(scratch, "a-nf3.dai.html");
    await saveOut(pageA, afterNf3);

    // B's first merge: B has opened this document before but never merged, so
    // B is asked once too.
    await pageB.setInputFiles("#file", afterNf3);
    await expect(pageB.locator("#card-merge")).toBeVisible({ timeout: 60_000 });
    await pageB.locator("#card-merge").click();
    await expect(appB.locator("#move-history")).toContainText("Nf3", { timeout: 60_000 });

    await play(appB, "b8", "c6");
    const afterNc6 = join(scratch, "b-nc6.dai.html");
    await saveOut(pageB, afterNc6);

    /*
     * The fourth exchange, and the point of the ruling. A has already said yes
     * to this document; asking again is not consent, it is friction, and a
     * relay delivering moves would be unusable. No card — this one merges and
     * says so in a line.
     */
    await pageA.setInputFiles("#file", afterNc6);
    await expect(appA.locator("#move-history")).toContainText("Nc6", { timeout: 60_000 });
    await expect(pageA.locator("#card")).toBeHidden();

    // The claim. Not "both look right" — both are the same rows.
    expect(await dumpOf(pageA)).toBe(await dumpOf(pageB));

    const stateA = await boardState(appA);
    expect(await boardState(appB)).toEqual(stateA);
    expect(stateA.history).toContain("Nc6");

    await deviceA.close();
    await deviceB.close();
  });
});
