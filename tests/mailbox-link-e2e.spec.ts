import { createServer, type Server } from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type BrowserContext, type Frame, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { firstMailboxMerge } from "./mailbox-wait.js";
import { TO_HOST } from "../src/bridge.js";
import { compileDirectory } from "../src/compile.js";
import { FRAME_PUBLIC } from "../src/frame.js";
import { fsMailbox } from "../src/mailbox-fs.js";
import { base64 } from "../src/mailbox-http.js";
import { play } from "./chess-play.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const app = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * The app frame (the doubly-nested one), found by depth rather than array order.
 *
 * `page.frames().at(-1)` picks the last frame in enumeration order, which is the
 * app frame on Chromium and is not on WebKit — the order is engine-defined and
 * not part of the contract. The app is the frame two levels down (main → shell →
 * app), which is the same on every engine.
 *
 * Note for the record: this was NOT the cause of the WebKit reds in this file.
 * Those fail earlier, at the share step, with the store returning HTTP 404 — a
 * test-relay reachability problem, not frame enumeration. This helper is kept
 * because it is strictly more robust (structure, not array order), not because
 * it fixed those failures; it did not.
 */
const appFrame = (page: Page): Frame => {
  const frame = page.frames().find((f) => f.parentFrame()?.parentFrame() === page.mainFrame());
  if (!frame) throw new Error("app frame not found (main → shell → app)");
  return frame;
};

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
  let store: Server;
  let storeBase: string;
  let container: string;
  let creatorContainer: string;
  let rolesContainer: string;
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

    // A real store, on its own origin, standing in for the R2 bucket this repo
    // does not run: presign, the PUT, and the public read, backed by `bucket`.
    // A real server rather than a route because the opener's service worker
    // intercepts a same-origin request before a page route sees it — which is
    // what made the mocked store read as a 404 on WebKit. A different port is a
    // different origin, outside the worker's scope, so the opener reaches it.
    store = createServer((req, res) => {
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,PUT,POST,OPTIONS,HEAD",
        "access-control-allow-headers": "content-type",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (req.method === "POST" && url.pathname === "/presign") {
          const ask = JSON.parse(body.toString()) as { hash: string; kind: string };
          const name = ask.kind === "sidecar" ? `${ask.hash}.json` : ask.kind === "icon" ? `${ask.hash}.png` : ask.hash;
          res.writeHead(200, { ...cors, "content-type": "application/json" });
          res.end(
            JSON.stringify({ url: `${storeBase}/__put/${name}`, method: "PUT", headers: {}, href: `${storeBase}/${name}`, token: "t.link" }),
          );
        } else if (req.method === "PUT" && url.pathname.startsWith("/__put/")) {
          bucket.set(decodeURIComponent(url.pathname.slice("/__put/".length)), body);
          res.writeHead(200, cors);
          res.end();
        } else if (req.method === "GET" || req.method === "HEAD") {
          const held = bucket.get(decodeURIComponent(url.pathname.slice(1)));
          if (!held) {
            res.writeHead(404, cors);
            res.end();
            return;
          }
          res.writeHead(200, { ...cors, "content-length": String(held.length) });
          res.end(req.method === "HEAD" ? undefined : held);
        } else {
          res.writeHead(404, cors);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => store.listen(0, r));
    storeBase = `http://localhost:${(store.address() as { port: number }).port}`;

    const built = await compileDirectory({
      sourceDir: join(repo, "tests", "fixture", "chess"),
      root: repo,
      appName: "Velvet Chess",
    });
    container = join(mkdtempSync(join(tmpdir(), "dai-link-")), "velvet-chess.dai.html");
    writeFileSync(container, built.html, "utf8");

    // A close=creator variant of the same app, built by copying the fixture and
    // swapping the one profile line. Chess ships close=any, so this is the only
    // way to exercise the creator-gated close and, with it, prove the policy is
    // actually delivered to the frame — a close=any run cannot tell a delivered
    // "any" from an undelivered undefined.
    const creatorDir = mkdtempSync(join(tmpdir(), "dai-chess-creator-"));
    cpSync(join(repo, "tests", "fixture", "chess"), creatorDir, { recursive: true });
    const schemaPath = join(creatorDir, "schema.sql");
    const swapped = readFileSync(schemaPath, "utf8").replace(
      "max_parties=2 close=any",
      "max_parties=2 close=creator",
    );
    expect(swapped, "the profile line was swapped to close=creator").toContain("close=creator");
    writeFileSync(schemaPath, swapped, "utf8");
    const builtCreator = await compileDirectory({ sourceDir: creatorDir, root: repo, appName: "Velvet Chess" });
    creatorContainer = join(mkdtempSync(join(tmpdir(), "dai-link-creator-")), "velvet-chess.dai.html");
    writeFileSync(creatorContainer, builtCreator.html, "utf8");

    // A roles build of the same app (D15): two tables chess never touches, one
    // that only the session's creator may write and one only its joiner may. The
    // write-surface refusal lives in the runtime, so it needs a real document;
    // the merge-side property is proven without one in session-roles.spec.ts.
    const rolesDir = mkdtempSync(join(tmpdir(), "dai-chess-roles-"));
    cpSync(join(repo, "tests", "fixture", "chess"), rolesDir, { recursive: true });
    const rolesSchema = join(rolesDir, "schema.sql");
    writeFileSync(
      rolesSchema,
      readFileSync(rolesSchema, "utf8") +
        "\n-- dai:replicated author=creator\nCREATE TABLE advice (\n  note TEXT NOT NULL\n);\n" +
        "\n-- dai:replicated author=joiner\nCREATE TABLE answers (\n  note TEXT NOT NULL\n);\n",
      "utf8",
    );
    const builtRoles = await compileDirectory({ sourceDir: rolesDir, root: repo, appName: "Velvet Chess" });
    rolesContainer = join(mkdtempSync(join(tmpdir(), "dai-link-roles-")), "velvet-chess.dai.html");
    writeFileSync(rolesContainer, builtRoles.html, "utf8");
  });

  test.afterAll(() => {
    relay?.close();
    store?.close();
  });

  /**
   * Point every page in this context at the local store, before it loads.
   *
   * `window.__daiStore` is read by the opener's storeConfig(); injected here so
   * the opener seals to and reads from the server stood up in beforeAll rather
   * than the production bucket. Setting the base is scenery — the key still
   * crosses in the link, which is the fact this e2e proves.
   */
  async function mountStore(context: BrowserContext): Promise<void> {
    await context.addInitScript(
      (cfg) => {
        (window as unknown as { __daiStore: unknown }).__daiStore = cfg;
      },
      { presignUrl: `${storeBase}/presign`, publicBase: `${storeBase}/` },
    );
  }

  const useRelay = (page: Page): Promise<void> =>
    page.evaluate((b) => (window as any).__runner.useRelay(b), relayBase);

  /**
   * Lets a test hold this context's saves back: the losing order, forced.
   *
   * A save the frame asks for reaches the host as a message, and the host
   * writes it to storage in several steps under a lock. A page closed in
   * between keeps none of it, and on WebKit that is about half of the time
   * when a test closes a tab straight after a pull (D125). Setting
   * `__holdSavesMs` on a page delays each save message by that long before the
   * host sees it, so a test that closes too early fails every time instead of
   * half of the time. A listener registered before the opener's own, which
   * stops the message and sends the same one again later.
   */
  async function holdSaves(context: BrowserContext): Promise<void> {
    await context.addInitScript((saveType) => {
      window.addEventListener(
        "message",
        (event) => {
          const ms = Number((window as any).__holdSavesMs ?? 0);
          if (!ms || (event.data as { type?: string } | null)?.type !== saveType || (event as any).__held) return;
          event.stopImmediatePropagation();
          window.setTimeout(() => {
            const again = new MessageEvent("message", { data: event.data, origin: event.origin, source: event.source });
            (again as any).__held = true;
            window.dispatchEvent(again);
          }, ms);
        },
        true,
      );
    }, TO_HOST.SAVE);
  }


  /** The roster as this copy holds it: its own id, its bindings, and how many
   *  distinct binders each seat has — the number that reads 2 for a contested seat. */
  const bindState = (
    page: Page,
  ): Promise<{
    me: string;
    myBindings: { sess: string; seat: string }[];
    seatBinders: { seat: string; binders: number }[];
    members: string[];
  }> => {
    const f = appFrame(page);
    return f.evaluate(() => {
      const db = (window as any).daiKit.db;
      const q = (sql: string, bind?: unknown[]) => (bind ? db.selectObjects(sql, bind) : db.selectObjects(sql));
      const me = String(q("SELECT lower(hex(id)) id FROM _dai_replica")[0]?.id ?? "");
      return {
        me,
        myBindings: q(
          "SELECT lower(hex(_r_session)) sess, lower(hex(seat)) seat FROM _dai_binding_current WHERE lower(hex(_r_replica)) = ?",
          [me],
        ),
        seatBinders: q(
          "SELECT lower(hex(seat)) seat, count(DISTINCT lower(hex(_r_replica))) binders FROM _dai_binding_current GROUP BY seat",
        ),
        members: q("SELECT lower(hex(replica)) r FROM _dai_member").map((r: any) => String(r.r)),
      };
    });
  };

  /** Open a container, start a game as `you`/`them` with the given color, and play one move. */
  async function startGameAndShare(
    page: Page,
    containerPath: string,
    you: string,
    them: string,
    from: string,
    to: string,
  ): Promise<{ appFrame: FrameLocator; link: string }> {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", containerPath);
    await page.locator("#card-open").click();
    const appFrame = app(page);
    await expect(appFrame.locator("#app")).toBeVisible({ timeout: 60_000 });
    await appFrame.locator("[data-new-game]:visible").first().click();
    await appFrame.locator("#setup-you").fill(you);
    await appFrame.locator("#setup-them").fill(them);
    await appFrame.locator('input[name="color"][value="w"]').check();
    await appFrame.locator("#new-game-form button[type=submit]").click();
    await play(appFrame, from, to);
    await useRelay(page);
    await page.evaluate(() => {
      (window as any).__copied = undefined;
      navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
    });
    await page.click("#more");
    await page.click("#send");
    await page.click("#send-go");
    await expect(page.locator("#report")).toContainText(/Link copied|Shared/, { timeout: 30_000 });
    const link = await page.evaluate(() => (window as any).__copied as string | undefined);
    expect(link, "the share produced a link, not a file").toBeTruthy();
    return { appFrame, link: link! };
  }

  /**
   * The creator's copy seats the joiner (identity step 5). A joiner's open only
   * asks for the seat; the creator's copy confirms whoever asked when it sees
   * the ask, which over the mailbox is its next pull, and the joiner holds the
   * seat once the confirmation comes back on its own pull. Waits until every
   * seat the joiner asked for that is still open to it is held by it.
   */
  async function letIn(creator: Page, joiner: Page): Promise<void> {
    await expect(async () => {
      await creator.evaluate(() => (window as any).__runner.pullMailbox());
      await joiner.evaluate(() => (window as any).__runner.pullMailbox());
      const seen = await app(joiner).locator("body").evaluate(() => {
        const kit = (window as any).daiKit;
        const me = kit.author();
        const asked = kit.db.selectObjects(
          "SELECT DISTINCT lower(hex(_r_session)) s FROM _dai_binding WHERE lower(hex(_r_replica)) = ?",
          [me],
        );
        return { me, asked: asked.length, waiting: asked.filter((r: { s: string }) => kit.pendingSeat(r.s) !== null).length };
      });
      // What it looked at, before what it found: an ask to wait on, by a known author.
      expect(seen.me, "the joiner's author id").toMatch(/^[0-9a-f]{32}$/);
      expect(seen.asked, "the joiner asked for a seat").toBeGreaterThan(0);
      expect(seen.waiting, "the joiner is still waiting to be seated").toBe(0);
    }).toPass({ timeout: 30_000 });
  }

  /**
   * Whether this device's stored copy, the one a reopen reads, holds the
   * creator's confirmation seating the joiner. `letIn` waits for the copy in
   * memory; a test that closes the tab next needs the stored one, because a pulled confirmation is
   * applied at once and saved a moment later (D125: closed in between,
   * the reopened copy waits to be seated again). Read through the opener's own
   * load and opened in the app frame's SQLite, so it is the bytes a reopen gets.
   * The confirmation row itself, not `_dai_member`: the view needs a function
   * only the live database registers, and this row is the one found missing.
   */
  async function confirmedInStore(page: Page): Promise<boolean> {
    const bytes = await page.evaluate(async () => {
      const runner = (window as any).__runner;
      const stored: Uint8Array | null = await runner.loadStored(runner.loaded.manifest.documentUuid);
      return stored ? Array.from(stored) : [];
    });
    if (bytes.length === 0) return false;
    return appFrame(page).evaluate(async (raw) => {
      const kit = (window as any).daiKit;
      const api = await (window as any).dai.initSqlite();
      const data = new Uint8Array(raw);
      const db = new api.oo1.DB();
      try {
        const pointer = api.wasm.allocFromTypedArray(data);
        api.capi.sqlite3_deserialize(
          db.pointer,
          "main",
          pointer,
          data.length,
          data.length,
          api.capi.SQLITE_DESERIALIZE_FREEONCLOSE | api.capi.SQLITE_DESERIALIZE_RESIZEABLE,
        );
        return (
          db.selectObjects("SELECT 1 FROM _dai_confirm WHERE _r_deleted = 0 AND lower(hex(holder)) = ?", [kit.author()])
            .length > 0
        );
      } finally {
        db.close();
      }
    }, bytes);
  }

  /** Open a share link on a page, wait for the board, point it at the relay. */
  async function openLink(page: Page, link: string): Promise<FrameLocator> {
    await page.goto(link);
    await page.locator("#card-open").click({ timeout: 60_000 });
    const opened = app(page);
    await expect(opened.locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(page);
    return opened;
  }

  /**
   * Start another game on A and invite into it with the app's own Invite
   * button — the way a person sends a second game — returning the link.
   * The opponent is left unnamed, so whoever takes the seat is asked.
   */
  /**
   * A new game, invited.
   *
   * `withData` is the checkbox a person ticks to send what they have entered
   * along with the app. Every invite here went without it until 23 September,
   * so the recipient always got a blank copy -- which is the one shape where
   * a copy cannot come up wearing the sender's identity, because there is no
   * `_dai_replica` row in it to keep. The phone found the other shape
   * (tests/invite-identity.spec.ts).
   */
  async function inviteNewGame(
    page: Page,
    appFrame: FrameLocator,
    you = "Ada",
    options: { withData?: boolean } = {},
  ): Promise<string> {
    await appFrame.locator("[data-new-game]:visible").first().click();
    await appFrame.locator("#setup-you").fill(you);
    await appFrame.locator("#setup-them").fill("");
    await appFrame.locator('input[name="color"][value="w"]').check();
    await appFrame.locator("#new-game-form button[type=submit]").click();
    await play(appFrame, "d2", "d4");
    await page.evaluate(() => {
      (window as any).__copied = undefined;
      navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
    });
    await appFrame.locator("#share").click();
    if (options.withData) {
      await expect(page.locator("#send-sheet")).toBeVisible({ timeout: 30_000 });
      await page.locator("#send-with-data").check();
    }
    await page.locator("#send-go").click();
    await expect.poll(() => page.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 }).not.toBeNull();
    return page.evaluate(() => (window as any).__copied as string);
  }

  /**
   * Collects the opener's mount-guard refusals on a page (the permanent
   * `dai: refused to mount…` line). Empty means the guard never fired.
   */
  const guardWatch = (page: Page): string[] => {
    const lines: string[] = [];
    page.on("console", (m) => {
      if (m.text().startsWith("dai: refused to mount")) lines.push(m.text());
    });
    return lines;
  };

  /** The games this copy's own database holds, as "white vs black". */
  const gamesHeld = (page: Page): Promise<string[]> =>
    appFrame(page).evaluate(() =>
      (window as any).daiKit.db
        .selectObjects("SELECT white_name || ' vs ' || black_name AS g FROM games_current ORDER BY _r_lc")
        .map((r: any) => String(r.g)),
    );

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
    await firstMailboxMerge(pageB);
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

  /**
   * Turns belong to seats, and the person invited names themselves.
   *
   * The app-side half of collaborative play (docs/collaborative-play.md): only
   * the seat whose turn it is may author the next move, each copy says in a
   * standing banner whose move it is — to its own player, so the two copies say
   * different things — and the creator need not know what the invitee calls
   * themselves. Each claim is checked on the copy it is about, with the move
   * and the name crossing the real link and mailbox.
   */
  test("only the side to move can move, each copy says whose move it is, and the invitee names themselves", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    // A leaves the opponent unnamed, plays e4 as White, and invites.
    const { appFrame: appA, link } = await startGameAndShare(pageA, container, "Ada", "", "e2", "e4");
    const appB = await openLink(pageB, link);

    // B took the open seat of a game nobody named, so B is asked, once.
    await expect(appB.locator("#name-dialog")).toBeVisible({ timeout: 30_000 });
    await appB.locator("#my-name").fill("Bo");
    await appB.locator("#name-form button[type=submit]").click();
    await expect(appB.locator("#name-dialog")).toBeHidden();
    await expect(appB.locator("#bottom-player")).toContainText("Bo");
    await expect(appB.locator("#turn-banner-title")).toHaveText("Your move.");

    // A hears the seat taken and the name given, and it is not A's move.
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#turn-banner-title")).toHaveText("Bo’s move.", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    // The same link sends the game again, so both players keep it after the seat is
    // taken: it is how a player who lost the tab gets back (D48).
    await expect(appA.locator("#share"), "the game can still be sent again after the seat is taken").toBeVisible();
    await expect(appB.locator("#share"), "the player who joined can send it too").toBeVisible();

    // A's own piece, out of turn: nothing is picked up, and A is told why.
    await appA.locator('[data-square="g1"]').click();
    await expect(appA.locator("#toast")).toContainText("Bo’s move");
    await expect(appA.locator('[data-square="g1"]')).toHaveAttribute("aria-selected", "false");

    // B moves, and the turn — and each banner — changes hands.
    await play(appB, "e7", "e5");
    await expect(appB.locator("#turn-banner-title")).toHaveText("Ada’s move.");
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#turn-banner-title")).toHaveText("Your move.", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await play(appA, "g1", "f3");
    await expect(appA.locator("#move-history")).toContainText("Nf3");

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * A second invite reaches a browser that already holds the app.
   *
   * The defect: a recipient who had played an earlier game, followed a new
   * invite, was shown the old game — no new game, no name step — and nothing
   * said so. Every invite is the same document (the app) filtered to
   * one game, so the second one always arrives at a device that holds it.
   * Driven the way a person does it: the app's own Invite button, the link
   * followed in the same browser with nothing cleared, and each of the two
   * buttons the card offers.
   */
  test("a second invite to a browser that holds the app opens the new game", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();
    const refused = guardWatch(pageB);

    // Game 1: A invites Bo, and B takes the seat.
    const { appFrame: appA, link: first } = await startGameAndShare(pageA, container, "Ada", "Bo", "e2", "e4");
    const appB = await openLink(pageB, first);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });

    // Game 2: A starts another, leaves the opponent unnamed, and invites
    // with the app's own Invite button.
    const second = await inviteNewGame(pageA, appA);

    // B follows the new invite in the same browser, nothing cleared. The card
    // offers one thing, and it says it adds to B's copy.
    await pageB.goto(second);
    await expect(pageB.locator("#card-open")).toHaveText("Open in my copy", { timeout: 60_000 });
    await expect(pageB.locator("#card-merge"), "no second button offering what the first one does").toHaveCount(0);
    await pageB.locator("#card-open").click();
    const appB2 = app(pageB);
    await expect(appB2.locator("#app")).toBeVisible({ timeout: 60_000 });
    // Pointed at the relay, as openLink does, so B's ask for the new seat reaches A.
    await useRelay(pageB);

    // The new game, and its name step once A's copy seats B: B was never named
    // in it. And game 1 is still B's.
    await letIn(pageA, pageB);
    await expect(appB2.locator("#name-dialog")).toBeVisible({ timeout: 30_000 });
    await expect(appB2.locator("#move-history")).toContainText("d4");
    expect(await gamesHeld(pageB)).toContain("Ada vs Bo");
    expect(refused, "the mount guard stays silent on a legitimate merge").toEqual([]);

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * A second invite newer than everything the recipient has saved loses none of it.
   *
   * The other branch of the rule that dropped the invite above: when the
   * arriving copy is stamped later than the recipient's last save, "newer
   * wins" wrote the invite's database — one game — over the recipient's own,
   * and every other game went with it. The timing is forced rather than hoped
   * for: B's page is closed before A makes the second game, so B saves nothing
   * after the invite is stamped.
   */
  test("a second invite newer than the recipient's copy keeps the recipient's other games", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const { appFrame: appA, link: first } = await startGameAndShare(pageA, container, "Ada", "Bo", "e2", "e4");
    const appB = await openLink(pageB, first);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    const before = await gamesHeld(pageB);
    expect(before, "B holds game 1 before the second invite").toContain("Ada vs Bo");
    // Saved and gone: nothing B does can be stamped after the invite.
    await pageB.waitForTimeout(2_000);
    await pageB.close();
    await pageA.waitForTimeout(1_500);

    const second = await inviteNewGame(pageA, appA);

    const pageB2 = await deviceB.newPage();
    const refused = guardWatch(pageB2);
    await pageB2.goto(second);
    await pageB2.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(pageB2).locator("#app")).toBeVisible({ timeout: 60_000 });
    // Wait for what the assertion needs — the invited game in B's database —
    // not for a length of time.
    await expect.poll(async () => (await gamesHeld(pageB2)).length, { timeout: 30_000 }).toBeGreaterThan(before.length);
    const after = await gamesHeld(pageB2);

    // Nothing B had is gone, and the new game is there too.
    for (const game of before) expect(after, `B still holds "${game}"`).toContain(game);
    expect(refused, "the mount guard stays silent on a legitimate merge").toEqual([]);

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * Reopening the invite on the same copy binds no second seat.
   *
   * The discoverable open seat is bound on first open; a reopen must be a no-op
   * (T1-D29/D32). The failure this guards is the one that kills a game: if a
   * reopen adopted a fresh replica and bound again, the seat would have two
   * distinct binders — contested — and admit *neither*, so both players' moves
   * would vanish. So the test reopens B in the same browser context (the same
   * OPFS a person's second tab sees), and asserts the seat still has exactly one
   * binder, B is still a member, and a move played after the reopen still
   * crosses — the game is alive, not silently dead.
   */
  test("reopening the invite on the same copy binds no second seat", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    await holdSaves(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    // A starts a game and plays e4; B opens the link and binds the open seat.
    const { appFrame: appA, link } = await startGameAndShare(pageA, container, "Ada", "Bo", "e2", "e4");
    const appB = await openLink(pageB, link);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });

    // B replies e5, and A pulls it — so the binding and the move are both
    // durably in the mailbox before B goes away, not racing an autosave.
    await play(appB, "e7", "e5");
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#move-history")).toContainText("e5", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    // And A's copy has seated B, and B holds the confirmation, before B goes away.
    // B's saves are slow from here, so a close before the one holding the
    // confirmation lands fails every time rather than half of the time.
    await pageB.evaluate(() => void ((window as any).__holdSavesMs = 4_000));
    await letIn(pageA, pageB);
    // Held in memory is not held: the reopen reads the stored copy, so wait
    // until the confirmation is written there, not until it is applied.
    await expect.poll(() => confirmedInStore(pageB), { timeout: 30_000 }).toBe(true);
    const before = await bindState(pageB);
    expect(before.myBindings, "B bound exactly one seat on first open").toHaveLength(1);
    const seat = before.myBindings[0]!.seat;

    // B closes the tab and opens the same link again, in the same context — the
    // same stored copy a returning person reopens.
    await pageB.close();
    const pageB2 = await deviceB.newPage();
    await mountStore(deviceB); // routes are per-context; the new page needs them too
    // Reopening the link is reopening the OTHER player's copy (a sibling), so the
    // first merge is offered on a card, not resumed silently (T1-D33 corrected —
    // the resume gate is for this device's own copy, not any held sibling). B
    // accepts; the merge folds into B's own copy, keeping its replica and its one
    // binding. The guard below is the point: no second seat, whatever the card.
    await pageB2.goto(link);
    await pageB2.locator("#card-open").click({ timeout: 60_000 });
    const appB2 = app(pageB2);
    await expect(appB2.locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageB2);

    // The guard: the reopened copy is the same replica (T1-D33 — a merge into the
    // held copy keeps its identity), still holds exactly one binding, and the seat
    // it took has exactly one binder. A fresh replica rebinding the seat would show
    // two binders here — contested — which is the game-killer this guards.
    const after = await bindState(pageB2);
    expect(after.me, "a reopen keeps the copy's identity").toBe(before.me);
    expect(after.myBindings, "no second binding was written on reopen").toHaveLength(1);
    expect(after.myBindings[0]!.seat).toBe(seat);
    expect(after.seatBinders.find((s) => s.seat === seat)?.binders, "the seat has one binder, not two").toBe(1);
    expect(after.members, "B is still an admitted member after reopen").toContain(before.me);

    // And the game is alive: A replies Nf3 and the reopened B receives it —
    // proving the resumed copy is still an admitted member, not a contested
    // stranger whose moves are dropped.
    await play(appA, "g1", "f3");
    await expect(async () => {
      await pageB2.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appB2.locator("#move-history")).toContainText("Nf3", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * A resignation ends the game; a close ends the session — two separate acts.
   *
   * The resignation is a `game_events` row: the result derives from it and the
   * board stays readable forever (T1-D32). The close is the heavier, separate act
   * — a `_dai_close` row, no more rows after it (T1-D31). Both cross the mailbox,
   * so the other copy sees the result and then the closed state; and closed means
   * the board still shows, not that it vanishes. Chess is `close=any`, so either
   * player may close a finished game.
   */
  test("a resignation is a game row; a close is a session act; both cross the link", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const { appFrame: appA, link } = await startGameAndShare(pageA, container, "Ada", "Bo", "e2", "e4");
    const appB = await openLink(pageB, link);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    await play(appB, "e7", "e5");
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#move-history")).toContainText("e5", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    // A resigns (it is white's turn) — a game row. The board keeps its result.
    await appA.locator("#game-actions-button").click();
    await appA.locator("#resign").click();
    await appA.locator("#confirm-yes").click();
    await expect(appA.locator("#turn-title")).toContainText("wins", { timeout: 30_000 });
    // Resign is NOT a close: the match is not yet closed, so Close match offers.
    await expect(appA.locator("#close-match")).toBeVisible();

    /*
     * The retirement breadcrumb, held by this test (D41).
     *
     * A closed game's lane retires and releases its push subscription. When it
     * did not, the only evidence was a subscription still standing at the relay,
     * which "released the wrong address" and "never released at all" both
     * produce. Captured from here, before the close, so the line is the one the
     * close caused.
     */
    const retiredLines = (page: Page): string[] => {
      const lines: string[] = [];
      page.on("console", (message) => {
        const text = message.text();
        if (/^dai: lane [0-9a-f]{12} retired: /.test(text)) lines.push(text);
      });
      return lines;
    };
    const retiredA = retiredLines(pageA);
    const retiredB = retiredLines(pageB);

    // A closes the match — a session act, separate button, only after the result.
    await appA.locator("#close-match").click();
    await appA.locator("#confirm-yes").click();
    await expect(appA.locator("#move-step")).toContainText("MATCH CLOSED", { timeout: 30_000 });
    // Closed means no new rows, not invisible: the board and its moves still show.
    await expect(appA.locator("#move-history")).toContainText("e5");
    // A `_dai_close` row now names the session.
    const closedOnA = await appFrame(pageA).evaluate(() =>
      (window as any).daiKit.db.selectObjects("SELECT count(*) AS n FROM _dai_close_current")[0].n,
    );
    expect(Number(closedOnA), "a close row was authored").toBeGreaterThan(0);

    // Both the resignation and the close cross the mailbox: B sees the result and
    // then the closed match, with the board still readable.
    await expect(async () => {
      await pageB.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appB.locator("#turn-title")).toContainText("wins", { timeout: 2_000 });
      await expect(appB.locator("#move-step")).toContainText("MATCH CLOSED", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(appB.locator("#move-history")).toContainText("e5");

    // Both copies said their lane retired. Polled for rather than asserted at
    // once, because retirement follows the last publish and pull, not the close.
    await expect.poll(() => retiredA.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(async () => {
      await pageB.evaluate(() => (window as any).__runner.pullMailbox());
      expect(retiredB.length, "the copy that learned of the close says its lane retired").toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * A closed game's lane does not retire while its last move waits on a save
   * (identity step 4, ordering; cold review).
   *
   * A sealed batch is published only once a save holding its seal has landed,
   * and until then the frame answers the publish with the batch held back. A
   * lane that took that answer for "nothing left to send" would retire, release
   * its push, and never send the close. Here A's store refuses every write, A
   * closes the match, and the lane must say it is held back rather than retire;
   * then the store takes writes again, the save lands, the close is sent, and
   * only then does the lane retire.
   */
  test("a closed game's lane does not retire while its close waits on a save that has not landed", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const { appFrame: appA, link } = await startGameAndShare(pageA, container, "Ada", "Bo", "e2", "e4");
    const appB = await openLink(pageB, link);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    await appA.locator("#game-actions-button").click();
    await appA.locator("#resign").click();
    await appA.locator("#confirm-yes").click();
    await expect(appA.locator("#close-match")).toBeVisible({ timeout: 30_000 });

    const retired: string[] = [];
    const heldBack: string[] = [];
    pageA.on("console", (message) => {
      const text = message.text();
      if (/^dai: lane [0-9a-f]{12} retired: /.test(text)) retired.push(text);
      if (/^dai: lane [0-9a-f]{12} not retired: .*nothing left to send/.test(text)) heldBack.push(text);
    });

    // A's store refuses: the file system, and the fallback the host falls to.
    await pageA.evaluate(() => {
      const w = window as any;
      if (typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype) {
        w.__keptCreateWritable = (FileSystemFileHandle.prototype as any).createWritable;
        (FileSystemFileHandle.prototype as any).createWritable = () => Promise.reject(new Error("test: the disk refused"));
      }
      w.__keptPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: any[]) {
        if (this.name === "sqlite_databases") throw new DOMException("test: the disk refused", "QuotaExceededError");
        return w.__keptPut.apply(this, args);
      } as any;
    });

    await appA.locator("#close-match").click();
    await appA.locator("#confirm-yes").click();
    await expect(appA.locator("#move-step")).toContainText("MATCH CLOSED", { timeout: 30_000 });
    // The publish ran and the lane decided: held back, or (wrongly) retired.
    await expect.poll(() => heldBack.length + retired.length, { timeout: 60_000 }).toBeGreaterThan(0);
    expect(retired, "no retirement while the close has not been sent").toEqual([]);
    expect(heldBack.length, "the lane says what holds it").toBeGreaterThan(0);

    // The store takes writes again: the retry lands, the close is sent, B sees it,
    // and then the lane retires.
    await pageA.evaluate(() => {
      const w = window as any;
      if (w.__keptCreateWritable) (FileSystemFileHandle.prototype as any).createWritable = w.__keptCreateWritable;
      IDBObjectStore.prototype.put = w.__keptPut;
    });
    await expect(async () => {
      await pageB.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appB.locator("#move-step")).toContainText("MATCH CLOSED", { timeout: 2_000 });
    }).toPass({ timeout: 120_000 });
    await expect.poll(() => retired.length, { timeout: 60_000 }).toBeGreaterThan(0);

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * Under close=creator, only the creator may close — refused by name otherwise.
   *
   * Chess ships close=any; this uses a close=creator build of the same app so the
   * gated path actually runs (T1-D32). It asserts two facts a close=any run
   * cannot: a non-creator's close is refused by name, and the creator's is
   * honored. The refusal also proves the policy is *delivered* to the frame —
   * were it not, the non-creator's close would succeed, indistinguishable from a
   * delivered "any". A is the creator (it authored the seats); B joined.
   */
  test("close=creator: a non-creator's close is refused by name; the creator's is honored", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const { appFrame: appA, link } = await startGameAndShare(pageA, creatorContainer, "Ada", "Bo", "e2", "e4");
    const appB = await openLink(pageB, link);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    await play(appB, "e7", "e5");
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#move-history")).toContainText("e5", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    // A resigns so the game is finished — the Close match control needs a result.
    await appA.locator("#game-actions-button").click();
    await appA.locator("#resign").click();
    await appA.locator("#confirm-yes").click();
    await expect(appA.locator("#turn-title")).toContainText("wins", { timeout: 30_000 });

    // B (the non-creator) sees the finished game, then tries to close it.
    await expect(async () => {
      await pageB.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appB.locator("#close-match")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await appB.locator("#close-match").click();
    await appB.locator("#confirm-yes").click();
    // Refused by name: the toast carries the refusal code, and no close row was
    // written — the session is not closed on B.
    await expect(appB.locator("#toast")).toContainText("CLOSE_NOT_PERMITTED", { timeout: 10_000 });
    const closedOnB = await appFrame(pageB).evaluate(() =>
      (window as any).daiKit.db.selectObjects("SELECT count(*) AS n FROM _dai_close_current")[0].n,
    );
    expect(Number(closedOnB), "a non-creator's close wrote nothing").toBe(0);

    // A (the creator) closes it, and it is honored.
    await appA.locator("#close-match").click();
    await appA.locator("#confirm-yes").click();
    await expect(appA.locator("#move-step")).toContainText("MATCH CLOSED", { timeout: 30_000 });
    const closedOnA = await appFrame(pageA).evaluate(() =>
      (window as any).daiKit.db.selectObjects("SELECT count(*) AS n FROM _dai_close_current")[0].n,
    );
    expect(Number(closedOnA), "the creator's close was honored").toBeGreaterThan(0);

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * Roles, at the write surface (D15): each party writes its own table, and is
   * refused the other's by name — with the direction said.
   *
   * A creator writing a joiner-only table and a joiner writing a creator-only one
   * are different mistakes with different fixes, so the refusal names which, and
   * the table. This is the correctness check on a copy's own writes; the merge,
   * which is where a role actually holds against a copy that enforced nothing,
   * is proven in session-roles.spec.ts.
   */
  test("roles: each party writes only its own table, and is refused the other's by name", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    // A starts the game, so A authored the seats: A is the creator, B the joiner.
    const { link } = await startGameAndShare(pageA, rolesContainer, "Ada", "Bo", "e2", "e4");
    const appB = await openLink(pageB, link);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });

    /** Write one row into `table` under the active game's session; "written" or the refusal. */
    const write = (page: Page, table: string): Promise<string> =>
      appFrame(page).evaluate((target) => {
        const db = (window as any).daiKit.db;
        const active = db.selectObjects("SELECT active_game_id AS g FROM settings WHERE id = 1")[0].g;
        const session = db.selectObjects(
          "SELECT lower(hex(_r_session)) AS s FROM games_current WHERE lower(hex(_r_entity)) = ?",
          [active],
        )[0].s;
        try {
          (window as any).dai.replicated.insert(target, { note: `into ${target}` }, session);
          return "written";
        } catch (error: any) {
          return String((error && error.message) || error);
        }
      }, table);
    /*
     * Rows in `table` that this copy itself authored.
     *
     * Not every row in the table: the other party's permitted rows arrive over the
     * relay, and are meant to. The first version counted the whole table, and it
     * passed locally only because the relay had not delivered yet; in CI it had,
     * so the joiner's copy held the creator's legitimate advice and the count read
     * 1 where the claim — "a refused write left nothing behind" — is about this
     * copy's own rows. The check now asks the question the claim is about.
     */
    const ownRowsIn = async (page: Page, table: string): Promise<number> =>
      Number(
        await appFrame(page).evaluate(
          (target) =>
            (window as any).daiKit.db.selectObjects(
              `SELECT count(*) AS n FROM ${target} WHERE _r_replica = (SELECT id FROM _dai_replica)`,
            )[0].n,
          table,
        ),
      );

    // The creator: its own table is written; the joiner's is refused, saying so.
    expect(await write(pageA, "advice"), "the creator writes a creator-only table").toBe("written");
    const creatorRefused = await write(pageA, "answers");
    expect(creatorRefused).toContain("ROLE_NOT_PERMITTED");
    expect(creatorRefused, "and names the direction and the table").toContain("the creator wrote answers");

    // The joiner: its own table is written; the creator's is refused, saying so.
    expect(await write(pageB, "answers"), "the joiner writes a joiner-only table").toBe("written");
    const joinerRefused = await write(pageB, "advice");
    expect(joinerRefused).toContain("ROLE_NOT_PERMITTED");
    expect(joinerRefused, "and names the direction and the table").toContain("the joiner wrote advice");

    /*
     * Force the condition that failed in CI, rather than hope a run reaches it.
     *
     * The relay delivers each party's permitted row to the other copy; in CI it
     * had done so before the counts ran, and locally it had not. So both copies
     * pull until each holds the other's row — and the other party's row is not
     * only stored but admitted, which is the role rule doing its job end to end in
     * the real runtime: the creator's advice is admitted on the joiner's copy, and
     * the joiner's answer on the creator's.
     */
    const allRowsIn = async (page: Page, view: string): Promise<number> =>
      Number(
        await appFrame(page).evaluate(
          (target) => (window as any).daiKit.db.selectObjects(`SELECT count(*) AS n FROM ${target}`)[0].n,
          view,
        ),
      );
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await pageB.evaluate(() => (window as any).__runner.pullMailbox());
      expect(await allRowsIn(pageB, "advice_current"), "the creator's advice is admitted on the joiner's copy").toBe(1);
      expect(await allRowsIn(pageA, "answers_current"), "the joiner's answer is admitted on the creator's copy").toBe(1);
    }).toPass({ timeout: 30_000 });

    // A refused write left nothing behind; a permitted one landed.
    expect(await ownRowsIn(pageA, "advice"), "the creator's permitted write landed").toBe(1);
    expect(await ownRowsIn(pageA, "answers"), "the creator's refused write left no row of its own").toBe(0);
    expect(await ownRowsIn(pageB, "answers"), "the joiner's permitted write landed").toBe(1);
    expect(await ownRowsIn(pageB, "advice"), "the joiner's refused write left no row of its own").toBe(0);

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * A forwarded invite contests the seat (identity step 5). Two different
   * devices open one invite and both ask for the open seat before the creator's
   * copy has seen either ask. Nobody is seated by a clock or an author id: the
   * seat is held by whoever the creator's copy confirms, and it confirms only a
   * seat exactly one device asked for. So neither is seated, the creator is
   * shown the contest and the repair, and the repair (a fresh seat) retires the
   * value both asked for, so both copies are told their place is gone. The
   * intended player opens the fresh invite and is seated; the move it wrote
   * while waiting for the old seat never stands. One outcome, whatever the ids.
   *
   * The creator's copy is kept from reading its mailbox while the two open, so
   * both asks are there when it next looks. A creator whose copy sees one ask
   * first seats that one, and a later ask is not a contest (a hold never moves);
   * that case is "reopening the invite" and the seat tests, not this one.
   */
  test("a forwarded invite contests the seat, nobody is seated, both are told, and the creator repairs", async ({ browser }) => {
    /*
     * A's worker is blocked, because A's reads are refused by a context route
     * below and on WebKit a route never sees a request from a page the worker
     * controls, cross-origin relay included (D119). Measured: A made twelve relay
     * requests in the window, Playwright's page events and the page's own
     * Resource Timing both saw them, and the route saw none; with the worker
     * blocked it saw eleven and refused eight. Until then this test stopped at
     * its setup check on WebKit and tested nothing there.
     */
    const deviceA: BrowserContext = await browser.newContext({ serviceWorkers: "block" });
    const deviceB: BrowserContext = await browser.newContext();
    const deviceC: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    await mountStore(deviceC);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();
    const pageC = await deviceC.newPage();
    const pull = (p: Page) => p.evaluate(() => (window as any).__runner.pullMailbox());

    // A starts a game and shares one invite. From here until both have opened it,
    // A's copy cannot read its mailbox, so it sees neither ask before the other.
    const { appFrame: appA, link } = await startGameAndShare(pageA, container, "Ada", "Bo", "e2", "e4");
    let blocked = 0;
    const blockReads = (route: import("@playwright/test").Route) =>
      route.request().method() === "GET" ? (blocked++, route.abort()) : route.continue();
    await deviceA.route(`${relayBase}/**`, blockReads);

    // B opens it and asks for the seat, and plays e5 while waiting: its own board
    // shows the move, and no other copy admits it until B is seated.
    const appB = await openLink(pageB, link);
    await expect(appB.locator("#app")).toBeVisible({ timeout: 60_000 });
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    await play(appB, "e7", "e5");
    await expect(appB.locator("#move-history")).toContainText("e5");
    // C opens the *same* invite on a different device — the forward.
    const appC = await openLink(pageC, link);
    await expect(appC.locator("#app")).toBeVisible({ timeout: 60_000 });

    // Over the mailbox the creator's copy merges one batch at a time, so it seats
    // whichever ask it reads first, and a later one is not a contest. A contest
    // is two asks reaching the creator's copy in one merge. So: C's copy, whose
    // reads were never cut, gathers both asks, and C sends its copy to A, who
    // opens it into her own. A's copy was really kept from reading until then.
    const askersOn = (page: Page) =>
      app(page).locator("body").evaluate(
        () =>
          (window as any).daiKit.db.selectObjects(
            "SELECT max(n) n FROM (SELECT count(DISTINCT b._r_replica) n FROM _dai_binding_current b JOIN _dai_open_seat s ON s.session = b._r_session AND s.seat = b.seat GROUP BY s.session, s.seat)",
          )[0].n,
      );
    await expect(async () => {
      await pull(pageC);
      expect(await askersOn(pageC), "C's copy holds both asks for the open seat").toBe(2);
    }).toPass({ timeout: 30_000 });
    expect(blocked, "A's copy tried to read and was refused while the two opened").toBeGreaterThan(0);
    await pageC.evaluate(() => {
      (window as any).__copied = undefined;
      navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
    });
    await pageC.click("#more");
    await pageC.click("#send");
    await pageC.click("#send-go");
    await expect.poll(() => pageC.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 }).not.toBeNull();
    const fromC = await pageC.evaluate(() => (window as any).__copied as string);
    await pageA.goto(fromC);
    await pageA.locator("#card-open").click({ timeout: 60_000 });
    await expect(appA.locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageA);

    // Both asks reached A's copy together. It seats neither: the creator is
    // shown the contest and offered the repair.
    expect(await askersOn(pageA), "A's copy holds both asks").toBe(2);
    await expect(appA.locator("#new-invite")).toBeVisible({ timeout: 30_000 });
    const member = (page: Page) =>
      appFrame(page).evaluate(() => {
        const kit = (window as any).daiKit;
        const session = kit.db.selectObjects("SELECT lower(hex(_r_session)) s FROM games_current WHERE white_name = 'Ada'")[0]?.s;
        return session ? kit.mySeat(session) !== null : false;
      });
    await pull(pageB);
    await pull(pageC);
    expect(await member(pageB), "B is not seated").toBe(false);
    expect(await member(pageC), "C is not seated").toBe(false);
    await expect(appA.locator("#move-history"), "B's e5 does not stand on A's copy").not.toContainText("e5");

    // A mints a fresh seat, then shares a new invite — a fresh snapshot carrying
    // the new open seat, so the opener does not depend on mailbox timing.
    await appA.locator("#new-invite").click();
    await appA.locator("#confirm-yes").click();
    await deviceA.unroute(`${relayBase}/**`, blockReads);

    // The seat both asked for is retired, so both are told their place is gone,
    // that nothing they did lost it, and that the creator can send a new invite.
    for (const [page, frame] of [[pageB, appB], [pageC, appC]] as const) {
      await expect(async () => {
        await pull(page);
        await expect(frame.locator("#contested-banner")).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await expect(frame.locator("#contested-banner")).toContainText("used on another device");
      await expect(frame.locator("#play-move")).toBeDisabled();
    }

    // Safe default (T1-D34): an untagged dai:merged must NOT join. C now holds the
    // fresh open seat over the mailbox and is not a member — the exact state where
    // an unsafe default would auto-bind it. A source-less merge event must leave it
    // out, so a future dispatch site that forgets the `via` tag cannot silently
    // reintroduce auto-rebinding. (The carrier positive is proven by B, below.)
    await expect(async () => {
      await pull(pageC);
      const openForC = await appFrame(pageC).evaluate(() =>
        (window as any).daiKit.db.selectObjects(
          "SELECT 1 FROM _dai_open_seat s WHERE lower(hex(s.seat)) NOT IN " +
            "(SELECT lower(hex(b.seat)) FROM _dai_binding_current b WHERE b._r_session = s.session) LIMIT 1",
        ).length > 0,
      );
      expect(openForC, "the fresh open seat reached C").toBe(true);
    }).toPass({ timeout: 30_000 });
    const cMemberAfterUntagged = await appFrame(pageC).evaluate((mergedType) => {
      const db = (window as any).daiKit.db;
      window.dispatchEvent(new CustomEvent(mergedType, { detail: { applied: 1 } })); // no `via`
      const me = db.selectObjects("SELECT lower(hex(id)) id FROM _dai_replica")[0].id;
      return db.selectObjects("SELECT 1 FROM _dai_member WHERE lower(hex(replica)) = ?", [me]).length > 0;
    }, FRAME_PUBLIC.MERGED);
    expect(cMemberAfterUntagged, "an untagged merge event must not join").toBe(false);

    await pageA.evaluate(() => {
      (window as any).__copied = undefined;
      navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
    });
    await pageA.locator("#more").click();
    await pageA.locator("#send").click();
    await pageA.locator("#send-go").click();
    await expect
      .poll(() => pageA.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 })
      .not.toBeNull();
    const link2 = await pageA.evaluate(() => (window as any).__copied as string);

    // B opens the new invite on a fresh page — a deliberate open, so join runs on
    // init and B takes the fresh seat. The same rows arriving by mailbox alone
    // (as C gets them) never re-seat anyone (T1-D34).
    const pageB2 = await deviceB.newPage();
    await pageB2.goto(link2);
    // The new invite is a newer copy of a document this device holds, so it
    // arrives as a sibling merge: the person accepts it, which merges the fresh
    // seat into B's own copy (its replica kept) and re-runs join on mount.
    await pageB2.locator("#card-open").click({ timeout: 60_000 });
    const appB2 = app(pageB2);
    await expect(appB2.locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageB2);
    // B asked for the fresh seat; A's copy, seeing one ask, seats B.
    await letIn(pageA, pageB2);
    await expect(appB2.locator("#contested-banner")).toBeHidden({ timeout: 30_000 });
    const bIsMember = await appFrame(pageB2).evaluate(() => {
      const db = (window as any).daiKit.db;
      const me = db.selectObjects("SELECT lower(hex(id)) id FROM _dai_replica")[0].id;
      return db.selectObjects("SELECT 1 FROM _dai_member WHERE lower(hex(replica)) = ?", [me]).length > 0;
    });
    expect(bIsMember, "B is seated in the fresh seat on opening the new invite").toBe(true);
    // B's e5 was written for the seat the repair retired, which nobody was ever
    // seated in: it never stands, on B's copy or A's.
    await expect(appB2.locator("#move-history")).toContainText("e4");
    await expect(appB2.locator("#move-history")).not.toContainText("e5");
    await expect(appA.locator("#move-history")).not.toContainText("e5");

    // C, which only receives the reseat over the mailbox and never opens the new
    // invite, does not silently re-enter: it stays out, and stays told so.
    await pull(pageC);
    await expect(appC.locator("#contested-banner")).toBeVisible();
    const cIsMember = await appFrame(pageC).evaluate(() => {
      const db = (window as any).daiKit.db;
      const me = db.selectObjects("SELECT lower(hex(id)) id FROM _dai_replica")[0].id;
      return db.selectObjects("SELECT 1 FROM _dai_member WHERE lower(hex(replica)) = ?", [me]).length > 0;
    });
    expect(cIsMember, "C does not re-enter on a merge").toBe(false);

    await deviceA.close();
    await deviceB.close();
    await deviceC.close();
  });

  /**
   * Reseat refuses on a healthy session and the honest joiner keeps their moves.
   *
   * Reseating replaces the open seat's value, dropping every binding to the old
   * one — a repair for a seat two parties opened, and damage to a seat one honest
   * joiner holds (T1-D29). So it must refuse unless a seat is actually contested.
   * Here the game has exactly one honest binding; a reseat is refused by name and
   * the joiner's move stays admitted.
   */
  test("reseat refuses on a healthy session, so an honest joiner is not ejected", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const { appFrame: appA, link } = await startGameAndShare(pageA, container, "Ada", "Bo", "e2", "e4");
    const appB = await openLink(pageB, link);
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    await play(appB, "e7", "e5");
    // A pulls B's move and binding: the game is now healthy — A's creator seat and
    // B's seat, one binder each, no contest.
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#move-history")).toContainText("e5", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    // Call reseat directly on this healthy session. It must refuse by name rather
    // than pick a seat by row order and eject the joiner.
    const outcome = await appFrame(pageA).evaluate(() => {
      const db = (window as any).daiKit.db;
      const active = db.selectObjects("SELECT active_game_id AS g FROM settings WHERE id = 1")[0].g;
      const sess = db.selectObjects(
        "SELECT lower(hex(_r_session)) AS s FROM games_current WHERE lower(hex(_r_entity)) = ?",
        [active],
      )[0].s;
      try {
        (window as any).dai.replicated.session.reseat(sess);
        return "did-not-refuse";
      } catch (e: any) {
        return String((e && e.message) || e);
      }
    });
    expect(outcome, "reseat on a healthy session is refused by name").toContain("CANNOT_RESEAT");

    // The joiner keeps their seat and their move: nothing was dropped.
    await expect(appA.locator("#move-history")).toContainText("e5");
    const bStillMember = await appFrame(pageA).evaluate(() =>
      (window as any).daiKit.db.selectObjects("SELECT count(*) AS n FROM _dai_member")[0].n,
    );
    expect(Number(bStillMember), "both players are still members").toBeGreaterThanOrEqual(2);

    await deviceA.close();
    await deviceB.close();
  });

  /*
   * Two people inviting each other, in all four orders they can do it in
   * (backlog D37).
   *
   * The defect: two people who invited each other were shown as though they were
   * in two different games, with both boards looking healthy.
   * The cause was that a key meant "this document" and "this game" at once, so
   * whoever invited second re-keyed everything the first had — every mailbox
   * address is derived from that key, so each published moves the other never
   * read, in silence.
   *
   * The finding underneath is that nothing in this suite ever had **two people
   * act**. Every test had one inviter. So these force the orders rather than
   * hoping for one: each is deterministic, and none waits on a race.
   */
  /** Open the chess container on a fresh page and wait for the board. */
  async function openContainer(page: Page): Promise<FrameLocator> {
    await page.goto(RUNNER_URL);
    await page.setInputFiles("#file", container);
    await page.locator("#card-open").click({ timeout: 60_000 });
    const opened = app(page);
    await expect(opened.locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(page);
    return opened;
  }

  /** The keys this copy holds per game, as `<session>:<key>`. Two copies of one game must agree. */
  const keysHeld = (page: Page): Promise<string[]> =>
    page.evaluate(async () => {
      const items = (await (window as any).__runner.listLibrary()) as { sessionKeys?: Record<string, string> }[];
      return items.flatMap((item) => Object.entries(item.sessionKeys ?? {}).map(([s, k]) => `${s}:${k}`));
    });

  /** Every move this copy holds, as `<san>@<session>` — a move checked in the game it belongs to. */
  const movesHeld = (page: Page): Promise<string[]> =>
    appFrame(page).evaluate(() =>
      (window as any).daiKit.db
        .selectObjects(
          "SELECT m.san AS san, lower(hex(g._r_session)) AS s FROM moves_current m" +
            " JOIN games_current g ON lower(hex(g._r_entity)) = m.game_id ORDER BY m.ply",
        )
        .map((r: any) => `${String(r.san)}@${String(r.s)}`),
    );

  /** The session of the game this copy is showing. */
  const activeSession = (page: Page): Promise<string> =>
    appFrame(page).evaluate(() => {
      const db = (window as any).daiKit.db;
      const active = db.selectObjects("SELECT active_game_id AS g FROM settings WHERE id = 1")[0].g;
      return String(
        db.selectObjects("SELECT lower(hex(_r_session)) AS s FROM games_current WHERE lower(hex(_r_entity)) = ?", [
          active,
        ])[0].s,
      );
    });

  /** Pull until a move lands, in the game it belongs to. The poll is the app's own. */
  async function reaches(page: Page, want: string, why: string): Promise<void> {
    await expect(async () => {
      await page.evaluate(() => (window as any).__runner.pullMailbox());
      expect(await movesHeld(page), why).toContain(want);
    }).toPass({ timeout: 30_000 });
  }

  /** A copy that took an open seat is asked to name itself, once. */
  async function nameIfAsked(page: Page, name: string, inviter?: string): Promise<void> {
    const dialog = app(page).locator("#name-dialog");
    if (await dialog.waitFor({ state: "visible", timeout: 20_000 }).then(() => true, () => false)) {
      // Who invited is the other player, never this one (D65: both were once "Ada").
      if (inviter) await expect(app(page).locator("#name-detail")).toContainText(`${inviter} invited you`);
      await app(page).locator("#my-name").fill(name);
      await app(page).locator("#name-form button[type=submit]").click();
    }
  }

  test("an invite carries the game it opens, and both copies key that game the same way", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    /*
     * The lane breadcrumb, held by a test so it cannot rot (backlog D39).
     *
     * Which address each copy derives for a game — and from whose key — is the
     * fact that took two rounds of a throwaway probe to reach, and the probe was
     * wrong about itself twice on the way. The instrument lives in the product
     * now; this is what keeps it honest, because a breadcrumb nothing checks is
     * one nobody notices going quiet.
     */
    const laneLines = (page: Page): string[] => {
      const lines: string[] = [];
      page.on("console", (message) => {
        const text = message.text();
        if (text.startsWith("dai: lane for game")) lines.push(text);
      });
      return lines;
    };
    const lanesA = laneLines(pageA);
    const lanesB = laneLines(pageB);
    const addressFor = (lines: string[], game: string): string | undefined =>
      lines.find((line) => line.includes(`lane for game ${game.slice(0, 8)}`))?.match(/-> ([0-9a-f]{12})/)?.[1];

    const appA = await openContainer(pageA);
    await openContainer(pageB);
    const link = await inviteNewGame(pageA, appA);
    const session = await activeSession(pageA);

    // The game travels in the link beside the key, because the receiving host
    // holds ciphertext and cannot read the document's tables to find out which
    // game a key opens.
    expect(new URL(link).hash, "the invite names the game its key opens").toContain(`s=${session}`);

    await pageB.goto(link);
    await pageB.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(pageB).locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageB);
    await nameIfAsked(pageB, "Bo", "Ada");

    // Both copies hold the same key for that game — which is what makes their
    // derived mailbox addresses agree.
    await expect
      .poll(async () => (await keysHeld(pageB)).filter((k) => k.startsWith(`${session}:`)), { timeout: 30_000 })
      .toEqual(await keysHeld(pageA).then((keys) => keys.filter((k) => k.startsWith(`${session}:`))));

    await play(app(pageB), "e7", "e5");
    await reaches(pageA, `e5@${session}`, "B's reply reaches A in the game they share");

    // Both copies said out loud where that game publishes, and said the same
    // thing. Two different addresses here is the whole of D37, in two lines.
    await expect.poll(() => addressFor(lanesA, session), { timeout: 30_000 }).toBeTruthy();
    await expect.poll(() => addressFor(lanesB, session), { timeout: 30_000 }).toBeTruthy();
    expect(
      addressFor(lanesB, session),
      "both copies derive the same relay address for the game they share",
    ).toBe(addressFor(lanesA, session));

    await deviceA.close();
    await deviceB.close();
  });

  for (const withData of [false, true]) {
  test(`both invite before either opens, and each game still reaches the other copy${withData ? " (with data)" : ""}`, async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const appA = await openContainer(pageA);
    const appB = await openContainer(pageB);

    // The reported order: each mints an invite before either has opened one, so
    // under one key per document the two copies held different keys from here on.
    const linkFromA = await inviteNewGame(pageA, appA, "Ada", { withData });
    const sessionA = await activeSession(pageA);
    const linkFromB = await inviteNewGame(pageB, appB, "Bo", { withData });
    const sessionB = await activeSession(pageB);
    expect(sessionA, "two invites are two different games").not.toBe(sessionB);

    await pageB.goto(linkFromA);
    await pageB.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(pageB).locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageB);
    await nameIfAsked(pageB, "Bo", "Ada");

    await pageA.goto(linkFromB);
    await pageA.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(pageA).locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageA);
    await nameIfAsked(pageA, "Ada", "Bo");

    // B replies in A's game, and A replies in B's. Both must arrive: the failure
    // this guards is both of them looking healthy and neither hearing anything.
    await play(app(pageB), "e7", "e5");
    await reaches(pageA, `e5@${sessionA}`, "B's reply in A's game reaches A");

    await play(app(pageA), "e7", "e5");
    await reaches(pageB, `e5@${sessionB}`, "A's reply in B's game reaches B");

    // And opening the other's invite left each copy's own game keyed as it was:
    // the stranding half of D37, where an arriving key re-keyed everything held.
    expect(await keysHeld(pageA), "A still holds its own game's key").toEqual(
      expect.arrayContaining([expect.stringContaining(`${sessionA}:`)]),
    );
    expect(await keysHeld(pageB), "B still holds its own game's key").toEqual(
      expect.arrayContaining([expect.stringContaining(`${sessionB}:`)]),
    );

    await deviceA.close();
    await deviceB.close();
  });

  test(`the same crossed invites in the other opening order reach each other too${withData ? " (with data)" : ""}`, async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const appA = await openContainer(pageA);
    const appB = await openContainer(pageB);
    const linkFromA = await inviteNewGame(pageA, appA, "Ada", { withData });
    const sessionA = await activeSession(pageA);
    const linkFromB = await inviteNewGame(pageB, appB, "Bo", { withData });
    const sessionB = await activeSession(pageB);

    // A opens first this time. Opening order is the other half of "who acted
    // first", and it decided the outcome before per-game keys.
    await pageA.goto(linkFromB);
    await pageA.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(pageA).locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageA);
    await nameIfAsked(pageA, "Ada", "Bo");

    await pageB.goto(linkFromA);
    await pageB.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(pageB).locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageB);
    await nameIfAsked(pageB, "Bo", "Ada");

    await firstMailboxMerge(pageA);
    await play(app(pageA), "e7", "e5");
    await reaches(pageB, `e5@${sessionB}`, "A's reply in B's game reaches B");

    await play(app(pageB), "e7", "e5");
    await reaches(pageA, `e5@${sessionA}`, "B's reply in A's game reaches A");

    await deviceA.close();
    await deviceB.close();
  });
  }

  test("a second invite from the same copy leaves the first game reaching its player", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const appA = await openContainer(pageA);
    await openContainer(pageB);

    const first = await inviteNewGame(pageA, appA);
    const firstSession = await activeSession(pageA);
    await pageB.goto(first);
    await pageB.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(pageB).locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageB);
    await nameIfAsked(pageB, "Bo", "Ada");

    // A second invite into a different game mints a different key. The first
    // game must keep working: under one key per document it did not, because
    // minting the second replaced the key the first was running on.
    await inviteNewGame(pageA, appA);
    const secondSession = await activeSession(pageA);
    expect(secondSession).not.toBe(firstSession);

    await play(app(pageB), "e7", "e5");
    await reaches(pageA, `e5@${firstSession}`, "the first game still reaches A after a second invite");

    await deviceA.close();
    await deviceB.close();
  });

  /*
   * A link naming a game this device holds, under a different key (backlog
   * D122; IDENTITY-KEY-HELD).
   *
   * The database is outside the signed set, so anybody holding a copy can
   * re-seal it under a key of their own and send a link naming the game. Made
   * here the way anybody holding a copy could: A's library is given another key
   * for the game (the store's own names, since the opener exports none; the
   * write is checked before anything leans on it), and A shares the game again.
   * Before the ruling, B filed the new key over the one it held, and its
   * mailbox for the game moved to an address A's partner lane never reads.
   */
  test("a link naming a held game under a different key is refused, and the held key stays", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();
    const refusals: string[] = [];
    pageB.on("console", (m) => {
      if (m.text().startsWith("dai: refused a link naming game")) refusals.push(m.text());
    });

    const appA = await openContainer(pageA);
    await openContainer(pageB);
    const first = await inviteNewGame(pageA, appA);
    const session = await activeSession(pageA);
    const keyIn = (link: string): string | undefined => new URL(link).hash.match(/[#&]k=([^&]+)/)?.[1];
    const held = keyIn(first);
    expect(held, "the invite carries the game's key").toBeTruthy();

    await pageB.goto(first);
    await pageB.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(pageB).locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageB);
    await nameIfAsked(pageB, "Bo", "Ada");
    await expect.poll(() => keysHeld(pageB), { timeout: 30_000 }).toContain(`${session}:${held}`);

    /*
     * A copy re-keyed: A's library holds another key for the same game, and A
     * shares the game again, so the link names it under that key.
     *
     * The write goes round the opener's library lock, so a locked write of A's
     * own, read before it, can put the old record back (seen once in ten on
     * WebKit: the link came out under the first key). What the next step
     * depends on is a link under the other key, so that is what is waited for.
     */
    let other = "";
    let second = "";
    await expect(async () => {
      other = await pageA.evaluate(
        ({ game }) =>
          new Promise<string>((done) => {
            const bytes = crypto.getRandomValues(new Uint8Array(32));
            const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            const open = indexedDB.open("dai_runner_storage");
            open.onerror = () => done("open failed");
            open.onsuccess = () => {
              const tx = open.result.transaction("cartridges", "readwrite");
              const store = tx.objectStore("cartridges");
              const all = store.getAll();
              all.onsuccess = () => {
                for (const item of all.result) {
                  if (!item.sessionKeys?.[game]) continue;
                  item.sessionKeys[game] = key;
                  store.put(item);
                }
              };
              tx.oncomplete = () => done(key);
              tx.onerror = () => done(`error ${String(tx.error)}`);
            };
          }),
        { game: session },
      );
      expect(await keysHeld(pageA), "A's library now holds another key for the game").toContain(`${session}:${other}`);
      await pageA.evaluate(() => {
        (window as any).__copied = undefined;
        navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
      });
      await appA.locator("#share").click();
      await pageA.locator("#send-go").click();
      await expect.poll(() => pageA.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 }).not.toBeNull();
      second = await pageA.evaluate(() => (window as any).__copied as string);
      expect(new URL(second).hash, "the second link names the same game").toContain(`s=${session}`);
      expect(keyIn(second), "under the other key").toBe(other);
    }).toPass({ timeout: 120_000 });

    // B opens it. A held copy opens without a card, so the decision point is the
    // load the link brings (a fresh navigation, or the opener's own reload at a
    // same-document one), then the sentence or the mounted copy: the key is filed
    // before either, or never.
    let loads = 0;
    pageB.on("load", () => void loads++);
    await pageB.goto(second);
    await expect.poll(() => loads, { timeout: 60_000 }).toBeGreaterThan(0);
    const sentence = pageB.locator("#report", { hasText: "This link is for a game already on this device" });
    await expect(sentence.or(pageB.locator("body.loaded"))).toBeVisible({ timeout: 60_000 });
    expect(await keysHeld(pageB), "B still holds the key it was invited with").toContain(`${session}:${held}`);
    expect(await keysHeld(pageB), "and never filed the other").not.toContain(`${session}:${other}`);
    await expect(sentence, "the person is told why the link did not open").toBeVisible();
    expect(refusals, "the refusal is reported").toHaveLength(1);
    expect(refusals[0]).toContain(session.slice(0, 8));

    await deviceA.close();
    await deviceB.close();
  });

  /** The document keys this device holds, one per document. */
  const documentKeysHeld = (page: Page): Promise<string[]> =>
    page.evaluate(async () => {
      const items = (await (window as any).__runner.listLibrary()) as { documentKey?: string }[];
      return items.flatMap((item) => (item.documentKey ? [item.documentKey] : []));
    });

  /** The host's own Send, from the menu: a link that names no game. */
  async function sendFromMenu(page: Page): Promise<string> {
    await page.evaluate(() => {
      (window as any).__copied = undefined;
      navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
    });
    await page.click("#more");
    await page.click("#send");
    await page.click("#send-go");
    await expect.poll(() => page.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 }).not.toBeNull();
    return page.evaluate(() => (window as any).__copied as string);
  }

  /**
   * The screen a refused link leaves: the sentence, and nothing over it.
   *
   * The address names a copy held here, so the page is painted as launching
   * into it, and the launch screen hides the report beneath it. A refusal that
   * leaves it up leaves the person on "This is taking longer than it should ·
   * Tap to open", which reopens the held copy without a word about the link.
   */
  async function refusedInSight(page: Page, sentence: RegExp): Promise<void> {
    await expect(page.locator("#report", { hasText: sentence }), "the person is told why the link did not open").toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator("#launch"), "and the launch screen is down").toBeHidden();
  }

  /*
   * A link naming no game, for a document this device holds under a different
   * key (backlog D122, ruled 25 September: a held key, document or game, is
   * never replaced by an arriving one; IDENTITY-KEY-HELD).
   *
   * The document's key is its mailbox for everything that is not a game with a
   * key of its own. Made the way anybody holding a copy could, as for a game:
   * A's library is given another document key, and A sends the document again
   * from the menu, which names no game.
   */
  test("a link naming a held document under a different key is refused, and the held key stays", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();
    const refusals: string[] = [];
    pageB.on("console", (m) => {
      if (m.text().startsWith("dai: refused a link naming document")) refusals.push(m.text());
    });
    const keyIn = (link: string): string | undefined => new URL(link).hash.match(/[#&]k=([^&]+)/)?.[1];

    await openContainer(pageA);
    const first = await sendFromMenu(pageA);
    expect(new URL(first).hash, "a send from the menu names no game").not.toMatch(/[#&]s=/);
    const held = keyIn(first);
    expect(held, "the link carries the document's key").toBeTruthy();
    await openLink(pageB, first);
    await expect.poll(() => documentKeysHeld(pageB), { timeout: 30_000 }).toContain(held);

    // Re-keyed round the opener's lock; waited on as the game test waits (above).
    let other = "";
    let second = "";
    await expect(async () => {
      other = await pageA.evaluate(
        () =>
          new Promise<string>((done) => {
            const bytes = crypto.getRandomValues(new Uint8Array(32));
            const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            const open = indexedDB.open("dai_runner_storage");
            open.onerror = () => done("open failed");
            open.onsuccess = () => {
              const tx = open.result.transaction("cartridges", "readwrite");
              const store = tx.objectStore("cartridges");
              const all = store.getAll();
              all.onsuccess = () => {
                for (const item of all.result) {
                  if (!item.documentKey) continue;
                  item.documentKey = key;
                  store.put(item);
                }
              };
              tx.oncomplete = () => done(key);
              tx.onerror = () => done(`error ${String(tx.error)}`);
            };
          }),
      );
      expect(await documentKeysHeld(pageA), "A's library now holds another document key").toContain(other);
      second = await sendFromMenu(pageA);
      expect(new URL(second).hash, "the second link names no game either").not.toMatch(/[#&]s=/);
      expect(keyIn(second), "under the other key").toBe(other);
    }).toPass({ timeout: 120_000 });

    let loads = 0;
    pageB.on("load", () => void loads++);
    await pageB.goto(second);
    await expect.poll(() => loads, { timeout: 60_000 }).toBeGreaterThan(0);
    // The decision point: the sentence, or the card for the copy it carries.
    // A person offered the card presses Open, and the key is read when the
    // copy's mailbox starts, so that is what is waited for before the keys.
    const sentence = /already on this device, but it does not match/;
    const card = pageB.locator("#card-open");
    await expect
      .poll(async () => ((await card.isVisible()) ? "card" : (await pageB.locator("#report", { hasText: sentence }).count()) ? "refused" : ""), {
        timeout: 60_000,
      })
      .not.toBe("");
    if (await card.isVisible()) {
      await card.click();
      await expect(app(pageB).locator("#app")).toBeVisible({ timeout: 60_000 });
      await useRelay(pageB);
      await expect.poll(() => pageB.evaluate(() => (window as any).__runner.mailboxPolls !== undefined), { timeout: 30_000 }).toBe(true);
    }
    expect(await documentKeysHeld(pageB), "B still holds the key it was sent").toContain(held);
    expect(await documentKeysHeld(pageB), "and never filed the other").not.toContain(other);
    await refusedInSight(pageB, sentence);
    expect(refusals, "the refusal is reported").toHaveLength(1);

    await deviceA.close();
    await deviceB.close();
  });

  /*
   * A link to a document this device holds, published by somebody else
   * (backlog D122, ruled 25 September: every refusal on the arrival path takes
   * the launch screen down). The same id under another publisher's key, as a
   * stranger can make: the id is in every copy. A sends somebody else's copy;
   * B holds the genuine one, opened and so kept.
   */
  async function heldAndAStrangersLink(
    browser: Browser,
  ): Promise<{ deviceA: BrowserContext; deviceB: BrowserContext; link: string }> {
    const uuid = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "dai-two-publishers-"));
    const build = async (key: string, name: string): Promise<string> => {
      const built = await compileDirectory({
        sourceDir: join(repo, "tests", "fixture", "chess"),
        root: repo,
        appName: "Velvet Chess",
        documentUuid: uuid,
        signingKey: resolve(repo, key),
        // As trust-consent.spec.ts builds its two publishers: a signing key
        // alone makes version 4, which this opener does not read.
        manifestVersion: 3,
      });
      const path = join(dir, name);
      writeFileSync(path, built.html, "utf8");
      return path;
    };
    const ours = await build("conformance/trust-publisher-a-key.pem", "ours.dai.html");
    const theirs = await build("conformance/trust-publisher-b-key.pem", "theirs.dai.html");

    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    await pageA.goto(RUNNER_URL);
    await pageA.setInputFiles("#file", theirs);
    await pageA.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(pageA).locator("#app")).toBeVisible({ timeout: 60_000 });
    const link = await sendFromMenu(pageA);

    await pageB.goto(RUNNER_URL);
    await pageB.setInputFiles("#file", ours);
    await pageB.locator("#card-open").click({ timeout: 60_000 });
    await expect(app(pageB).locator("#app")).toBeVisible({ timeout: 60_000 });
    return { deviceA, deviceB, link };
  }

  /** Opens a link on a fresh page of the context and waits for the load it brings. */
  async function arriveAt(context: BrowserContext, link: string): Promise<Page> {
    const page = await context.newPage();
    let loads = 0;
    page.on("load", () => void loads++);
    await page.goto(link);
    await expect.poll(() => loads, { timeout: 60_000 }).toBeGreaterThan(0);
    return page;
  }

  test("a link to a held document from another publisher is refused in sight", async ({ browser }) => {
    const { deviceA, deviceB, link } = await heldAndAStrangersLink(browser);
    // A kept copy is pinned when it is opened, so the pin answers first. The
    // refusal named in the ruling, "published by somebody else", sits behind
    // it and is not reached even with the pin gone: backlog D126.
    const page = await arriveAt(deviceB, link);
    await refusedInSight(page, /different publisher/);
    await expect(page.locator("#card-open")).toBeHidden();
    await deviceA.close();
    await deviceB.close();
  });

  /** Every row the question turns on, as this copy holds it. */
  const seatRows = (page: Page) =>
    appFrame(page).evaluate(() => {
      const db = (window as any).daiKit.db;
      // The invited game only: the app also holds a demo game in a session of its own.
      const session = db.selectObjects("SELECT _r_session s FROM games_current WHERE white_name = 'Ada'")[0]?.s;
      const q = (sql: string) => db.selectObjects(sql, [session]);
      return {
        me: String(db.selectObjects("SELECT lower(hex(id)) id FROM _dai_replica")[0]?.id ?? ""),
        members: q("SELECT lower(hex(replica)) r FROM _dai_member WHERE session = ? ORDER BY 1").map((r: any) => String(r.r)),
        seatAuthors: q("SELECT DISTINCT lower(hex(_r_replica)) r FROM _dai_seat_current WHERE _r_session = ? ORDER BY 1").map((r: any) => String(r.r)),
        bindings: q("SELECT lower(hex(seat)) seat, lower(hex(_r_replica)) r FROM _dai_binding_current WHERE _r_session = ? ORDER BY 1, 2"),
        games: q("SELECT white_name w, black_name b, creator_color c, lower(hex(_r_replica)) r FROM games_current WHERE _r_session = ?"),
        moves: q("SELECT ply, color, san, lower(hex(_r_replica)) r FROM moves_current WHERE _r_session = ? ORDER BY ply"),
      };
    });

  /**
   * Guard for the correct path, not D80's proof: the joiner reopens the invite
   * on the same device and moves, and the move is the joiner's.
   *
   * Written while chasing D80 (19 September), where two phones ended with the
   * joiner's move admitted as the creator's. This route does not reproduce
   * that (Chromium and WebKit, and with the stored database removed first): the
   * reopened copy keeps its own id. It is kept so that path stays right. D80's
   * proof is the next test, which forces the precondition the phones reached.
   */
  test("the joiner reopens the invite and moves: the move is the joiner's, and both players stay seated", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    // Ada (White) starts a game with the opponent unnamed and invites; Bo names himself.
    const { appFrame: appA, link } = await startGameAndShare(pageA, container, "Ada", "", "e2", "e4");
    const appB = await openLink(pageB, link);
    await nameIfAsked(pageB, "Bo", "Ada");
    await expect(appB.locator("#bottom-player")).toContainText("Bo");

    // Bo plays e5, Ada hears it and plays Nf3, Bo hears that: Bo to move.
    await play(appB, "e7", "e5");
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#move-history")).toContainText("e5", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await play(appA, "g1", "f3");
    await expect(async () => {
      await pageB.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appB.locator("#move-history")).toContainText("Nf3", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const bo = (await seatRows(pageB)).me;

    // Bo opens the invite again on the same device: the link, and the card's Open.
    await pageB.close();
    const pageB2 = await deviceB.newPage();
    await pageB2.goto(link);
    await pageB2.locator("#card-open").click({ timeout: 60_000 });
    const appB2 = app(pageB2);
    await expect(appB2.locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageB2);
    await expect(async () => {
      await pageB2.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appB2.locator("#move-history")).toContainText("Nf3", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(appB2.locator("#bottom-player")).toContainText("Bo");

    await play(appB2, "d7", "d6");
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#move-history")).toContainText("d6", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const afterA = await seatRows(pageA);
    const afterB = await seatRows(pageB2);

    const last = afterA.moves[afterA.moves.length - 1] as { r: string; color: string };
    expect(last.r, "the move arrived as Bo's").toBe(bo);
    expect(last.color).toBe("b");
    for (const [who, rows] of [["A", afterA], ["B", afterB]] as const) {
      expect(rows.members, `${who} still holds two members`).toHaveLength(2);
      expect(rows.bindings.map((b: { r: string }) => b.r), `${who} still holds Bo's seat`).toContain(bo);
      expect(rows.games[0], `${who} still names both players`).toMatchObject({ w: "Ada", b: "Bo" });
    }

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * A copy can seat itself as any player, and the other copy believes it (D80).
   *
   * Found on two phones, 19 September: the player who joined moved, and the
   * creator's phone announced the move as the creator's own and oriented as
   * the creator, and both copies ended holding the creator's game with the
   * joiner gone. The phones' route to it is d22 (a copy coming back under the
   * sender's id); these tests do not take that route. They force the state the
   * route produces, Bo's copy running under Ada's replica id.
   *
   * The setup both tests share: a game Ada started and Bo joined, one move each,
   * and then Bo's copy rewrites its own `_dai_replica` to Ada's id.
   */
  async function forgedPair(browser: Browser) {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    const { appFrame: appA, link } = await startGameAndShare(pageA, container, "Ada", "", "e2", "e4");
    const appB = await openLink(pageB, link);
    await nameIfAsked(pageB, "Bo", "Ada");
    await firstMailboxMerge(pageB);
    await play(appB, "e7", "e5");
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#move-history")).toContainText("e5", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const beforeA = await seatRows(pageA);
    const beforeB = await seatRows(pageB);
    console.log(`D80 before, A: ${JSON.stringify(beforeA)}`);
    console.log(`D80 before, B: ${JSON.stringify(beforeB)}`);
    expect(beforeA.members, "two players seated before").toHaveLength(2);

    // The precondition the phones reached by d22's route: Bo's copy under Ada's id.
    await appFrame(pageB).evaluate((ada) => {
      (window as any).daiKit.db.exec(`UPDATE _dai_replica SET id = x'${ada}'`);
    }, beforeA.me);
    return { deviceA, deviceB, pageA, pageB, appA, appB, beforeA, beforeB };
  }

  /** Both players still seated, on the copy given. */
  function stillSeated(who: string, rows: Awaited<ReturnType<typeof seatRows>>, bo: string): void {
    expect(rows.members, `${who} still holds two members`).toHaveLength(2);
    expect(rows.bindings.map((b: { r: string }) => b.r), `${who} still holds Bo's seat`).toContain(bo);
    expect(rows.games[0], `${who} still names both players`).toMatchObject({ w: "Ada", b: "Bo" });
  }

  /**
   * The attack itself: the forged copy moves as the creator, and the creator's
   * copy refuses the move.
   *
   * Bo's copy, under Ada's id and with nothing pulled since, believes it holds
   * White and plays d2-d4.
   *
   * Since step 2 the write is stamped with the host's key, re-asserted on
   * every write (docs/identity.md, binding rule 2), so the row reaches Ada's
   * copy honestly as Bo's. What refuses it is the seat, not the signature: a
   * signature answers who wrote a row, a seat answers whether they may, and
   * Bo, holding Black, may not play from White's seat (IDENTITY-SEAT-ADMITS in
   * src/rules.ts). The signature never refuses this path, because Bo's copy
   * signs as Bo and Bo's batch verifies. Since step 5 a move names the seat it
   * acts for, and the document admits it only from whoever held that seat when
   * it was written; Ada's copy stores the row and reports it as
   * `SEAT_NOT_HELD` with Bo's id. The forger who stamps Ada's id outside the
   * runtime is the signature's to refuse, and is held by signed-batch test 2.
   *
   * The strongest form of the forgery: the move names Ada's own seat. (A move
   * that names no seat is refused the same way; tests/seat-admission.spec.ts
   * holds that case.)
   */
  test("D80: a forged copy's move as the creator is refused by the seat, and both players stay seated", async ({ browser }) => {
    const { deviceA, deviceB, pageA, pageB, appB, beforeA, beforeB } = await forgedPair(browser);
    const refusals: string[] = [];
    pageA.on("console", (message) => {
      if (/^dai: merge refused /.test(message.text())) refusals.push(message.text());
    });

    // The forged copy writes White's move at once, around every gate an honest
    // copy passes (a hostile copy owns its frame): straight into the table, as
    // Bo (the key the host signs with) but for Ada's seat. Bo's copy then seals
    // and publishes it like any row of its own. Not through the board, and not
    // through the write surface, which refuses a seat this copy does not hold.
    // How the forger produces the row is scenery; Ada's copy refusing it is the
    // fact under test.
    await appFrame(pageB).evaluate(() => {
      const kit = (window as any).daiKit;
      const db = kit.db;
      const game = db.selectObjects(
        "SELECT lower(hex(_r_entity)) id, lower(hex(_r_session)) s FROM games_current WHERE white_name = 'Ada'",
      )[0];
      const adasSeat = kit.seats(game.s).find((seat: { creator: boolean }) => seat.creator).seat;
      const bo = kit.author();
      const tables = ["games", "moves", "game_events", "_dai_seat", "_dai_binding", "_dai_close"];
      const top = Math.max(
        ...tables.map((t) => Number(db.selectObjects(`SELECT coalesce(max(_r_seq), 0) AS n FROM "${t}" WHERE lower(hex(_r_replica)) = ?`, [bo])[0].n)),
      );
      const lc = Number(db.selectObjects("SELECT lc FROM _dai_replica")[0].lc) + 1;
      const entity = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      db.exec({
        sql:
          "INSERT INTO moves (seat, game_id, ply, color, from_sq, to_sq, promotion, san, draw_offer, " +
          "_r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_session) " +
          "VALUES (?, ?, 3, 'w', 'd2', 'd4', NULL, 'd4', 0, ?, ?, ?, ?, '[]', 0, ?)",
        bind: [kit.seatBytes(adasSeat), game.id, kit.seatBytes(bo), top + 1, lc, kit.seatBytes(entity), kit.seatBytes(game.s)],
      });
    });

    // Wait for what the refusal is about: the row arriving at Ada's copy.
    const arrived = () =>
      appFrame(pageA).evaluate(() =>
        (window as any).daiKit.db.selectObjects(
          "SELECT san, lower(hex(_r_replica)) r FROM moves WHERE san = 'd4'",
        ) as { san: string; r: string }[],
      );
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      expect(await arrived(), "the forged move reached Ada's copy").toHaveLength(1);
    }).toPass({ timeout: 30_000 });

    const afterA = await seatRows(pageA);
    const afterB = await seatRows(pageB);
    console.log(`D80 after, A: ${JSON.stringify(afterA)}`);
    console.log(`D80 after, B: ${JSON.stringify(afterB)}`);

    // Who wrote it (step 2, holds now): stamped as Bo, not as Ada.
    expect((await arrived())[0]!.r, "the move is stamped with Bo's key, not the forged id").toBe(beforeB.me);
    expect((await arrived())[0]!.r).not.toBe(beforeA.me);
    // Whether Bo may (step 5): Bo holds Black, and this move acts for White's seat.
    expect(afterA.moves.map((m: { san: string }) => m.san), "the seat refuses it: Ada's game does not admit it").not.toContain("d4");
    // And the refusal is said, with the author it belongs to.
    const bosShownId = Buffer.from(beforeB.me, "hex").toString("base64url");
    expect(refusals.join("\n"), "reported as SEAT_NOT_HELD with Bo's id").toContain(`${bosShownId} SEAT_NOT_HELD`);
    stillSeated("A", afterA, beforeB.me);

    await deviceA.close();
    await deviceB.close();
  });

  /**
   * What makes the refusal above possible: a copy whose `_dai_replica` has been
   * rewritten is back on its host's key from its next write, whatever that
   * write is. Here the write is applying Ada's next move; after it, Bo's copy
   * is Bo, and its answer reaches Ada as Bo's.
   */
  test("a rewritten _dai_replica lasts until the copy's next write, and then it writes under its host's key", async ({
    browser,
  }) => {
    const { deviceA, deviceB, pageA, pageB, appA, appB, beforeB } = await forgedPair(browser);
    await pageB.evaluate(() => (window as any).__runner.pullMailbox());

    // Ada moves. Applying it is Bo's copy's next write, and the forged id does
    // not survive it: the copy is put back to the key its host holds.
    await play(appA, "d2", "d4");
    await expect(async () => {
      await pageB.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appB.locator("#move-history")).toContainText("d4", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    expect((await seatRows(pageB)).me, "Bo's copy writes as Bo again").toBe(beforeB.me);

    // Bo answers, as Black, and it reaches Ada as Bo's.
    await play(appB, "d7", "d5");
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(appA.locator("#move-history")).toContainText("d5", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const afterA = await seatRows(pageA);
    const afterB = await seatRows(pageB);
    console.log(`D80 heal after, A: ${JSON.stringify(afterA)}`);
    console.log(`D80 heal after, B: ${JSON.stringify(afterB)}`);

    const last = afterA.moves[afterA.moves.length - 1] as { r: string };
    expect(last.r, "Bo's move is admitted as Bo's, not Ada's").toBe(beforeB.me);
    stillSeated("A", afterA, beforeB.me);
    stillSeated("B", afterB, beforeB.me);

    await deviceA.close();
    await deviceB.close();
  });
});
