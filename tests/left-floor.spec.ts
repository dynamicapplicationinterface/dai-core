import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { play } from "./chess-play.js";
import { FRAME } from "../src/frame.js";
import { leftFloorKey, seqFloorKey } from "../src/keys.js";
import { BATCH_FORMAT_VERSION, canonicalHeader } from "../src/replicated-batch.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * The host signs only rows above the floor (docs/format.md, `floor`; the step
 * 6 review, Pass 1).
 *
 * Two marks, both beside the person key. The sequence floor counts every seq
 * this device has issued a row at, so a new row is never issued at one again;
 * it is claimed from the seqs a header lists, read by the host from the header
 * it signs, never from the number the frame sends with it. The left floor is
 * the highest seq a header of this device's lists in bytes the host saw land in
 * its store or published, and the host signs no header listing a seq at or
 * below it: those headers could have left, and a second one over one of their
 * seqs is the author signing twice (`equivocation`). A seal of rows a save held
 * pending, or a re-seal after a lost save, lists seqs the sequence floor counts
 * and the left floor does not, and is signed.
 *
 * The document's code is the frame's, so it asks here the way any document's
 * code can: its own sign message.
 */
test.describe("the floor a sign is held to", () => {
  test.slow();

  let container: string;
  test.beforeAll(async () => {
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-left-floor-")), "velvet-chess.dai.html");
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

  async function newGame(ui: FrameLocator, you: string, them: string): Promise<void> {
    await ui.locator("[data-new-game]:visible").first().click({ timeout: 60_000 });
    await ui.locator("#setup-you").fill(you);
    await ui.locator("#setup-them").fill(them);
    await ui.locator('input[name="color"][value="w"]').check();
    await ui.locator("#new-game-form button[type=submit]").click();
  }

  /** This copy's own rows by seq, and the ids of the headers of its own that list each. */
  const own = (
    page: Page,
  ): Promise<{ rows: Record<number, { batch: string | null }>; listedBy: Record<number, string[]> }> =>
    app(page)
      .locator("#app")
      .evaluate(() => {
        const db = (window as any).daiKit.db;
        const me = db.selectObjects("SELECT id FROM _dai_replica")[0]?.id;
        const rows: Record<number, { batch: string | null }> = {};
        const listedBy: Record<number, string[]> = {};
        if (!me) return { rows, listedBy };
        for (const { name } of db.selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")) {
          const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => String(c.name));
          if (!cols.includes("_r_seq") || !cols.includes("_r_batch")) continue;
          for (const r of db.selectObjects(`SELECT _r_seq s, lower(hex(_r_batch)) b FROM "${name}" WHERE _r_replica = ?`, [me])) {
            rows[Number(r.s)] = { batch: r.b ? String(r.b) : null };
          }
        }
        for (const h of db.selectObjects("SELECT lower(hex(id)) id, covers FROM _dai_batch WHERE author = ?", [me])) {
          for (const [, seq] of JSON.parse(String(h.covers)) as [string, number][]) {
            (listedBy[seq] ??= []).push(String(h.id));
          }
        }
        return { rows, listedBy };
      });

  const savesWritten = (page: Page): Promise<number> =>
    page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0));

  const uuidOf = (page: Page): Promise<string> =>
    page.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid as string);

  /** A number kept in the host's key store, read the way the host reads it. */
  const kept = (page: Page, key: string): Promise<number> =>
    page.evaluate(
      (name) =>
        new Promise<number>((done, fail) => {
          const open = indexedDB.open("dai_runner_storage");
          open.onerror = () => fail(open.error);
          open.onsuccess = () => {
            const read = open.result.transaction("keys", "readonly").objectStore("keys").get(name);
            read.onsuccess = () => done(typeof read.result === "number" ? read.result : 0);
            read.onerror = () => fail(read.error);
          };
        }),
      key,
    );

  /** Asks the host, from the document's own code, to sign `header`, sending `seq` with it as the frame does. */
  const ask = (page: Page, header: Uint8Array, seq: number): Promise<string> =>
    app(page)
      .locator("#app")
      .evaluate(
        (_app, { bytes, seq, names }) =>
          new Promise<string>((done) => {
            const id = `left-${Math.random().toString(36).slice(2)}`;
            window.addEventListener("message", (event) => {
              const data = (event.data ?? {}) as { type?: string; id?: string; sig?: unknown; error?: string };
              if (data.type !== names.signed || data.id !== id) return;
              done(data.sig ? "signed" : `refused: ${data.error ?? ""}`);
            });
            window.parent.postMessage({ type: names.sign, id, header: Uint8Array.from(bytes), seq }, "*");
          }),
        { bytes: [...header], seq, names: { sign: FRAME.SIGN, signed: FRAME.SIGNED } },
      );

  /** A header of this device's author for the open document, well formed in every way but what it lists. */
  async function headerOver(page: Page, covers: [string, number][]): Promise<Uint8Array> {
    const author = Buffer.from((await page.evaluate(() => (window as any).__runner.authorId())) as string, "base64url");
    return canonicalHeader({
      version: BATCH_FORMAT_VERSION,
      document: await uuidOf(page),
      author: new Uint8Array(author),
      lc: 1,
      digest: new Uint8Array(32).fill(9),
      covers,
    });
  }

  test("a header over a seq that has left is not signed, and the sequence floor is claimed from what a header lists", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const ui = await openWith(page, container);
    await newGame(ui, "Ada", "Bo");
    await expect
      .poll(async () => Object.values((await own(page)).rows).every((r) => r.batch) && (await savesWritten(page)) > 0, {
        timeout: 30_000,
        message: "the game is signed and saved",
      })
      .toBe(true);
    const uuid = await uuidOf(page);
    const sealed = Math.max(...Object.keys((await own(page)).rows).map(Number));
    await expect
      .poll(() => kept(page, leftFloorKey(uuid)), { timeout: 30_000, message: "the landed save counts what it holds" })
      .toBe(sealed);

    // A seq that left, whatever number the frame sends beside it.
    expect(await ask(page, await headerOver(page, [["moves", sealed]]), sealed + 100), "a seq that left").toMatch(
      /^refused: .*already sent/,
    );
    // A seq listed twice, in two tables: not a list (covers-spelling).
    expect(
      await ask(page, await headerOver(page, [["games", sealed + 20], ["moves", sealed + 20]]), sealed + 20),
      "one seq in two tables",
    ).toMatch(/^refused/);

    // Above it, signed; the floor counts the listed seq, not the frame's 1.
    const above = sealed + 50;
    expect(await ask(page, await headerOver(page, [["moves", above]]), 1)).toBe("signed");
    expect(await kept(page, seqFloorKey(uuid)), "the sequence floor counts what the header listed").toBe(above);
    expect(await kept(page, leftFloorKey(uuid)), "a sign alone moves nothing that has left").toBe(sealed);

    await context.close();
  });

  test("a save that lands and is not counted: after a relaunch nothing is re-sealed, and the stored copy is counted", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    // The left floor's write fails on demand, standing in for the page going
    // between the store's write and the count: the save has landed, and the
    // frame is never told so.
    await context.addInitScript((prefix) => {
      const w = window as any;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: any[]) {
        if (w.__loseLeft && typeof args[1] === "string" && args[1].startsWith(prefix)) {
          w.__leftLost = (w.__leftLost ?? 0) + 1;
          throw new DOMException("test: the page went", "AbortError");
        }
        return put.apply(this, args as any);
      } as any;
    }, leftFloorKey(""));
    const page = await context.newPage();
    const ui = await openWith(page, container);
    await newGame(ui, "Ada", "Bo");
    await expect
      .poll(async () => Object.values((await own(page)).rows).every((r) => r.batch) && (await savesWritten(page)) > 0, {
        timeout: 30_000,
        message: "the game is signed and saved",
      })
      .toBe(true);
    const uuid = await uuidOf(page);
    const before = new Set(Object.keys((await own(page)).rows).map(Number));
    const counted = await kept(page, leftFloorKey(uuid));

    await page.evaluate(() => {
      (window as any).__loseLeft = true;
    });
    await play(ui, "e2", "e4");
    await expect
      .poll(() => page.evaluate(() => Number((window as any).__leftLost ?? 0)), {
        timeout: 30_000,
        message: "a save of the move landed and was not counted",
      })
      .toBeGreaterThan(0);
    // Landed: the stored copy holds the move, sealed.
    const stored = await page.evaluate(async (id) => {
      const bytes: Uint8Array | null = await (window as any).__runner.loadStored(id);
      return bytes ? bytes.byteLength : 0;
    }, uuid);
    expect(stored, "the stored copy is there").toBeGreaterThan(0);
    const moved = await own(page);
    const move = Object.keys(moved.rows)
      .map(Number)
      .filter((s) => !before.has(s));
    expect(move.length, "the move wrote rows").toBeGreaterThan(0);
    expect(move.every((s) => moved.rows[s]!.batch), "and sealed them").toBe(true);
    expect(await kept(page, leftFloorKey(uuid)), "nothing counted them").toBe(counted);

    // The page goes, and comes back to the stored copy.
    await page.reload();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    const back = await own(page);
    expect(
      move.filter((s) => back.rows[s]?.batch !== moved.rows[s]!.batch),
      "the move is in the stored copy under the header it was sealed with",
    ).toEqual([]);
    await expect
      .poll(() => kept(page, leftFloorKey(uuid)), { timeout: 30_000, message: "the mount counts the stored copy" })
      .toBe(Math.max(...move));

    // Written on: only pending rows are sealed, so no seq is listed twice.
    const held = new Set(Object.keys(back.rows).map(Number));
    await newGame(app(page), "Ada", "Cy");
    await expect
      .poll(
        async () => {
          const now = await own(page);
          const fresh = Object.keys(now.rows).map(Number).filter((s) => !held.has(s));
          return fresh.length > 0 && fresh.every((s) => now.rows[s]!.batch);
        },
        { timeout: 30_000, message: "the next game is signed" },
      )
      .toBe(true);
    const after = await own(page);
    expect(
      Object.entries(after.listedBy).filter(([, ids]) => new Set(ids).size > 1),
      "no seq of this device's is listed by two of its headers",
    ).toEqual([]);

    await context.close();
  });
});
