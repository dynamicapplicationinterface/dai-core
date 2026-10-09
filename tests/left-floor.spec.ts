import { mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { play } from "./chess-play.js";
import { TO_HOST } from "../src/bridge.js";
import { FRAME } from "../src/frame.js";
import { leftFloorKey, seqFloorKey } from "../src/keys.js";
import { BATCH_FORMAT_VERSION, batchIdOf, canonicalHeader } from "../src/replicated-batch.js";

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

  /** The same, from the copy this device's store holds: each own seq and the header its row names. */
  async function storedOwn(page: Page, uuid: string): Promise<Record<number, string | null>> {
    const bytes = await page.evaluate(async (id) => {
      const stored: Uint8Array | null = await (window as any).__runner.loadStored(id);
      return stored ? [...stored] : null;
    }, uuid);
    const rows: Record<number, string | null> = {};
    if (!bytes) return rows;
    const file = join(mkdtempSync(join(tmpdir(), "dai-left-stored-")), "document.sqlite");
    writeFileSync(file, Uint8Array.from(bytes));
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const me = (db.prepare("SELECT id FROM _dai_replica").get() as { id?: Uint8Array } | undefined)?.id;
      if (!me) return rows;
      for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]) {
        const cols = (db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all() as { name: string }[]).map((c) => c.name);
        if (!cols.includes("_r_seq") || !cols.includes("_r_batch")) continue;
        for (const r of db.prepare(`SELECT _r_seq s, lower(hex(_r_batch)) b FROM "${name}" WHERE _r_replica = ?`).all(me) as {
          s: number;
          b: string | null;
        }[]) {
          rows[Number(r.s)] = r.b ? String(r.b) : null;
        }
      }
    } finally {
      db.close();
    }
    return rows;
  }

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
    // frame is told it was not saved.
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
    const uuid = await uuidOf(page);
    // Every row of the game sealed, and counted by a landed save: not the first
    // save written, since a later one of the game can still be on its way.
    await expect
      .poll(
        async () => {
          const seqs = Object.entries((await own(page)).rows);
          return (
            seqs.length > 0 &&
            seqs.every(([, r]) => r.batch) &&
            (await kept(page, leftFloorKey(uuid))) === Math.max(...seqs.map(([s]) => Number(s)))
          );
        },
        { timeout: 30_000, message: "the game is signed, saved and counted" },
      )
      .toBe(true);
    const before = new Set(Object.keys((await own(page)).rows).map(Number));
    const counted = await kept(page, leftFloorKey(uuid));

    await page.evaluate(() => {
      (window as any).__loseLeft = true;
    });
    await play(ui, "e2", "e4");
    // Landed: the stored copy holds every row of the move, sealed under the
    // header the frame holds. Not the first save lost: rows written while a
    // signature was on its way are sealed by the next save.
    await expect
      .poll(
        async () => {
          const moved = await own(page);
          const move = Object.keys(moved.rows)
            .map(Number)
            .filter((s) => !before.has(s));
          const stored = await storedOwn(page, uuid);
          return (
            move.length > 0 &&
            move.every((s) => moved.rows[s]!.batch && stored[s] === moved.rows[s]!.batch) &&
            (await page.evaluate(() => Number((window as any).__leftLost ?? 0))) > 0
          );
        },
        { timeout: 30_000, message: "a save of the move landed, sealed, and was not counted" },
      )
      .toBe(true);
    const moved = await own(page);
    const move = Object.keys(moved.rows)
      .map(Number)
      .filter((s) => !before.has(s));
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

  test("a file the shell writes itself counts what it carries: after a lost save, a sign over a seq in it is refused", async ({
    browser,
  }) => {
    /*
     * D173. A save races a sign, and the save is lost: the frame holds a header
     * the store never did. The shell writes the frame's bytes to a file itself
     * (a download here; a picker save asks the same `LEAVE_CHECK`), and the
     * file leaves the device carrying that header. A re-seal over one of its
     * seqs would be a second header over a seq that left, so the host refuses
     * it (docs/format.md, `floor`): every route by which bytes leave raises the
     * left floor before they leave.
     */
    const context = await browser.newContext({ acceptDownloads: true });
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
    const page = await context.newPage();
    const ui = await openWith(page, container);
    await newGame(ui, "Ada", "Bo");
    const uuid = await uuidOf(page);
    await expect
      .poll(
        async () => {
          const seqs = Object.entries((await own(page)).rows);
          return (
            seqs.length > 0 &&
            seqs.every(([, r]) => r.batch) &&
            (await kept(page, leftFloorKey(uuid))) === Math.max(...seqs.map(([s]) => Number(s)))
          );
        },
        { timeout: 30_000, message: "the game is signed, saved and counted" },
      )
      .toBe(true);
    const landed = new Set(Object.keys((await own(page)).rows).map(Number));

    await page.evaluate(() => {
      (window as any).__loseSaves = true;
    });
    await play(ui, "e2", "e4");
    await expect
      .poll(
        async () => {
          const now = await own(page);
          const fresh = Object.keys(now.rows).map(Number).filter((s) => !landed.has(s));
          return fresh.length > 0 && fresh.every((s) => now.rows[s]!.batch);
        },
        { timeout: 30_000, message: "the move is signed" },
      )
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => Number((window as any).__savesLost)), { timeout: 30_000, message: "the save of it is lost" })
      .toBeGreaterThan(0);
    const signed = Math.max(...Object.keys((await own(page)).rows).map(Number));
    expect(await kept(page, leftFloorKey(uuid)), "no save landed to count the move").toBe(Math.max(...landed));

    // The shell writes the file itself: the frame's bytes, the move's header in them.
    const downloading = page.waitForEvent("download", { timeout: 60_000 });
    await ui.locator("#app").evaluate(async () => {
      const win = window as any;
      const result = await win.dai.saveDatabase(win.daiKit.db, { method: "download" });
      if (!result?.saved) throw new Error(`the file was not written: ${JSON.stringify(result)}`);
    });
    await downloading;

    expect(await ask(page, await headerOver(page, [["moves", signed]]), signed), "a seq in the written file").toMatch(
      /^refused: .*already sent/,
    );

    await context.close();
  });

  /*
   * What leaves (D181). The host keeps the id of every header of the person's
   * that has left, beside the left floor: a header over a seq at or below the
   * floor leaves only if that very header left before, and no leave carries
   * two of the person's headers over one seq. The document's code asks for
   * the signatures here the way any document's code can, and writes the
   * headers into its own copy.
   */

  /** The host's signature over `header`, asked from the document's own code, or why it would not sign. */
  const signOver = (page: Page, header: Uint8Array): Promise<{ sig?: number[]; pub?: number[]; error?: string }> =>
    app(page)
      .locator("#app")
      .evaluate(
        (_app, { bytes, names }) =>
          new Promise((done) => {
            const id = `leave-${Math.random().toString(36).slice(2)}`;
            window.addEventListener("message", (event) => {
              const data = (event.data ?? {}) as any;
              if (data.type !== names.signed || data.id !== id) return;
              done(data.sig ? { sig: [...data.sig], pub: [...data.pub] } : { error: String(data.error ?? "") });
            });
            window.parent.postMessage({ type: names.sign, id, header: Uint8Array.from(bytes), seq: 1 }, "*");
          }),
        { bytes: [...header], names: { sign: FRAME.SIGN, signed: FRAME.SIGNED } },
      );

  type Held = { id: number[]; hex: string; author: number[]; seq: number; fill: number; sig: number[]; pub: number[] };

  /** A header of this device's over `seq` with its own digest, signed by the host while `seq` is above the left floor, and held. */
  async function signedHeader(page: Page, seq: number, fill: number): Promise<Held> {
    const author = new Uint8Array(Buffer.from((await page.evaluate(() => (window as any).__runner.authorId())) as string, "base64url"));
    const header = canonicalHeader({ version: BATCH_FORMAT_VERSION, document: await uuidOf(page), author, lc: seq, digest: new Uint8Array(32).fill(fill), covers: [["moves", seq]] });
    const signed = await signOver(page, header);
    expect(signed.error, `the host signs a header over ${seq}, above the left floor`).toBeUndefined();
    const id = [...(await batchIdOf(header))];
    return { id, hex: Buffer.from(id).toString("hex"), author: [...author], seq, fill, sig: signed.sig!, pub: signed.pub! };
  }

  /** Writes a held header into the open copy, as the document's code can. */
  const insertHeader = (page: Page, held: Held): Promise<void> =>
    app(page)
      .locator("#app")
      .evaluate(
        (_app, { held, version }) => {
          (window as any).daiKit.db.exec({
            sql: "INSERT INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
            bind: [
              Uint8Array.from(held.id),
              Uint8Array.from(held.author),
              held.seq,
              Uint8Array.from(held.sig),
              Uint8Array.from(held.pub),
              version,
              new Uint8Array(32).fill(held.fill),
              JSON.stringify([["moves", held.seq]]),
            ],
          });
        },
        { held, version: BATCH_FORMAT_VERSION },
      );

  /** The open copy written to a file by the shell itself (the host's LEAVE_CHECK first): "written", or why not. */
  const writeFile = (page: Page): Promise<string> =>
    app(page)
      .locator("#app")
      .evaluate(async () => {
        const win = window as any;
        try {
          const result = await win.dai.saveDatabase(win.daiKit.db, { method: "download" });
          return result?.saved ? "written" : `refused: ${String(result?.error ?? JSON.stringify(result))}`;
        } catch (error) {
          return `refused: ${error instanceof Error ? error.message : String(error)}`;
        }
      });

  /** The ids of the headers of this device's the stored copy holds, hex. */
  async function storedHeaders(page: Page, uuid: string): Promise<string[]> {
    const bytes = await page.evaluate(async (id) => {
      const stored: Uint8Array | null = await (window as any).__runner.loadStored(id);
      return stored ? [...stored] : null;
    }, uuid);
    if (!bytes) return [];
    const file = join(mkdtempSync(join(tmpdir(), "dai-left-stored-")), "document.sqlite");
    writeFileSync(file, Uint8Array.from(bytes));
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const me = (db.prepare("SELECT id FROM _dai_replica").get() as { id?: Uint8Array } | undefined)?.id;
      if (!me) return [];
      return (db.prepare("SELECT lower(hex(id)) AS h FROM _dai_batch WHERE author = ?").all(me) as { h: string }[]).map((r) => r.h);
    } finally {
      db.close();
    }
  }

  /** A game of Ada's, every row signed, saved and counted: the left floor where it stands. */
  async function countedGame(page: Page): Promise<number> {
    const ui = await openWith(page, container);
    await newGame(ui, "Ada", "Bo");
    const uuid = await uuidOf(page);
    await expect
      .poll(
        async () => {
          const seqs = Object.entries((await own(page)).rows);
          return (
            seqs.length > 0 &&
            seqs.every(([, r]) => r.batch) &&
            (await kept(page, leftFloorKey(uuid))) === Math.max(...seqs.map(([s]) => Number(s)))
          );
        },
        { timeout: 30_000, message: "the game is signed, saved and counted" },
      )
      .toBe(true);
    return kept(page, leftFloorKey(uuid));
  }

  test("a header held while the floor passed its seq does not leave", async ({ browser }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const floor = await countedGame(page);
    const uuid = await uuidOf(page);
    const n = floor + 1;

    // Signed over n while n was above the floor, and held.
    const held = await signedHeader(page, n, 1);
    // Another header, over n + 1, leaves in a file: the floor passes n.
    await insertHeader(page, await signedHeader(page, n + 1, 2));
    expect(await writeFile(page), "a header over a seq above the floor leaves").toBe("written");
    expect(await kept(page, leftFloorKey(uuid)), "the file counted what it carried").toBe(n + 1);

    // The held header, written into the copy: over a seq at or below the
    // floor, and never left. A save does not land it in this device's store
    // (a save is asked by the export's flush), and a file does not carry it.
    await insertHeader(page, held);
    await page.evaluate(() => (window as any).__runner.exportContainer());
    expect(await storedHeaders(page, uuid), "the stored copy does not hold it").not.toContain(held.hex);
    expect(await writeFile(page), "a header over a seq that left, which itself never left").toMatch(/^refused: .*already sent/);
    expect(await kept(page, leftFloorKey(uuid)), "a refused leave counts nothing").toBe(n + 1);

    await context.close();
  });

  test("two of the person's headers over one seq do not leave together, by save or by file", async ({ browser }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const floor = await countedGame(page);
    const uuid = await uuidOf(page);
    const n = floor + 1;

    const first = await signedHeader(page, n, 1);
    const second = await signedHeader(page, n, 2);
    await insertHeader(page, first);
    await insertHeader(page, second);
    await page.evaluate(() => (window as any).__runner.exportContainer());
    const stored = await storedHeaders(page, uuid);
    expect([first.hex, second.hex].filter((id) => stored.includes(id)), "a save does not land them in this device's store").toEqual([]);
    expect(await writeFile(page), "a file carrying two headers of the person's over one seq").toMatch(/^refused: .*two different changes/);
    expect(await kept(page, leftFloorKey(uuid)), "a refused leave counts nothing").toBe(floor);

    await context.close();
  });

  test("a re-seal after a lost save leaves, and so does every file after it", async ({ browser }) => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const floor = await countedGame(page);
    const uuid = await uuidOf(page);
    const n = floor + 1;

    // The first seal over n never left (its save was lost), so a second header
    // over n is an honest re-seal (floor-honest-reseal).
    await signedHeader(page, n, 1);
    const resealed = await signedHeader(page, n, 2);
    await insertHeader(page, resealed);
    await page.evaluate(() => (window as any).__runner.exportContainer());
    expect(await storedHeaders(page, uuid), "a save lands the re-seal").toContain(resealed.hex);
    expect(await kept(page, leftFloorKey(uuid)), "and counts it").toBe(n);
    // Over a seq at the floor now, and it left: it leaves again, in a file.
    expect(await writeFile(page), "a header that left leaves again").toBe("written");

    await context.close();
  });
});
