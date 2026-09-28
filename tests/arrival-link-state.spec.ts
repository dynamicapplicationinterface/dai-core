import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { compileDirectory } from "../src/compile.js";
import { publish } from "../src/store.js";
import { fsStore } from "../src/store-fs.js";
import { inlineLink } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_URL = "http://localhost:5175/";
const REFUSED = /already on this device, but it does not match/;

/** A plain file server for the store, as the icon tests use. */
async function serve(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const name = (request.url ?? "/").split("?")[0].replace(/^\//, "");
    try {
      const bytes = readFileSync(join(root, name));
      response.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
      response.end(bytes);
    } catch {
      response.writeHead(404, { "access-control-allow-origin": "*" });
      response.end("not found");
    }
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

/** A replicated example, signed, written to a file a person could pick. */
async function build(example: string, appName: string): Promise<{ html: string; uuid: string; file: string }> {
  const built = await compileDirectory({
    sourceDir: join(repo, "examples", example),
    root: repo,
    appName,
    signingKey: resolve(repo, "conformance", "signing-key.pem"),
    allowTestKey: true,
  });
  const file = join(mkdtempSync(join(tmpdir(), "dai-d127-")), `${example}.dai.html`);
  writeFileSync(file, built.html, "utf8");
  return { html: built.html, uuid: built.manifest.documentUuid, file };
}

/** The document key this device's library holds for one document, if any. */
const documentKeyOf = (page: Page, uuid: string): Promise<string | null> =>
  page.evaluate(async (id) => {
    const items = (await (window as any).__runner.listLibrary()) as { documentUuid: string; documentKey?: string }[];
    return items.find((item) => item.documentUuid === id)?.documentKey ?? null;
  }, uuid);

/** A file picked the way a person picks one: the chooser's button, then the system's picker. */
async function pick(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#open").click();
  await (await chooser).setFiles(file);
}

/**
 * A page where a store link was just refused, with "Open a file" in reach.
 *
 * One replicated document sealed twice: two links, two keys. The first link
 * opens it and files its key; the second is refused, because a held key is
 * never replaced (IDENTITY-KEY-HELD). Both links are real store arrivals, so
 * the refused one set the page's arriving key before it was refused.
 */
async function afterARefusedLink(browser: Browser): Promise<{
  page: Page;
  held: Awaited<ReturnType<typeof build>>;
  first: string;
  second: string;
  refusals: string[];
  close: () => Promise<void>;
}> {
  const held = await build("receipts", "Shared receipts");
  const root = mkdtempSync(join(tmpdir(), "dai-store-d127-"));
  const store = await serve(root);
  const first = (await publish(held.html, fsStore({ root, baseUrl: store.origin }), RUNNER_URL)).sealed;
  const second = (await publish(held.html, fsStore({ root, baseUrl: store.origin }), RUNNER_URL)).sealed;
  expect(second.key, "each seal has its own key").not.toBe(first.key);
  const link = (s: { hash: string; key: string }) => `${RUNNER_URL}d/${s.hash}#h=${s.hash}&k=${s.key}`;

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((config) => {
    (window as unknown as { __daiStore: unknown }).__daiStore = config;
  }, { presignUrl: store.origin + "/presign-unused", publicBase: store.origin + "/" });
  const refusals: string[] = [];
  page.on("console", (m) => {
    if (m.text().startsWith("dai: refused a link naming document")) refusals.push(m.text());
  });

  await page.goto(link(first));
  await page.locator("#card-open").click({ timeout: 60_000 });
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
  await expect.poll(() => documentKeyOf(page, held.uuid), { timeout: 30_000 }).toBe(first.key);

  await page.goto(link(second));
  await expect(page.locator("#report", { hasText: REFUSED })).toBeVisible({ timeout: 60_000 });
  expect(refusals, "the link is refused, once").toHaveLength(1);
  // The question the entry left open: whether a person can pick a file here at all.
  await expect(page.locator("#open"), "the chooser's own control is back").toBeVisible();

  return {
    page,
    held,
    first: first.key,
    second: second.key,
    refusals,
    close: async () => {
      await context.close();
      store.server.close();
    },
  };
}

/**
 * A link's key belongs to the arrival that carried it (backlog D127).
 *
 * A store link leaves its key and game on the page for the keep and the
 * mailbox to read. A link refused before the card puts the chooser back, and
 * "Open a file" with it, on the same page. A file picked there arrived by no
 * link, so it is read under no link's key.
 */
test.describe("a file picked after a refused link", () => {
  test.slow();

  test("is kept without the refused link's key", async ({ browser }) => {
    const { page, held, first, second, close } = await afterARefusedLink(browser);
    try {
      const picked = await build("request", "Shared request");
      await pick(page, picked.file);
      await page.locator("#card-open").click({ timeout: 60_000 });
      await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
      await expect
        .poll(
          () =>
            page.evaluate(
              async (id) =>
                ((await (window as any).__runner.listLibrary()) as { documentUuid: string }[]).some(
                  (item) => item.documentUuid === id,
                ),
              picked.uuid,
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      const key = await documentKeyOf(page, picked.uuid);
      expect(key, "not the refused link's key").not.toBe(second);
      expect(key, "a file carries no key, so none is kept").toBeNull();
      expect(await documentKeyOf(page, held.uuid), "and the held key stays").toBe(first);
    } finally {
      await close();
    }
  });

  test("is not refused against the link's key when this device holds it", async ({ browser }) => {
    const { page, held, first, refusals, close } = await afterARefusedLink(browser);
    try {
      await pick(page, held.file);
      // The card for the held copy, or a second refusal: whichever the pick brings.
      await expect
        .poll(async () => ((await page.locator("#card-open").isVisible()) ? "card" : refusals.length > 1 ? "refused" : ""), {
          timeout: 60_000,
        })
        .toBe("card");
      expect(refusals, "the picked file is not refused against the link").toHaveLength(1);
      expect(await documentKeyOf(page, held.uuid), "and the held key stays").toBe(first);
    } finally {
      await close();
    }
  });
});

/*
 * The same page, reached by a link rather than a file: a link carrying its
 * document in the fragment, pasted into the tab the refusal left. Nothing
 * reloads (a fragment change is a same-document navigation), so the opener's
 * hashchange handler opens it on the page the refused link's key is still on.
 */
test.describe("a link pasted after a refused link", () => {
  test.slow();

  test("is kept without the refused link's key", async ({ browser }) => {
    const { page, first, second, held, close } = await afterARefusedLink(browser);
    try {
      const pasted = await build("request", "Shared request");
      const link = await inlineLink(pasted.html, RUNNER_URL, {
        template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
        runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
      });
      if (!link) throw new Error("expected an inline link");
      await page.evaluate((hash) => {
        location.hash = hash;
      }, new URL(link).hash);
      await page.locator("#card-open").click({ timeout: 60_000 });
      await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
      await expect.poll(() => page.evaluate(
        async (id) =>
          ((await (window as any).__runner.listLibrary()) as { documentUuid: string }[]).some((item) => item.documentUuid === id),
        pasted.uuid,
      ), { timeout: 30_000 }).toBe(true);
      const key = await documentKeyOf(page, pasted.uuid);
      expect(key, "not the refused link's key").not.toBe(second);
      expect(key, "a link that carries its document carries no key, so none is kept").toBeNull();
      expect(await documentKeyOf(page, held.uuid), "and the held key stays").toBe(first);
    } finally {
      await close();
    }
  });
});
