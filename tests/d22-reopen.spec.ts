import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { fsMailbox } from "../src/mailbox-fs.js";
import { base64 } from "../src/mailbox-http.js";

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

  async function play(a: FrameLocator, from: string, to: string): Promise<void> {
    await a.locator(`[data-square="${from}"]`).click();
    await a.locator(`[data-square="${to}"]`).click();
    await expect(a.locator("#play-move")).toBeEnabled({ timeout: 15_000 });
    await a.locator("#play-move").click();
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
    // is acknowledged without a move being played.
    await expect
      .poll(() => pageB.evaluate(() => (window as any).__runner.saves), { timeout: 15_000 })
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
});
