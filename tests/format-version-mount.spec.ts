import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type Frame, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { resealContainer, verifyContainer } from "../src/container.js";
import { authorIdOf, mintPersonKey, rawPublicKey } from "../src/identity.js";
import { rewriteReplicated } from "../src/replicated.js";
import { pendingBatches, recordSeal, signBatch } from "../src/replicated-batch.js";
import { mergeTablesOf } from "../src/replicated-frame.js";
import { createEntity, ensureReplica, startSession, type Rows } from "../src/replicated-rows.js";
import { SESSION_ID_FUNCTION, sessionIdOf } from "../src/session-id.js";

/**
 * What a copy is mounted as, by the batch format its rows are in (step 6,
 * batch format version 2).
 *
 * - An arriving database is merged, not mounted (D133's load path): a row
 *   nobody signed never reaches the copy, and a signed one does.
 * - A host mounts read-only, with the update sentence, a document holding a
 *   header of a batch format above its own, or one below version 2 (D108,
 *   both directions).
 *
 * Page tests, because the load path and the mount are the host's and the
 * frame's, and a person meets them by opening a file.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const SENTENCE = "This app needs an update before it can be written to; what's here is kept";
const rnd = (): Uint8Array => crypto.getRandomValues(new Uint8Array(16));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const appFrame = (page: Page): Frame => {
  const frame = page.frames().find((f) => f.parentFrame()?.parentFrame() === page.mainFrame());
  if (!frame) throw new Error("app frame not found (main → shell → app)");
  return frame;
};

/** Chess, signed, and a database built beside it by `fill`, resealed into it as a file a person could pick. */
async function chessWith(fill: (db: Rows, document: string) => Promise<void>): Promise<string> {
  const built = await compileDirectory({
    sourceDir: join(repo, "tests", "fixture", "chess"),
    root: repo,
    appName: "Chess",
    signingKey: resolve(repo, "conformance", "signing-key.pem"),
    allowTestKey: true,
    // As the other specs that pick a signed file build it: a signed version 4
    // is refused before it opens (backlog D166).
    manifestVersion: 3,
  });
  const dir = mkdtempSync(join(tmpdir(), "dai-step6-"));
  const path = join(dir, "document.sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.function(SESSION_ID_FUNCTION, { deterministic: true }, (a, n) => sessionIdOf(a, n));
  sqlite.exec(rewriteReplicated(readFileSync(join(repo, "tests", "fixture", "chess", "schema.sql"), "utf8")).sql);
  const db: Rows = {
    all: (sql, params = []) => sqlite.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: (sql, params = []) => {
      sqlite.prepare(sql).run(...(params as never[]));
    },
  };
  await fill(db, built.manifest.documentUuid);
  sqlite.close();
  const resealed = await resealContainer(await verifyContainer(built.html), new Uint8Array(readFileSync(path)));
  const file = join(dir, "chess.dai.html");
  writeFileSync(file, resealed.html, "utf8");
  return file;
}

/** Ada's game, every row signed by her key for this document. */
async function adasGame(db: Rows, document: string): Promise<{ author: Uint8Array; session: Uint8Array }> {
  const keys = await mintPersonKey();
  const author = await authorIdOf(await rawPublicKey(keys.publicKey));
  ensureReplica(db, author);
  const session = startSession(db, { creatorSeat: rnd(), openSeat: rnd(), entities: [rnd(), rnd()] });
  createEntity(db, "games", rnd(), { white_name: "Ada", black_name: "", creator_color: "w", initial_fen: "" }, session);
  for (const batch of pendingBatches(db, author, mergeTablesOf(db))) recordSeal(db, await signBatch(batch, { document, keys }));
  return { author, session };
}

/** A fresh device opens the file from the chooser, and the application runs. */
async function openOnAFreshDevice(browser: Browser, file: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(RUNNER_URL);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#open").click();
  await (await chooser).setFiles(file);
  // The card a picked file shows, and its one button, as a person presses it.
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  // The application frame comes up after the loaded class, and its kit after that.
  await expect
    .poll(
      async () => {
        try {
          return await appFrame(page).evaluate(() => Boolean((window as any).daiKit?.db));
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return { page, close: () => context.close() };
}

const rowsBy = (page: Page, table: string, author: Uint8Array): Promise<number> =>
  appFrame(page).evaluate(
    ([t, a]) => Number((window as any).daiKit.db.selectObjects(`SELECT count(*) AS n FROM ${t} WHERE lower(hex(_r_replica)) = ?`, [a])[0].n),
    [table, hex(author)] as const,
  );
const writable = (page: Page): Promise<boolean> => appFrame(page).evaluate(() => (window as any).dai.replicated.writable());

test.describe("batch format version 2: what an arriving copy is mounted as", () => {
  test.slow();

  test("an arriving database is merged, not mounted: a row nobody signed never reaches the copy, and a signed one does (D133)", async ({ browser }) => {
    test.fail(true, "step 6: a whole file is mounted as it arrived, and verifies nothing");
    const mal = rnd();
    let ada: { author: Uint8Array; session: Uint8Array } | undefined;
    const file = await chessWith(async (db, document) => {
      ada = await adasGame(db, document);
      // A game under Mal's id in Ada's session, with no batch: written into the file by hand.
      db.run(
        "INSERT INTO games (white_name, black_name, creator_color, initial_fen, _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_session) VALUES ('Mal', '', 'w', '', ?, 1, 1, ?, '[]', 0, ?)",
        [mal, rnd(), ada.session],
      );
    });
    const { page, close } = await openOnAFreshDevice(browser, file);
    expect(await rowsBy(page, "games", ada!.author), "Ada's signed game arrived").toBe(1);
    expect(await rowsBy(page, "games", mal), "the row nobody signed did not").toBe(0);
    await close();
  });

  for (const [version, why] of [
    [1, "below version 2: a header from before covers were signed (the new host meets an old document)"],
    [3, "above this host's version 2 (an old host meets a newer document)"],
  ] as const) {
    test(`a document holding a batch format ${version} header mounts read-only, with the sentence: ${why} (D108)`, async ({ browser }) => {
      test.fail(true, "step 6, D108: a host mounts every document writable, whatever batch format its headers are in");
      const file = await chessWith(async (db, document) => {
        const { author } = await adasGame(db, document);
        db.run("UPDATE _dai_batch SET version = ? WHERE author = ?", [version, author]);
      });
      const { page, close } = await openOnAFreshDevice(browser, file);
      await expect(page.locator("#report")).toContainText(SENTENCE, { timeout: 30_000 });
      expect(await writable(page), "the copy cannot be written").toBe(false);
      await close();
    });
  }
});
