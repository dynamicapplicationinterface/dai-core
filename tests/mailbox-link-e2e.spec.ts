import { createServer, type Server } from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type BrowserContext, type Frame, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { firstMailboxMerge } from "./mailbox-wait.js";
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

    // The new game, and its name step: B was never named in it. And game 1 is
    // still B's.
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
   * sender's id); this test does not take that route. It forces the state the
   * route produces, Bo's copy running under Ada's replica id, because that is
   * the whole of what the merge would need to be fooled: `_r_replica` is set by
   * the writer and trusted by the merge, and the per-game key (D37) is one both
   * copies hold, so nothing tells Ada's copy which of the two wrote a row.
   *
   * Closed at step 2 of the identity sitting (docs/identity.md, binding rules 1
   * and 2): the id a row is stamped with is the host's key, re-asserted on
   * every write, never the row in `_dai_replica`. So the forged id lasts until
   * Bo's copy next writes, which here is applying Ada's next move; from then on
   * Bo's copy is Bo, and what it writes reaches Ada as Bo's, with both players
   * still seated. A copy that forges rows outside the runtime is the merge's to
   * refuse, by signature (tests/signed-batch.spec.ts, test 2).
   */
  test("D80: a copy running under the creator's id is not believed to be the creator", async ({ browser }) => {
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
    console.log(`D80 after, A: ${JSON.stringify(afterA)}`);
    console.log(`D80 after, B: ${JSON.stringify(afterB)}`);

    const last = afterA.moves[afterA.moves.length - 1] as { r: string };
    expect(last.r, "Bo's move is admitted as Bo's, not Ada's").toBe(beforeB.me);
    for (const [who, rows] of [["A", afterA], ["B", afterB]] as const) {
      expect(rows.members, `${who} still holds two members`).toHaveLength(2);
      expect(rows.bindings.map((b: { r: string }) => b.r), `${who} still holds Bo's seat`).toContain(beforeB.me);
      expect(rows.games[0], `${who} still names both players`).toMatchObject({ w: "Ada", b: "Bo" });
    }

    await deviceA.close();
    await deviceB.close();
  });
});
