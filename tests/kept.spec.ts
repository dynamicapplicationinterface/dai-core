import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { RUNNER_URL, buildNotes, openFile, pointAtStore, storedHolds, typeNote, uuidOf } from "./owner.js";
import { KEYS } from "../src/keys.js";
import { serveOwnerStore } from "./owner-store-memory.js";
import { enrollHere, keepingLog, keptRecord, libraryRevision, openerWithStore, pillText, putInKeyStore, waitKeptCurrent, waitSettledKept } from "./keeping.js";

/**
 * "Kept", Build 2b-2 item 3 (R-Z sentences 2 and 4; D300).
 *
 * The pill reads "Kept" only on the store's acknowledgment of the revision on
 * screen. Offline, or with the store unreachable, the document stays
 * editable, new edits stay in this browser, the last kept revision does not
 * advance, and the pill says both facts in its own box: "Saved here · kept
 * 10:42 AM", named by R-Z's sentence "Saved in this browser. Last kept at
 * 10:42 AM." A connection that comes back changes nothing by itself; an
 * acknowledgment does. And the pill's box is one box, whatever it says.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/**
 * Says, as another page of this browser context does when an owner signs in,
 * that the owner changed: the opener reads the owner and what is kept again.
 */
const announceOwner = (page: Page): Promise<void> => page.evaluate((name) => new BroadcastChannel(name).postMessage("changed"), KEYS.OWNER);

const shortTime = (page: Page, iso: string): Promise<string> =>
  page.evaluate((at) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), iso);

test.describe("Kept (R-Z sentences 2 and 4, Build 2b-2 item 3)", () => {
  test.slow();

  test("store unavailable: the document stays editable, new edits stay here, the last kept revision does not advance, and only an acknowledgment says Kept again", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "an owner needs a passkey with PRF: Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-kept-")), "Notes"));
      const uuid = await uuidOf(page);
      await enrollHere(page);
      await typeNote(app, "first");
      // Every key of it saved and every save written, then that revision kept: none is still on its way.
      await expect.poll(() => storedHolds(page, uuid, "first"), { timeout: 30_000 }).toBe(true);
      const first = await waitSettledKept(page, uuid);
      await expect.poll(() => pillText(page)).toBe("Kept");
      const at = await shortTime(page, first.at);
      const earlier = `Saved here · kept ${at}`;
      const sentence = `Saved in this browser. Last kept at ${at}.`;

      // Offline: the edit saves here, and the pill says both facts.
      await context.setOffline(true);
      await typeNote(app, " offline");
      await expect.poll(() => storedHolds(page, uuid, "first offline"), { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => (await keepingLog(page)).unavailable, { timeout: 30_000 }).toBeGreaterThan(0);
      await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe(earlier);
      await expect(page.locator("#save-state")).toHaveAttribute("aria-label", sentence);
      expect(await keptRecord(page, uuid), "the last kept revision does not advance").toEqual(first);
      await context.setOffline(false);

      // The store unreachable: refusing every request, the connection fine.
      store.setMode("unavailable");
      await typeNote(app, " unreachable");
      await expect.poll(() => storedHolds(page, uuid, "first offline unreachable"), { timeout: 30_000 }).toBe(true);
      const revision = await libraryRevision(page, uuid);
      await expect.poll(async () => (await keepingLog(page)).last, { timeout: 30_000 }).toMatch(/^unavailable: HTTP 503/);
      await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe(earlier);
      expect(await keptRecord(page, uuid)).toEqual(first);
      // The field still takes every key: editing is never blocked.
      await expect(app.locator("#note")).toHaveValue("first offline unreachable");

      // The connection "comes back", and the store still cannot acknowledge: nothing changes.
      store.setMode("up");
      store.rewrite((path, answer) => (path.endsWith("/append") ? new Response(null, { status: 503 }) : answer));
      const before = await keepingLog(page);
      // Every word the pill says from here, not only the last: "never" is not "eventually".
      await page.evaluate(() => {
        const said: string[] = [];
        (window as Any).__pillSaid = said;
        const el = document.getElementById("save-state")!;
        new MutationObserver(() => said.push(el.innerText.trim())).observe(el, { childList: true, subtree: true, characterData: true });
      });
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect.poll(async () => (await keepingLog(page)).sent, { timeout: 30_000 }).toBeGreaterThan(before.sent);
      await expect.poll(async () => (await keepingLog(page)).unavailable, { timeout: 30_000 }).toBeGreaterThan(before.unavailable);
      expect(await pillText(page), "reconnecting alone never changes the label").toBe(earlier);
      const said = (await page.evaluate(() => (window as Any).__pillSaid)) as string[];
      expect(said.filter((w) => w !== earlier), "nothing else was said while reconnecting").toEqual([]);
      expect(await keptRecord(page, uuid)).toEqual(first);

      // An acknowledgment does.
      store.rewrite(null);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      const now = await waitKeptCurrent(page, uuid, first.revision);
      expect(now.revision).toBe(revision);
      await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe("Kept");
      await expect(page.locator("#save-state")).not.toHaveAttribute("aria-label", /./);
    } finally {
      await context.close();
      await store.close();
    }
  });

  for (const [width, height] of [
    [390, 700],
    [1280, 720],
  ] as const) {
    test(`at ${width} wide the pill's box is one box in every state it shows: the offer, saving, saved, kept, and kept earlier`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height } });
      // The offer is made only by an opener with a store; the owner planted below has no record, so nothing is sent to it.
      const store = await serveOwnerStore();
      await pointAtStore(context, store.base);
      try {
        const page = await context.newPage();
        // Every box the pill has while it is shown, with its words, from the moment the page loads.
        await page.addInitScript(() => {
          const seen: { words: string; box: number[]; fits: boolean }[] = [];
          (window as Any).__pillBoxes = seen;
          const record = () => {
            const el = document.getElementById("save-state");
            if (!el || el.dataset.shown === undefined) return;
            const r = el.getBoundingClientRect();
            const span = el.querySelector(".words");
            const fits = !span || span.scrollWidth <= span.clientWidth;
            seen.push({ words: el.innerText.trim(), box: [r.x, r.y, r.width, r.height], fits });
          };
          const watch = () => {
            const el = document.getElementById("save-state");
            if (!el) return void setTimeout(watch, 20);
            new MutationObserver(record).observe(el, { attributes: true, childList: true, subtree: true, characterData: true });
          };
          watch();
        });
        const boxes: { words: string; box: number[]; fits: boolean }[] = [];
        const collect = async () => boxes.push(...((await page.evaluate(() => (window as Any).__pillBoxes)) as typeof boxes));

        await page.goto(RUNNER_URL);
        const file = await buildNotes(mkdtempSync(join(tmpdir(), "dai-kept-")), "Notes");
        const app = await openFile(page, file);
        const uuid = await uuidOf(page);
        // The offer, then "Not now": saving and saved.
        await typeNote(app, "a");
        await expect(page.locator("#save-state[data-offer]")).toBeVisible({ timeout: 30_000 });
        await page.locator("#save-state").click();
        await page.locator("#keep-not-now").click();
        await typeNote(app, "b");
        await expect.poll(() => storedHolds(page, uuid, "ab"), { timeout: 30_000 }).toBe(true);
        await expect.poll(() => pillText(page)).toBe("Saved in this browser");
        await collect();

        // An owner signed in, the revision on screen kept: "Kept".
        const revision = await libraryRevision(page, uuid);
        const noon = await page.evaluate(() => new Date(2026, 9, 27, 12, 59).toISOString());
        const kept = { owner: "owner-under-test", revision, digest: "d", checkpoint: "c", release: "r", at: noon, as: "head" };
        await putInKeyStore(page, KEYS.OWNER, kept.owner);
        await putInKeyStore(page, `dai:kept:${uuid}`, kept);
        await announceOwner(page);
        await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe("Kept");
        await collect();

        // An earlier revision kept: both facts, at the widest time of day.
        await putInKeyStore(page, `dai:kept:${uuid}`, { ...kept, revision: revision - 1 });
        await announceOwner(page);
        const earlier = `Saved here · kept ${await shortTime(page, noon)}`;
        await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe(earlier);
        // And typing on, which passes through saving back to it.
        await typeNote(app, "c");
        await expect.poll(() => storedHolds(page, uuid, "abc"), { timeout: 30_000 }).toBe(true);
        await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe(earlier);
        await collect();

        const words = new Set(boxes.map((b) => b.words));
        for (const expected of ["Saved in this browser · Keep?", "Saved in this browser", "Kept", earlier]) {
          expect(words.has(expected), `the pill was seen saying "${expected}" (saw ${[...words].join(" | ")})`).toBe(true);
        }
        const offer = boxes.find((b) => b.words === "Saved in this browser · Keep?")!.box;
        for (const { words: said, box } of boxes) {
          box.forEach((value, i) => expect(Math.abs(value - offer[i]!), `"${said}": box ${box.join(",")} against the offer's ${offer.join(",")}`).toBeLessThan(0.01));
        }
        // And in every state the words fit the box whole on this engine: nothing is cut.
        expect(boxes.filter((b) => !b.fits).map((b) => b.words), "words cut to fit the box").toEqual([]);
      } finally {
        await context.close();
        await store.close();
      }
    });
  }
});
