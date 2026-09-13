import { createServer, type Server } from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Frame, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { fsMailbox } from "../src/mailbox-fs.js";
import { base64 } from "../src/mailbox-http.js";

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
  let container: string;
  let creatorContainer: string;
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

  /** Open a share link on a page, wait for the board, point it at the relay. */
  async function openLink(page: Page, link: string): Promise<FrameLocator> {
    await page.goto(link);
    await page.locator("#card-open").click({ timeout: 60_000 });
    const opened = app(page);
    await expect(opened.locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(page);
    return opened;
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
    await pageB2.locator("#card-merge").click({ timeout: 60_000 });
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
   * A forwarded invite contests the seat, and the state shows on both copies —
   * the exact shape the reopen bug produced (T1-D29). Two different devices open
   * one invite and bind the same seat; when the second binding merges in, neither
   * is a member and both are told so, rather than silently dropping rows into a
   * dead game. Then the creator's repair — a fresh seat — lets the one intended
   * player back in, while the other copy stays out.
   */
  test("a forwarded invite contests the seat, both copies show it, and the creator repairs", async ({ browser }) => {
    const deviceA: BrowserContext = await browser.newContext();
    const deviceB: BrowserContext = await browser.newContext();
    const deviceC: BrowserContext = await browser.newContext();
    await mountStore(deviceA);
    await mountStore(deviceB);
    await mountStore(deviceC);
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();
    const pageC = await deviceC.newPage();
    const pull = (p: Page) => p.evaluate(() => (window as any).__runner.pullMailbox());

    // A starts a game and shares one invite. B opens it and takes the seat.
    const { appFrame: appA, link } = await startGameAndShare(pageA, container, "Ada", "Bo", "e2", "e4");
    const appB = await openLink(pageB, link);
    await expect(appB.locator("#app")).toBeVisible({ timeout: 60_000 });
    // B is the sole member so far, and plays e5 — a move admitted while it holds
    // the seat, which the contest will hide and the repair must bring back.
    await expect(appB.locator("#move-history")).toContainText("e4", { timeout: 30_000 });
    await play(appB, "e7", "e5");
    await expect(appB.locator("#move-history")).toContainText("e5");
    // C opens the *same* invite on a different device — the forward.
    const appC = await openLink(pageC, link);
    await expect(appC.locator("#app")).toBeVisible({ timeout: 60_000 });

    // The two bindings meet through the mailbox: the seat is contested, and both
    // B and C are told their place is set aside — not left to silently drop moves.
    await expect(async () => {
      await pull(pageB);
      await pull(pageC);
      await expect(appB.locator("#contested-banner")).toBeVisible({ timeout: 2_000 });
      await expect(appC.locator("#contested-banner")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(appB.locator("#contested-banner")).toContainText("used on another device");
    await expect(appB.locator("#play-move")).toBeDisabled();
    // While contested, B is not a member, so its own e5 is hidden — already gone
    // before any repair, not lost by it.
    await expect(appB.locator("#move-history")).not.toContainText("e5");

    // The creator sees the contest and is offered the repair.
    await expect(async () => {
      await pull(pageA);
      await expect(appA.locator("#new-invite")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    // A mints a fresh seat, then shares a new invite — a fresh snapshot carrying
    // the new open seat, so the opener does not depend on mailbox timing.
    await appA.locator("#new-invite").click();
    await appA.locator("#confirm-yes").click();

    // Safe default (T1-D34): an untagged dai:merged must NOT join. C now holds the
    // fresh open seat over the mailbox and is not a member — the exact state where
    // an unsafe default would auto-bind it. A source-less merge event must leave it
    // out, so a future dispatch site that forgets the `via` tag cannot silently
    // reintroduce auto-rebinding. (The carrier positive is proven by B, below.)
    await expect(async () => {
      await pull(pageC);
      const openForC = await appFrame(pageC).evaluate(() =>
        (window as any).daiKit.db.selectObjects(
          "SELECT 1 FROM _dai_seat_current s WHERE lower(hex(s.seat)) NOT IN " +
            "(SELECT lower(hex(b.seat)) FROM _dai_binding_current b WHERE b._r_session = s._r_session) LIMIT 1",
        ).length > 0,
      );
      expect(openForC, "the fresh open seat reached C").toBe(true);
    }).toPass({ timeout: 30_000 });
    const cMemberAfterUntagged = await appFrame(pageC).evaluate(() => {
      const db = (window as any).daiKit.db;
      window.dispatchEvent(new CustomEvent("dai:merged", { detail: { applied: 1 } })); // no `via`
      const me = db.selectObjects("SELECT lower(hex(id)) id FROM _dai_replica")[0].id;
      return db.selectObjects("SELECT 1 FROM _dai_member WHERE lower(hex(replica)) = ?", [me]).length > 0;
    });
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
    await pageB2.locator("#card-merge").click({ timeout: 60_000 });
    const appB2 = app(pageB2);
    await expect(appB2.locator("#app")).toBeVisible({ timeout: 60_000 });
    await useRelay(pageB2);
    await expect(appB2.locator("#contested-banner")).toBeHidden({ timeout: 30_000 });
    const bIsMember = await appFrame(pageB2).evaluate(() => {
      const db = (window as any).daiKit.db;
      const me = db.selectObjects("SELECT lower(hex(id)) id FROM _dai_replica")[0].id;
      return db.selectObjects("SELECT 1 FROM _dai_member WHERE lower(hex(replica)) = ?", [me]).length > 0;
    });
    expect(bIsMember, "B rebinds the fresh seat on opening the new invite").toBe(true);
    // The load-bearing claim of T1-D34: B's e5, hidden while contested, re-emerges
    // when B is a member again — the recompute keys on the replica, so the rows
    // come back rather than being lost across the repair.
    await expect(appB2.locator("#move-history")).toContainText("e5", { timeout: 30_000 });

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
});
