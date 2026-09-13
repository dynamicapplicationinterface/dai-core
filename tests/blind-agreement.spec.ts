import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { fsMailbox } from "../src/mailbox-fs.js";
import { base64 } from "../src/mailbox-http.js";

// One-off: the second blind candidate (a two-person agreement), driven over the
// mailbox in the real host. Skipped unless CANDIDATE_DIR names it.
const DIR = process.env.CANDIDATE_DIR;
const RUNNER_URL = "http://localhost:5175/";
const appIn = (page: Page): FrameLocator => page.frameLocator("iframe").frameLocator("iframe");

test.skip(!DIR, "CANDIDATE_DIR not set");

let relay: Server;
let store: Server;
let relayBase = "";
let storeBase = "";
let container = "";

test.beforeAll(async () => {
  const backend = fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-blind2-relay-")) });
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS,HEAD",
    "access-control-allow-headers": "content-type",
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

  const built = await compileDirectory({ sourceDir: DIR!, root: process.cwd(), appName: "Agreement" });
  container = join(mkdtempSync(join(tmpdir(), "dai-blind2-")), "agreement.dai.html");
  writeFileSync(container, built.html, "utf8");
});

test.afterAll(() => {
  relay?.close();
  store?.close();
});

async function device(browser: import("@playwright/test").Browser, label: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(
    (cfg) => {
      (window as unknown as { __daiStore: unknown }).__daiStore = cfg;
    },
    { presignUrl: `${storeBase}/presign`, publicBase: `${storeBase}/` },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => process.stdout.write(`[${label} pageerror] ${error.message}\n`));
  page.on("console", (m) => {
    if (m.type() === "error") process.stdout.write(`[${label} console.error] ${m.text().slice(0, 200)}\n`);
  });
  return { context, page };
}

const useRelay = (page: Page): Promise<void> => page.evaluate((b) => (window as any).__runner.useRelay(b), relayBase);
const pull = (page: Page): Promise<void> => page.evaluate(() => (window as any).__runner.pullMailbox());
async function pullUntil(page: Page, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await pull(page);
    await check();
  }).toPass({ timeout: 45_000 });
}

const entityOf = async (app: FrameLocator, text: string): Promise<string> =>
  (await app.locator("#terms li", { hasText: text }).first().getAttribute("data-entity"))!;

async function edit(app: FrameLocator, entity: string, wording: string): Promise<void> {
  await app.locator(`#term-edit-${entity}`).click();
  await app.locator(`#term-edit-text-${entity}`).fill(wording);
  await app.locator(`#term-save-${entity}`).click();
  await expect(app.locator(`#term-text-${entity}`)).toHaveText(wording, { timeout: 15_000 });
}

test("what B is typing survives the other copy's rows arriving", async ({ browser }) => {
  // The WebKit failure's snapshot fits one story: a background merge redrew the
  // term list while B was mid-edit, rebuilt the textarea from the stored
  // wording, and B's typing was gone. Forced deterministically here.
  const { context: ctxA, page: pageA } = await device(browser, "A");
  const { context: ctxB, page: pageB } = await device(browser, "B");
  await pageA.goto(RUNNER_URL);
  await pageA.setInputFiles("#file", container);
  await pageA.locator("#card-open").click();
  const appA = appIn(pageA);
  await expect(appA.locator("#new-agreement")).toBeVisible({ timeout: 60_000 });
  await appA.locator("#agreement-name").fill("House rules");
  await appA.locator("#you").fill("Ada");
  await appA.locator("#them").fill("Bo");
  await appA.locator("#start-agreement").click();
  for (const wording of ["Bins go out on Monday.", "Quiet after 11."]) {
    await appA.locator("#new-term").fill(wording);
    await appA.locator("#add-term").click();
    await expect(appA.locator("#terms")).toContainText(wording, { timeout: 15_000 });
  }
  await useRelay(pageA);
  await pageA.evaluate(() => {
    (window as any).__copied = undefined;
    navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
  });
  await pageA.click("#more");
  await pageA.click("#send");
  await pageA.click("#send-go");
  await expect(pageA.locator("#report")).toContainText(/Link copied|Shared/, { timeout: 30_000 });
  const link = (await pageA.evaluate(() => (window as any).__copied as string | undefined))!;
  await pageB.goto(link);
  await pageB.locator("#card-open").click({ timeout: 60_000 });
  const appB = appIn(pageB);
  await expect(appB.locator("#terms")).toContainText("Quiet after 11.", { timeout: 60_000 });
  await useRelay(pageB);
  const bins = await entityOf(appB, "Bins");
  const quiet = await entityOf(appB, "Quiet");

  // B opens the editor on one term and types, without saving.
  await appB.locator(`#term-edit-${bins}`).click();
  await appB.locator(`#term-edit-text-${bins}`).fill("Bins go out on Sunday night.");
  // A changes a different term, and B's copy receives it.
  await edit(appA, quiet, "Quiet after 10.");
  await pullUntil(pageB, () => expect(appB.locator(`#term-text-${quiet}`)).toHaveText("Quiet after 10.", { timeout: 2_000 }));
  // What B was typing should still be there.
  await expect(appB.locator(`#term-edit-text-${bins}`)).toHaveValue("Bins go out on Sunday night.");

  for (const context of [ctxA, ctxB]) await context.close();
});

test("an agreement is written, contested, accepted, voided, re-accepted and sealed over the mailbox", async ({ browser }) => {
  test.slow();
  const { context: ctxA, page: pageA } = await device(browser, "A");
  const { context: ctxB, page: pageB } = await device(browser, "B");
  const { context: ctxC, page: pageC } = await device(browser, "C");

  // A starts an agreement with two terms, then invites B by link.
  await pageA.goto(RUNNER_URL);
  await pageA.setInputFiles("#file", container);
  await pageA.locator("#card-open").click();
  const appA = appIn(pageA);
  await expect(appA.locator("#new-agreement")).toBeVisible({ timeout: 60_000 });
  await appA.locator("#agreement-name").fill("Lease for 12 Elm St");
  await appA.locator("#you").fill("Ada");
  await appA.locator("#them").fill("Bo");
  await appA.locator("#start-agreement").click();
  for (const wording of ["Rent is 1000 a month.", "Pets are allowed."]) {
    await appA.locator("#new-term").fill(wording);
    await appA.locator("#add-term").click();
    await expect(appA.locator("#terms")).toContainText(wording, { timeout: 15_000 });
  }
  await useRelay(pageA);
  await pageA.evaluate(() => {
    (window as any).__copied = undefined;
    navigator.clipboard.writeText = async (t: string) => void ((window as any).__copied = t);
  });
  await pageA.click("#more");
  await pageA.click("#send");
  await pageA.click("#send-go");
  await expect(pageA.locator("#report")).toContainText(/Link copied|Shared/, { timeout: 30_000 });
  const link = (await pageA.evaluate(() => (window as any).__copied as string | undefined))!;
  expect(link, "the share produced a link").toBeTruthy();

  // B opens the link: takes the open seat and sees both terms.
  await pageB.goto(link);
  await pageB.locator("#card-open").click({ timeout: 60_000 });
  const appB = appIn(pageB);
  await expect(appB.locator("#terms")).toContainText("Pets are allowed.", { timeout: 60_000 });
  await expect(appB.locator("#seat")).toBeHidden();
  await useRelay(pageB);
  const rent = await entityOf(appB, "Rent is");
  const pets = await entityOf(appB, "Pets");

  // Mailbox, B → A: an edit crosses with no file.
  await edit(appB, rent, "Rent is 900 a month.");
  await pullUntil(pageA, () => expect(appA.locator(`#term-text-${rent}`)).toHaveText("Rent is 900 a month.", { timeout: 2_000 }));

  // The same term edited on both copies before either hears of the other.
  await edit(appA, pets, "No pets.");
  await edit(appB, pets, "Cats only.");
  await pullUntil(pageA, () => expect(appA.locator(`#term-${pets} .conflict`)).toBeVisible({ timeout: 2_000 }));
  await expect(appA.locator("#accept")).toBeDisabled();
  await appA.locator(`#term-${pets} .conflict button`, { hasText: "Cats only." }).click();
  await expect(appA.locator(`#term-${pets} .conflict`)).toHaveCount(0);
  await expect(appA.locator(`#term-text-${pets}`)).toHaveText("Cats only.");
  await pullUntil(pageB, async () => {
    await expect(appB.locator(`#term-${pets} .conflict`)).toHaveCount(0, { timeout: 2_000 });
    await expect(appB.locator(`#term-text-${pets}`)).toHaveText("Cats only.", { timeout: 2_000 });
  });

  // Both accept the same version: agreed on both copies.
  await appA.locator("#accept").click();
  await pullUntil(pageB, () => expect(appB.locator("#acceptance-first")).toHaveAttribute("data-accepted", "true", { timeout: 2_000 }));
  await appB.locator("#accept").click();
  await expect(appB.locator("#agreement-status")).toHaveAttribute("data-state", "agreed");
  await pullUntil(pageA, () => expect(appA.locator("#agreement-status")).toHaveAttribute("data-state", "agreed", { timeout: 2_000 }));

  // Any change voids both acceptances, without anybody writing a status.
  await edit(appB, rent, "Rent is 950 a month.");
  await expect(appB.locator("#agreement-status")).toHaveAttribute("data-state", "open");
  await pullUntil(pageA, () => expect(appA.locator("#agreement-status")).toHaveAttribute("data-state", "open", { timeout: 2_000 }));
  await expect(appA.locator("#acceptance-first")).toHaveAttribute("data-accepted", "false");

  // Re-accepted, then sealed by A.
  await appA.locator("#accept").click();
  await pullUntil(pageB, () => expect(appB.locator("#acceptance-first")).toHaveAttribute("data-accepted", "true", { timeout: 2_000 }));
  await appB.locator("#accept").click();
  await pullUntil(pageA, () => expect(appA.locator("#agreement-status")).toHaveAttribute("data-state", "agreed", { timeout: 2_000 }));
  await appA.locator("#seal").click();
  await appA.locator("#seal-confirm-yes").click();
  await expect(appA.locator("#agreement-status")).toHaveAttribute("data-state", "sealed");

  // B, not yet having heard of the seal, edits a term. The seal closed the
  // session at what A had seen, so that late edit is not admitted — on A, and
  // on B once the seal arrives.
  await edit(appB, rent, "Rent is 1 a month.");
  await pullUntil(pageB, () => expect(appB.locator("#agreement-status")).toHaveAttribute("data-state", "sealed", { timeout: 2_000 }));
  await expect(appB.locator(`#term-text-${rent}`)).toHaveText("Rent is 950 a month.");
  await expect(appB.locator("#add-term-form")).toBeHidden();
  await pull(pageA);
  await pull(pageA);
  await expect(appA.locator(`#term-text-${rent}`)).toHaveText("Rent is 950 a month.");
  await expect(appA.locator("#agreement-status")).toHaveAttribute("data-state", "sealed");

  // C is handed B's copy as a file, never invited: can read, cannot take part.
  await pageB.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloading = pageB.waitForEvent("download", { timeout: 60_000 });
  await pageB.evaluate(() => (window as any).__runner.exportContainer());
  const forwarded = join(mkdtempSync(join(tmpdir(), "dai-blind2-fwd-")), "fwd.dai.html");
  writeFileSync(forwarded, readFileSync(await (await downloading).path()));
  await pageC.goto(RUNNER_URL);
  await pageC.setInputFiles("#file", forwarded);
  await pageC.locator("#card-open").click({ timeout: 60_000 });
  const appC = appIn(pageC);
  await expect(appC.locator("#seat-text")).toContainText("not been invited", { timeout: 60_000 });
  await expect(appC.locator("#accept")).toBeHidden();

  for (const context of [ctxA, ctxB, ctxC]) await context.close();
});
