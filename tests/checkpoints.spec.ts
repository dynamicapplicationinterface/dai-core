import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./fixtures.js";
import { buildNotes, openFile, savesWritten, typeNote, uuidOf } from "./owner.js";
import { serveOwnerStore } from "./owner-store-memory.js";
import { enrollHere, keepingLog, keptRecord, libraryRevision, openerWithStore, pillText, waitSettledKept } from "./keeping.js";
import { digestOf, parseEnvelope } from "../apps/owner-store/src/envelope.js";

/**
 * Checkpoints, Build 2b-2 item 2 (R-C, R-Z sentence 2; docs/store.md).
 *
 * Saving appends a checkpoint: {release digest, document id, revision,
 * database digest, parent checkpoint digests}, signed by the author key,
 * sealed under the data key, chained to the last one acknowledged. The
 * receipt is the store's acknowledgment of exactly that revision: one that
 * names an envelope differing by one byte from what was sent is refused by
 * the opener, and a replayed acknowledgment advances nothing.
 *
 * Chromium only: an owner needs a passkey with PRF, which only Chromium's
 * virtual authenticator gives under Playwright.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const PASSKEY = "an owner needs a passkey with PRF: Chromium's virtual authenticator";

test.describe("checkpoints (R-C, Build 2b-2 item 2)", () => {
  test.slow();

  test("each save appends a checkpoint chained to the last one acknowledged, and the receipt is for exactly what was sent", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", PASSKEY);
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-keep-")), "Notes"));
      const uuid = await uuidOf(page);
      const owner = await enrollHere(page);
      await typeNote(app, "first");
      const first = await waitSettledKept(page, uuid);
      expect(first.owner).toBe(owner);
      await typeNote(app, " second");
      const second = await waitSettledKept(page, uuid, first.revision);
      expect(second.revision).toBeGreaterThan(first.revision);

      // What the store was sent: envelopes in a chain, the last the one acknowledged.
      const appends = store.received().filter((r) => r.method === "POST" && r.url.includes(`/d/${owner}/${uuid}/append`));
      const envelopes = await Promise.all(appends.map(async (r) => ({ digest: await digestOf(r.body), envelope: parseEnvelope(r.body) })));
      const byDigest = new Map(envelopes.map((e) => [e.digest, e.envelope]));
      expect(byDigest.has(second.digest), "the acknowledged digest is of bytes the store was sent").toBe(true);
      // Walk the chain back from the last acknowledged: every parent was appended, back to a root.
      let at = byDigest.get(second.digest)!;
      let steps = 0;
      while (at.parents.length > 0) {
        expect(at.parents).toHaveLength(1);
        expect(byDigest.has(at.parents[0]!), "each parent is an envelope this opener appended").toBe(true);
        at = byDigest.get(at.parents[0]!)!;
        steps += 1;
      }
      expect(steps).toBeGreaterThanOrEqual(1);
      expect(at.author).toBe(byDigest.get(second.digest)!.author);
      expect(await pillText(page)).toBe("Kept");
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("a receipt naming an envelope one byte different from what was sent is refused, and nothing is kept", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", PASSKEY);
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      // Every append is stored, and answered for the envelope with its last byte changed.
      store.rewrite(async (path, answer, body) => {
        if (!path.endsWith("/append") || !answer.ok) return answer;
        const ack = (await answer.json()) as Any;
        const altered = Buffer.from(body);
        altered[altered.length - 2] ^= 1;
        return new Response(JSON.stringify({ ...ack, digest: await digestOf(altered) }), { status: 200, headers: answer.headers });
      });
      const { page } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-keep-")), "Notes"));
      const uuid = await uuidOf(page);
      await enrollHere(page);
      await typeNote(app, "first");
      await expect.poll(async () => JSON.stringify(await keepingLog(page)), { timeout: 45_000 }).toMatch(/"refusedReceipts":[1-9]/);
      const saves = await savesWritten(page);
      await expect.poll(() => libraryRevision(page, uuid), { timeout: 30_000 }).toBeGreaterThan(0);
      expect(await keptRecord(page, uuid), "no receipt held, so nothing is kept").toBeNull();
      expect((await keepingLog(page)).kept).toBe(0);
      expect(saves).toBeGreaterThan(0);
      await expect.poll(() => pillText(page), { timeout: 15_000 }).toMatch(/^Saved in this browser/);
      expect(await pillText(page)).not.toContain("Kept");
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("a replayed acknowledgment advances nothing", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", PASSKEY);
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page } = await openerWithStore(context, store.base);
      const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-keep-")), "Notes"));
      const uuid = await uuidOf(page);
      await enrollHere(page);
      await typeNote(app, "first");
      const first = await waitSettledKept(page, uuid);
      // From here every append is answered with an acknowledgment already given: the first one, replayed.
      store.rewrite(async (path, answer) => {
        if (!path.endsWith("/append") || !answer.ok) return answer;
        return new Response(
          JSON.stringify({ result: first.as, digest: first.digest, at: first.at, owner: first.owner, document: uuid }),
          { status: 200, headers: answer.headers },
        );
      });
      const before = (await keepingLog(page)).refusedReceipts;
      await typeNote(app, " more");
      await expect.poll(async () => (await keepingLog(page)).refusedReceipts, { timeout: 45_000 }).toBeGreaterThan(before);
      await expect.poll(() => libraryRevision(page, uuid), { timeout: 30_000 }).toBeGreaterThan(first.revision);
      const after = await keptRecord(page, uuid);
      expect(after, "the kept record is the first one still").toEqual(first);
      const at = new Date(first.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      await expect.poll(() => pillText(page), { timeout: 15_000 }).toBe(`Saved here · kept ${at}`);
    } finally {
      await context.close();
      await store.close();
    }
  });
});
