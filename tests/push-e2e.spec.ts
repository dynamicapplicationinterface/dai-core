import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type BrowserContext, type CDPSession, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import type { Vapid } from "../apps/relay/src/push.js";
import { serveRelay, vapidKeys, verifyVapid, type ServedRelay } from "./relay-memory.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const RUNNER_ORIGIN = "http://localhost:5175";
const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

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
      const held = new Map<string, { endpoint: string }>();
      const registrationOf = async (manager: PushManager): Promise<ServiceWorkerRegistration> => {
        for (const registration of await navigator.serviceWorker.getRegistrations()) {
          if (registration.pushManager === manager) return registration;
        }
        throw new Error("no registration for this push manager");
      };
      const subscription = (endpoint: string) =>
        ({ endpoint, toJSON: () => ({ endpoint }), unsubscribe: async () => true }) as unknown as PushSubscription;
      PushManager.prototype.getSubscription = async function (this: PushManager) {
        const held1 = held.get((await registrationOf(this)).scope);
        return held1 ? subscription(held1.endpoint) : null;
      };
      PushManager.prototype.subscribe = async function (this: PushManager) {
        const scope = (await registrationOf(this)).scope;
        const endpoint = `${cfg.pushBase}/${encodeURIComponent(cfg.name)}/${encodeURIComponent(scope)}`;
        held.set(scope, { endpoint });
        return subscription(endpoint);
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
  // naming the document. Read from a page opened afterward, on the chooser.
  const later = await ctxA.newPage();
  await later.goto(RUNNER_URL);
  const readNotes = () =>
    later.evaluate(async (s) => {
      const registration = await navigator.serviceWorker.getRegistration(s);
      const notes = registration ? await registration.getNotifications() : [];
      return notes.map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: (n.data as { url?: string } | null)?.url ?? "" }));
    }, scope);
  await expect.poll(async () => (await readNotes()).length, { timeout: 30_000 }).toBe(1);
  const [note] = await readNotes();
  expect(note!.title.length).toBeGreaterThan(0);
  expect(note!.url).toMatch(/^\/#u=[0-9a-f-]{36}$/);
  expect(note!.tag).toBe(note!.url.slice("/#u=".length));

  // Following it opens the game with Bo's move in it, and asks nothing.
  await later.goto(new URL(note!.url, RUNNER_URL).href);
  const appLater = appIn(later);
  await expect(appLater.locator("#board")).toBeVisible({ timeout: 60_000 });
  await later.evaluate((base) => (window as any).__runner.useRelay(base), relay.base);
  await expect(cell(appLater, 1)).toHaveText("O", { timeout: 30_000 });
  await expect(later.locator("#card"), "a relayed move raises no card").toBeHidden();
  await expect(later.locator("#card-merge")).toBeHidden();

  for (const context of [ctxA, ctxB]) await context.close();
});
