import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { buildNotes, openFile, storedHolds, typeNote, uuidOf, withKeyStore } from "./owner.js";
import { serveOwnerStore, type ServedStore } from "./owner-store-memory.js";
import { enrollHere, openerWithStore, waitSettledKept } from "./keeping.js";
import { watchKeychain, wipe } from "./keychain.js";
import {
  admitChallenge,
  authorIdOf,
  b64u,
  checkpointDigest,
  digestOf,
  keychainVerifier,
  openEnvelope,
  parseEnvelope,
  sealEnvelope,
  utf8,
  type Author,
} from "../apps/owner-store/src/envelope.js";
import { admitAuthor, appendEnvelope, isRefused } from "../apps/owner-store/src/client.js";

/**
 * Every kept revision verifies on restore (R-C; Build 2b-2b item 8).
 *
 * A store is trusted for liveness, never for content (R-B), so a store that
 * serves an envelope whose signature does not hold, whose author is not
 * enrolled under the owner, or whose checkpoint does not name the checkpoint
 * of the envelope before it, has that document refused: not restored, not
 * listed, not opened, never "Kept", and the person told in one sentence.
 *
 * Each store here is the local test store made to lie the one way, as a store
 * that is not the owner's would: it can rewrite what it answers, and it can
 * hold whatever an enrolled author appends, but it holds no data key and no
 * author key. The broken link is appended by an author enrolled through the
 * keychain proof, holding the document's data key, as a faulty host would.
 *
 * Chromium only: the passkey with PRF is its virtual authenticator.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const REFUSED = "A kept copy could not be verified, so it was not restored.";

/** Keeps two revisions for a new owner, so the chain has a link; then wipes the browser. */
async function twoKeptThenWiped(context: BrowserContext, store: ServedStore) {
  const handed = await watchKeychain(context);
  const { page, provider } = await openerWithStore(context, store.base);
  const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-verify-")), "Notes"));
  const uuid = await uuidOf(page);
  const owner = await enrollHere(page);
  await typeNote(app, "first-1V");
  await expect.poll(() => storedHolds(page, uuid, "first-1V"), { timeout: 30_000 }).toBe(true);
  const first = await waitSettledKept(page, uuid);
  await typeNote(app, " second-2V");
  await expect.poll(() => storedHolds(page, uuid, "first-1V second-2V"), { timeout: 30_000 }).toBe(true);
  const head = await waitSettledKept(page, uuid, first.revision);
  // The data key, as the faulty host of the broken-link case holds it: exported here before the wipe.
  const dataKey = await withKeyStore<number[]>(page, `return [...new Uint8Array(await crypto.subtle.exportKey("raw", (await get("dai:data-key:" + arg)).key))];`, uuid);
  const appended = store
    .received()
    .filter((r) => r.method === "POST" && r.url.includes(`/d/${owner}/${uuid}/append`))
    .map((r) => new Uint8Array(r.body));
  await wipe(page, provider.cdp);
  await page.evaluate((b) => (window as Any).__runner.useStore(b), store.base);
  return { page, uuid, owner, head, appended, dataKey, secret: handed[0]!.secret };
}

/** The bytes the store holds for a digest, as the opener appended them. */
async function appendedAs(appended: Uint8Array[], digest: string): Promise<Uint8Array> {
  for (const bytes of appended) if ((await digestOf(bytes)) === digest) return bytes;
  throw new Error(`not appended: ${digest}`);
}

/** The store's own headers on a rewritten answer (its CORS among them, or the browser reads no answer), with `set` over them. */
function like(answer: Response, set: Record<string, string>): Headers {
  const headers = new Headers(answer.headers);
  for (const [key, value] of Object.entries(set)) headers.set(key, value);
  return headers;
}

/** Serves `forged` as the document's one head, under its own digest, and everything else as the store holds it. */
async function serveAsHead(store: ServedStore, uuid: string, forged: Uint8Array, at: string): Promise<string> {
  const digest = await digestOf(forged);
  store.rewrite(async (path, answer) => {
    if (path.endsWith(`/${uuid}/heads`)) {
      const held = (await answer.json()) as { key: string };
      return new Response(JSON.stringify({ key: held.key, heads: [{ digest, at }] }), { headers: like(answer, { "content-type": "application/json" }) });
    }
    if (path.endsWith(`/${uuid}/e/${digest}`)) return new Response(Buffer.from(forged), { headers: like(answer, { "content-type": "application/octet-stream", "x-dai-at": at }) });
    return answer;
  });
  return digest;
}

/** Recovers with the passkey and checks the one document is refused, by the check named, and nothing of it is restored. */
async function refusedOnRecover(page: Page, uuid: string, why: string): Promise<void> {
  const said: string[] = [];
  page.on("console", (message) => said.push(message.text()));
  await page.locator("#recover").click();
  await expect(page.locator("#report")).toHaveText(REFUSED, { timeout: 30_000 });
  expect(said.filter((line) => line.startsWith(`dai: ${uuid} not restored:`)), "refused by this check").toEqual([`dai: ${uuid} not restored: ${why}`]);
  await expect(page.locator("#recovered")).toBeHidden();
  await expect(page.locator(`#recovered button[data-document="${uuid}"]`)).toHaveCount(0);
  expect(await page.evaluate(() => (window as Any).__runner.listLibrary()), "nothing restored").toEqual([]);
  expect(await page.evaluate((id) => (window as Any).__runner.loadStored(id), uuid), "no database written").toBeNull();
  expect(await page.evaluate((id) => (window as Any).__runner.keeping.kept(id), uuid), "nothing called kept").toBeNull();
  expect(await page.evaluate(() => (window as Any).__runner.loaded ?? null), "nothing opened").toBeNull();
  await expect(page.locator("#save-state")).not.toHaveText("Kept");
}

test.describe("every kept revision verifies on restore (R-C; Build 2b-2b item 8)", () => {
  test.slow();

  test("a store serving an envelope whose signature does not hold: refused, not restored, and said", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, uuid, head, appended } = await twoKeptThenWiped(context, store);
      const real = parseEnvelope(await appendedAs(appended, head.digest));
      // The same envelope, its signature changed: it opens under the data key (the signature is not sealed), and does not verify.
      const flipped = real.signature.startsWith("A") ? `B${real.signature.slice(1)}` : `A${real.signature.slice(1)}`;
      await serveAsHead(store, uuid, utf8(JSON.stringify({ ...real, signature: flipped })), head.at);
      await refusedOnRecover(page, uuid, "envelope-signature");
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("a store naming the envelope's author as not enrolled under the owner: refused, not restored, and said", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, uuid, owner, head, appended } = await twoKeptThenWiped(context, store);
      const author = parseEnvelope(await appendedAs(appended, head.digest)).author;
      store.rewrite(async (path, answer) => {
        if (path !== `/o/${owner}/library`) return answer;
        const held = (await answer.json()) as { documents: string[]; authors: Record<string, string> };
        // The author that wrote it left out of the authors the store enrolled; every other author kept.
        const authors = Object.fromEntries(Object.entries(held.authors).filter(([id]) => id !== author));
        return new Response(JSON.stringify({ ...held, authors }), { headers: like(answer, { "content-type": "application/json" }) });
      });
      await refusedOnRecover(page, uuid, "author-not-enrolled");
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("a store serving a head whose checkpoint does not name its parent's: refused, not restored, and said", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, uuid, owner, head, appended, dataKey, secret } = await twoKeptThenWiped(context, store);
      const key = await crypto.subtle.importKey("raw", new Uint8Array(dataKey), "AES-GCM", true, ["encrypt", "decrypt"]);
      const top = await openEnvelope(await appendedAs(appended, head.digest), key);

      // A faulty host: an author enrolled under the owner by the keychain proof, holding the data key.
      const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
      const pub = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
      const faulty: Author = { privateKey: keys.privateKey, pub, id: await authorIdOf(pub) };
      const challenge = `${admitChallenge()}:${faulty.id}`;
      const verifier = await keychainVerifier(utf8(secret));
      const signature = b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, verifier.privateKey, utf8(challenge))));
      expect(isRefused(await admitAuthor(store.base, faulty, owner, { kind: "keychain", challenge, signature }))).toBe(false);

      // Its envelope's clear part names the head; its checkpoint names a parent that is no checkpoint here.
      const broken = await sealEnvelope(
        { owner, document: uuid, author: faulty.id, parents: [head.digest] },
        {
          checkpoint: { ...top.inside.checkpoint, revision: top.inside.checkpoint.revision + 1, parents: [await checkpointDigest({ ...top.inside.checkpoint, revision: 0 })] },
          title: top.inside.title,
          database: top.database,
        },
        key,
        faulty,
      );
      const appendedBroken = await appendEnvelope(store.base, faulty, owner, uuid, broken.bytes, "head");
      expect(isRefused(appendedBroken), "the store holds what an enrolled author appends").toBe(false);
      await refusedOnRecover(page, uuid, "parent-chain");
    } finally {
      await context.close();
      await store.close();
    }
  });
});
