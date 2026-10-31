import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";
import { cutTheNetwork } from "./offline.js";
import {
  RUNNER_URL,
  addPasskeyProvider,
  buildNotes,
  currentOwner,
  keepFromMenu,
  openFile,
  passkeysHeld,
  savesWritten,
  storedDigest,
  storedHolds,
  typeNote,
  uuidOf,
  pointAtStore,
  waitMounted,
  withKeyStore,
} from "./owner.js";
import { serveOwnerStore, type ServedStore } from "./owner-store-memory.js";

/**
 * Owner enrollment, Build 2b-1 (R-Z sentences 1, 3 and 8; R-D as amended).
 *
 * A document is used before anything is asked: saved in this browser with no
 * owner and no connection. Enrolling later, from the menu, makes a passkey
 * with PRF; the owner key it makes is wrapped under the key derived from the
 * PRF output and under the keychain secret; the data key the document already
 * has is wrapped under the owner key. Nothing is rewritten and nothing is
 * uploaded. A passkey that is not the owner's opens nothing, and the author
 * key cannot leave the browser (D195).
 *
 * The passkey cases run on Chromium's virtual authenticator, the only engine
 * Playwright can give a passkey with PRF. Each recovery path alone on an
 * iPhone, in Safari and a Home Screen app, is a reading owed (R-Z, "Each
 * recovery path, where it can run").
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const VIRTUAL_PASSKEY = "a passkey with PRF is Chromium's virtual authenticator; the iPhone reading is owed (R-Z)";

/**
 * What a key-derivation reader of the store needs (docs/store.md, "Keys"):
 * HKDF-SHA-256 over the secret, salt "dai owner key v1", info the path's name,
 * to AES-KW-256. Written here from the contract, not imported, so the test
 * holds the opener to the contract rather than to itself.
 */
const OPEN_WITH = `
  const wrapping = async (secret, path) => {
    const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("dai owner key v1"), info: new TextEncoder().encode(path) },
      base, { name: "AES-KW", length: 256 }, false, ["unwrapKey"]);
  };
  const raw = async (key) => [...new Uint8Array(await crypto.subtle.exportKey("raw", key))].join(",");
`;

/** Records what the opener hands the keychain, then hands it on: how a test reads a password manager. */
async function watchKeychain(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as Any).__keychain = seen;
    const store = navigator.credentials?.store?.bind(navigator.credentials);
    if (!store) return;
    navigator.credentials.store = (credential: Any) => {
      if (credential && typeof credential.password === "string") seen.push(credential.password);
      return store(credential);
    };
  });
}

/** The library's revision for a document: whether a step wrote a save. */
const revisionOf = (page: Page, uuid: string): Promise<number> =>
  page.evaluate(async (id) => {
    const held = ((await (window as Any).__runner.listLibrary()) as Any[]).find((item) => item.documentUuid === id);
    return Number(held?.revision ?? -1);
  }, uuid);

test.describe("owner enrollment (R-Z, Build 2b-1)", () => {
  test.slow();
  // An opener offers to keep beyond this browser only with a store to keep in: the tests that enroll have one.
  let store: ServedStore;
  test.beforeAll(async () => {
    store = await serveOwnerStore();
  });
  test.afterAll(async () => {
    await store?.close();
  });

  test("with no owner and no connection, a document opens, is edited and saved in this browser, and its data key is minted unwrapped", async ({ browser, browserName }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-owner-"));
    const file = await buildNotes(scratch, "Notes");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    await page.evaluate(() => navigator.serviceWorker.ready);
    /*
     * WebKit under Playwright, here, runs with no service worker, and cannot
     * read a picked file while the network is cut ("The I/O read operation
     * failed."). With no worker to serve it, the save's egress check cannot
     * load the host's engine offline either ("Importing a module script
     * failed", `leavingIn`). So there the document opens, and saves once,
     * online; the edit under test and its save run with the network cut.
     */
    const webkit = browserName === "webkit";
    let cut = webkit ? null : await cutTheNetwork(context, page);
    const app = await openFile(page, file);
    const uuid = await uuidOf(page);
    if (webkit) {
      await typeNote(app, "online ");
      await expect.poll(() => storedHolds(page, uuid, "online "), { timeout: 30_000 }).toBe(true);
      cut = await cutTheNetwork(context, page);
    }
    await typeNote(app, "written offline");
    await expect.poll(() => storedHolds(page, uuid, "written offline"), { timeout: 30_000 }).toBe(true);

    expect(await currentOwner(page)).toBeNull();
    const dataKey = await withKeyStore(
      page,
      'const r = await get("dai:data-key:" + arg); return r ? { key: r.key instanceof CryptoKey, owner: r.owner ?? null, wrapped: r.wrapped ? "yes" : "no" } : null;',
      uuid,
    );
    expect(dataKey).toEqual({ key: true, owner: null, wrapped: "no" });
    expect(cut!.reached, cut!.summary()).toEqual([]);
    await context.close();
  });

  test("the author key cannot be exported, and a key kept extractable from before D195 is replaced by one that cannot", async ({ browser }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dai-owner-"));
    const file = await buildNotes(scratch, "Notes");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    let app = await openFile(page, file);
    const uuid = await uuidOf(page);
    await typeNote(app, "first");
    await expect.poll(() => storedHolds(page, uuid, "first"), { timeout: 30_000 }).toBe(true);

    const kept = await withKeyStore<{ extractable: boolean; exported: string }>(
      page,
      `const pair = await get("dai:person-key");
       let exported = "exported";
       try { await crypto.subtle.exportKey("pkcs8", pair.privateKey); } catch (e) { exported = "refused: " + e.name; }
       return { extractable: pair.privateKey.extractable, exported };`,
    );
    expect(kept.extractable).toBe(false);
    expect(kept.exported).toMatch(/^refused/);

    // A device whose key was made before D195: an extractable pair in the same place.
    const planted = await page.evaluate(async () => {
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const id = new Uint8Array(await crypto.subtle.digest("SHA-256", raw)).slice(0, 16);
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const open = indexedDB.open("dai_runner_storage");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("keys", "readwrite");
        tx.objectStore("keys").put(pair, "dai:person-key");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return btoa(String.fromCharCode(...id)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    });

    // The opener resumes the document open last: that is this one, reopened.
    await page.goto(RUNNER_URL);
    app = await waitMounted(page, file);
    await typeNote(app, " second");
    await expect.poll(() => storedHolds(page, uuid, "first second"), { timeout: 30_000 }).toBe(true);
    const author = await page.evaluate(() => (window as Any).__runner.authorId() as Promise<string>);
    expect(author).not.toBe(planted);
    const replaced = await withKeyStore<boolean>(page, 'return (await get("dai:person-key")).privateKey.extractable;');
    expect(replaced).toBe(false);
    await context.close();
  });

  test("enrolling afterwards wraps the data key the document already has, under an owner key both secrets open, rewrites nothing, and sends only what the owner's store is owed", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", VIRTUAL_PASSKEY);
    const scratch = mkdtempSync(join(tmpdir(), "dai-owner-"));
    const file = await buildNotes(scratch, "Notes");
    const context = await browser.newContext();
    await pointAtStore(context, store.base);
    const page = await context.newPage();
    await watchKeychain(page);
    await page.goto(RUNNER_URL);
    const provider = await addPasskeyProvider(context, page);
    const app = await openFile(page, file);
    const uuid = await uuidOf(page);
    await typeNote(app, "kept words");
    await expect.poll(() => storedHolds(page, uuid, "kept words"), { timeout: 30_000 }).toBe(true);
    const before = { digest: await storedDigest(page, uuid), revision: await revisionOf(page, uuid), saves: await savesWritten(page) };
    const dataKeyBefore = await withKeyStore<string>(
      page,
      `${OPEN_WITH} return raw((await get("dai:data-key:" + arg)).key);`,
      uuid,
    );
    expect(await passkeysHeld(provider)).toBe(0);

    // Uploading is sending: any request that is not a GET, or that leaves the opener's origin. Opening the
    // menu asks the opener's own version.json, a GET, and that is not one.
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" || new URL(request.url()).origin !== new URL(RUNNER_URL).origin) {
        requests.push(`${request.method()} ${request.url()}`);
      }
    });
    await keepFromMenu(page);
    await expect.poll(() => currentOwner(page), { timeout: 30_000 }).not.toBeNull();

    expect(await passkeysHeld(provider)).toBe(1);
    expect({ digest: await storedDigest(page, uuid), revision: await revisionOf(page, uuid), saves: await savesWritten(page) }).toEqual(before);
    // Since Build 2b-2d item 5, what enrolling adopted is kept at once: the owner registered, the wrapped key, the sealed revision, each to the owner's store and nowhere else.
    await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(3);
    const path = (request: string): string => request.replace(store.base, "").replace(/[A-Za-z0-9_-]{22}/, "<owner>").replace(uuid, "<document>");
    expect(requests.map(path)).toEqual(["POST /o/<owner>/enroll", "PUT /d/<owner>/<document>/key", "POST /d/<owner>/<document>/append?as=head"]);

    const keychain = await page.evaluate(() => (window as Any).__keychain as string[]);
    expect(keychain).toHaveLength(1);
    const opened = await withKeyStore<Any>(
      page,
      `${OPEN_WITH}
       const owner = await get("dai:owner");
       const record = await get("dai:owner:" + owner);
       const doc = await get("dai:data-key:" + arg.uuid);
       const viaHeld = await crypto.subtle.unwrapKey("raw", doc.wrapped, record.key, "AES-KW", { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
       const ownerViaKeychain = await crypto.subtle.unwrapKey("raw", record.wraps.keychain,
         await wrapping(new TextEncoder().encode(arg.secret), "keychain"), "AES-KW", { name: "AES-KW", length: 256 }, false, ["unwrapKey"]);
       const viaKeychain = await crypto.subtle.unwrapKey("raw", doc.wrapped, ownerViaKeychain, "AES-KW", { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
       return {
         ownerKeyExtractable: record.key.extractable,
         docOwner: doc.owner === owner,
         prfWrap: record.wraps.prf instanceof Uint8Array || record.wraps.prf instanceof ArrayBuffer,
         viaHeld: await raw(viaHeld),
         viaKeychain: await raw(viaKeychain),
       };`,
      { uuid, secret: keychain[0] },
    );
    expect(opened.ownerKeyExtractable).toBe(false);
    expect(opened.docOwner).toBe(true);
    expect(opened.prfWrap).toBe(true);
    expect(opened.viaHeld).toBe(dataKeyBefore);
    expect(opened.viaKeychain).toBe(dataKeyBefore);
    await context.close();
  });

  test("the owner's passkey opens the owner key, and another passkey for the same owner opens nothing", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", VIRTUAL_PASSKEY);
    const scratch = mkdtempSync(join(tmpdir(), "dai-owner-"));
    const file = await buildNotes(scratch, "Notes");
    const context = await browser.newContext();
    await pointAtStore(context, store.base);
    const page = await context.newPage();
    await page.goto(RUNNER_URL);
    let provider = await addPasskeyProvider(context, page);
    const app = await openFile(page, file);
    const uuid = await uuidOf(page);
    await typeNote(app, "mine");
    await expect.poll(() => storedHolds(page, uuid, "mine"), { timeout: 30_000 }).toBe(true);
    await keepFromMenu(page);
    await expect.poll(() => currentOwner(page), { timeout: 30_000 }).not.toBeNull();
    const owner = (await currentOwner(page))!;
    const wrapsBefore = await withKeyStore<string>(page, 'const r = await get("dai:owner:" + arg); return JSON.stringify([...new Uint8Array(r.wraps.prf)]);', owner);

    expect(await page.evaluate(() => (window as Any).__runner.owner.signIn())).toBe("opened");

    // The owner's passkey gone; another made for the same owner id, as a second provider would.
    await provider.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: provider.id });
    provider = await addPasskeyProvider(context, page);
    await page.evaluate(async (id) => {
      const bytes = Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      await navigator.credentials.create({
        publicKey: {
          rp: { name: "another", id: location.hostname },
          user: { id: bytes, name: "another", displayName: "another" },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          extensions: { prf: {} } as Any,
        },
      });
    }, owner);
    expect(await passkeysHeld(provider)).toBe(1);

    expect(await page.evaluate(() => (window as Any).__runner.owner.signIn())).toBe("refused");
    expect(await currentOwner(page)).toBe(owner);
    const wrapsAfter = await withKeyStore<string>(page, 'const r = await get("dai:owner:" + arg); return JSON.stringify([...new Uint8Array(r.wraps.prf)]);', owner);
    expect(wrapsAfter).toBe(wrapsBefore);
    await context.close();
  });
});
