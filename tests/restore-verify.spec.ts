import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { buildNotes, openFile, storedHolds, typeNote, uuidOf, withKeyStore } from "./owner.js";
import { serveOwnerStore, type ServedStore } from "./owner-store-memory.js";
import { enrollHere, keptRecord, openerWithStore, putInKeyStore, waitSettledKept, type KeptRecord } from "./keeping.js";
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

/**
 * Keeps four revisions, A to D, the third carrying the release's container
 * again (its kept record before it stood up as one from before `containerIn`,
 * which carries the container once more), then wipes the browser. So
 * recovering D fetches D and C alone: the root and B are links of Chain the
 * opener never opens, and what Chain says of them is held by Chain's own
 * checks or by nothing (2b2f-L2).
 */
async function fourKeptThenWiped(context: BrowserContext, store: ServedStore) {
  const { page, provider } = await openerWithStore(context, store.base);
  const app = await openFile(page, await buildNotes(mkdtempSync(join(tmpdir(), "dai-verify-")), "Notes"));
  const uuid = await uuidOf(page);
  const owner = await enrollHere(page);
  let text = "";
  let after = 0;
  const keep = async (more: string): Promise<KeptRecord> => {
    await typeNote(app, more);
    text += more;
    await expect.poll(() => storedHolds(page, uuid, text), { timeout: 30_000 }).toBe(true);
    const kept = await waitSettledKept(page, uuid, after);
    after = kept.revision;
    return kept;
  };
  await keep("A");
  await keep("B");
  const record = await keptRecord(page, uuid);
  await putInKeyStore(page, `dai:kept:${uuid}`, { ...record, containerIn: undefined });
  const c = await keep("C");
  const head = await keep("D");
  const dataKey = await withKeyStore<number[]>(page, `return [...new Uint8Array(await crypto.subtle.exportKey("raw", (await get("dai:data-key:" + arg)).key))];`, uuid);
  const appended = store
    .received()
    .filter((r) => r.method === "POST" && r.url.includes(`/d/${owner}/${uuid}/append`))
    .map((r) => new Uint8Array(r.body));
  const links = await chainOfAppended(appended, head.at);
  const byDigest = new Map(links.map((link) => [link.digest, link]));
  expect(byDigest.get(head.digest)?.parents, "D's parent is C").toEqual([c.digest]);
  const b = byDigest.get(c.digest)!.parents[0]!;
  const root = links.find((link) => link.parents.length === 0)!.digest;
  expect([b, root].includes(head.digest) || [b, root].includes(c.digest), "the root and B are neither D nor C").toBe(false);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(dataKey), "AES-GCM", true, ["encrypt", "decrypt"]);
  expect((await openEnvelope(await appendedAs(appended, c.digest), key)).inside.container, "C carries the container").toBeDefined();
  await wipe(page, provider.cdp);
  await page.evaluate((x) => (window as Any).__runner.useStore(x), store.base);
  return { page, uuid, head, b, root };
}

/** Chain for D, as the store answers it, with `change` made to it: what a store that does not answer truly says of its log. */
function chainChanged(store: ServedStore, uuid: string, head: string, change: (chain: { digest: string; parents: string[]; author: string; at: string }[]) => unknown[]): void {
  store.rewrite(async (path, answer) => {
    if (!path.endsWith(`/${uuid}/c/${head}`)) return answer;
    const held = (await answer.json()) as { chain: { digest: string; parents: string[]; author: string; at: string }[] };
    return new Response(JSON.stringify({ chain: change(held.chain) }), { headers: like(answer, { "content-type": "application/json" }) });
  });
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

/** The log as the store holds it, from what was appended: what Chain answers from the newest envelope back. */
async function chainOfAppended(appended: Uint8Array[], at: string): Promise<{ digest: string; parents: string[]; author: string; at: string }[]> {
  return Promise.all(
    appended.map(async (bytes) => {
      const envelope = parseEnvelope(bytes);
      return { digest: await digestOf(bytes), parents: envelope.parents, author: envelope.author, at };
    }),
  );
}

/**
 * Serves `forged` as the document's one head, in place of the envelope
 * `replaces`, and everything else as the store holds it. Heads, Get and Chain
 * agree: a store that forges an envelope can name it in its log too, so what
 * refuses it is the envelope's own check, not a log that gives it away.
 */
async function serveAsHead(store: ServedStore, uuid: string, forged: Uint8Array, at: string, replaces: string, appended: Uint8Array[]): Promise<string> {
  const digest = await digestOf(forged);
  const chain = (await chainOfAppended(appended, at)).map((link) => (link.digest === replaces ? { ...link, digest } : link));
  store.rewrite(async (path, answer) => {
    if (path.endsWith(`/${uuid}/c/${digest}`)) return new Response(JSON.stringify({ chain }), { headers: like(answer, { "content-type": "application/json" }) });
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
      await serveAsHead(store, uuid, utf8(JSON.stringify({ ...real, signature: flipped })), head.at, head.digest, appended);
      await refusedOnRecover(page, uuid, "envelope-signature");
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("a store whose Chain stops short of a root: refused, not restored, and said", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, uuid, head, appended } = await twoKeptThenWiped(context, store);
      const roots = (await chainOfAppended(appended, head.at)).filter((link) => link.parents.length === 0).map((link) => link.digest);
      expect(roots.length, "the log has its root").toBeGreaterThan(0);
      store.rewrite(async (path, answer) => {
        if (!path.endsWith(`/${uuid}/c/${head.digest}`)) return answer;
        const held = (await answer.json()) as { chain: { digest: string }[] };
        return new Response(JSON.stringify({ chain: held.chain.filter((link) => !roots.includes(link.digest)) }), { headers: like(answer, { "content-type": "application/json" }) });
      });
      await refusedOnRecover(page, uuid, "parent-chain");
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

  /*
   * Chain's four checks, one test each (2b2f-L2, Build 2b-2fr item 5). Chain
   * is the store's own unsigned account of the log, so each lie here is one a
   * store that does not answer truly can tell, and each test is made so that
   * only its own check can refuse it: the lie is about a link the opener never
   * opens (the root, or B), or, for the check that holds each opened envelope
   * to Chain, about D in a way the other three accept.
   */
  test("Chain with no root, every parent on it: refused by the root check alone", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, uuid, head, b, root } = await fourKeptThenWiped(context, store);
      // The root made B's child, B being on the chain: a loop with no root, every parent present, every author enrolled.
      chainChanged(store, uuid, head.digest, (chain) => chain.map((link) => (link.digest === root ? { ...link, parents: [b] } : link)));
      await refusedOnRecover(page, uuid, "parent-chain");
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("Chain naming a parent it does not hold, above the head's parents: refused by the parents check alone", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, uuid, head, b } = await fourKeptThenWiped(context, store);
      const nowhere = "Z".repeat(43);
      chainChanged(store, uuid, head.digest, (chain) => chain.map((link) => (link.digest === b ? { ...link, parents: [...link.parents, nowhere] } : link)));
      await refusedOnRecover(page, uuid, "parent-chain");
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("Chain naming an author not enrolled on a link the opener does not open: refused by the authors check alone", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, uuid, head, b } = await fourKeptThenWiped(context, store);
      const stranger = "S".repeat(43);
      chainChanged(store, uuid, head.digest, (chain) => chain.map((link) => (link.digest === b ? { ...link, author: stranger } : link)));
      await refusedOnRecover(page, uuid, "author-not-enrolled");
    } finally {
      await context.close();
      await store.close();
    }
  });

  test("Chain saying of the head other than its envelope says: refused by holding each envelope to Chain alone", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "the passkey with PRF is Chromium's virtual authenticator");
    const store = await serveOwnerStore();
    const context = await browser.newContext();
    try {
      const { page, uuid, head } = await fourKeptThenWiped(context, store);
      // D named a root: a chain with roots, every parent present, every author enrolled; only D's envelope, which names C, disagrees.
      chainChanged(store, uuid, head.digest, (chain) => chain.map((link) => (link.digest === head.digest ? { ...link, parents: [] } : link)));
      await refusedOnRecover(page, uuid, "parent-chain");
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
