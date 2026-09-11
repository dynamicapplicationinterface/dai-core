import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
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
 * The key path, end to end: no injected key.
 *
 * The rule tests/README.md exists to keep — an end-to-end test uses the carrier
 * a person uses. So the key is not handed to either copy; it is minted at the
 * invite, sealed into the link, and read out of the link the other person opens.
 * One copy starts a game and *shares a link*; the other *opens the link*; a move
 * crosses the mailbox. `useRelay(base)` is scenery — it points at the local
 * relay and sets no key. The store is a directory this test stands up, reached
 * the way the opener reaches the real one.
 */
test.describe("a game continues over a shared link (the key path)", () => {
  test.slow();

  let relay: Server;
  let relayBase: string;
  let container: string;
  const bucket = new Map<string, Buffer>();

  test.beforeAll(async () => {
    const backend = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-link-relay-")) });
    relay = createServer((req, res) => {
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
    await new Promise<void>((r) => relay.listen(0, r));
    relayBase = `http://localhost:${(relay.address() as { port: number }).port}/m`;

    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-link-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");
  });

  test.afterAll(() => relay?.close());

  /** The store the opener seals to and reads from: presign, the PUT, and the read. */
  async function mountStore(context: BrowserContext): Promise<void> {
    await context.route("**/api/presign", async (route) => {
      const body = route.request().postDataJSON() as { hash: string; kind: string };
      const name = body.kind === "sidecar" ? `${body.hash}.json` : body.kind === "icon" ? `${body.hash}.png` : body.hash;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ url: `https://store.opendai.app/__put/${name}`, method: "PUT", headers: {}, href: `https://store.opendai.app/${name}`, token: "t.link" }),
      });
    });
    await context.route("https://store.opendai.app/__put/**", async (route) => {
      const name = new URL(route.request().url()).pathname.slice("/__put/".length);
      bucket.set(name, route.request().postDataBuffer() ?? Buffer.alloc(0));
      await route.fulfill({ status: 200, body: "" });
    });
    await context.route("https://store.opendai.app/*", async (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      const held = bucket.get(name);
      if (!held) return route.fulfill({ status: 404, body: "" });
      await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: held });
    });
  }

  const useRelay = (page: Page): Promise<void> =>
    page.evaluate((b) => (window as any).__runner.useRelay(b), relayBase);

  async function play(a: FrameLocator, from: string, to: string): Promise<void> {
    await a.locator(`[data-square="${from}"]`).click();
    await a.locator(`[data-square="${to}"]`).click();
    await expect(a.locator("#play-move")).toBeEnabled({ timeout: 15_000 });
    await a.locator("#play-move").click();
  }

  test("the key reaches the second copy through the link, and a move crosses", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();
    pageA.on("console", (m) => m.type() === "error" && console.log("A err", m.text().slice(0, 160)));
    pageB.on("console", (m) => m.type() === "error" && console.log("B err", m.text().slice(0, 160)));

    // A starts a game and plays e4.
    await pageA.goto(RUNNER_URL);
    await pageA.setInputFiles("#file", container);
    await pageA.locator("#card-open").click();
    const appA = app(pageA);
    await expect(appA.locator("#app")).toBeVisible({ timeout: 60_000 });
    await appA.locator("[data-new-game]:visible").first().click();
    await appA.locator("#setup-you").fill("Ada");
    await appA.locator("#setup-them").fill("Bo");
    await appA.locator('input[name="color"][value="w"]').check();
    await appA.locator("#new-game-form button[type=submit]").click();
    await play(appA, "e2", "e4");
    await useRelay(pageA);

    // A shares — a real link through the store. No navigator.share in headless,
    // so the link goes to the clipboard, which is captured.
    await pageA.evaluate(() => {
      (window as any).__copied = undefined;
      navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
    });
    await pageA.click("#more");
    await pageA.click("#send");
    await pageA.click("#send-go");
    await expect(pageA.locator("#report")).toContainText(/Link copied|Shared/, { timeout: 30_000 });
    const link = await pageA.evaluate(() => (window as any).__copied as string | undefined);
    expect(link, "the share produced a link, not a file").toBeTruthy();
    expect(new URL(link!).pathname).toMatch(/^\/d\/[0-9a-f]{64}$/);

    // B opens the link — and gets the key only from it.
    await pageB.goto(link!);
    await pageB.locator("#card-open").click({ timeout: 60_000 });
    const appB = app(pageB);
    await expect(appB.locator("#app")).toBeVisible({ timeout: 60_000 });
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    await useRelay(pageB);

    // B replies e5 over the mailbox; A pulls it. No key was injected anywhere.
    await play(appB, "e7", "e5");
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#move-history")).toContainText("e5", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    // And back: A plays Nf3, B pulls it.
    await play(appA, "g1", "f3");
    await expect(async () => {
      await pageB.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appB.locator("#move-history")).toContainText("Nf3", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await deviceA.close();
    await deviceB.close();
  });
});
