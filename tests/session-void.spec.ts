import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { resealContainer, verifyContainer } from "../src/container.js";
import { FRAME } from "../src/frame.js";
import { leftFloorKey } from "../src/keys.js";
import { BATCH_FORMAT_VERSION, batchIdOf, canonicalHeader } from "../src/replicated-batch.js";

/**
 * A void session is said, with its cause and a way on (R10, the eighth attack
 * review; docs/format.md#session-void).
 *
 * A session whose creator signed two different headers at one seq is void on
 * every copy that holds both: nothing in it is admitted or seats anyone, and
 * the repair is a new session. The copy that took part is told so by the kit,
 * in its own words, with a button that starts a new session.
 *
 * Ada starts a chess game; Bo opens her file and asks for the open seat. Then
 * the document's own code on Ada's copy asks her host for two headers over
 * one seq above her left floor, with two digests (what the eighth review's A9
 * showed a document can do). Her host lets no leave carry both (D181), so they
 * reach Bo in a copy of her file the test writes them into, as a second copy
 * of her store would send it. His copy now holds both, so her game is void
 * there, the kit says why, and its button starts him a new game of his own.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const SENTENCE =
  "This game cannot go on: whoever started it signed two different changes at the same point, so every copy has set it aside. Start a new game to keep playing.";

const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

async function firstOpen(page: Page, file: string): Promise<FrameLocator> {
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", file);
  await page.locator("#card-open").click({ timeout: 60_000 });
  const app = appIn(page);
  await expect(app.locator("#app")).toBeVisible({ timeout: 60_000 });
  return app;
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

/** A number the host keeps for this document (the left floor), read from its store. */
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

/** The highest seq this copy holds under its own id, and how many of its rows are pending. */
const ownTop = (app: FrameLocator): Promise<{ top: number; pending: number }> =>
  app.locator("#app").evaluate(() => {
    const db = (window as any).daiKit.db;
    const me = db.selectObjects("SELECT id FROM _dai_replica")[0]?.id;
    let top = 0;
    let pending = 0;
    for (const { name } of db.selectObjects("SELECT name FROM sqlite_schema WHERE type = 'table'")) {
      const cols = db.selectObjects(`SELECT name FROM pragma_table_info('${name}')`).map((c: any) => String(c.name));
      if (!cols.includes("_r_seq") || !cols.includes("_r_batch")) continue;
      for (const r of db.selectObjects(`SELECT _r_seq s, _r_batch b FROM "${name}" WHERE _r_replica = ?`, [me])) {
        top = Math.max(top, Number(r.s));
        if (!r.b) pending += 1;
      }
    }
    return { top, pending };
  });

test("a session whose creator signed twice is void, and the copy that took part is told so and offered a new game", async ({ browser }) => {
  test.slow();
  const scratch = mkdtempSync(join(tmpdir(), "dai-session-void-"));
  const built = await compileDirectory({ sourceDir: join(repo, "tests", "fixture", "chess"), root: repo, appName: "Velvet Chess" });
  const container = join(scratch, "chess.dai.html");
  writeFileSync(container, built.html, "utf8");
  const contexts = [await browser.newContext({ acceptDownloads: true }), await browser.newContext({ acceptDownloads: true })];
  const [pageA, pageB] = await Promise.all(contexts.map((c) => c.newPage()));

  // Ada starts a game as White.
  const appA = await firstOpen(pageA!, container);
  await appA.locator("[data-new-game]:visible").first().click();
  await appA.locator("#setup-you").fill("Ada");
  await appA.locator("#setup-them").fill("Bo");
  await appA.locator('input[name="color"][value="w"]').check();
  await appA.locator("#new-game-form button[type=submit]").click();
  const uuid = (await pageA!.evaluate(() => (window as any).__runner.loaded.manifest.documentUuid)) as string;
  await expect
    .poll(async () => {
      const own = await ownTop(appA);
      return own.top > 0 && own.pending === 0 && (await kept(pageA!, leftFloorKey(uuid))) === own.top;
    }, { timeout: 30_000, message: "Ada's game is signed, saved and counted" })
    .toBe(true);
  const a1 = await saveOut(pageA!, join(scratch, "a1.dai.html"));

  // Bo opens her file and asks for the open seat.
  const appB = await firstOpen(pageB!, a1);
  await expect(appB.locator("#game-id")).toContainText("waiting for Ada to let you in", { timeout: 30_000 });
  const said = appB.locator("[data-dai-session-void]");
  await expect(said, "a session nobody signed twice in is not void").toHaveCount(0);

  // Two headers of Ada's over one seq above her left floor, two digests, each
  // signed by her host. Her host lets no leave carry both (D181), so they come
  // to Bo in a copy of her file carrying both, as a second copy of her store
  // (a device restored from a backup) or a client that is not her host would
  // send it.
  const n = (await kept(pageA!, leftFloorKey(uuid))) + 1;
  const author = new Uint8Array(Buffer.from((await pageA!.evaluate(() => (window as any).__runner.authorId())) as string, "base64url"));
  const headerOf = (fill: number): Uint8Array =>
    canonicalHeader({ version: BATCH_FORMAT_VERSION, document: uuid, author, lc: n, digest: new Uint8Array(32).fill(fill), covers: [["moves", n]] });
  const verified = await verifyContainer(readFileSync(a1, "utf8"));
  const dbFile = join(scratch, "a2.sqlite");
  writeFileSync(dbFile, verified.archive["document.sqlite"]!);
  const sqlite = new DatabaseSync(dbFile);
  for (const fill of [1, 2]) {
    const header = headerOf(fill);
    const signed = (await appA.locator("#app").evaluate(
      (_app, { bytes, names, seq }) =>
        new Promise((done) => {
          const id = `void-${Math.random().toString(36).slice(2)}`;
          window.addEventListener("message", (event) => {
            const data = (event.data ?? {}) as any;
            if (data.type !== names.signed || data.id !== id) return;
            done(data.sig ? { sig: [...data.sig], pub: [...data.pub] } : { error: String(data.error ?? "") });
          });
          window.parent.postMessage({ type: names.sign, id, header: Uint8Array.from(bytes), seq }, "*");
        }),
      { bytes: [...header], names: { sign: FRAME.SIGN, signed: FRAME.SIGNED }, seq: n },
    )) as { sig?: number[]; pub?: number[]; error?: string };
    expect(signed.error, "the host signs a header over a seq above the left floor").toBeUndefined();
    sqlite
      .prepare("INSERT INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)")
      .run(await batchIdOf(header), author, n, Uint8Array.from(signed.sig!), Uint8Array.from(signed.pub!), BATCH_FORMAT_VERSION, new Uint8Array(32).fill(fill), JSON.stringify([["moves", n]]));
  }
  sqlite.close();
  const a2 = join(scratch, "a2.dai.html");
  writeFileSync(a2, (await resealContainer(verified, new Uint8Array(readFileSync(dbFile)))).html, "utf8");

  // Bo's copy takes Ada's file in: her game is void there, and the kit says why.
  await pageB!.setInputFiles("#file", a2);
  await expect(pageB!.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
  await pageB!.locator("#card-open").click();
  await expect(said, "the kit names the cause and the way on").toContainText(SENTENCE, { timeout: 60_000 });
  await expect(said).toHaveCount(1);
  const session = await said.getAttribute("data-dai-session-void");
  const facts = () =>
    appB.locator("#app").evaluate((_app, s) => {
      const db = (window as any).daiKit.db;
      const me = (window as any).daiKit.author();
      const count = (sql: string, bind: unknown[] = []) => Number(db.selectObjects(sql, bind)[0].n);
      return {
        void: count("SELECT count(*) AS n FROM _dai_void_session WHERE lower(hex(session)) = ?", [s]),
        holders: count("SELECT count(*) AS n FROM _dai_holder WHERE lower(hex(session)) = ?", [s]),
        mine: count("SELECT count(*) AS n FROM _dai_creator WHERE lower(hex(replica)) = ?", [me]),
      };
    }, session);
  expect(await facts(), "the game is void on Bo's copy: nobody holds a seat in it, and Bo has started none").toEqual({ void: 1, holders: 0, mine: 0 });

  // The way on: a new game of Bo's own.
  await said.getByRole("button", { name: "Start a new game" }).click();
  await expect(said).toHaveCount(0);
  await expect.poll(async () => (await facts()).mine, { timeout: 30_000, message: "Bo's copy started a session of its own" }).toBe(1);

  for (const context of contexts) await context.close();
});
