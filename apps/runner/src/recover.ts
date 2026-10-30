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
 * Every revision restored is verified first (R-C): each envelope back to the
 * root opens under the data key, is signed by an author the store enrolled
 * under this owner whose key it carries, and names as parents exactly the
 * checkpoints of the envelopes before it. A document whose chain does not
 * verify is refused, not restored. The store is trusted for liveness, never
 * for content (R-B).
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
  keychainVerifier,
  openEnvelope,
  utf8,
  verifyOpened,
  type Author,
  type Opened,
  type Unverified,
} from "../../owner-store/src/envelope.js";
import { admitAuthor, getEnvelope, headsOf, isRefused, isUnavailable, libraryOf } from "../../owner-store/src/client.js";
import { keepInKeyStore, keptInKeyStore } from "./opfs.js";
import { readCartridge, resealCartridge } from "./cartridge.js";
import { person } from "./person.js";
import { announceOwnerChange, currentOwner, type DataKeyRecord, type OwnerRecord } from "./owner.js";
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
export async function recoverWithKeychain(base: string | undefined, owner: string, secret: string, here: Here): Promise<Recovered> {
  if (!owner || !secret) return { cancelled: "no saved password filled in" };
  if (!base) return { unavailable: "no store is configured here" };
  const bytes = utf8(secret);
  return restore(base, here, {
    owner,
    proof: async (author) => {
      const challenge = `${admitChallenge()}:${author}`;
      const { privateKey } = await keychainVerifier(bytes);
      return { kind: "keychain", challenge, signature: b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, utf8(challenge)))) };
    },
    open: async (wraps) => (await openOwnerKey(wraps.keychain, bytes, "keychain")) ?? "the saved password does not open the owner key",
  });
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

  // Every envelope back to the root, opened and verified, each once.
  const opened = new Map<string, { opened: Opened; bytes: Uint8Array; at: string }>();
  const order: string[] = [];
  const pending = [head.digest];
  while (pending.length > 0) {
    const digest = pending.pop()!;
    if (opened.has(digest)) continue;
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
    opened.set(digest, { opened: one, bytes: got.bytes, at: got.at });
    order.push(digest);
    pending.push(...one.clear.parents);
  }
  for (const digest of order) {
    const { opened: one, bytes } = opened.get(digest)!;
    const parents = await Promise.all(one.clear.parents.map((p) => checkpointDigest(opened.get(p)!.opened.inside.checkpoint)));
    const why = await verifyOpened(bytes, one, enrolled, parents);
    if (why) return { why };
  }

  const top = opened.get(head.digest)!.opened;
  let container: string | undefined;
  for (let at: string | undefined = head.digest; at && container === undefined; ) {
    const one: Opened = opened.get(at)!.opened;
    container = one.inside.container;
    at = one.clear.parents[0];
  }
  if (container === undefined) return { why: "no container in the chain" };
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
