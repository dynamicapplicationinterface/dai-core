import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { play } from "./chess-play.js";
import { HINT_KEY } from "../src/link.js";
import { TO_HOST } from "../src/bridge.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * A device never issues the same `(author, seq)` twice for one document
 * (docs/identity.md; cold review of step 2, findings #1 and #3).
 *
 * The author id is the device's key, so it outlives any one copy: a copy can
 * be removed and received again, or reopened from a save older than what the
 * device already sent. Whatever copy is open, the next row this device writes
 * takes a seq above every seq the device ever let leave it. The host keeps a
 * high-water mark per document beside the person key, raised before a save is
 * written and before a batch is published, and hands it to the frame as the
 * floor; the frame holds its seq at or above it on every write.
 *
 * A seq that never left the device (written, then lost before any save or
 * publish) may be issued again: nobody else ever saw it.
 */
test.describe("one (author, seq) per row, whatever copy is open", () => {
  test.slow();

  let container: string;
  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-seq-floor-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
  });

  async function openWith(page: Page, file: string): Promise<FrameLocator> {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").waitFor({ timeout: 60_000 });
    await page.locator("#card-open").click();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    return app(page);
  }

  async function saveOut(page: Page, to: string): Promise<void> {
    await page.evaluate(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const dl = page.waitForEvent("download", { timeout: 60_000 });
    await page.evaluate(() =>
      (window as unknown as { __runner: { exportContainer(): Promise<void> } }).__runner.exportContainer(),
    );
    writeFileSync(to, readFileSync(await (await dl).path()));
  }

  async function newGame(ui: FrameLocator, you: string, them: string): Promise<void> {
    await ui.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
    await ui.locator("#setup-you").fill(you);
    await ui.locator("#setup-them").fill(them);
    await ui.locator('input[name="color"][value="w"]').check();
    await ui.locator("#new-game-form button[type=submit]").click();
  }

  /** Every row this copy holds under its own current id, as `table:seq`, with the seqs. */
  const ownRows = (page: Page): Promise<{ key: string; seq: number }[]> =>
    app(page)
      .locator("#app")
      .evaluate(() => {
        const db = (window as any).daiKit.db;
        const me = db.selectObjects("SELECT id FROM _dai_replica")[0]?.id;
        if (!me) return [];
        const tables = db
          .selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")
          .map((r: any) => String(r.name))
          .filter((name: string) => {
            const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => c.name);
            return cols.includes("_r_replica") && cols.includes("_r_seq");
          });
        const rows: { key: string; seq: number }[] = [];
        for (const t of tables) {
          for (const r of db.selectObjects(`SELECT _r_seq s FROM "${t}" WHERE _r_replica = ?`, [me])) {
            rows.push({ key: `${t}:${r.s}`, seq: Number(r.s) });
          }
        }
        return rows;
      });

  const savesWritten = (page: Page): Promise<number> =>
    page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0));

  test("removed and received again: the next row is above everything this device already saved", async ({
    browser,
  }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    // An early copy, with this device's first rows in it.
    const ui = await openWith(page, container);
    await newGame(ui, "Ada", "Bo");
    await play(ui, "e2", "e4");
    const seed = join(dirname(container), "seq-floor-seed.dai.html");
    await saveOut(page, seed);
    const inSeed = await ownRows(page);

    // More rows, and a save that writes them: now they have left the page.
    const before = await savesWritten(page);
    await newGame(ui, "Ada", "Cy");
    await expect.poll(() => savesWritten(page), { timeout: 30_000 }).toBeGreaterThan(before);
    const highest = Math.max(...(await ownRows(page)).map((r) => r.seq));
    expect(highest, "the second game wrote rows past the seed").toBeGreaterThan(Math.max(...inSeed.map((r) => r.seq)));

    // Removed from this device, then the early copy arrives again.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.click("#more");
    await page.click("#remove");
    await expect(page.locator("body")).not.toHaveClass(/loaded/, { timeout: 30_000 });
    const again = await openWith(page, seed);
    const held = new Set((await ownRows(page)).map((r) => r.key));

    // The next row this device writes.
    await newGame(again, "Ada", "Di");
    await expect.poll(async () => (await ownRows(page)).filter((r) => !held.has(r.key)).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const written = (await ownRows(page)).filter((r) => !held.has(r.key)).map((r) => r.seq);
    expect(Math.min(...written), `new rows ${written} must be above ${highest}, the highest already saved`).toBeGreaterThan(
      highest,
    );

    await context.close();
  });

  test("an application that rewinds _dai_replica.seq does not rewind the next row", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const ui = await openWith(page, container);
    await newGame(ui, "Ada", "Bo");
    await play(ui, "e2", "e4");
    const highest = Math.max(...(await ownRows(page)).map((r) => r.seq));
    const held = new Set((await ownRows(page)).map((r) => r.key));

    // The application holds the database, and rewinds the counter.
    await app(page)
      .locator("#app")
      .evaluate(() => (window as any).daiKit.db.exec("UPDATE _dai_replica SET seq = 0"));

    await newGame(ui, "Ada", "Cy");
    await expect
      .poll(async () => (await ownRows(page)).filter((r) => !held.has(r.key)).length, {
        timeout: 30_000,
        // How a rewound counter shows itself: the next row reissues a seq this
        // copy already holds, and the write surface refuses it, so nothing lands.
        message: "the write after the rewind landed (a rewound seq reissues one this copy holds, and is refused)",
      })
      .toBeGreaterThan(0);
    const written = (await ownRows(page)).filter((r) => !held.has(r.key)).map((r) => r.seq);
    expect(Math.min(...written), `new rows ${written} must be above ${highest}`).toBeGreaterThan(highest);

    await context.close();
  });

  /** This copy's own rows by seq: the row's content, and whether a header covers it. */
  const ownBySeq = (page: Page): Promise<Record<number, { row: string; signed: boolean }>> =>
    app(page)
      .locator("#app")
      .evaluate(() => {
        const db = (window as any).daiKit.db;
        const me = db.selectObjects("SELECT id FROM _dai_replica")[0]?.id;
        const out: Record<number, { row: string; signed: boolean }> = {};
        if (!me) return out;
        for (const { name } of db.selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")) {
          const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => String(c.name));
          if (!cols.includes("_r_seq") || !cols.includes("_r_batch")) continue;
          for (const r of db.selectObjects(`SELECT * FROM "${name}" WHERE _r_replica = ?`, [me])) {
            const content = cols
              .filter((c: string) => !c.startsWith("_r_"))
              .map((c: string) => (r[c] instanceof Uint8Array ? Array.from(r[c] as Uint8Array).join(".") : String(r[c])));
            out[Number(r._r_seq)] = { row: `${name}:${content.join("|")}`, signed: r._r_batch != null };
          }
        }
        return out;
      });

  /** Makes the store refuse every save of a document's database: the file system, and the fallback. */
  const refuseSaves = (): void => {
    const w = window as any;
    if (typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype) {
      (FileSystemFileHandle.prototype as any).createWritable = () => Promise.reject(new Error("test: the disk refused"));
    }
    w.__keptPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: any[]) {
      if (this.name === "sqlite_databases") throw new DOMException("test: the disk refused", "QuotaExceededError");
      return w.__keptPut.apply(this, args);
    } as any;
  };

  /** Seqs in `rows` not in `held`, signed or not. */
  const newSeqs = (rows: Record<number, { signed: boolean }>, held: Set<number>, signed?: boolean): number[] =>
    Object.keys(rows)
      .map(Number)
      .filter((s) => !held.has(s) && (signed === undefined || rows[s]!.signed === signed));

  /** A first tab with a game saved, and the document's id. */
  async function firstTab(context: import("@playwright/test").BrowserContext): Promise<{ page: Page; uuid: string }> {
    const page = await context.newPage();
    const ui = await openWith(page, container);
    await newGame(ui, "Ada", "Bo");
    await expect
      .poll(async () => Object.values(await ownBySeq(page)).every((r) => r.signed) && (await savesWritten(page)) > 0, {
        timeout: 30_000,
        message: "the first game is signed and saved",
      })
      .toBe(true);
    return { page, uuid: await page.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid as string) };
  }

  async function secondTab(context: import("@playwright/test").BrowserContext, uuid: string, saves: "refused" | "kept"): Promise<Page> {
    const page = await context.newPage();
    if (saves === "refused") await page.addInitScript(refuseSaves);
    await page.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    return page;
  }

  test("two tabs on one held copy, by the floor alone: the tab written past signs nothing, says so, and writes above once reopened", async ({
    browser,
  }) => {
    // D105: both tabs stamp rows under this device's one author from one
    // counter. The second tab's store refuses its saves, so no save moves the
    // revision and only the floor can tell the tabs apart.
    const context = await browser.newContext();
    const { page: first, uuid } = await firstTab(context);
    const second = await secondTab(context, uuid, "refused");
    const held = new Set(Object.keys(await ownBySeq(first)).map(Number));
    expect(new Set(Object.keys(await ownBySeq(second)).map(Number)), "both tabs start from one copy").toEqual(held);

    // The second tab writes and signs first; its save never lands.
    await newGame(app(second), "Ada", "Di");
    await expect
      .poll(async () => newSeqs(await ownBySeq(second), held, true).length, { timeout: 30_000, message: "the second tab's game is signed" })
      .toBeGreaterThan(0);
    const signedThere = newSeqs(await ownBySeq(second), held, true);

    // The first tab writes the same seqs and signs none of them, and is told.
    await newGame(app(first), "Ada", "Cy");
    await expect(first.locator("#save-state")).toHaveAttribute("title", /written from another tab/, { timeout: 30_000 });
    const one = await ownBySeq(first);
    const two = await ownBySeq(second);
    expect(newSeqs(one, held).length, "the first tab wrote its game").toBeGreaterThan(0);
    expect(newSeqs(one, held, true), "the first tab signed nothing").toEqual([]);
    expect(
      Object.keys(one).map(Number).filter((s) => one[s]!.signed && two[s]?.signed && one[s]!.row !== two[s]!.row),
      "no seq is signed in both tabs with different rows",
    ).toEqual([]);

    // Reopened, it writes above every seq signed on this device.
    await first.reload();
    await expect(app(first).locator("#app")).toBeVisible({ timeout: 60_000 });
    const before = new Set(Object.keys(await ownBySeq(first)).map(Number));
    await newGame(app(first), "Ada", "Cy");
    await expect
      .poll(async () => newSeqs(await ownBySeq(first), before, true).length, { timeout: 30_000, message: "the reopened tab's game is signed" })
      .toBeGreaterThan(0);
    const after = newSeqs(await ownBySeq(first), before);
    expect(Math.min(...after), `rows ${after} are above ${signedThere}`).toBeGreaterThan(Math.max(...signedThere));

    await context.close();
  });

  test("two tabs on one held copy: a tab another tab has saved past signs nothing, and the other goes on", async ({ browser }) => {
    // D105 with D41: the second tab's save on opening moves the revision
    // before it writes anything, so the floor has not moved. The first tab,
    // which may no longer save, may no longer sign either; were it to sign,
    // its seqs would stop the second tab signing too, and neither could keep
    // anything.
    const context = await browser.newContext();
    const { page: first, uuid } = await firstTab(context);
    const saved = await savesWritten(first);
    const second = await secondTab(context, uuid, "kept");
    await expect.poll(() => savesWritten(second), { timeout: 30_000, message: "the second tab saved on opening" }).toBeGreaterThan(0);
    const held = new Set(Object.keys(await ownBySeq(first)).map(Number));

    await newGame(app(first), "Ada", "Cy");
    await expect(first.locator("#save-state")).toHaveAttribute("title", /written from another tab/, { timeout: 30_000 });
    const one = await ownBySeq(first);
    expect(newSeqs(one, held).length, "the first tab wrote its game").toBeGreaterThan(0);
    expect(newSeqs(one, held, true), "the first tab signed nothing").toEqual([]);
    expect(await savesWritten(first), "and saved nothing").toBe(saved);

    const secondSaved = await savesWritten(second);
    await newGame(app(second), "Ada", "Di");
    await expect
      .poll(async () => newSeqs(await ownBySeq(second), held, true).length > 0 && (await savesWritten(second)) > secondSaved, {
        timeout: 30_000,
        message: "the second tab's game is signed and saved",
      })
      .toBe(true);

    await context.close();
  });

  test("a signed batch whose save never lands: the next row is above it", async ({ browser }) => {
    // D109. A batch leaves only after the save holding it lands (see
    // publish-after-landed), and the floor is claimed before it is signed, so
    // no route can carry a seq the floor has not counted. Held here at the
    // sign alone: every save is lost before the host sees it, so neither a
    // save nor a publish counts the move, and the page is reloaded.
    const context = await browser.newContext();
    // Registered before the host's own listener, so it runs first, and armed
    // only once the first game has landed.
    await context.addInitScript((save) => {
      const w = window as any;
      w.__savesLost = 0;
      window.addEventListener("message", (event) => {
        if (!w.__loseSaves || (event.data as any)?.type !== save) return;
        w.__savesLost += 1;
        event.stopImmediatePropagation();
      });
    }, TO_HOST.SAVE);
    const { page } = await firstTab(context);
    const landed = new Set(Object.keys(await ownBySeq(page)).map(Number));

    await page.evaluate(() => {
      (window as any).__loseSaves = true;
    });
    // Every save asked before this has been written: none is still in flight.
    const asked = async (): Promise<number> => page.evaluate(() => Number((window as any).__runner.saves ?? 0));
    await expect.poll(async () => (await asked()) === (await savesWritten(page)), { timeout: 30_000 }).toBe(true);
    const askedBefore = await asked();
    await play(app(page), "e2", "e4");
    await expect
      .poll(async () => newSeqs(await ownBySeq(page), landed, true).length, { timeout: 30_000, message: "the move is signed" })
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => Number((window as any).__savesLost)), { timeout: 30_000, message: "the save of it is lost" })
      .toBeGreaterThan(0);
    expect(await asked(), "the host never saw it").toBe(askedBefore);
    const signed = Math.max(...Object.keys(await ownBySeq(page)).map(Number));

    // Lost: the page goes, and the copy reopens from the last save that landed.
    await page.reload();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    const reopened = new Set(Object.keys(await ownBySeq(page)).map(Number));
    expect(reopened.has(signed), `seq ${signed} was never saved, so the reopened copy lacks it`).toBe(false);

    await newGame(app(page), "Ada", "Cy");
    await expect
      .poll(async () => Object.keys(await ownBySeq(page)).filter((s) => !reopened.has(Number(s))).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const written = Object.keys(await ownBySeq(page)).map(Number).filter((s) => !reopened.has(s));
    expect(Math.min(...written), `new rows ${written} must be above ${signed}, which was signed`).toBeGreaterThan(signed);

    await context.close();
  });
});
