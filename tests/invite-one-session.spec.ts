import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { parseContainer } from "../src/container.js";
import { fsMailbox } from "../src/mailbox-fs.js";
import { base64 } from "../src/mailbox-http.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

/**
 * An invite carries the one session it was sent for, and nothing of the others
 * (backlog D4, T1-D28).
 *
 * Carrier-first: the invite is made the way a person makes one — the game's own
 * Invite button, which asks the host's share sheet for an invite into that
 * game's session — and opened the way the other person opens it, from the link.
 * The claim is the complement: in the copy that arrives, no table, author or
 * system, holds anything of the session that was not shared. A whole-document
 * share, opened on a third device, is the control that shows the same scan
 * finds that session when it is there.
 */

let relay: Server;
let store: Server;
let relayBase = "";
let storeBase = "";
let container = "";

test.beforeAll(async () => {
  const backend = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-invite-relay-")) });
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS,HEAD",
    "access-control-allow-headers": "content-type,if-none-match",
    "access-control-expose-headers": "etag",
  };
  relay = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
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
  container = join(mkdtempSync(join(tmpdir(), "dai-invite-")), "tic-tac-toe.dai.html");
  writeFileSync(container, built.html, "utf8");
});

test.afterAll(() => {
  relay?.close();
  store?.close();
});

async function device(browser: import("@playwright/test").Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(
    (cfg) => {
      (window as unknown as { __daiStore: unknown }).__daiStore = cfg;
    },
    { presignUrl: `${storeBase}/presign`, publicBase: `${storeBase}/` },
  );
  return { context, page: await context.newPage() };
}

async function captureLink(page: Page, press: () => Promise<void>): Promise<string> {
  await page.evaluate(() => {
    (window as any).__copied = undefined;
    navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
  });
  await press();
  // Waited on the captured link itself, not on the report line: the report
  // still says "Link copied" from the previous share, so waiting on it passes
  // before this share has produced anything.
  await expect
    .poll(() => page.evaluate(() => (window as any).__copied as string | undefined), { timeout: 30_000 })
    .toBeTruthy();
  return (await page.evaluate(() => (window as any).__copied as string))!;
}

/** The database a copy holds, read out of the file it saves — the bytes, not what the app draws. */
async function databaseOf(page: Page): Promise<DatabaseSync> {
  await page.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.evaluate(() => (window as any).__runner.exportContainer());
  const html = readFileSync(await (await downloading).path(), "utf8");
  const path = join(mkdtempSync(join(tmpdir(), "dai-invite-db-")), "d.sqlite");
  writeFileSync(path, parseContainer(html).archive["document.sqlite"]!);
  return new DatabaseSync(path);
}

const hex = (value: unknown): string =>
  value instanceof Uint8Array ? Buffer.from(value).toString("hex") : typeof value === "string" ? value.toLowerCase() : "";

/** Every place in every table where either of `needles` appears, as "table.column". */
function whereFound(db: DatabaseSync, needles: string[]): string[] {
  const found: string[] = [];
  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  for (const table of tables) {
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]) {
      for (const [column, value] of Object.entries(row)) {
        const text = hex(value);
        if (text && needles.some((needle) => text.includes(needle))) found.push(`${table}.${column}`);
      }
    }
  }
  return [...new Set(found)];
}

test("an invite carries the session it was sent for, and nothing of the other", async ({ browser }) => {
  test.slow();
  const { context: ctxA, page: pageA } = await device(browser);
  const { context: ctxB, page: pageB } = await device(browser);
  const { context: ctxC, page: pageC } = await device(browser);
  const cell = (app: FrameLocator, n: number) => app.locator("#board .cell").nth(n);

  // A holds two games, each its own session, with a mark in each.
  await pageA.goto(RUNNER_URL);
  await pageA.setInputFiles("#file", container);
  await pageA.locator("#card-open").click();
  const appA = appIn(pageA);
  await expect(appA.locator("#new-game")).toBeVisible({ timeout: 60_000 });
  for (const [them, at] of [["Bo", 0], ["Cy", 4]] as const) {
    await appA.locator("#you").fill("Ada");
    await appA.locator("#them").fill(them);
    await appA.locator("#new-game button[type=submit]").click();
    await expect(appA.locator("#players")).toContainText(`${them} (O)`, { timeout: 30_000 });
    await cell(appA, at).click();
    await expect(cell(appA, at)).toHaveText("X");
  }

  // The truth to check against, from A's own saved copy.
  const a = await databaseOf(pageA);
  const games = a.prepare("SELECT lower(hex(_r_entity)) AS entity, lower(hex(_r_session)) AS session, o_name FROM games").all() as {
    entity: string;
    session: string;
    o_name: string;
  }[];
  const shared = games.find((g) => g.o_name === "Bo")!;
  const other = games.find((g) => g.o_name === "Cy")!;
  expect(shared && other && shared.session !== other.session, "two games in two sessions").toBe(true);
  expect(whereFound(a, [other.session, other.entity]).length, "A holds the other game, as it should").toBeGreaterThan(0);

  // A invites Bo into the first game, through the game's own Invite.
  await appA.locator("#game-list").selectOption({ label: "Ada v Bo" });
  await expect(appA.locator("#players")).toContainText("Bo (O)");
  await pageA.evaluate((b) => (window as any).__runner.useRelay(b), relayBase);
  const invite = await captureLink(pageA, async () => {
    await appA.locator("#invite").click();
    await expect(pageA.locator("#send-title")).toHaveText("Invite someone into this game");
    await pageA.click("#send-go");
  });

  // B opens the invite as a person would, takes the seat, and sees that game.
  await pageB.goto(invite);
  await pageB.locator("#card-open").click({ timeout: 60_000 });
  const appB = appIn(pageB);
  await expect(appB.locator("#status")).toContainText("Your move, Bo.", { timeout: 60_000 });
  await expect(cell(appB, 0)).toHaveText("X");

  // The complement: nothing of the other session, in any table.
  const b = await databaseOf(pageB);
  expect(whereFound(b, [other.session, other.entity]), "the other game leaked into the invite").toEqual([]);
  // And the shared session did arrive, in the author tables and the roster alike.
  for (const table of ["games", "marks", "_dai_seat", "_dai_binding"]) {
    const sessions = (b.prepare(`SELECT DISTINCT lower(hex(_r_session)) AS s FROM "${table}"`).all() as { s: string }[]).map((r) => r.s);
    expect(sessions, table).toEqual([shared.session]);
  }
  expect((b.prepare("SELECT count(*) AS n FROM games WHERE o_name = 'Cy'").get() as { n: number }).n).toBe(0);

  // The control: A's own menu share sends the whole document, and the same scan
  // finds the other game in it — so the empty result above is a finding.
  const whole = await captureLink(pageA, async () => {
    await pageA.click("#more");
    await pageA.click("#send");
    await expect(pageA.locator("#send-note")).toContainText("every game in it");
    await pageA.click("#send-go");
  });
  await pageC.goto(whole);
  await pageC.locator("#card-open").click({ timeout: 60_000 });
  await expect(appIn(pageC).locator("#play")).toBeVisible({ timeout: 60_000 });
  const c = await databaseOf(pageC);
  expect(whereFound(c, [other.session, other.entity]).length, "a whole-document share carries the other game").toBeGreaterThan(0);

  for (const context of [ctxA, ctxB, ctxC]) await context.close();
});
