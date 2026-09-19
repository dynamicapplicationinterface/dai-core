import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { fsMailbox } from "../src/mailbox-fs.js";
import { base64 } from "../src/mailbox-http.js";
import { play } from "./chess-play.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * T1-D22: one replica per copy, settled at mount.
 *
 * The bug the two-phone test found: a copy that arrived from someone else kept
 * the sender's replica id until its first write, and a refresh in that window
 * reopened it from the library as this device's own — still under the sender's
 * id. Then both copies allocated the same `(replica, seq)` and the exchange
 * refused a row as tampering ("A different row already exists"). The fix settles
 * an arrived copy's identity at mount, before any refresh can reopen it.
 *
 * A test that only watched for the absence of that refusal would pass for the
 * wrong reasons — a timing shift, a dropped row, a copy that never published.
 * So this reads the replica id through `__runner.replicaId()` and says what it
 * means: an arrived copy takes its own id at mount and keeps it across a reopen,
 * an own copy's id never changes, and the move still crosses.
 */
test.describe("a reopened arrived copy keeps its own replica id (D22)", () => {
  test.slow();

  let server: Server;
  let relayBase: string;
  let container: string;
  let key: string;

  test.beforeAll(async () => {
    const backend = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-d22-relay-")) });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,if-none-match",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      const isHead = parts[parts.length - 1] === "head";
      const doc = isHead ? parts[parts.length - 2]! : parts[parts.length - 1]!;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        void (async () => {
          if (req.method === "POST") {
            res.writeHead(200, cors);
            res.end(await backend.append(doc, new Uint8Array(Buffer.concat(chunks))));
          } else if (isHead) {
            res.writeHead(200, cors);
            res.end(await backend.head(doc));
          } else {
            const { cursor, batches } = await backend.since(doc, url.searchParams.get("since") ?? "");
            res.writeHead(200, { ...cors, "content-type": "application/json" });
            res.end(JSON.stringify({ cursor, batches: batches.map(base64.encode) }));
          }
        })();
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    relayBase = `http://localhost:${(server.address() as { port: number }).port}/m`;

    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-d22-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
    key = base64.encode(crypto.getRandomValues(new Uint8Array(32)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  });

  test.afterAll(() => server?.close());

  async function openWith(page: Page, file: string): Promise<FrameLocator> {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", file);
    await page.locator("#card-open").waitFor({ timeout: 60_000 });
    await page.locator("#card-open").click();
    await expect(app(page).locator("#app")).toBeVisible({ timeout: 60_000 });
    return app(page);
  }

  /** Reopen the last-used document from the library, as a refresh does. */
  async function reopen(page: Page): Promise<FrameLocator> {
    await page.reload();
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

  const useRelay = (page: Page): Promise<void> =>
    page.evaluate(([b, k]) => (window as any).__runner.useRelay(b, k), [relayBase, key] as const);

  /** The mounted copy's replica id, retried until the frame answers. */
  async function replicaId(page: Page): Promise<string> {
    let id: string | null = null;
    await expect(async () => {
      id = (await page.evaluate(() => (window as any).__runner.replicaId())) as string | null;
      expect(id).toBeTruthy();
    }).toPass({ timeout: 15_000 });
    return id!;
  }

  test("adopted at mount, kept across a reopen, and the move still crosses", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const deviceB: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    // A creates the game and plays e4. It is this device's own copy, and it has
    // written, so it has a replica id.
    const appA = await openWith(pageA, container);
    await appA.locator("[data-new-game]:visible").first().click();
    await appA.locator("#setup-you").fill("Ada");
    await appA.locator("#setup-them").fill("Bo");
    await appA.locator('input[name="color"][value="w"]').check();
    await appA.locator("#new-game-form button[type=submit]").click();
    await play(appA, "e2", "e4");
    const idA = await replicaId(pageA);

    // The initial game reaches B once, by file. B now carries A's replica id.
    const seed = join(dirname(container), "seed.dai.html");
    await saveOut(pageA, seed);

    // Third state, from the other direction: reopening an OWN copy must keep its
    // id. Adoption that fired on every mount would mint a new one here — the same
    // corruption, and nothing else catches it.
    await reopen(pageA);
    expect(await replicaId(pageA), "an own copy keeps its id across a reopen").toBe(idA);
    await useRelay(pageA);

    // B opens the arrived copy. The fix settles its identity at mount: before B
    // has written anything, its id is already its own, not A's.
    const appB = await openWith(pageB, seed);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    const idB = await replicaId(pageB);
    expect(idB, "an arrived copy adopts its own id at mount").not.toBe(idA);

    // The adoption is persisted, not just held in memory — otherwise the reopen
    // below reads the sender's id back off disk. It flushes at mount, so a save
    // is written without a move being played. Written, not asked: this waited on
    // `saves`, which counts saves asked, and on a slow CI Firefox the reopen
    // below landed before the write and came back as the sender (d22).
    await expect
      .poll(() => pageB.evaluate(() => (window as any).__runner.savesWritten), { timeout: 15_000 })
      .toBeGreaterThan(0);

    // The D22 window: B is reopened from the library BEFORE its first write. The
    // reopen mounts it as this device's own — and it must still be idB, not A's.
    await reopen(pageB);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    const idBAfter = await replicaId(pageB);
    expect(idBAfter, "the reopened arrived copy keeps its own id").toBe(idB);
    expect(idBAfter, "and never falls back to the sender's").not.toBe(idA);
    await useRelay(pageB);

    // And the payoff: B plays under its own id, so the row does not collide with
    // A's. The move crosses the mailbox and both boards agree.
    await play(appB, "e7", "e5");
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#move-history")).toContainText("e5", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * The route d22 takes, and D80's precondition (19 September).
   *
   * Firefox CI traces: page B adopted its own id at mount, logged "save 1
   * asked", and was reloaded before "save 1 written". The reload found no
   * stored database, mounted the library's copy (the arrived file, which
   * carries the sender's id) as this device's own, and kept the sender's id.
   * The test above waits on `__runner.saves`, which counts saves asked, not
   * written, so a slow write loses the race. This takes the race on purpose:
   * the reload lands between asked and written.
   */
  test("a reload between the first save asked and written keeps the copy's own id", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const deviceB: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const appA = await openWith(pageA, container);
    await appA.locator("[data-new-game]:visible").first().click();
    await appA.locator("#setup-you").fill("Ada");
    await appA.locator("#setup-them").fill("Bo");
    await appA.locator('input[name="color"][value="w"]').check();
    await appA.locator("#new-game-form button[type=submit]").click();
    await play(appA, "e2", "e4");
    const idA = await replicaId(pageA);
    const seed = join(dirname(container), "seed-race.dai.html");
    await saveOut(pageA, seed);

    // Reload B the instant its first save is asked, before it is written.
    const lines: string[] = [];
    let reloading: Promise<unknown> | undefined;
    pageB.on("console", (m) => {
      const text = m.text();
      if (text.startsWith("dai: ")) lines.push(text);
      if (!reloading && /^dai: save 1 asked/.test(text)) reloading = pageB.reload();
    });
    // Opened by hand rather than with openWith: the reload can land during the
    // mount, before the application is on screen, so there is nothing to wait for.
    await pageB.goto(RUNNER_URL);
    await pageB.setInputFiles("#file", seed);
    await pageB.locator("#card-open").click({ timeout: 60_000 });
    await expect.poll(() => reloading !== undefined, { timeout: 30_000 }).toBe(true);
    await reloading;
    // The id B took at mount, before the reload, from its own line.
    const adopted = lines
      .map((l) => /^dai: replica [^:]*: \S+ -> ([0-9a-f]{32})$/.exec(l)?.[1])
      .find((id): id is string => Boolean(id));

    // The reopen: from the library if the first save landed, and otherwise the
    // chooser, since a first arrival has no library record until its first save
    // is written. Then the person opens the file again, as they would.
    const reopened = await app(pageB)
      .locator("#move-history")
      .waitFor({ timeout: 15_000 })
      .then(() => true, () => false);
    if (!reopened) await openWith(pageB, seed);
    await expect(app(pageB).locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    const idB = await replicaId(pageB);
    const trail = lines.filter((l) => /save|stored|reopen|replica|library/.test(l)).join(" | ");
    console.log(`d22 race: A=${idA} B-before=${adopted} B-after=${idB} :: ${trail}`);
    // The reload is started on "asked", but the write often still lands first
    // (the old page can unload before it logs "written"). Then the reopen finds
    // the stored database and this run never reached the window. Say so instead
    // of passing or failing on a condition it never tested.
    // Before the fix the reopen came from the library ("reopen mounted the
    // stored database"); after it, a first arrival has no library record yet and
    // the file is opened again, which resumes the stored database when the save
    // landed. Either line means the write beat the reload.
    // Only the first reopen after the reload decides it: a later one in the same
    // run (the page settling) reads the database the first one went on to save.
    const firstReopen = lines
      .slice(lines.findIndex((l) => l.startsWith("dai: save 1 asked")) + 1)
      .find((l) => /^dai: (reopen mounted|resumed this device's own copy)/.test(l));
    test.skip(
      firstReopen !== undefined && /stored database/.test(firstReopen) && !/no stored database/.test(firstReopen),
      "the first save landed before the reopen: the window was missed",
    );
    expect(idB, "the reopened arrived copy is not the sender").not.toBe(idA);
    expect(idB, "and it is the id this device took before the reload").toBe(adopted);

    await deviceA.close();
    await deviceB.close();
  });

  /** The replica id this device has recorded for the one document it holds, read from storage. */
  const recordedReplica = (page: Page): Promise<string | null> =>
    page.evaluate(
      () =>
        new Promise<string | null>((done) => {
          const open = indexedDB.open("dai_runner_storage");
          open.onerror = () => done(null);
          open.onsuccess = () => {
            const req = open.result.transaction("sqlite_databases", "readonly").objectStore("sqlite_databases").getAllKeys();
            req.onerror = () => done(null);
            req.onsuccess = () => {
              const key = (req.result as IDBValidKey[]).map(String).find((k) => k.startsWith("replica:"));
              if (!key) return done(null);
              const get = open.result.transaction("sqlite_databases", "readonly").objectStore("sqlite_databases").get(key);
              get.onsuccess = () => done(typeof get.result === "string" ? get.result : null);
              get.onerror = () => done(null);
            };
          };
        }),
    );

  /**
   * The guard (d22): a copy mounted from this device's library writes under this
   * device's recorded replica id, never one carried by the file it mounted.
   *
   * Checked for both kinds of copy a library holds, each across a reopen: one
   * this device started (A), and one that arrived from A (B, which must also
   * never be A). The race test above covers a reopen inside the window; this
   * holds the ordinary reopen to the same rule, so a change that stopped
   * handing the recorded id to the frame fails here on every run, not only
   * when a race is won.
   */
  test("a copy reopened from the library writes under this device's recorded id", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const deviceB: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const appA = await openWith(pageA, container);
    await appA.locator("[data-new-game]:visible").first().click();
    await appA.locator("#setup-you").fill("Ada");
    await appA.locator("#setup-them").fill("Bo");
    await appA.locator('input[name="color"][value="w"]').check();
    await appA.locator("#new-game-form button[type=submit]").click();
    await play(appA, "e2", "e4");
    const seed = join(dirname(container), "seed-guard.dai.html");
    await saveOut(pageA, seed);
    await reopen(pageA);
    const idA = await replicaId(pageA);
    expect(await recordedReplica(pageA), "A writes under the id recorded for A").toBe(idA);

    await openWith(pageB, seed);
    await expect
      .poll(() => pageB.evaluate(() => (window as any).__runner.savesWritten), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await reopen(pageB);
    const idB = await replicaId(pageB);
    expect(await recordedReplica(pageB), "B writes under the id recorded for B").toBe(idB);
    expect(idB, "and B is never A").not.toBe(idA);

    await deviceA.close();
    await deviceB.close();
  });
});
