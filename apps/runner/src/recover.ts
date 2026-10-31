/**
 * Recovery (R-Z sentence 5, R-E; docs/store.md, "Operations").
 *
 * On a browser with nothing, the person chooses Recover and authenticates with
 * their passkey. The passkey's user handle names the owner, and its PRF output
 * opens the owner key's wrap, which the store hands over on Admit: this
 * context is admitted as a new author under the same owner (R-E). Then the
 * library, each document's heads and envelopes, opened with the data key the
 * owner key unwraps. Or, with no passkey, the password the password manager
 * kept at enrollment (R-D as amended, D298): its owner id names the owner,
 * and its secret proves the owner to Admit and opens the owner key's other
 * wrap. Each path recovers alone.
 *
 * Every revision restored is verified first (R-C): the chain, as the store's
 * log answers it without bytes, reaches a root and names only authors the
 * store enrolled under this owner; the head opens under the data key, is
 * signed by its author with the key it carries, and names as parents exactly
 * the checkpoints of the envelopes before it, which are fetched for that; and
 * the envelope that carries the release's container, named by the head, is
 * on the chain and of the head's release. Nothing else is fetched: a document
 * kept many times costs a few envelopes, not every revision ever kept. A
 * document that does not verify is refused, not restored. The store is
 * trusted for liveness, never for content (R-B).
 *
 * A passkey ceremony must start inside the tap, so `recover` reaches
 * `navigator.credentials.get` before its first await, with a challenge made
 * synchronously.
 */
import { KEYS, dataKeyKey, keptKey, ownerRecordKey } from "../../../src/keys.js";
import {
  admitChallenge,
  b64u,
  checkpointDigest,
  digestOf,
  fromB64u,
  openEnvelope,
  utf8,
  verifyOpened,
  type Author,
  type Opened,
  type Unverified,
} from "../../owner-store/src/envelope.js";
import { admitAuthor, chainOf, getEnvelope, headsOf, isRefused, isUnavailable, libraryOf } from "../../owner-store/src/client.js";
import { keepInKeyStore, keptInKeyStore } from "./opfs.js";
import { keychainKey } from "./keychain-key.js";
import { readCartridge, resealCartridge } from "./cartridge.js";
import { person } from "./person.js";
import { adoptUnder, announceOwnerChange, currentOwner, ownerOfAccount, type DataKeyRecord, type OwnerRecord, type StoreDataKey } from "./owner.js";
import type { KeptRecord } from "./keeping.js";

const PRF_INPUT = utf8("dai owner prf v1");

export interface Restored {
  documentUuid: string;
  title: string;
  /** The store's acknowledgment of the restored checkpoint, ISO 8601. */
  at: string;
  /** Restored by an earlier recovery that the store cut short, and held here since: nothing of it was written this time. */
  alreadyHere?: true;
}

/** What the opener writes into its library for one restored document, under that document's lock. */
export interface Install {
  documentUuid: string;
  title: string;
  database: Uint8Array;
  html: string;
  publicKeyFingerprint: string | undefined;
  revision: number;
}

/** What the opener lends recovery: a way to write one document into its library, and the title of one it holds already. */
export interface Here {
  install: (one: Install) => Promise<void>;
  held: (documentUuid: string) => Promise<string | null>;
}

export type Recovered =
  /** `unreached`: the store stopped answering after these, and the rest of the library was not reached. */
  | { restored: Restored[]; refused: { documentUuid: string; why: Unverified | string }[]; unreached?: string }
  | { unavailable: string }
  | { cancelled: string }
  | { refused: string };

const bytesOf = (buffer: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> =>
  buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);

/** The wrapping key for one path, as enrollment made it (owner.ts, docs/store.md "Keys"). */
async function wrappingKey(secret: Uint8Array<ArrayBuffer>, path: "prf" | "keychain"): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8("dai owner key v1"), info: utf8(path) },
    base,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** The owner key, opened from one of its wraps, kept non-extractable; null when the secret does not open it. */
async function openOwnerKey(wrapped: string, secret: Uint8Array<ArrayBuffer>, path: "prf" | "keychain"): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.unwrapKey("raw", fromB64u(wrapped), await wrappingKey(secret, path), "AES-KW", { name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
  } catch {
    return null;
  }
}

/** Recovers this owner's library from the store at `base`. Call it from the tap. */
export function recover(base: string | undefined, here: Here): Promise<Recovered> {
  if (!window.PublicKeyCredential || !navigator.credentials?.get) return Promise.resolve({ cancelled: "this browser has no passkeys" });
  const challenge = admitChallenge();
  // Reached before any await: the ceremony runs inside the tap.
  const asked = navigator.credentials.get({
    publicKey: {
      challenge: utf8(challenge),
      userVerification: "required",
      extensions: { prf: { eval: { first: PRF_INPUT } } } as AuthenticationExtensionsClientInputs,
    },
  }) as Promise<PublicKeyCredential | null>;
  return asked.then(
    async (assertion) => {
      if (!assertion) return { cancelled: "no passkey chosen" };
      const response = assertion.response as AuthenticatorAssertionResponse;
      if (!response.userHandle) return { refused: "the passkey names no owner" };
      const secret = (assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
      if (!secret) return { refused: "the passkey's provider gave no PRF output" };
      if (!base) return { unavailable: "no store is configured here" };
      const prf = bytesOf(secret);
      return restore(base, here, {
        owner: b64u(bytesOf(response.userHandle)),
        proof: async () => ({
          kind: "passkey",
          credential: b64u(bytesOf(assertion.rawId)),
          clientDataJSON: b64u(bytesOf(response.clientDataJSON)),
          authenticatorData: b64u(bytesOf(response.authenticatorData)),
          signature: b64u(bytesOf(response.signature)),
        }),
        open: async (wraps) => (await openOwnerKey(wraps.prf, prf, "prf")) ?? "the passkey does not open the owner key",
      });
    },
    (error: unknown) => ({ cancelled: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
  );
}

/**
 * Recovers this owner's library with the keychain secret alone, as the
 * password manager filled it in, with no passkey (R-D as amended): the secret
 * derives the verifier's key, which signs the Admit's challenge, and the key
 * that opens the owner key's keychain wrap. A secret that is not the owner's
 * is refused by the store, and opens nothing here either.
 */
export async function recoverWithKeychain(base: string | undefined, account: string, secret: string, here: Here): Promise<Recovered> {
  // The account as the password manager fills it: "Your documents · <hostname> · <owner id>", or a bare owner id saved before (Build 2b-2d item 4).
  const owner = ownerOfAccount(account);
  if (!owner || !secret) return { cancelled: "no saved password filled in" };
  if (!base) return { unavailable: "no store is configured here" };
  const bytes = utf8(secret);
  return restore(base, here, {
    owner,
    proof: async (author) => {
      const challenge = `${admitChallenge()}:${author}`;
      // WebCrypto's Ed25519, or the opener's own where WebCrypto has none: the same key, the same signature (D302).
      const key = await keychainKey(bytes);
      return { kind: "keychain", challenge, signature: b64u(await key.sign(utf8(challenge))) };
    },
    open: async (wraps) => (await openOwnerKey(wraps.keychain, bytes, "keychain")) ?? "the saved password does not open the owner key",
  });
}

export type Joined =
  /** Signed in as the owner the passkey names, this context admitted; `adopted` are the documents now under that owner. */
  | { joined: string; adopted: string[] }
  | { unavailable: string }
  | { cancelled: string }
  | { refused: string };

/**
 * The passkey the person already has, from "Keep beyond this browser" (R-Z,
 * amended 31 October): a person is one owner across their browser contexts.
 * Recovery's ceremony, inside the tap; then Admit, which makes this context a
 * new author under that owner (R-E) and hands over the owner key's wraps; the
 * owner signed in here; and the documents saved in this context adopted under
 * that owner, as enrolling adopts them. A document the store already holds
 * under that owner keeps the store's data key. Nothing is restored here:
 * the owner's other documents stay at the store. Call it from the tap.
 */
export function joinOwner(base: string | undefined, documents: () => Promise<readonly string[]>): Promise<Joined> {
  if (!window.PublicKeyCredential || !navigator.credentials?.get) return Promise.resolve({ cancelled: "this browser has no passkeys" });
  const challenge = admitChallenge();
  // Reached before any await: the ceremony runs inside the tap.
  const asked = navigator.credentials.get({
    publicKey: {
      challenge: utf8(challenge),
      userVerification: "required",
      extensions: { prf: { eval: { first: PRF_INPUT } } } as AuthenticationExtensionsClientInputs,
    },
  }) as Promise<PublicKeyCredential | null>;
  return asked.then(
    async (assertion): Promise<Joined> => {
      if (!assertion) return { cancelled: "no passkey chosen" };
      const response = assertion.response as AuthenticatorAssertionResponse;
      if (!response.userHandle) return { refused: "the passkey names no owner" };
      const secret = (assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
      if (!secret) return { refused: "the passkey's provider gave no PRF output" };
      if (!base) return { unavailable: "no store is configured here" };
      if ((await currentOwner()) !== null) return { refused: "an owner is signed in here" };
      const owner = b64u(bytesOf(response.userHandle));
      const me = await person();
      const author: Author = { privateKey: me.keys.privateKey, pub: me.pub, id: me.author };
      const admitted = await admitAuthor(base, author, owner, {
        kind: "passkey",
        credential: b64u(bytesOf(assertion.rawId)),
        clientDataJSON: b64u(bytesOf(response.clientDataJSON)),
        authenticatorData: b64u(bytesOf(response.authenticatorData)),
        signature: b64u(bytesOf(response.signature)),
      });
      if (isUnavailable(admitted)) return { unavailable: admitted.unavailable };
      if (isRefused(admitted)) return { refused: admitted.refused };
      const ownerKey = await openOwnerKey(admitted.wraps.prf, bytesOf(secret), "prf");
      if (!ownerKey) return { refused: "the passkey does not open the owner key" };
      // The store's data key for each document saved here that it holds under this owner, read before anyone is signed in.
      const saved = await documents();
      const atStore = new Map<string, StoreDataKey>();
      for (const documentUuid of saved) {
        const heads = await headsOf(base, author, owner, documentUuid);
        if (isUnavailable(heads)) return { unavailable: heads.unavailable };
        if (isRefused(heads)) return { refused: `heads: ${heads.refused}` };
        if (!heads.key) continue;
        try {
          const key = await crypto.subtle.unwrapKey("raw", fromB64u(heads.key), ownerKey, "AES-KW", { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
          atStore.set(documentUuid, { key, wrapped: fromB64u(heads.key) });
        } catch {
          return { refused: "a data key the store holds does not open under the owner key" };
        }
      }
      const record: OwnerRecord = {
        owner,
        credential: admitted.credential,
        key: ownerKey,
        wraps: { prf: fromB64u(admitted.wraps.prf), keychain: fromB64u(admitted.wraps.keychain) },
        keychain: "not offered",
        enrolled: new Date().toISOString(),
        atStore: true,
      };
      await keepInKeyStore(ownerRecordKey(owner), record);
      await keepInKeyStore(KEYS.OWNER, owner);
      announceOwnerChange();
      const adopted = await adoptUnder(record, saved, atStore);
      console.info(`dai: joined owner ${owner} with the passkey already held; ${adopted.length} document(s) adopted`);
      return { joined: owner, adopted };
    },
    (error: unknown) => ({ cancelled: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
  );
}

/*
 * Each document is restored whole before the next begins: verified, then its
 * data key and kept record, then its library record, which is what lists it.
 * The owner is signed in before the first of these writes, so no state exists
 * in which a restored document is held and its owner is not. A store that
 * stops answering partway leaves the documents already restored, the owner
 * signed in, and the record marked as recovering, so Recover stays offered
 * and a second one brings the rest, passing over what is here already.
 */
async function restore(
  base: string,
  here: Here,
  asked: {
    owner: string;
    /** The proof Admit is given, for the author it admits. */
    proof: (author: string) => Promise<Parameters<typeof admitAuthor>[3]>;
    /** The owner key, opened from the wraps the store answered with, or why it did not open. */
    open: (wraps: { prf: string; keychain: string }) => Promise<CryptoKey | string>;
  },
): Promise<Recovered> {
  const signedIn = await currentOwner();
  if (signedIn !== null && signedIn !== asked.owner) return { refused: "another owner is signed in here" };
  const me = await person();
  const author: Author = { privateKey: me.keys.privateKey, pub: me.pub, id: me.author };
  const admitted = await admitAuthor(base, author, asked.owner, await asked.proof(author.id));
  if (isUnavailable(admitted)) return { unavailable: admitted.unavailable };
  if (isRefused(admitted)) return { refused: admitted.refused };
  const ownerKey = await asked.open(admitted.wraps);
  if (typeof ownerKey === "string") return { refused: ownerKey };
  const library = await libraryOf(base, author, asked.owner);
  if (isUnavailable(library)) return { unavailable: library.unavailable };
  if (isRefused(library)) return { refused: library.refused };

  // The owner's record, its key held non-extractable; marked recovering until every document was reached.
  const signIn = async (recovering: boolean): Promise<void> => {
    const record: OwnerRecord = {
      owner: asked.owner,
      credential: admitted.credential,
      key: ownerKey,
      wraps: { prf: fromB64u(admitted.wraps.prf), keychain: fromB64u(admitted.wraps.keychain) },
      keychain: "not offered",
      enrolled: new Date().toISOString(),
      atStore: true,
      ...(recovering ? { recovering: true } : {}),
    };
    await keepInKeyStore(ownerRecordKey(asked.owner), record);
    await keepInKeyStore(KEYS.OWNER, asked.owner);
    announceOwnerChange();
  };
  let writing = signedIn === asked.owner;
  const beforeFirstWrite = async (): Promise<void> => {
    if (writing) return;
    await signIn(true);
    writing = true;
  };

  const enrolled = new Map(Object.entries(library.authors));
  const restored: Restored[] = [];
  const refused: { documentUuid: string; why: string }[] = [];
  let unreached: string | undefined;
  for (const documentUuid of library.documents) {
    const kept = await keptInKeyStore<KeptRecord>(keptKey(documentUuid));
    const title = kept?.owner === asked.owner ? await here.held(documentUuid) : null;
    if (kept && title !== null) {
      restored.push({ documentUuid, title, at: kept.at, alreadyHere: true });
      continue;
    }
    const outcome = await restoreOne(base, here.install, beforeFirstWrite, author, asked.owner, documentUuid, ownerKey, enrolled);
    if ("unavailable" in outcome) {
      unreached = outcome.unavailable;
      break;
    }
    if ("why" in outcome) {
      console.warn(`dai: ${documentUuid} not restored: ${outcome.why}`);
      refused.push({ documentUuid, why: outcome.why });
    } else if (outcome.restored) restored.push(outcome.restored);
  }
  // Nothing written: nobody is signed in on nothing.
  if (unreached !== undefined && !writing) return { unavailable: unreached };

  // Signed in only once there is something true to show.
  await signIn(unreached !== undefined);
  console.info(`dai: recovered owner ${asked.owner}: ${restored.length} restored, ${refused.length} refused${unreached ? `, the rest unreached: ${unreached}` : ""}`);
  return { restored, refused, ...(unreached !== undefined ? { unreached } : {}) };
}

/** One document: its newest head, verified back to the root, installed at that revision. */
async function restoreOne(
  base: string,
  install: (one: Install) => Promise<void>,
  beforeFirstWrite: () => Promise<void>,
  author: Author,
  owner: string,
  documentUuid: string,
  ownerKey: CryptoKey,
  enrolled: ReadonlyMap<string, string>,
): Promise<{ restored: Restored | null } | { why: string } | { unavailable: string }> {
  const heads = await headsOf(base, author, owner, documentUuid);
  if (isUnavailable(heads)) return { unavailable: heads.unavailable };
  if (isRefused(heads)) return { why: `heads: ${heads.refused}` };
  if (!heads.key || heads.heads.length === 0) return { restored: null };
  let dataKey: CryptoKey;
  try {
    dataKey = await crypto.subtle.unwrapKey("raw", fromB64u(heads.key), ownerKey, "AES-KW", { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  } catch {
    return { why: "the data key does not open under the owner key" };
  }
  // The newest acknowledged head. Branches are reconciled by the host that holds them (R-F as R-Z amends it).
  const head = [...heads.heads].sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0]!;

  // The chain as the store's log holds it, without bytes: back to a root, every author enrolled under this owner.
  const links = await chainOf(base, author, owner, documentUuid, head.digest);
  if (isUnavailable(links)) return { unavailable: links.unavailable };
  // A store that has no Chain yet answers no such operation: the envelopes themselves are the chain then.
  if (isRefused(links) && links.refused !== "no such operation") return { why: `chain: ${links.refused}` };
  const chain = isRefused(links) ? null : new Map(links.chain.map((link) => [link.digest, link]));
  if (chain) {
    if (!chain.has(head.digest) || ![...chain.values()].some((link) => link.parents.length === 0)) return { why: "parent-chain" };
    for (const link of chain.values()) {
      if (link.parents.some((parent) => !chain.has(parent))) return { why: "parent-chain" };
      if (!enrolled.has(link.author)) return { why: "author-not-enrolled" };
    }
  }

  // Each envelope fetched once, its digest checked, opened, and held to what the log said of it.
  const opened = new Map<string, { opened: Opened; bytes: Uint8Array }>();
  const fetchOpen = async (digest: string): Promise<Opened | { why: string } | { unavailable: string }> => {
    const held = opened.get(digest);
    if (held) return held.opened;
    const got = await getEnvelope(base, author, owner, documentUuid, digest);
    if (isUnavailable(got)) return { unavailable: got.unavailable };
    if (isRefused(got)) return { why: `get: ${got.refused}` };
    if ((await digestOf(got.bytes)) !== digest) return { why: "an envelope is not the one its digest names" };
    let one: Opened;
    try {
      one = await openEnvelope(got.bytes, dataKey);
    } catch {
      return { why: "an envelope does not open under the data key" };
    }
    if (one.clear.owner !== owner || one.clear.document !== documentUuid) return { why: "document" };
    const link = chain?.get(digest);
    if (chain && (!link || link.author !== one.clear.author || link.parents.join(" ") !== one.clear.parents.join(" "))) return { why: "parent-chain" };
    opened.set(digest, { opened: one, bytes: got.bytes });
    return one;
  };
  const failed = (got: Opened | { why: string } | { unavailable: string }): got is { why: string } | { unavailable: string } => !("clear" in got);

  // The head, verified against its parents' checkpoints, which are fetched for that and nothing more.
  const top = await fetchOpen(head.digest);
  if (failed(top)) return top;
  const parentCheckpoints: string[] = [];
  for (const parent of top.clear.parents) {
    const one = await fetchOpen(parent);
    if (failed(one)) return one;
    parentCheckpoints.push(await checkpointDigest(one.inside.checkpoint));
  }
  const why = await verifyOpened(opened.get(head.digest)!.bytes, top, enrolled, parentCheckpoints);
  if (why) return { why };

  // The container: carried by the head, named by it, or, on a chain sealed before envelopes named it, found up the first parents.
  let container = top.inside.container;
  let containerIn = head.digest;
  if (container === undefined && top.inside.containerIn !== undefined) {
    if (chain && !chain.has(top.inside.containerIn)) return { why: "parent-chain" };
    const holder = await fetchOpen(top.inside.containerIn);
    if (failed(holder)) return holder;
    if (holder.inside.checkpoint.release !== top.inside.checkpoint.release) return { why: "the container named is another release's" };
    container = holder.inside.container;
    containerIn = top.inside.containerIn;
  }
  for (let at = top.clear.parents[0]; container === undefined && at !== undefined; ) {
    const one = await fetchOpen(at);
    if (failed(one)) return one;
    container = one.inside.container;
    containerIn = at;
    at = one.clear.parents[0];
  }
  if (container === undefined) return { why: "no container in the chain" };
  // Every other envelope fetched verifies on its own: its signatures under its enrolled author, its database, its document.
  for (const [digest, { opened: one, bytes }] of opened) {
    if (digest === head.digest) continue;
    const unverified = await verifyOpened(bytes, one, enrolled, null);
    if (unverified) return { why: unverified };
  }
  const cartridge = await readCartridge(new File([container], `${top.inside.title}.dai.html`, { type: "text/html" }));
  if (cartridge.manifest.documentUuid !== documentUuid) return { why: "document" };
  const resealed = await resealCartridge(cartridge, top.database);
  // Verified and ready: the owner first, then the key and the kept record, then the library record that lists it.
  await beforeFirstWrite();
  await keepInKeyStore(dataKeyKey(documentUuid), { key: dataKey, owner, wrapped: fromB64u(heads.key), atStore: true } satisfies DataKeyRecord);
  await keepInKeyStore(keptKey(documentUuid), {
    owner,
    revision: top.inside.checkpoint.revision,
    digest: head.digest,
    checkpoint: await checkpointDigest(top.inside.checkpoint),
    release: top.inside.checkpoint.release,
    at: head.at,
    as: "head",
    containerIn,
  } satisfies KeptRecord);
  await install({
    documentUuid,
    title: top.inside.title,
    database: top.database,
    html: resealed.html,
    publicKeyFingerprint: resealed.publicKeyFingerprint,
    revision: top.inside.checkpoint.revision,
  });
  return { restored: { documentUuid, title: top.inside.title, at: head.at } };
}
