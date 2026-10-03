import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { authorIdOf, showAuthorId, verifySignature } from "../src/identity.js";
import { canonicalHeader, rowsDigest, type BatchEntry } from "../src/replicated-batch.js";
import { TO_DOCUMENT, TO_HOST } from "../src/bridge.js";
import { FRAME_INTERNAL } from "../src/frame.js";
import { decode } from "../src/cbor.js";
import { pick, play } from "./chess-play.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/** How many rows of this device's own are still pending (no `_r_batch`), read in the frame. */
const pendingOwn = (ui: FrameLocator): Promise<number> =>
  ui.locator("#app").evaluate(() => {
    const db = (window as any).daiKit.db;
    const me = db.selectObjects("SELECT id FROM _dai_replica")[0].id;
    let n = 0;
    for (const { name } of db.selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")) {
      const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => c.name);
      if (cols.includes("_r_batch") && cols.includes("_r_replica")) {
        n += Number(db.selectObjects(`SELECT count(*) AS n FROM "${name}" WHERE _r_replica = ? AND _r_batch IS NULL`, [me])[0].n);
      }
    }
    return n;
  });

/**
 * This device's own rows, read in the frame: its replica id, the highest seq it
 * holds, and the rows still pending as `[table, seq]`, the shape a header's
 * `covers` lists them in.
 */
const ownRows = (ui: FrameLocator): Promise<{ me: string; top: number; pending: [string, number][] }> =>
  ui.locator("#app").evaluate(() => {
    const db = (window as any).daiKit.db;
    const me = db.selectObjects("SELECT lower(hex(id)) AS h, id FROM _dai_replica")[0];
    let top = 0;
    const pending: [string, number][] = [];
    if (!me) return { me: "", top, pending };
    for (const { name } of db.selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")) {
      const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => c.name);
      if (!cols.includes("_r_batch") || !cols.includes("_r_replica")) continue;
      for (const row of db.selectObjects(`SELECT _r_seq AS seq, _r_batch IS NULL AS open FROM "${name}" WHERE _r_replica = ?`, [me.id])) {
        top = Math.max(top, Number(row.seq));
        if (row.open) pending.push([name, Number(row.seq)]);
      }
    }
    return { me: String(me.h), top, pending };
  });

/**
 * What leaves the device is signed (docs/identity.md, step 3: seal on leave).
 *
 * The real runtime, the real host key: a person plays a move, the document
 * saves, and what the save holds is checked from outside the page with the
 * library's own canonical functions. No own row is still pending, every header's
 * digest is its rows, every signature verifies, and the key it verifies under
 * fingerprints to the author, which is this device's host key.
 */
test("a saved document's rows are sealed, and every batch verifies under this device's key", async ({ page }) => {
  test.slow();
  const built = await compileDirectory({
    sourceDir: join(repo, "tests", "fixture", "chess"),
    root: repo,
    appName: "Velvet Chess",
  });
  const file = join(mkdtempSync(join(tmpdir(), "dai-sealed-leave-")), "velvet-chess.dai.html");
  writeFileSync(file, built.html, "utf8");

  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const ui = app(page);
  await expect(ui.locator("#app")).toBeVisible({ timeout: 60_000 });
  await ui.locator("[data-new-game]:visible").first().click();
  await ui.locator("#setup-you").fill("Ada");
  await ui.locator("#setup-them").fill("Bo");
  await ui.locator('input[name="color"][value="w"]').check();
  await ui.locator("#new-game-form button[type=submit]").click();
  const before = await page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0));
  await play(ui, "e2", "e4");
  // The save after the move is the leave this is about.
  await expect.poll(() => page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0)), { timeout: 30_000 })
    .toBeGreaterThan(before);

  const author = (await page.evaluate(() => (window as any).__runner.authorId())) as string;
  const document = (await page.evaluate(() => (window as any).__runner.loaded?.manifest?.documentUuid ?? null)) as string | null;

  // Every row written is sealed by the saves that follow it. A row written just
  // after a save is pending until the next one, so wait for what the claim is
  // about: nothing of this device's left pending.
  await expect.poll(() => pendingOwn(ui), { timeout: 30_000, message: "every row this device wrote is sealed by the saves after it" }).toBe(0);

  // Everything the checks need, out of the page as plain arrays.
  const held = await ui.locator("#app").evaluate(() => {
    const db = (window as any).daiKit.db;
    const plain = (v: unknown) => (v instanceof Uint8Array ? { bytes: [...v] } : v);
    const me = db.selectObjects("SELECT id FROM _dai_replica")[0].id as Uint8Array;
    const tables = db
      .selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .map((r: any) => String(r.name))
      .filter((name: string) => {
        const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => c.name);
        return cols.includes("_r_replica") && cols.includes("_r_batch");
      });
    const rows: { table: string; row: Record<string, unknown> }[] = [];
    let pending = 0;
    for (const t of tables) {
      for (const r of db.selectObjects(`SELECT * FROM "${t}" WHERE _r_replica = ?`, [me])) {
        if (r._r_batch == null) pending += 1;
        rows.push({ table: t, row: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])) });
      }
    }
    const headers = db
      .selectObjects("SELECT * FROM _dai_batch")
      .map((h: any) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, plain(v)])));
    return { pending, rows, headers };
  });

  const bytes = (v: unknown): Uint8Array => Uint8Array.from((v as { bytes: number[] }).bytes);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  expect(held.pending, "no row of this device's is left pending after a save").toBe(0);
  expect(held.headers.length, "the save carries signed headers").toBeGreaterThan(0);
  expect(document, "the document's id, which every header signs").toBeTruthy();

  for (const header of held.headers) {
    const id = bytes(header["id"]);
    const entries: BatchEntry[] = held.rows
      .filter((r) => r.row["_r_batch"] && hex(bytes(r.row["_r_batch"])) === hex(id))
      .map(({ table, row }) => ({
        table,
        row: {
          _r_replica: bytes(row["_r_replica"]),
          _r_seq: Number(row["_r_seq"]),
          _r_lc: Number(row["_r_lc"]),
          _r_entity: bytes(row["_r_entity"]),
          _r_parents: String(row["_r_parents"]),
          _r_deleted: Number(row["_r_deleted"]),
          ...(row["_r_session"] ? { _r_session: bytes(row["_r_session"]) } : {}),
          columns: Object.fromEntries(
            Object.entries(row)
              .filter(([k]) => !k.startsWith("_r_"))
              .map(([k, v]) => [k, v && typeof v === "object" && "bytes" in (v as object) ? bytes(v) : v]),
          ),
        },
      }));
    expect(entries.length, `batch ${hex(id)} covers rows`).toBeGreaterThan(0);
    expect(hex(await rowsDigest(entries)), "the header's digest is its rows").toBe(hex(bytes(header["digest"])));
    const pub = bytes(header["pub"]);
    expect(showAuthorId(await authorIdOf(pub)), "the key fingerprints to this device's author").toBe(author);
    expect(showAuthorId(bytes(header["author"]))).toBe(author);
    const signed = canonicalHeader({
      version: Number(header["version"]),
      document: document!,
      author: bytes(header["author"]),
      lc: Number(header["lc"]),
      digest: bytes(header["digest"]),
      covers: JSON.parse(String(header["covers"])) as [string, number][],
    });
    expect(await verifySignature(pub, signed, bytes(header["sig"])), "the signature verifies").toBe(true);
  }
});

/**
 * D178, in the order that loses it. A row written while a save's seal waits for
 * its signature is not in that seal, and is in the bytes that save takes. The
 * seal's own write queues a save, which the save in flight cancels as its own;
 * the row's queued save is the same database and was cancelled with it. Locally
 * on WebKit, the new game's seal was out when the move was played 11 times in 20.
 * Here the new game's seal has its last signature held, given back the moment
 * the move is written, so the seal and its save finish inside the move's
 * debounce. Holding an earlier one left the rest to be asked after the release,
 * and on WebKit that outlasted the debounce two times in three: the move's
 * queued save then ran, the order that passes.
 *
 * The move is the only write while the signature is held. Any other write's
 * debounce can fire during the hold, and a save asked while one is in flight is
 * asked again after it, which seals the move: the order that passes, again. So
 * the move is drafted straight after the submit, inside the new game's own
 * debounce, and only Play is pressed during the hold. What is held is the
 * host's answer, in the shell, not the frame's request at the host: given back
 * there, it reaches the frame without the host's signing in between.
 *
 * How many batches that seal has depends on the setup's timing: a save asked
 * while the form is filled seals the fixture's rows, and the new game's seal is
 * then one batch, not two (CI, run 37040021127). Nor which batch is last: a
 * seal goes by session, and the game's batch sorts before or after the
 * fixture's by its random session id. So no count or order is assumed. Every
 * signature asked once the hold is armed is held and read from outside: it is
 * kept only if the new game is written and every own row still pending is in
 * this batch, so the seal asking carries the game and no batch follows it. Any
 * other is given back at once.
 *
 * From the move on, the host does not hear that the frame wrote. It answers that
 * by publishing, and a publish seals and saves whatever is pending, so on the
 * old runtime it sealed the move whenever it ran after the held seal: WebKit, 20
 * of 20 green on `0cfda2e` with it heard. What is checked here is the save, not
 * the publish.
 */
test("a row written while a seal waits for its signature is sealed by a later save", async ({ page }) => {
  test.slow();
  // In the shell, the frame between the host and the document, before the
  // shell's own listener, so it runs first; armed by the test.
  await page.context().addInitScript(
    ({ sign, signed, authored }) => {
      if (window === window.top || window.parent !== window.top) return;
      const w = window as any;
      w.__asked = {};
      const giveBack = (): void => {
        const held = w.__heldSigned;
        w.__heldSigned = null;
        window.dispatchEvent(new MessageEvent("message", { data: held, source: window.parent }));
      };
      // Not the one: the seal goes on to its next batch.
      w.__giveBack = giveBack;
      window.addEventListener("message", (event) => {
        const data = event.data as any;
        const fromHost = event.source === window.parent;
        if (!fromHost && data?.type === sign) {
          w.__asked[String(data.id)] = Array.from(data.header as Uint8Array);
        } else if (w.__holdSign && fromHost && data?.type === signed && !w.__heldSigned && event.isTrusted) {
          w.__heldSigned = data;
          event.stopImmediatePropagation();
        } else if (w.__kept && w.__heldSigned && !fromHost && data?.type === authored) {
          // The move is written: the signature goes back now.
          w.__kept = false;
          w.__released = true;
          giveBack();
          event.stopImmediatePropagation();
        } else if (w.__released && !fromHost && data?.type === authored) {
          // Nor any after it: a publish would seal the move instead of a save.
          event.stopImmediatePropagation();
        }
      });
    },
    { sign: FRAME_INTERNAL.SIGN, signed: TO_DOCUMENT.SIGNED, authored: FRAME_INTERNAL.AUTHORED },
  );
  const shell = () => page.mainFrame().childFrames()[0]!;
  const built = await compileDirectory({
    sourceDir: join(repo, "tests", "fixture", "chess"),
    root: repo,
    appName: "Velvet Chess",
  });
  const file = join(mkdtempSync(join(tmpdir(), "dai-sealed-leave-")), "velvet-chess.dai.html");
  writeFileSync(file, built.html, "utf8");

  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const ui = app(page);
  await expect(ui.locator("#app")).toBeVisible({ timeout: 60_000 });
  await ui.locator("[data-new-game]:visible").first().click();
  await ui.locator("#setup-you").fill("Ada");
  await ui.locator("#setup-them").fill("Bo");
  await ui.locator('input[name="color"][value="w"]').check();
  // Whatever was saved before this point, the new game's rows are above it.
  const before = await ownRows(ui);
  await shell().evaluate(() => {
    (window as any).__holdSign = true;
  });
  await ui.locator("#new-game-form button[type=submit]").click();
  // Drafted at once, inside the new game's debounce, so the move is the only
  // write while the signature is held.
  await pick(ui, "e2", "e4");
  let given = 0;
  await expect
    .poll(
      async () => {
        const asked = await shell().evaluate(() => {
          const w = window as any;
          return w.__heldSigned ? (w.__asked[String(w.__heldSigned.id)] as number[]) : null;
        });
        if (!asked) return false;
        const covers = (decode(Uint8Array.from(asked)) as unknown[])[5] as [string, number][];
        const now = await ownRows(ui);
        if (before.me) expect(now.me, "this copy writes under the id it had when the hold was armed").toBe(before.me);
        const inBatch = new Set(covers.map(([table, seq]) => `${table}\u0000${seq}`));
        // The new game is written, and nothing pending is outside this batch: the
        // seal asking is the one that carries the game, and this is its last.
        const last = now.top > before.top && now.pending.every(([table, seq]) => inBatch.has(`${table}\u0000${seq}`));
        if (last) {
          await shell().evaluate(() => {
            (window as any).__holdSign = false;
          });
          return true;
        }
        await shell().evaluate(() => (window as any).__giveBack());
        given += 1;
        return false;
      },
      { timeout: 30_000, intervals: [50], message: "the new game's seal asks for its last signature" },
    )
    .toBe(true);
  test.info().annotations.push({ type: "signatures given back before the held one", description: String(given) });
  // Every save asked before the hold has landed, and its landing said so, before
  // the release is armed: a landing is said the way a write is, and must not
  // pass for the move's.
  let landed = { asked: -1, written: 0 };
  await expect
    .poll(
      async () => {
        landed = await page.evaluate(() => {
          const runner = (window as any).__runner;
          return { asked: Number(runner.saves ?? 0), written: Number(runner.savesWritten ?? 0) };
        });
        return landed.asked === landed.written;
      },
      { timeout: 30_000, message: "every save asked before the hold has landed" },
    )
    .toBe(true);
  await shell().evaluate(() => {
    (window as any).__kept = true;
  });

  await ui.locator("#play-move").click();
  await expect
    .poll(() => shell().evaluate(() => Boolean((window as any).__released)), { timeout: 30_000, message: "the move is written while the signature is held" })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => Number((window as any).__runner.savesWritten ?? 0)), { timeout: 30_000, message: "the new game's save lands" })
    .toBeGreaterThan(landed.written);

  await expect
    .poll(() => pendingOwn(ui), { timeout: 30_000, message: "the move, written during the seal, is sealed by a save after it" })
    .toBe(0);
});
