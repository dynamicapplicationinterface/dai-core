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
 * The chess loop over the relay, end to end: no file per move.
 *
 * The two players share the initial game by file once, as they do today, then
 * every move after travels through the mailbox — A publishes on write, B reads
 * on foreground, and the boards agree. It runs against a directory-backed relay
 * this test stands up, which also exercises the HTTP adapter and the wire
 * contract the Durable Object implements. What it proves is the host loop: the
 * frame's nudge, the seal, the append, the pull, and the apply, wired through
 * `main.ts`.
 */
/*
 * NOT the key-path proof. This test injects one key into both copies through
 * `__runner.useRelay(base, key)`, so the two sides trivially share a key and the
 * batches open. It proves the mechanism — the frame's nudge, the seal, the
 * append, the pull, the apply — and nothing about how two real people converge
 * on a key. The key path is proven in mailbox-link-e2e.spec.ts, which shares a
 * link and opens it, with no injected key. See tests/README.md.
 */
test.describe("the mailbox mechanism (with an injected key — not the key path)", () => {
  test.slow();

  let server: Server;
  let relayBase: string;
  let container: string;
  let key: string;

  test.beforeAll(async () => {
    const backend = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-e2e-relay-")) });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const parts = url.pathname.split("/").filter(Boolean); // ["m", <doc>] or ["m", <doc>, "head"]
      const isHead = parts[parts.length - 1] === "head";
      const doc = isHead ? parts[parts.length - 2]! : parts[parts.length - 1]!;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        void (async () => {
          if (req.method === "POST") {
            const cursor = await backend.append(doc, new Uint8Array(Buffer.concat(chunks)));
            res.writeHead(200, cors);
            res.end(cursor);
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
    const port = (server.address() as { port: number }).port;
    relayBase = `http://localhost:${port}/m`;

    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-e2e-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
    // A shared 32-byte key, as a link would carry, base64url.
    key = base64.encode(crypto.getRandomValues(new Uint8Array(32)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
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

  test("the first game goes by file, every move after by mailbox", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const deviceB: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    // A starts a game and plays the first move, then points its mailbox at the
    // relay with the shared key.
    const appA = await openWith(pageA, container);
    await appA.locator("[data-new-game]:visible").first().click();
    await appA.locator("#setup-you").fill("Ada");
    await appA.locator("#setup-them").fill("Bo");
    await appA.locator('input[name="color"][value="w"]').check();
    await appA.locator("#new-game-form button[type=submit]").click();
    await play(appA, "e2", "e4");
    await pageA.evaluate(([b, k]) => (window as any).__runner.useRelay(b, k), [relayBase, key] as const);

    // The initial game reaches B once, by file.
    const seed = join(dirname(container), "seed.dai.html");
    await saveOut(pageA, seed);
    const appB = await openWith(pageB, seed);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    await pageB.evaluate(([b, k]) => (window as any).__runner.useRelay(b, k), [relayBase, key] as const);

    // A move is published on write, but the write path debounces the seal-and-
    // send, so the reader pulls on a foreground it does not get to schedule.
    // The test stands in for that foreground by pulling until the move lands.
    const deliver = async (reader: Page, board: FrameLocator, move: string): Promise<void> => {
      await expect(async () => {
        await reader.evaluate(() => (window as any).__runner.pullMailbox());
        await expect(board.locator("#move-history")).toContainText(move, { timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
    };

    // From here, no file. After 1.e4 it is Black's turn: B replies e5, publishes
    // on write, and A pulls it on foreground.
    await play(appB, "e7", "e5");
    await deliver(pageA, appA, "e5");

    // A plays Nf3; B pulls it.
    await play(appA, "g1", "f3");
    await deliver(pageB, appB, "Nf3");

    // And back once more: B replies Nc6, A pulls, both agree.
    await play(appB, "b8", "c6");
    await deliver(pageA, appA, "Nc6");

    const historyA = await appA.locator("#move-history").textContent();
    const historyB = await appB.locator("#move-history").textContent();
    expect(historyA?.replace(/\s+/g, "")).toContain("Nc6");
    expect(historyB?.replace(/\s+/g, "")).toContain("Nc6");

    await deviceA.close();
    await deviceB.close();
  });

  test("a reply arrives on its own — the poll delivers it, with no pull", async ({ browser }) => {
    /*
     * The other tests stand in for the foreground with an explicit
     * `pullMailbox()`. This one gives the reader no pull at all: the only thing
     * that can carry the move onto A's board is A's own poll timer (FAST is 3s;
     * see mailbox-session.ts). It is the proof of the claim the polling was
     * built for — that the app looks for the other copy's moves on its own.
     *
     * Its own freshly compiled document, so the mailbox on the shared relay is
     * empty at the start: a mailbox holding an earlier test's moves would land
     * them whether or not the timer ran, and prove nothing about the timer.
     */
    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    const own = join(mkdtempSync(join(tmpdir(), "dai-autopoll-")), "auto.dai.html");
    writeFileSync(own, built.html, "utf8");

    const deviceA: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const deviceB: BrowserContext = await browser.newContext({ acceptDownloads: true });
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const appA = await openWith(pageA, own);
    await appA.locator("[data-new-game]:visible").first().click();
    await appA.locator("#setup-you").fill("Ada");
    await appA.locator("#setup-them").fill("Bo");
    await appA.locator('input[name="color"][value="w"]').check();
    await appA.locator("#new-game-form button[type=submit]").click();
    await play(appA, "e2", "e4");
    await pageA.evaluate(([b, k]) => (window as any).__runner.useRelay(b, k), [relayBase, key] as const);

    const seed = join(dirname(own), "seed.dai.html");
    await saveOut(pageA, seed);
    const appB = await openWith(pageB, seed);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    await pageB.evaluate(([b, k]) => (window as any).__runner.useRelay(b, k), [relayBase, key] as const);

    // B replies e5 and publishes on write. A is never told to pull. The generous
    // ceiling is for a loaded CI machine, not the expected latency.
    await play(appB, "e7", "e5");
    await expect(appA.locator("#move-history")).toContainText("e5", { timeout: 30_000 });

    await deviceA.close();
    await deviceB.close();
  });
});
