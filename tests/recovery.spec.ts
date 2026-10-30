import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type CDPSession, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, appIn, buildNotes, openFile, pointAtStore, storedHolds, typeNote, uuidOf } from "./owner.js";
import { serveOwnerStore } from "./owner-store-memory.js";
import { enrollHere, keptRecord, openerWithStore, waitSettledKept } from "./keeping.js";

/**
 * Recovery, Build 2b-2 item 5 (R-Z sentence 5 and its first red test; R-E).
 *
 * R-Z's first red test, in four steps: A is kept; the store is cut off; B is saved in this
 * browser only; the browser's storage is wiped. Recover, with the passkey,
 * brings back A exactly, identified by the time the store acknowledged it,
 * with no claim about B and no invented count of anything. And recovery with
 * the store unreachable says so, and presents nothing as recovered.
 *
 * Chromium only: the passkey with PRF is its virtual authenticator, which
 * keeps the passkey through the wipe as a phone's keychain does.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const SENTENCE_TAIL = "Changes saved only in the cleared browser are not included.";

/** Wipes everything this origin keeps: storage, databases, the worker and its caches. The passkey is the authenticator's. */
async function wipe(page: Page, cdp: CDPSession): Promise<void> {
  await cdp.send("Storage.clearDataForOrigin", { origin: new URL(RUNNER_URL).origin, storageTypes: "all" });
  await page.goto(RUNNER_URL);
  expect(await page.evaluate(() => (window as Any).__runner.listLibrary()), "nothing is left").toEqual([]);
}

test.describe("recovery (R-Z sentence 5, Build 2b-2 item 5)", () => {
  test.slow();

  test("A kept, the store cut off, B saved here only, the browser wiped: Recover brings back A exactly, by its time, and says nothing of B", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, provider } = await openerWithStore(context, store.base);
      const file = await buildNotes(mkdtempSync(join(tmpdir(), "dai-recover-")), "Notes");
      let app = await openFile(page, file);
      const uuid = await uuidOf(page);
      await enrollHere(page);

      // 1. A, kept, at two revisions that differ: a recovery that restores the head's parent is not A.
      await typeNote(app, "A-7Q");
      await expect.poll(() => storedHolds(page, uuid, "A-7Q"), { timeout: 30_000 }).toBe(true);
      const earlier = await waitSettledKept(page, uuid);
      await typeNote(app, "-kept");
      await expect.poll(() => storedHolds(page, uuid, "A-7Q-kept"), { timeout: 30_000 }).toBe(true);
      const a = await waitSettledKept(page, uuid, earlier.revision);
      // 2. The store cut off. 3. B, saved in this browser only.
      store.setMode("unavailable");
      await typeNote(app, " B-local-3X");
      await expect.poll(() => storedHolds(page, uuid, "A-7Q-kept B-local-3X"), { timeout: 30_000 }).toBe(true);
      await page.evaluate(() => (window as Any).__runner.flush());
      expect(await keptRecord(page, uuid), "B was never kept").toEqual(a);
      // 4. The browser's storage wiped; the store back.
      await wipe(page, provider.cdp);
      store.setMode("up");
      await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);

      // Recover, with the passkey.
      await expect(page.locator("#recover")).toBeVisible();
      await page.locator("#recover").click();
      const at = await page.evaluate((iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), a.at);
      const row = page.locator(`#recovered button[data-document="${uuid}"]`);
      await expect(row).toHaveText(`Notes · kept ${at}`, { timeout: 30_000 });
      await expect(page.locator("#recovered li")).toHaveCount(1);
      await row.click();

      // A exactly, identified by its time; nothing about B, and no count of anything.
      app = appIn(page);
      await expect(app.locator("#note")).toHaveValue("A-7Q-kept", { timeout: 60_000 });
      await expect(page.locator("#doc-note")).toHaveText(`Restored the copy kept at ${at}. ${SENTENCE_TAIL}`);
      const said = `${await page.locator("body").innerText()}`;
      expect(said).not.toContain("B-local-3X");
      expect((await page.locator("#doc-note").innerText()).replace(at, "").match(/\d/g), "no number but the time").toBeNull();
      // The restored copy goes on under the same owner: its own save on opening is kept on the chain after A.
      await expect.poll(async () => (await keptRecord(page, uuid))?.owner, { timeout: 30_000 }).toBe(a.owner);
      expect((await keptRecord(page, uuid))!.revision).toBeGreaterThanOrEqual(a.revision);
      await expect(page.locator("#save-state")).toHaveText("Kept", { timeout: 30_000 });
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("the store drops out at the second document: the first is restored whole, its owner signed in, and the sentence says what came back", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, provider } = await openerWithStore(context, store.base);
      const scratch = mkdtempSync(join(tmpdir(), "dai-recover-"));
      const files = { First: await buildNotes(scratch, "First"), Second: await buildNotes(scratch, "Second") };
      const ids: Record<string, string> = {};
      let owner = "";
      for (const [title, file] of Object.entries(files)) {
        const app = await openFile(page, file);
        ids[title] = await uuidOf(page);
        if (!owner) owner = await enrollHere(page);
        await typeNote(app, `${title}-text`);
        await expect.poll(() => storedHolds(page, ids[title]!, `${title}-text`), { timeout: 30_000 }).toBe(true);
        await waitSettledKept(page, ids[title]!);
      }

      await wipe(page, provider.cdp);
      await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
      // The library lists documents sorted: the store stops answering at the second's heads.
      const [first, second] = Object.keys(ids).sort((x, y) => (ids[x]! < ids[y]! ? -1 : 1)) as [string, string];
      let cut = false;
      await context.route(`${store.base}/**`, async (route) => {
        if (route.request().url().includes(`/${ids[second]}/heads`)) cut = true;
        return cut ? route.abort("connectionrefused") : route.continue();
      });
      await page.locator("#recover").click();
      await expect(page.locator("#report")).toHaveText(
        `Restored ${first}. The rest could not be reached: the store stopped answering. Recover again when you are online.`,
        { timeout: 30_000 },
      );
      await expect(page.locator("#recovered li")).toHaveCount(1);
      await expect(page.locator(`#recovered button[data-document="${ids[first]}"]`)).toBeVisible();
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "signed in as the owner it restored for").toBe(owner);
      // The first, whole: in the library, its data key under the owner, its kept record.
      const listed = ((await page.evaluate(() => (window as Any).__runner.listLibrary())) as Any[]).map((item) => item.documentUuid);
      expect(listed).toEqual([ids[first]]);
      expect((await keptRecord(page, ids[first]!))?.owner).toBe(owner);
      expect(await storedHolds(page, ids[first]!, `${first}-text`)).toBe(true);

      // Another page of this browser: Recover is still offered there, so what offers it is held here, not in the page;
      // and the person's own file of the restored document opens: nothing refuses it as another owner's.
      await context.unroute(`${store.base}/**`);
      await pointAtStore(context, store.base);
      const other = await context.newPage();
      await other.goto(RUNNER_URL);
      await expect(other.locator("#recover")).toBeVisible();
      await other.setInputFiles("#file", files[first as keyof typeof files]);
      await other.locator("#card-open").click({ timeout: 30_000 });
      await expect.poll(() => other.evaluate(() => (window as Any).__runner.loaded?.manifest?.documentUuid ?? null), { timeout: 30_000 }).toBe(ids[first]);
      expect(await other.locator("body").innerText()).not.toContain("belongs to another owner");

      // Recover again, the store back: the rest comes back, and what is here stays.
      await page.locator("#recover").click();
      await expect(page.locator("#recovered li")).toHaveCount(2, { timeout: 30_000 });
      await expect(page.locator("#report")).toHaveText("");
      expect((await keptRecord(page, ids[second]!))?.owner).toBe(owner);
      expect(await storedHolds(page, ids[second]!, `${second}-text`)).toBe(true);
      await expect(page.locator("#recover")).toBeHidden();
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("a document kept many times is recovered from its head, the head's parent and its container's envelope, not every revision kept", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, provider } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-recover-")), "Notes"));
      const uuid = await uuidOf(page);
      await enrollHere(page);
      for (let n = 1, after = 0; n <= 6; n += 1) {
        await typeNote(app, ` r${n}`);
        after = (await waitSettledKept(page, uuid, after)).revision;
      }
      const text = await app.locator("#note").inputValue();
      const appended = store.bucket().filter((o) => o.key.includes(`/${uuid}/`));
      expect(appended.length, "kept many times").toBeGreaterThanOrEqual(6);
      const size = new Map(appended.map((o) => [o.key.split("/").pop()!, o.bytes.length]));

      const recoverAndCount = async (): Promise<{ gets: number; bytes: number }> => {
        await wipe(page, provider.cdp);
        await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
        const from = store.received().length;
        await page.locator("#recover").click();
        await expect(page.locator(`#recovered button[data-document="${uuid}"]`)).toBeVisible({ timeout: 30_000 });
        expect(await storedHolds(page, uuid, text), "the head, exactly").toBe(true);
        const gets = store.received().slice(from).filter((r) => r.method === "GET" && r.url.includes(`/d/`) && r.url.includes("/e/"));
        return { gets: gets.length, bytes: gets.reduce((sum, r) => sum + (size.get(r.url.split("/e/")[1]!.split("?")[0]!) ?? 0), 0) };
      };

      const now = await recoverAndCount();
      const largest = Math.max(...size.values());
      const later = [...size.values()].filter((n) => n !== largest);
      console.log(`recovery after ${appended.length} kept: ${now.gets} envelopes, ${now.bytes} bytes (all kept: ${[...size.values()].reduce((a, b) => a + b, 0)} bytes)`);
      expect(now.gets, "the head, its parent, the container's envelope").toBeLessThanOrEqual(3);
      expect(now.bytes).toBeLessThanOrEqual(largest + 2 * Math.max(...later));

      // A store with no Chain yet: the envelopes are the chain, and the document still comes back.
      store.rewrite((path, answer) => (/\/c\/[A-Za-z0-9_-]{43}$/.test(path) ? new Response(JSON.stringify({ refused: "no such operation" }), { status: 404, headers: answer.headers }) : answer));
      const without = await recoverAndCount();
      console.log(`recovery without Chain: ${without.gets} envelopes, ${without.bytes} bytes`);
      expect(without.gets).toBeLessThanOrEqual(3);
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("with the store unreachable, recovery says so and presents nothing as recovered", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, provider } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-recover-")), "Notes"));
      const uuid = await uuidOf(page);
      await enrollHere(page);
      await typeNote(app, "kept");
      await expect.poll(() => storedHolds(page, uuid, "kept"), { timeout: 30_000 }).toBe(true);
      await waitSettledKept(page, uuid);

      await wipe(page, provider.cdp);
      store.setMode("unavailable");
      await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
      await page.locator("#recover").click();
      await expect(page.locator("#report")).toHaveText(
        "Your documents could not be recovered right now: the store did not answer. Nothing was restored. Try again when you are online.",
        { timeout: 30_000 },
      );
      await expect(page.locator("#recovered")).toBeHidden();
      expect(await page.evaluate(() => (window as Any).__runner.listLibrary()), "nothing presented as recovered").toEqual([]);
      expect(await page.evaluate(() => (window as Any).__runner.owner.current()), "and nobody signed in on nothing").toBeNull();
      expect(await page.evaluate(() => (window as Any).__runner.loaded ?? null)).toBeNull();
    } finally {
      await context.close();
      await store.close();
    }
  });
});
