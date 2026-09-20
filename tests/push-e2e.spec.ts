import { createServer, type Server } from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type BrowserContext, type CDPSession, type Frame, type FrameLocator, type Page } from "@playwright/test";
import { FRAME_PUBLIC } from "../src/frame.js";
import { HINT_KEY } from "../src/link.js";
import { compileDirectory } from "../src/compile.js";
import type { Vapid } from "../apps/relay/src/push.js";
import { serveRelay, vapidKeys, verifyVapid, type ServedRelay } from "./relay-memory.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const RUNNER_ORIGIN = "http://localhost:5175";
const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * The app's own frame, and the first merge it takes in from its mailbox.
 *
 * A copy that has just pointed at the relay pulls, merges and redraws. A tap
 * during that redraw used to be lost (D79, fixed in the app by deferring the
 * redraw while a pointer is down). A test that taps there is racing the redraw
 * for no reason: it waits for the merge, then taps.
 */
const frameOf = (page: Page): Frame =>
  page.frames().find((f) => f.parentFrame()?.parentFrame() === page.mainFrame())!;

async function firstMailboxMerge(page: Page): Promise<void> {
  const frame = frameOf(page);
  await frame.evaluate((merged) => {
    const held = window as unknown as { __merges?: number };
    if (held.__merges !== undefined) return;
    held.__merges = 0;
    window.addEventListener(merged, (event) => {
      if ((event as CustomEvent).detail?.via === "mailbox") held.__merges = (held.__merges ?? 0) + 1;
    });
  }, FRAME_PUBLIC.MERGED);
  await expect
    .poll(() => frameOf(page).evaluate(() => (window as unknown as { __merges?: number }).__merges ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(0);
}

/**
 * A move arrives while the app is closed (Track 5, slice two).
 *
 * Carrier-first, and the one piece that is not ours named plainly: the
 * browser's push service. Headless Chromium has none — `pushManager.subscribe`
 * is refused there, measured, with permission granted — so this test stands in
 * for exactly that hop and nothing else. The subscribe call returns an
 * endpoint on a local server, and that server, on receiving a push, checks the
 * VAPID token a real push service would check and hands the push to the
 * device's service worker through the DevTools protocol. Everything either
 * side of it is the shipped code: the opener subscribes each mailbox on its
 * own, the relay is the real Durable Object deciding whom to wake, the service
 * worker asks the relay what moved and raises the notification, and the
 * notification's address opens the document with the move in it — silently,
 * no card, because the mailbox was the consent.
 *
 * Not covered here, and said so: the tap itself (a notification cannot be
 * clicked from a test; its address is followed instead), a real push service,
 * and iOS, where push needs a home-screen install. Those are a phone check.
 *
 * Chromium only: the delivery hop is a DevTools-protocol command, and it
 * shows a notification only in the full browser's headless mode.
 */
test.use({ channel: "chromium" });
test.skip(({ browserName }) => browserName !== "chromium", "the push-service stand-in is a Chromium DevTools command");

let relay: ServedRelay;
let vapid: Vapid;
let store: Server;
let storeBase = "";
let pushService: Server;
let pushBase = "";
let container = "";
/** Every push the stand-in received: which device, which scope, and whether it was delivered. */
const pushes: { device: string; scope: string; delivered: boolean }[] = [];
/** Per device, the DevTools session that can deliver to its service workers, and their registrations by scope. */
const devices = new Map<string, { cdp: CDPSession; registrations: Map<string, string> }>();

test.beforeAll(async () => {
  vapid = await vapidKeys();
  relay = await serveRelay(vapid);

  pushService = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      void (async () => {
        const [device, scope] = (req.url ?? "/").split("/").filter(Boolean).map(decodeURIComponent) as [string, string];
        // What a real push service checks before it delivers anything.
        await verifyVapid(String(req.headers["authorization"] ?? ""), vapid.publicKey);
        const held = devices.get(device);
        const registrationId = held?.registrations.get(scope);
        if (held && registrationId) {
          await held.cdp.send("ServiceWorker.deliverPushMessage", { origin: RUNNER_ORIGIN, registrationId, data: "" });
        }
        pushes.push({ device, scope, delivered: Boolean(held && registrationId) });
        res.writeHead(201);
        res.end();
      })().catch(() => {
        res.writeHead(400);
        res.end();
      });
    });
  });
  await new Promise<void>((r) => pushService.listen(0, r));
  pushBase = `http://localhost:${(pushService.address() as { port: number }).port}`;

  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS,HEAD",
    "access-control-allow-headers": "content-type",
  };
  const bucket = new Map<string, Buffer>();
  store = createServer((req, res) => {
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
        res.end(JSON.stringify({ url: `${storeBase}/__put/${name}`, method: "PUT", headers: {}, href: `${storeBase}/${name}`, token: "t.link" }));
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

  const built = await compileDirectory({ sourceDir: join(repo, "examples", "tic-tac-toe"), root: repo, appName: "Tic-tac-toe" });
  container = join(mkdtempSync(join(tmpdir(), "dai-push-")), "tic-tac-toe.dai.html");
  writeFileSync(container, built.html, "utf8");
});

test.afterAll(async () => {
  await relay?.close();
  for (const server of [store, pushService]) {
    server?.closeAllConnections();
    server?.close();
  }
});

/**
 * One person's browser. Notifications are allowed (the question itself is a
 * browser prompt a test cannot answer); the push service is the stand-in; and
 * a page off the opener's origin holds the DevTools session, so it is never a
 * window the service worker could count as the app being open.
 */
async function device(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ permissions: ["notifications"] });
  await context.addInitScript(
    (cfg) => {
      (window as unknown as { __daiStore: unknown }).__daiStore = cfg.store;
      // The push service's half of subscribe: an endpoint per registration,
      // on the stand-in, named so a push to it can find its way back here.
      // Kept in storage, as a browser keeps a subscription across reloads.
      const KEY = "__stand_in_push_subscriptions";
      const held = {
        read: (): Record<string, string> => JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>,
        get(scope: string) {
          const endpoint = this.read()[scope];
          return endpoint ? { endpoint } : undefined;
        },
        set(scope: string, value: { endpoint: string }) {
          localStorage.setItem(KEY, JSON.stringify({ ...this.read(), [scope]: value.endpoint }));
        },
        delete(scope: string) {
          const all = this.read();
          delete all[scope];
          localStorage.setItem(KEY, JSON.stringify(all));
        },
      };
      const registrationOf = async (manager: PushManager): Promise<ServiceWorkerRegistration> => {
        for (const registration of await navigator.serviceWorker.getRegistrations()) {
          if (registration.pushManager === manager) return registration;
        }
        throw new Error("no registration for this push manager");
      };
      const subscription = (scope: string, endpoint: string) =>
        ({
          endpoint,
          toJSON: () => ({ endpoint }),
          unsubscribe: async () => {
            held.delete(scope);
            return true;
          },
        }) as unknown as PushSubscription;
      PushManager.prototype.getSubscription = async function (this: PushManager) {
        const scope = (await registrationOf(this)).scope;
        const held1 = held.get(scope);
        return held1 ? subscription(scope, held1.endpoint) : null;
      };
      PushManager.prototype.subscribe = async function (this: PushManager) {
        const scope = (await registrationOf(this)).scope;
        const endpoint = `${cfg.pushBase}/${encodeURIComponent(cfg.name)}/${encodeURIComponent(scope)}`;
        held.set(scope, { endpoint });
        return subscription(scope, endpoint);
      };
    },
    { store: { presignUrl: `${storeBase}/presign`, publicBase: `${storeBase}/` }, pushBase, name },
  );
  const tray = await context.newPage();
  const cdp = await context.newCDPSession(tray);
  const registrations = new Map<string, string>();
  cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
    for (const r of event.registrations) {
      if (r.isDeleted) registrations.delete(r.scopeURL);
      else registrations.set(r.scopeURL, r.registrationId);
    }
  });
  await cdp.send("ServiceWorker.enable");
  devices.set(name, { cdp, registrations });
  return { context, page: await context.newPage() };
}

test("a move made while the other app is closed arrives as a notification that opens it", async ({ browser }) => {
  test.slow();
  const { context: ctxA, page: pageA } = await device(browser, "ada");
  const { context: ctxB, page: pageB } = await device(browser, "bo");
  const cell = (app: FrameLocator, n: number) => app.locator("#board .cell").nth(n);

  // Ada starts a game against Bo and invites him.
  await pageA.goto(RUNNER_URL);
  await pageA.setInputFiles("#file", container);
  await pageA.locator("#card-open").click();
  const appA = appIn(pageA);
  await expect(appA.locator("#new-game")).toBeVisible({ timeout: 60_000 });
  await appA.locator("#you").fill("Ada");
  await appA.locator("#them").fill("Bo");
  await appA.locator("#new-game button[type=submit]").click();
  await expect(appA.locator("#players")).toContainText("Bo (O)", { timeout: 30_000 });
  await cell(appA, 0).click();
  await expect(cell(appA, 0)).toHaveText("X");
  await pageA.evaluate(({ base, key }) => {
    (window as any).__runner.useRelay(base);
    (window as any).__runner.usePush(key);
  }, { base: relay.base, key: vapid.publicKey });
  await pageA.evaluate(() => {
    (window as any).__copied = undefined;
    navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
    // The full browser's headless mode has a share sheet, and the opener
    // prefers it to the clipboard; the link is what it would have shared.
    navigator.share = async (data?: ShareData) => void ((window as any).__copied = data?.url);
  });
  await appA.locator("#invite").click();
  await pageA.click("#send-go");
  await expect.poll(() => pageA.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 }).not.toBeNull();
  const link = await pageA.evaluate(() => (window as any).__copied as string);

  // The game's mailbox is the one address anything was written to, and Ada's
  // device subscribed to it on its own — no step here asked it to.
  await expect.poll(() => relay.appended.size, { timeout: 45_000 }).toBe(1);
  const [address] = [...relay.appended];
  await expect.poll(() => relay.subscriptions(address!).length, { timeout: 30_000 }).toBe(1);

  // Bo opens the invite and joins; his device subscribes to the same mailbox.
  await pageB.goto(link);
  await pageB.locator("#card-open").click({ timeout: 60_000 });
  const appB = appIn(pageB);
  await expect(appB.locator("#status")).toContainText("Your move, Bo.", { timeout: 60_000 });
  await pageB.evaluate(({ base, key }) => {
    (window as any).__runner.useRelay(base);
    (window as any).__runner.usePush(key);
  }, { base: relay.base, key: vapid.publicKey });
  await expect.poll(() => relay.subscriptions(address!).length, { timeout: 30_000 }).toBe(2);
  // Each device's subscription is its own registration, scoped to this mailbox.
  const scope = `${RUNNER_URL}push/${address}/`;
  expect(devices.get("ada")!.registrations.has(scope)).toBe(true);
  expect(devices.get("bo")!.registrations.has(scope)).toBe(true);

  // Ada closes the app. Bo moves.
  await pageA.close();
  pushes.length = 0;
  await cell(appB, 1).click();
  await expect(cell(appB, 1)).toHaveText("O");

  // The relay woke Ada's device and not Bo's own.
  await expect.poll(() => pushes.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await relay.settled();
  // A move can travel as more than one batch, and each new batch is a wake;
  // the notification's tag (and a real push service's topic) folds them into
  // one. What must hold is who: every wake is Ada's, none is Bo's own.
  for (const push of pushes) expect(push).toEqual({ device: "ada", scope, delivered: true });

  // Ada's service worker asked the relay what moved and raised a notification
  // naming the document. Read from a page on the opener's origin that is not
  // the opener — an icon — so reading cannot itself put the document on screen,
  // which would rightly make the worker take the notification down.
  const inspector = await ctxA.newPage();
  await inspector.goto(`${RUNNER_URL}icons/icon-192.png`);
  const readNotes = () =>
    inspector.evaluate(async (s) => {
      const registration = await navigator.serviceWorker.getRegistration(s);
      const notes = registration ? await registration.getNotifications() : [];
      return notes.map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: (n.data as { url?: string } | null)?.url ?? "" }));
    }, scope);
  await expect.poll(async () => (await readNotes()).length, { timeout: 30_000 }).toBe(1);
  const [note] = await readNotes();
  expect(note!.title.length).toBeGreaterThan(0);
  // The worker's copy of the hint key, held to HINT_KEY here (D56).
  expect(note!.url).toMatch(new RegExp(`^/#${HINT_KEY}=[0-9a-f-]{36}$`));
  expect(note!.tag).toBe(note!.url.slice(`/#${HINT_KEY}=`.length));

  // Following it opens the game with Bo's move in it, and asks nothing.
  await inspector.close();
  const later = await ctxA.newPage();
  await later.goto(new URL(note!.url, RUNNER_URL).href);
  const appLater = appIn(later);
  await expect(appLater.locator("#board")).toBeVisible({ timeout: 60_000 });
  await later.evaluate((base) => (window as any).__runner.useRelay(base), relay.base);
  await expect(cell(appLater, 1)).toHaveText("O", { timeout: 30_000 });
  await expect(later.locator("#card"), "a relayed move raises no card").toBeHidden();
  await expect(later.locator("#card-merge")).toBeHidden();
  const uuid = note!.tag;

  // A wake with nothing new behind it — the second batch of a move already
  // read — still ends in a notification, because a push that shows none is
  // what gets a subscription revoked. Silent, and it says so.
  // The page writes down how far it has read after the merge lands, so wait for
  // that before closing it: "read" here means read and recorded.
  const savedCursor = () =>
    later.evaluate(
      (a) =>
        new Promise<string>((resolve) => {
          const open = indexedDB.open("dai_runner_storage");
          open.onsuccess = () => {
            const all = open.result.transaction("mailboxes", "readonly").objectStore("mailboxes").getAll();
            all.onsuccess = () => resolve(String((all.result as { address?: string; cursor?: string }[]).find((r) => r.address === a)?.cursor ?? ""));
          };
        }),
      address!,
    );
  const head = async () => (await fetch(`${relay.base}/${address}/head`)).text();
  await expect.poll(async () => (await savedCursor()) === (await head()), { timeout: 30_000 }).toBe(true);
  await later.close();
  const ada = devices.get("ada")!;
  await ada.cdp.send("ServiceWorker.deliverPushMessage", {
    origin: RUNNER_ORIGIN,
    registrationId: ada.registrations.get(scope)!,
    data: "",
  });
  const chooser = await ctxA.newPage();
  await chooser.goto(`${RUNNER_URL}icons/icon-192.png`);
  // Every notification on every registration, so nothing else was raised either.
  const notesOn = (page: Page) =>
    page.evaluate(async () => {
      const out: { scope: string; body: string; tag: string; silent: boolean | null; error?: string }[] = [];
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        for (const n of await registration.getNotifications()) {
          // `error` is set only by the worker's catch-all, and says what failed.
          const error = (n.data as { error?: string } | null)?.error;
          out.push({ scope: registration.scope, body: n.body, tag: n.tag, silent: n.silent, ...(error ? { error } : {}) });
        }
      }
      return out;
    });
  await expect
    .poll(() => notesOn(chooser), { timeout: 30_000 })
    .toEqual([{ scope, body: "You're up to date.", tag: uuid, silent: true }]);
  await chooser.close();

  // The game plays to its end and is closed. A closed game stops: each device
  // releases its push once the last row is sent and read, and stops asking the
  // relay about that mailbox at all.
  const adaGame = await ctxA.newPage();
  await adaGame.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
  const appAda = appIn(adaGame);
  await expect(appAda.locator("#board")).toBeVisible({ timeout: 60_000 });
  await adaGame.evaluate(({ base, key }) => {
    (window as any).__runner.useRelay(base);
    (window as any).__runner.usePush(key);
  }, { base: relay.base, key: vapid.publicKey });
  const arrives = async (page: Page, app: FrameLocator, at: number, mark: string) =>
    expect(async () => {
      await page.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(cell(app, at)).toHaveText(mark, { timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
  await arrives(adaGame, appAda, 1, "O");
  for (const [page, app, other, otherApp, at, mark] of [
    [adaGame, appAda, pageB, appB, 3, "X"],
    [pageB, appB, adaGame, appAda, 4, "O"],
    [adaGame, appAda, pageB, appB, 6, "X"],
  ] as const) {
    await cell(app, at).click();
    await expect(cell(app, at)).toHaveText(mark);
    await arrives(other, otherApp, at, mark);
  }
  // The app keeps the result on the board; Close goes away once the match is
  // closed, on the closer's copy and then, when the close row arrives, on the other.
  await expect(appAda.locator("#close-match")).toBeVisible({ timeout: 30_000 });
  await appAda.locator("#close-match").click();
  await expect(appAda.locator("#close-match")).toBeHidden({ timeout: 30_000 });
  await expect(async () => {
    await pageB.evaluate(() => (window as any).__runner.pullMailbox());
    await expect(appB.locator("#close-match")).toBeHidden({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });

  await expect.poll(() => relay.subscriptions(address!).length, { timeout: 45_000 }).toBe(0);
  await expect.poll(() => devices.get("ada")!.registrations.has(scope), { timeout: 30_000 }).toBe(false);
  await expect.poll(() => devices.get("bo")!.registrations.has(scope), { timeout: 30_000 }).toBe(false);
  /*
   * Nobody polls it now. Waited on the poll itself, not on the clock: a tick
   * on each page first, which settles any request already in flight when the
   * lane stopped, then two more on each — the timer demonstrably ran, twice,
   * on both copies — and not one request may have reached the mailbox. The
   * sleeps this replaces assumed the timer fired inside them.
   */
  const polls = (page: Page) => page.evaluate(() => (window as any).__runner.mailboxPolls as number);
  const ticks = async (count: number) => {
    const from = [await polls(adaGame), await polls(pageB)] as const;
    await expect
      .poll(async () => (await polls(adaGame)) >= from[0] + count && (await polls(pageB)) >= from[1] + count, {
        timeout: 60_000,
      })
      .toBe(true);
  };
  await ticks(1);
  const before = relay.requests(address!);
  await ticks(2);
  const since = relay.requestLog(address!).slice(before);
  expect(since, `nobody polls a closed game's mailbox; it received: ${since.join(", ")}`).toEqual([]);

  for (const context of [ctxA, ctxB]) await context.close();
});

test("an opener update keeps push; removing the document releases it", async ({ browser }) => {
  test.slow();
  const { context, page } = await device(browser, "cy");
  await page.goto(RUNNER_URL);
  await page.setInputFiles("#file", container);
  await page.locator("#card-open").click();
  const app = appIn(page);
  await expect(app.locator("#new-game")).toBeVisible({ timeout: 60_000 });
  await app.locator("#you").fill("Cy");
  await app.locator("#them").fill("Di");
  await app.locator("#new-game button[type=submit]").click();
  await expect(app.locator("#players")).toContainText("Di (O)", { timeout: 30_000 });
  await page.evaluate(({ base, key }) => {
    (window as any).__runner.useRelay(base);
    (window as any).__runner.usePush(key);
  }, { base: relay.base, key: vapid.publicKey });
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => undefined;
    navigator.share = async () => undefined;
  });
  const already = new Set(relay.appended);
  await app.locator("#invite").click();
  await page.click("#send-go");
  await expect.poll(() => [...relay.appended].filter((a) => !already.has(a)).length, { timeout: 45_000 }).toBe(1);
  const [address] = [...relay.appended].filter((a) => !already.has(a));
  const scope = `${RUNNER_URL}push/${address}/`;
  await expect.poll(() => relay.subscriptions(address!).length, { timeout: 30_000 }).toBe(1);
  const uuid = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const open = indexedDB.open("dai_runner_storage");
        open.onsuccess = () => {
          const all = open.result.transaction("mailboxes", "readonly").objectStore("mailboxes").getAll();
          all.onsuccess = () => resolve(String((all.result[0] as { documentUuid: string }).documentUuid).split("/")[0]!);
        };
      }),
  );

  // The menu's update: caches and the shell's worker go, and the page reloads.
  // The mailbox's push worker is not the shell's, and it stays.
  await context.route("**/version.json*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ commit: "0000000deadbeefcafe" }) }),
  );
  await page.locator("#more").click();
  await expect(page.locator("#sheet-version")).toHaveText("New version — update", { timeout: 15_000 });
  await Promise.all([page.waitForEvent("load"), page.locator("#sheet-version").click()]);
  await context.unroute("**/version.json*");
  await expect.poll(() => devices.get("cy")!.registrations.has(scope), { timeout: 10_000 }).toBe(true);
  expect(relay.subscriptions(address!).length, "still subscribed at the relay").toBe(1);

  // Removing the document from this device releases its push everywhere.
  await page.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
  await expect(appIn(page).locator("#board")).toBeVisible({ timeout: 60_000 });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#more").click();
  await page.locator("#remove").click();
  await expect.poll(() => relay.subscriptions(address!).length, { timeout: 30_000 }).toBe(0);
  await expect.poll(() => devices.get("cy")!.registrations.has(scope), { timeout: 30_000 }).toBe(false);

  await context.close();
});

/**
 * The home-screen badge (backlog D34): how many games wait on this player,
 * set by the service worker when a move arrives while the app is closed.
 *
 * What the icon itself shows is the operating system's, and no test can see
 * it: this reads what the worker gave it, which it keeps beside the reason
 * (the dai_badge store), and badge.js's own tests cover the call to the API.
 * Per-install icons are a phone check: on a phone each home-screen install has
 * its own storage, so only that install's worker ever runs for its pushes.
 */
test("the badge counts games waiting on this player, clears on open and after a move, and a push that is not a new turn does not raise it", async ({ browser }) => {
  test.slow();
  const { context: ctxA, page: pageA } = await device(browser, "eve");
  const { context: ctxB, page: pageB } = await device(browser, "fay");
  const cell = (app: FrameLocator, n: number) => app.locator("#board .cell").nth(n);

  // Eve starts a game, moves, and invites Fay. It is Fay's turn.
  await pageA.goto(RUNNER_URL);
  await pageA.setInputFiles("#file", container);
  await pageA.locator("#card-open").click();
  const appA = appIn(pageA);
  await expect(appA.locator("#new-game")).toBeVisible({ timeout: 60_000 });
  await appA.locator("#you").fill("Eve");
  await appA.locator("#them").fill("Fay");
  await appA.locator("#new-game button[type=submit]").click();
  await expect(appA.locator("#players")).toContainText("Fay (O)", { timeout: 30_000 });
  await cell(appA, 0).click();
  await expect(cell(appA, 0)).toHaveText("X");
  await pageA.evaluate(({ base, key }) => {
    (window as any).__runner.useRelay(base);
    (window as any).__runner.usePush(key);
  }, { base: relay.base, key: vapid.publicKey });
  await pageA.evaluate(() => {
    (window as any).__copied = undefined;
    navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
    navigator.share = async (data?: ShareData) => void ((window as any).__copied = data?.url);
  });
  const already = new Set(relay.appended);
  await appA.locator("#invite").click();
  await pageA.click("#send-go");
  await expect.poll(() => pageA.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 }).not.toBeNull();
  const link = await pageA.evaluate(() => (window as any).__copied as string);
  await expect.poll(() => [...relay.appended].filter((a) => !already.has(a)).length, { timeout: 45_000 }).toBe(1);
  const [address] = [...relay.appended].filter((a) => !already.has(a));
  await expect.poll(() => relay.subscriptions(address!).length, { timeout: 30_000 }).toBe(1);

  await pageB.goto(link);
  await pageB.locator("#card-open").click({ timeout: 60_000 });
  const appB = appIn(pageB);
  await expect(appB.locator("#status")).toContainText("Your move, Fay.", { timeout: 60_000 });
  await pageB.evaluate(({ base, key }) => {
    (window as any).__runner.useRelay(base);
    (window as any).__runner.usePush(key);
  }, { base: relay.base, key: vapid.publicKey });
  await expect.poll(() => relay.subscriptions(address!).length, { timeout: 30_000 }).toBe(2);

  /** Eve's badge entries, read from a page on the opener's origin that is not the opener. */
  const entries = async () => {
    const reader = await ctxA.newPage();
    await reader.goto(`${RUNNER_URL}icons/icon-192.png`);
    const all = await reader.evaluate(
      () =>
        new Promise<{ uuid: string; waiting: string[]; moved: string[]; shown: number }[]>((resolve) => {
          const open = indexedDB.open("dai_badge", 1);
          open.onupgradeneeded = () => open.result.createObjectStore("documents", { keyPath: "uuid" });
          open.onsuccess = () => {
            const get = open.result.transaction("documents", "readonly").objectStore("documents").getAll();
            get.onsuccess = () => {
              resolve(get.result);
              open.result.close();
            };
          };
        }),
    );
    await reader.close();
    return all;
  };

  // Eve's own report, while her app is open: it is not her turn, so nothing waits.
  await expect.poll(async () => (await entries()).map((e) => [e.waiting.length, e.shown]), { timeout: 30_000 }).toEqual([[0, 0]]);
  const [{ uuid }] = await entries();

  // Eve closes the app. Fay moves: a legitimate turn, and the count rises to 1.
  await pageA.close();
  await firstMailboxMerge(pageB);
  await cell(appB, 4).click();
  await expect(cell(appB, 4)).toHaveText("O");
  await expect.poll(async () => (await entries())[0]?.shown, { timeout: 45_000 }).toBe(1);
  const session = (await entries())[0]!.moved[0]!;
  expect(session).toMatch(/^[0-9a-f]{32}$/);
  await relay.settled();

  // Eve opens it: the badge clears, and her app reports the game waiting on her.
  const again = await ctxA.newPage();
  await again.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
  const appAgain = appIn(again);
  await expect(appAgain.locator("#board")).toBeVisible({ timeout: 60_000 });
  await again.evaluate((base) => (window as any).__runner.useRelay(base), relay.base);
  await expect(async () => {
    await again.evaluate(() => (window as any).__runner.pullMailbox());
    await expect(cell(appAgain, 4)).toHaveText("O", { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  await expect.poll(async () => (await entries()).map((e) => ({ waiting: e.waiting, moved: e.moved, shown: e.shown })), { timeout: 30_000 })
    .toEqual([{ waiting: [session], moved: [], shown: 0 }]);

  // Guard: while it is Eve's turn, Fay renames the game. The mailbox moves and
  // the push is real, but it is not a new turn: the game already waits, so the
  // count stays at the one game waiting, not two.
  const cursorRead = async () =>
    again.evaluate(
      (a) =>
        new Promise<string>((resolve) => {
          const open = indexedDB.open("dai_runner_storage");
          open.onsuccess = () => {
            const all = open.result.transaction("mailboxes", "readonly").objectStore("mailboxes").getAll();
            all.onsuccess = () => resolve(String((all.result as { address?: string; cursor?: string }[]).find((r) => r.address === a)?.cursor ?? ""));
          };
        }),
      address!,
    );
  const head = async () => (await fetch(`${relay.base}/${address}/head`)).text();
  await expect.poll(async () => (await cursorRead()) === (await head()), { timeout: 30_000 }).toBe(true);
  await again.close();
  pushes.length = 0;
  await appB.locator("#rename").click();
  await appB.locator("#rename-x").fill("Evelyn");
  await appB.locator("#rename-form button[type=submit]").click();
  await expect.poll(() => pushes.filter((p) => p.device === "eve" && p.delivered).length, { timeout: 45_000 }).toBeGreaterThan(0);
  await relay.settled();
  await expect.poll(async () => (await entries())[0]?.moved, { timeout: 30_000 }).toEqual([session]);
  expect((await entries())[0]!.shown, "a push for a game already waiting must not count it twice").toBe(1);

  // Eve opens it and moves: after her own move nothing waits, and the badge is clear.
  const third = await ctxA.newPage();
  await third.goto(`${RUNNER_URL}#${HINT_KEY}=${uuid}`);
  const appThird = appIn(third);
  await expect(appThird.locator("#board")).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await entries())[0]?.shown, { timeout: 30_000 }).toBe(0);
  await expect(cell(appThird, 8)).toBeEnabled({ timeout: 30_000 });
  await cell(appThird, 8).click();
  await expect(cell(appThird, 8)).toHaveText("X");
  await expect.poll(async () => (await entries()).map((e) => ({ waiting: e.waiting, shown: e.shown })), { timeout: 30_000 })
    .toEqual([{ waiting: [], shown: 0 }]);

  for (const c of [ctxA, ctxB]) await c.close();
});

/**
 * The badge clears when this player moves (D34), on the phone and not only on
 * a fresh load. Found on a phone after this suite was green: a move made in a
 * resumed app left the badge standing until a reload mounted the document
 * again. A badge is the operating system's, and nothing here can see it, so
 * these read what the opener gave it.
 *
 * Run for an app that reports waiting games (tic-tac-toe) and for the same app
 * with its report removed, which is what the chess install is: for that one the
 * count is only "games that moved", and only the opener can clear it.
 */
async function nonReportingTicTacToe(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dai-noreport-"));
  cpSync(join(repo, "examples", "tic-tac-toe"), dir, { recursive: true });
  const app = join(dir, "app.js");
  const source = readFileSync(app, "utf8");
  const stripped = source.replace("  drawPending = false;\n  reportWaiting();", "  drawPending = false;");
  if (stripped === source) throw new Error("the report call was not removed");
  writeFileSync(app, stripped);
  const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "Tic-tac-toe" });
  const file = join(dir, "no-report.dai.html");
  writeFileSync(file, built.html, "utf8");
  return file;
}

for (const variant of ["reports waiting games", "does not report"] as const) {
  test(`the badge clears after this player's own move is sent, for an app that ${variant}`, async ({ browser }) => {
    test.slow();
    const file = variant === "reports waiting games" ? container : await nonReportingTicTacToe();
    const tag = variant === "reports waiting games" ? "gil" : "hal";
    const { context: ctxA, page: pageA } = await device(browser, `${tag}-a`);
    const { context: ctxB, page: pageB } = await device(browser, `${tag}-b`);
    const cell = (app: FrameLocator, n: number) => app.locator("#board .cell").nth(n);

    await pageA.goto(RUNNER_URL);
    await pageA.setInputFiles("#file", file);
    await pageA.locator("#card-open").click();
    const appA = appIn(pageA);
    await expect(appA.locator("#new-game")).toBeVisible({ timeout: 60_000 });
    await appA.locator("#you").fill("Gil");
    await appA.locator("#them").fill("Hal");
    await appA.locator("#new-game button[type=submit]").click();
    await expect(appA.locator("#players")).toContainText("Hal (O)", { timeout: 30_000 });
    await cell(appA, 0).click();
    await expect(cell(appA, 0)).toHaveText("X");
    await pageA.evaluate(({ base, key }) => {
      (window as any).__runner.useRelay(base);
      (window as any).__runner.usePush(key);
    }, { base: relay.base, key: vapid.publicKey });
    await pageA.evaluate(() => {
      (window as any).__copied = undefined;
      navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
      navigator.share = async (data?: ShareData) => void ((window as any).__copied = data?.url);
    });
    await appA.locator("#invite").click();
    await pageA.click("#send-go");
    await expect.poll(() => pageA.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 }).not.toBeNull();
    const link = await pageA.evaluate(() => (window as any).__copied as string);

    await pageB.goto(link);
    await pageB.locator("#card-open").click({ timeout: 60_000 });
    const appB = appIn(pageB);
    await expect(appB.locator("#status")).toContainText("Your move, Hal.", { timeout: 60_000 });
    await pageB.evaluate((base) => (window as any).__runner.useRelay(base), relay.base);
    await firstMailboxMerge(pageB);
    await cell(appB, 4).click();
    await expect(cell(appB, 4)).toHaveText("O");

    // Hal's move arrives on Gil's open copy: Gil's turn.
    await expect(async () => {
      await pageA.evaluate(() => (window as any).__runner.pullMailbox());
      await expect(cell(appA, 4)).toHaveText("O", { timeout: 2_000 });
    }).toPass({ timeout: 45_000 });

    /** Gil's one badge entry, and a way to set it as a push while the app was away would have. */
    const entry = () =>
      pageA.evaluate(
        () =>
          new Promise<{ uuid: string; waiting: string[]; moved: string[]; shown: number } | null>((resolve) => {
            const open = indexedDB.open("dai_badge", 1);
            open.onupgradeneeded = () => open.result.createObjectStore("documents", { keyPath: "uuid" });
            open.onsuccess = () => {
              const all = open.result.transaction("documents", "readonly").objectStore("documents").getAll();
              all.onsuccess = () => {
                resolve((all.result[0] as never) ?? null);
                open.result.close();
              };
            };
          }),
      );
    await expect.poll(async () => (await entry())?.uuid ?? "", { timeout: 30_000 }).not.toBe("");
    const uuid = (await entry())!.uuid;
    const standing = async () =>
      pageA.evaluate(
        (u) =>
          new Promise<void>((resolve) => {
            const open = indexedDB.open("dai_badge", 1);
            open.onsuccess = () => {
              const tx = open.result.transaction("documents", "readwrite");
              tx.objectStore("documents").put({ uuid: u, waiting: [], moved: ["a-game-that-moved"], shown: 1 });
              tx.oncomplete = () => {
                open.result.close();
                resolve();
              };
            };
          }),
        uuid,
      );

    // A move that cannot be sent does not clear it: nothing left this device.
    await standing();
    await pageA.context().route(`${relay.base}/**`, (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue(),
    );
    await cell(appA, 8).click();
    await expect(cell(appA, 8)).toHaveText("X");
    if (variant === "does not report") {
      await pageA.waitForTimeout(3_000);
      expect((await entry())!.shown, "a move that never left must not clear the badge").toBe(1);
    }

    // Once it is sent, the badge clears. A failed publish is sent again on this
    // copy's next write, not on a timer, so a rename is what sends the move.
    await standing();
    await pageA.context().unroute(`${relay.base}/**`);
    await appA.locator("#rename").click();
    await appA.locator("#rename-x").fill("Gilbert");
    await appA.locator("#rename-form button[type=submit]").click();
    await expect.poll(async () => (await entry())!.shown, { timeout: 45_000 }).toBe(0);
    expect((await entry())!.moved).toEqual([]);

    // Coming back to a resumed page clears it too, without a reload.
    await standing();
    await pageA.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(async () => (await entry())!.shown, { timeout: 15_000 }).toBe(0);

    for (const c of [ctxA, ctxB]) await c.close();
  });
}

/**
 * D79 reproduction: B clicks a square the instant its mount's first save is
 * asked, while that save is being written, and the frame records what the click
 * met. A probe until the mechanism is known: run with D79_PROBE=1.
 */
test("D79 probe: a square clicked while the mount's first save is being written", async ({ browser }) => {
  test.skip(!process.env.D79_PROBE, "a probe: run with D79_PROBE=1");
  test.slow();
  const { context: ctxA, page: pageA } = await device(browser, "d79-a");
  const { context: ctxB, page: pageB } = await device(browser, "d79-b");
  const cell = (app: FrameLocator, n: number) => app.locator("#board .cell").nth(n);

  await pageA.goto(RUNNER_URL);
  await pageA.setInputFiles("#file", container);
  await pageA.locator("#card-open").click();
  const appA = appIn(pageA);
  await expect(appA.locator("#new-game")).toBeVisible({ timeout: 60_000 });
  await appA.locator("#you").fill("Gil");
  await appA.locator("#them").fill("Hal");
  await appA.locator("#new-game button[type=submit]").click();
  await cell(appA, 0).click();
  await expect(cell(appA, 0)).toHaveText("X");
  await pageA.evaluate((base) => (window as any).__runner.useRelay(base), relay.base);
  await pageA.evaluate(() => {
    (window as any).__copied = undefined;
    navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
    navigator.share = async (data?: ShareData) => void ((window as any).__copied = data?.url);
  });
  await appA.locator("#invite").click();
  await pageA.click("#send-go");
  await expect.poll(() => pageA.evaluate(() => (window as any).__copied ?? null), { timeout: 30_000 }).not.toBeNull();
  const link = await pageA.evaluate(() => (window as any).__copied as string);

  const lines: string[] = [];
  pageB.on("console", (m) => {
    const text = m.text();
    if (/^(dai: |D79 )/.test(text)) lines.push(text);
  });
  const appB = appIn(pageB);
  await pageB.goto(link);
  await pageB.locator("#card-open").click({ timeout: 60_000 });
  await expect(appB.locator("#status")).toContainText("Your move, Hal.", { timeout: 60_000 });

  // Inside the app's own frame: what a click meets, every board rebuild, every notice.
  const frame = pageB.frames().find((f) => f.parentFrame()?.parentFrame() === pageB.mainFrame())!;
  await frame.evaluate(() => {
    const log = (s: string) => console.log(`D79 ${Math.round(performance.now())} ${s}`);
    const board = document.getElementById("board")!;
    const cells = () => [...board.children].map((c) => c.textContent || ".").join("");
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
      document.addEventListener(
        type,
        (event) => {
          const t = event.target as HTMLElement;
          log(`${type} on ${t?.id ? "#" + t.id : t?.className || t?.tagName} connected=${t?.isConnected}`);
        },
        true,
      );
    }
    document.addEventListener(
      "click",
      (event) => {
        const t = event.target as HTMLButtonElement;
        if (!t?.classList?.contains("cell")) return;
        log(`click on ${t.getAttribute("aria-label")} connected=${t.isConnected} disabled=${t.disabled}`);
        setTimeout(() => log(`after click: target connected=${t.isConnected} board=[${cells()}] status="${document.getElementById("status")?.textContent}" notice="${document.getElementById("notice")?.textContent}"`), 0);
      },
      true,
    );
    new MutationObserver(() => log(`board rebuilt: [${cells()}] enabled=${[...board.children].filter((c) => !(c as HTMLButtonElement).disabled).length}`)).observe(board, { childList: true });
    const notice = document.getElementById("notice")!;
    new MutationObserver(() => log(`notice: "${notice.textContent}"`)).observe(notice, { childList: true, characterData: true, subtree: true });
    window.addEventListener("dai:merged", (e) => log(`dai:merged via=${(e as CustomEvent).detail?.via}`));
    log("instrumented");
  });

  // The sightings' order: the relay, then the click about 15 ms later, with no wait between.
  await pageB.evaluate((base) => (window as any).__runner.useRelay(base), relay.base);
  if (process.env.D79_CLOSE) {
    // A merge that makes the move illegal mid-press: Gil closes the match (the
    // row the Close match button writes, through the app's own write surface),
    // and Hal's copy takes it in while Hal's finger is down.
    await pageB.waitForTimeout(1_500);
    const frameA = pageA.frames().find((f) => f.parentFrame()?.parentFrame() === pageA.mainFrame())!;
    // The session, as Hal's copy reports it waiting on Hal (the badge store).
    let session = "";
    await expect(async () => {
      session = await pageB.evaluate(
        () =>
          new Promise<string>((resolve) => {
            const open = indexedDB.open("dai_badge", 1);
            open.onupgradeneeded = () => open.result.createObjectStore("documents", { keyPath: "uuid" });
            open.onsuccess = () => {
              const all = open.result.transaction("documents", "readonly").objectStore("documents").getAll();
              all.onsuccess = () => resolve(String((all.result[0] as { waiting?: string[] })?.waiting?.[0] ?? ""));
            };
          }),
      );
      expect(session).not.toBe("");
    }).toPass({ timeout: 15_000 });
    const published: string[] = [];
    pageA.on("console", (m) => {
      if (/^dai: watermark published/.test(m.text())) published.push(m.text());
    });
    await frameA.evaluate((s) => (window as any).dai.replicated.session.close(s), session);
    // The close is at the relay before Hal presses, so the merge mid-press carries it.
    await expect.poll(() => published.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const box = (await cell(appB, 4).boundingBox())!;
    await pageB.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pageB.mouse.down();
    const mergedBefore = lines.filter((l) => /dai:merged via=mailbox/.test(l)).length;
    await expect(async () => {
      await pageB.evaluate(() => (window as any).__runner.pullMailbox());
      expect(lines.filter((l) => /dai:merged via=mailbox/.test(l)).length).toBeGreaterThan(mergedBefore);
    }).toPass({ timeout: 20_000 });
    await pageB.mouse.up();
    await pageB.waitForTimeout(500);
    console.log(`D79 notice after release: "${await appB.locator("#notice").textContent()}" hidden=${await appB.locator("#notice").isHidden()}`);
    console.log(`D79 status after release: "${await appB.locator("#status").textContent()}"`);
  } else if (process.env.D79_SPLIT) {
    // The press and the release around one redraw of the board, which is what a
    // merge arriving mid-click does: the app's own merged listener calls draw().
    await pageB.waitForTimeout(1_500);
    const box = (await cell(appB, 4).boundingBox())!;
    await pageB.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pageB.mouse.down();
    await frame.evaluate((merged) => window.dispatchEvent(new CustomEvent(merged, { detail: { via: "mailbox" } })), FRAME_PUBLIC.MERGED);
    await pageB.mouse.up();
  } else {
    await cell(appB, 4).click();
  }
  await pageB.waitForTimeout(4_000);
  for (const l of lines.filter((l) => /^D79|save|replica|lane|watermark|merged/.test(l))) console.log(`D79 PROBE | ${l}`);
  console.log(`D79 cell 4 now: "${await cell(appB, 4).textContent()}"`);

  for (const c of [ctxA, ctxB]) await c.close();
});
