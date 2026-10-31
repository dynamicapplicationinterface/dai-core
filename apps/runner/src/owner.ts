/**
 * The owner, in this browser context (R-A, R-B and R-D as amended, R-Z).
 *
 * A person uses a document before anything is asked of them: its saves land in
 * this browser with no owner, and each document gets a data key at its first
 * written save. Enrolling is chosen, from the menu or the one quiet line after
 * a first change, and only then does a ceremony start. It makes a passkey with
 * the PRF extension, and an owner key, which is wrapped twice: under a key
 * derived from the PRF output and under a key derived from a keychain secret
 * (docs/store.md, "Keys"). Each document's data key is wrapped once, under the
 * owner key. Nothing is uploaded here: the store is Build 2b-2.
 *
 * The owner key is made extractable only long enough to be wrapped, and is
 * kept as the key the PRF wrap opens, non-extractable. A data key stays
 * extractable, because a key is wrapped by exporting it into the wrap; it never
 * leaves this browser any other way.
 *
 * A passkey ceremony must run inside the person's tap (Safari allows it nowhere
 * else, "Owner/author spike", probe fault 1), so `enroll` reaches
 * `navigator.credentials.create` before its first await: everything it needs
 * before the ceremony is made synchronously.
 */
import { KEYS, dataKeyKey, ownerRecordKey } from "../../../src/keys.js";
import { dropFromKeyStore, keepInKeyStore, keepInKeyStoreOnce, keptInKeyStore, listCartridgesFromLibrary } from "./opfs.js";
import { keychainKey, keychainKeyDerivable } from "./keychain-key.js";

/** One owner, as this browser context holds it. */
export interface OwnerRecord {
  /** The owner id: 16 random bytes, base64url. The passkey's user handle and the keychain entry's name. */
  owner: string;
  /** The passkey's credential id, base64url. */
  credential: string;
  /** The owner key, AES-KW, as the PRF wrap opens it: it wraps and unwraps, and cannot be exported. */
  key: CryptoKey;
  /** The owner key, wrapped under each secret. */
  wraps: { prf: Uint8Array; keychain: Uint8Array };
  /**
   * How the keychain secret was handed to a password manager: through the
   * Credential Management API, or a form submission where the browser has no
   * such API, or not at all, where it refused it or the form could not be
   * answered in the browser. Never whether the keychain kept it: no page can
   * know that.
   */
  keychain: "offered" | "not offered";
  /** When this context enrolled, ISO 8601. */
  enrolled: string;
  /**
   * What the store's Enroll needs from the ceremony (docs/store.md, "The
   * wire"): the passkey's public key, SPKI, its algorithm, and the
   * registration's client data. Absent for an owner recovered here, which the
   * store holds already.
   */
  registration?: { publicKey: string; algorithm: number; clientDataJSON: string };
  /** The keychain path's verifier: the Ed25519 public key the keychain secret derives. */
  verifier?: string;
  /** Whether the store has this owner: enrolled there, or recovered from it. */
  atStore?: boolean;
  /** A recovery the store cut short: some of the owner's documents were not reached, and Recover stays offered. */
  recovering?: boolean;
}

/** A document's data key, and the owner it is wrapped under once it is. */
export interface DataKeyRecord {
  key: CryptoKey;
  owner?: string;
  wrapped?: Uint8Array;
  /** Whether the store has this wrap (Put). */
  atStore?: boolean;
}

/**
 * The name the passkey and the saved password carry (Build 2b-2d item 4): the
 * site, and that it is the one for all the person's documents. Two passkeys
 * both named "Your documents" left a person unable to tell which a prompt
 * wanted (the device reading of 30 October). Passkeys made before keep the
 * name they were made with.
 */
export const passkeyName = (): string => `Your documents · ${location.hostname}`;
/**
 * The saved password's account: the same name, and the owner id last, so each
 * owner's secret is its own entry and recovery reads the owner from it.
 */
export const keychainAccount = (owner: string): string => `${passkeyName()} · ${owner}`;
/** The owner id an account names: its last part, or the whole of a bare owner id, as saved before Build 2b-2d. */
export const ownerOfAccount = (account: string): string => (account.split(" · ").pop() ?? "").trim();

/** What the PRF extension is asked to evaluate. Fixed, so every context of one passkey derives one secret. */
const PRF_INPUT = new TextEncoder().encode("dai owner prf v1");
/** The HKDF salt for both wrapping keys (docs/store.md, "Keys"). */
const WRAP_SALT = new TextEncoder().encode("dai owner key v1");

const b64u = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesOf = (buffer: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> =>
  buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);

/** The wrapping key for one path: HKDF-SHA-256 over the secret, info the path's name, to AES-KW-256. */
async function wrappingKey(secret: Uint8Array<ArrayBuffer>, path: "prf" | "keychain"): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: WRAP_SALT, info: new TextEncoder().encode(path) },
    base,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** The PRF output a ceremony returned, or null: a passkey provider without PRF returns none. */
function prfOf(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> | null {
  const results = (credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer | ArrayBufferView } } }).prf?.results;
  return results?.first ? bytesOf(results.first) : null;
}

const keyStoreQueue: { tail: Promise<unknown> } = { tail: Promise.resolve() };
/** One key-store change at a time in this page: a save's data key and an enrollment's adoption never interleave. */
function serially<T>(work: () => Promise<T>): Promise<T> {
  const next = keyStoreQueue.tail.then(work, work);
  keyStoreQueue.tail = next.catch(() => undefined);
  return next;
}

/** The owner this browser context is signed in as, or null. */
export async function currentOwner(): Promise<string | null> {
  return (await keptInKeyStore<string>(KEYS.OWNER)) ?? null;
}

/**
 * Who is signed in changes for the whole browser context, so every page of it
 * hears of it: this one directly, the others over a channel of the origin's,
 * named for the key it announces. A listener reads `currentOwner` again rather
 * than trusting the message.
 */
const ownerChanged = new Set<() => void>();
const ownerChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel(KEYS.OWNER) : null;
ownerChannel?.addEventListener("message", () => {
  for (const listener of ownerChanged) listener();
});
export function announceOwnerChange(): void {
  for (const listener of ownerChanged) listener();
  ownerChannel?.postMessage("changed");
}
/** Calls `listener` whenever an owner signs in or leaves, in this page or another page of this browser context. */
export function onOwnerChange(listener: () => void): void {
  ownerChanged.add(listener);
}

/** The answer this browser context gave the offer to keep beyond it, or null while it has given none (R-Z sentence 3). */
export async function keepOfferAnswer(): Promise<"keep" | "not now" | null> {
  return (await keptInKeyStore<{ answer: "keep" | "not now" }>(KEYS.KEEP_OFFER))?.answer ?? null;
}

/** Keeps the answer for the browser context: once answered, the offer is not made again, whichever document is open. */
export async function answerKeepOffer(answer: "keep" | "not now"): Promise<void> {
  await keepInKeyStore(KEYS.KEEP_OFFER, { answer, at: new Date().toISOString() });
}

/** One owner's record, as kept here, or null. */
export async function ownerRecord(ownerId: string): Promise<OwnerRecord | null> {
  return (await keptInKeyStore<OwnerRecord>(ownerRecordKey(ownerId))) ?? null;
}

/** A document's data key record, or null when it has none yet. */
export async function dataKeyOf(documentUuid: string): Promise<DataKeyRecord | null> {
  return (await keptInKeyStore<DataKeyRecord>(dataKeyKey(documentUuid))) ?? null;
}

/** The document's data key, minted if it has none: one per document, whoever asks first. */
async function heldDataKey(documentUuid: string): Promise<DataKeyRecord> {
  const held = await dataKeyOf(documentUuid);
  if (held) return held;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  return keepInKeyStoreOnce<DataKeyRecord>(dataKeyKey(documentUuid), { key });
}

/** Wraps a document's data key under an owner, unless it is wrapped already. Never rewrites the document. */
async function wrapUnder(documentUuid: string, owner: OwnerRecord): Promise<boolean> {
  const held = await heldDataKey(documentUuid);
  if (held.owner) return false;
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", held.key, owner.key, "AES-KW"));
  await keepInKeyStore(dataKeyKey(documentUuid), { key: held.key, owner: owner.owner, wrapped } satisfies DataKeyRecord);
  return true;
}

/** A document's data key as the store holds it under an owner: opened, and as wrapped there. */
export interface StoreDataKey {
  key: CryptoKey;
  wrapped: Uint8Array;
}

/*
 * The adoption: each document named that no owner holds yet comes under
 * `owner`. One the store already holds under that owner, from another of the
 * person's browser contexts, takes the store's data key in place of this
 * browser's, so every envelope of it opens under the one key the store hands a
 * recovery: the key here sealed nothing yet, since no owner held the document
 * here and nothing of it was kept. Answers the documents adopted.
 */
async function adoptAll(owner: OwnerRecord, documents: readonly string[], atStore: ReadonlyMap<string, StoreDataKey>): Promise<string[]> {
  const adopted: string[] = [];
  for (const documentUuid of documents) {
    const there = atStore.get(documentUuid);
    if (!there) {
      if (await wrapUnder(documentUuid, owner)) adopted.push(documentUuid);
      continue;
    }
    if ((await dataKeyOf(documentUuid))?.owner) continue;
    await keepInKeyStore(dataKeyKey(documentUuid), { key: there.key, owner: owner.owner, wrapped: there.wrapped, atStore: true } satisfies DataKeyRecord);
    adopted.push(documentUuid);
  }
  return adopted;
}

/**
 * Adopts, under an owner signed in here by the passkey the person already has
 * (R-Z, amended 31 October), the documents saved in this browser that no owner
 * holds: the adoption `enroll` makes, with the store's data key for each
 * document the store already holds under that owner.
 */
export function adoptUnder(owner: OwnerRecord, documents: readonly string[], atStore: ReadonlyMap<string, StoreDataKey>): Promise<string[]> {
  return serially(() => adoptAll(owner, documents, atStore));
}

/**
 * After a save of a document landed in this browser: its data key exists, and
 * when the save carried a change of the person's, it is wrapped under the
 * owner this context is signed in as, if no owner holds it yet. A document no
 * owner holds is claimed by the owner who first changes it, never by a sign-in
 * or an open alone: the seed, an echo, a merge and the runtime's bookkeeping
 * claim nothing (R-Z sentence 5; 2b-1's L2). Off the save's path: nothing here
 * holds a save up, and a failure here loses nothing the save wrote.
 */
export function afterSaveWritten(documentUuid: string, personsChange: boolean): Promise<void> {
  return serially(async () => {
    const signedIn = await currentOwner();
    const owner = signedIn && personsChange ? await ownerRecord(signedIn) : null;
    if (owner) await wrapUnder(documentUuid, owner);
    else await heldDataKey(documentUuid);
  });
}

/**
 * Whether a document opens in this browser context (R-B, R-Z sentence 5): when
 * no owner holds it, or the owner signed in does. A document wrapped under
 * another owner is that owner's, listed and opened only under their sign-in,
 * whichever way it is reached: the library, a resume, an icon or a link.
 */
export async function mayOpenHere(documentUuid: string): Promise<boolean> {
  const held = await dataKeyOf(documentUuid);
  if (!held?.owner) return true;
  return held.owner === (await currentOwner());
}

/** Why an enrollment did not finish. Nothing was kept in any of them. */
export type NotEnrolled =
  /** The person closed the sheet, or this device has no passkey for the page: the browser cannot tell the two apart. */
  | "cancelled"
  /** A passkey was made, but its provider gave no PRF output, so nothing could be wrapped under it. */
  | "no-prf"
  /** This browser has no passkeys at all. */
  | "unsupported"
  /**
   * The store could never register this owner: no keychain verifier can be
   * derived here (refused before the passkey is made), or the passkey's public
   * key was not given (D302). Nothing is kept, and nobody is signed in.
   */
  | "unregistrable";

/**
 * Enrolls this browser context as a new owner, and adopts every document
 * `documents` names that no owner holds yet. Call it from the tap itself; the
 * documents are asked for after the ceremony, so nothing waits before it.
 */
export function enroll(
  rpName: string,
  documents: () => Promise<readonly string[]>,
  byForm?: OfferByForm,
): Promise<{ enrolled: string } | { refused: NotEnrolled; why: string }> {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    return Promise.resolve({ refused: "unsupported", why: "no WebAuthn" });
  }
  // Known before the tap: an engine that can derive no keychain verifier gets no passkey made for an owner the store could never hold (D302).
  if (keychainKeyDerivable() === false) return Promise.resolve({ refused: "unregistrable", why: "no keychain verifier can be derived here" });
  const ownerBytes = crypto.getRandomValues(new Uint8Array(16));
  const owner = b64u(ownerBytes);
  // Reached before any await: the ceremony runs inside the tap.
  const made = navigator.credentials.create({
    publicKey: {
      rp: { name: rpName },
      user: { id: ownerBytes, name: passkeyName(), displayName: passkeyName() },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: PRF_INPUT } } } as AuthenticationExtensionsClientInputs,
    },
  }) as Promise<PublicKeyCredential | null>;
  return made.then(
    async (credential) => {
      if (!credential) return { refused: "cancelled", why: "no credential returned" };
      let secret = prfOf(credential);
      if (!secret) {
        // Some providers evaluate PRF only at an assertion: ask once more, for this passkey.
        const asserted = (await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{ type: "public-key", id: bytesOf(credential.rawId) }],
            userVerification: "required",
            extensions: { prf: { eval: { first: PRF_INPUT } } } as AuthenticationExtensionsClientInputs,
          },
        })) as PublicKeyCredential | null;
        secret = asserted ? prfOf(asserted) : null;
      }
      if (!secret) return { refused: "no-prf", why: "the passkey's provider gave no PRF output" };
      const attestation = credential.response as AuthenticatorAttestationResponse;
      const spki = attestation.getPublicKey?.() ?? null;
      const registration = spki
        ? {
            publicKey: b64u(bytesOf(spki)),
            algorithm: attestation.getPublicKeyAlgorithm?.() ?? 0,
            clientDataJSON: b64u(bytesOf(attestation.clientDataJSON)),
          }
        : undefined;
      if (!registration) return { refused: "unregistrable" as const, why: "the passkey's public key was not given, so the store could not register it" };
      const adopt = await documents();
      return serially(() => keep(owner, b64u(bytesOf(credential.rawId)), secret, adopt, registration, byForm));
    },
    (error: unknown) => ({ refused: "cancelled" as const, why: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
  );
}

/** Makes and keeps the owner key, its two wraps, the record, and the documents' wraps. */
async function keep(
  owner: string,
  credential: string,
  prf: Uint8Array<ArrayBuffer>,
  documents: readonly string[],
  registration: NonNullable<OwnerRecord["registration"]>,
  byForm?: OfferByForm,
): Promise<{ enrolled: string } | { refused: "unregistrable"; why: string }> {
  const keychainSecret = b64u(crypto.getRandomValues(new Uint8Array(32)));
  // WebCrypto's Ed25519, or the opener's own where WebCrypto has none (D302): never a record the store cannot register.
  let verifier: string;
  try {
    verifier = (await keychainKey(new TextEncoder().encode(keychainSecret))).pub;
  } catch (error: unknown) {
    return { refused: "unregistrable", why: `no keychain verifier: ${error instanceof Error ? error.message : String(error)}` };
  }
  const made = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, true, ["wrapKey", "unwrapKey"]);
  const prfKey = await wrappingKey(prf, "prf");
  const wraps = {
    prf: new Uint8Array(await crypto.subtle.wrapKey("raw", made, prfKey, "AES-KW")),
    keychain: new Uint8Array(await crypto.subtle.wrapKey("raw", made, await wrappingKey(new TextEncoder().encode(keychainSecret), "keychain"), "AES-KW")),
  };
  // The key kept is the one the PRF wrap opens, so a wrap that does not open fails here, before anything is kept.
  const key = await crypto.subtle.unwrapKey("raw", wraps.prf, prfKey, "AES-KW", { name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"]);
  const record: OwnerRecord = {
    owner,
    credential,
    key,
    wraps,
    keychain: "not offered",
    enrolled: new Date().toISOString(),
    registration,
    verifier,
  };
  await keepInKeyStore(ownerRecordKey(owner), record);
  await keepInKeyStore(KEYS.OWNER, owner);
  announceOwnerChange();
  await adoptAll(record, documents, new Map());
  console.info(`dai: enrolled as owner ${owner}; ${documents.length} document(s) adopted`);
  // Last, once everything is kept: the form path reloads the page, and an enrollment must not depend on what follows it.
  const offered = async (): Promise<void> =>
    keepInKeyStore(ownerRecordKey(owner), { ...((await ownerRecord(owner)) ?? record), keychain: "offered" } satisfies OwnerRecord);
  const keychain = await offerToKeychain(owner, keychainSecret, offered, byForm);
  console.info(`dai: keychain secret ${keychain}`);
  return { enrolled: owner };
}

/**
 * How the opener hands the keychain secret to a password manager by a form
 * submission: it fills the form with the account (`keychainAccount`) and the secret, calls
 * `offered` once nothing can stop the submission, and submits. Answers false,
 * having called nothing, when it cannot submit without the secret leaving the
 * browser. A submission reloads the page, so a true answer is seldom seen.
 */
export type OfferByForm = (account: string, secret: string, offered: () => Promise<void>) => Promise<boolean>;

/**
 * Hands the keychain secret to the browser's password manager, and says
 * whether it was handed over: through the Credential Management API where the
 * browser has it (Chromium), and where it has none (Safari), through a form
 * submission the password manager offers to save, which reloads the page
 * ("Owner/author spike", probe fault 2; D298). The account names the site
 * and ends with the owner id, so each owner's secret is its own entry.
 *
 * Whether the keychain kept it is not knowable here: `store()` settles when
 * the browser offers to save, before the person answers, a form submission
 * says nothing at all, and nothing reads it back. So the keychain wrap is made
 * whatever this answers, and that the secret is in a keychain is a device
 * reading, never a claim the page makes.
 */
async function offerToKeychain(owner: string, secret: string, offered: () => Promise<void>, byForm?: OfferByForm): Promise<OwnerRecord["keychain"]> {
  const Password = (window as unknown as { PasswordCredential?: new (data: { id: string; password: string; name: string }) => Credential }).PasswordCredential;
  if (Password && navigator.credentials?.store) {
    try {
      await navigator.credentials.store(new Password({ id: keychainAccount(owner), password: secret, name: passkeyName() }));
    } catch {
      return "not offered";
    }
    await offered();
    return "offered";
  }
  return byForm && (await byForm(keychainAccount(owner), secret, offered)) ? "offered" : "not offered";
}

/**
 * Signs this browser context in as an owner it holds, with that owner's
 * passkey: the PRF output must open the owner key's PRF wrap. A passkey that is
 * not the owner's, even one made for the same owner id, opens nothing, and
 * nothing changes. With no owner named, any passkey for this page may answer,
 * and its user handle names the owner.
 */
export async function signIn(ownerId?: string): Promise<"opened" | "refused" | "unknown" | "cancelled"> {
  const named = ownerId ? await ownerRecord(ownerId) : null;
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        ...(named ? { allowCredentials: [{ type: "public-key" as const, id: fromB64u(named.credential) }] } : {}),
        userVerification: "required",
        extensions: { prf: { eval: { first: PRF_INPUT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch {
    return "cancelled";
  }
  if (!assertion) return "cancelled";
  const handle = (assertion.response as AuthenticatorAssertionResponse).userHandle;
  const record = handle ? await ownerRecord(b64u(bytesOf(handle))) : null;
  if (!record) return "unknown";
  const secret = prfOf(assertion);
  if (!secret) return "refused";
  try {
    await crypto.subtle.unwrapKey("raw", record.wraps.prf, await wrappingKey(secret, "prf"), "AES-KW", { name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"]);
  } catch {
    return "refused";
  }
  await keepInKeyStore(KEYS.OWNER, record.owner);
  announceOwnerChange();
  return "opened";
}

/**
 * Lets go of an owner the store can never register: a record kept here with
 * no keychain verifier or no passkey public key, as an opener before D302's
 * ruling kept one on an engine with no Ed25519. Nothing of it is at the store,
 * and nothing here can make what its Enroll needs (the keychain secret went to
 * a password manager, and the owner key cannot be wrapped again), so it is not
 * left signed in with every save refused. Each document wrapped under it goes
 * back to this browser's, its data key unchanged, so nothing is lost and
 * "Keep beyond this browser" adopts it again; the record goes, and the owner
 * is signed out.
 */
export function letGoOfOwner(ownerId: string): Promise<void> {
  return serially(async () => {
    for (const { documentUuid } of await listCartridgesFromLibrary()) {
      const held = await dataKeyOf(documentUuid);
      if (held?.owner === ownerId) await keepInKeyStore(dataKeyKey(documentUuid), { key: held.key } satisfies DataKeyRecord);
    }
    if ((await currentOwner()) === ownerId) await dropFromKeyStore(KEYS.OWNER);
    await dropFromKeyStore(ownerRecordKey(ownerId));
    console.info(`dai: owner ${ownerId} let go: the store could never register it`);
    announceOwnerChange();
  });
}

/** Signs this browser context out of its owner. The owner's record and every wrap stay. */
export async function leave(): Promise<void> {
  await dropFromKeyStore(KEYS.OWNER);
  announceOwnerChange();
}

/** One document in the library, and who holds it here: the owner signed in, or this browser alone. */
export interface LibraryEntry {
  documentUuid: string;
  appName: string;
  holder: "owner" | "this browser";
}

/**
 * The library this browser lists for the person (R-B: keyed by owner; R-Z
 * sentence 5): the documents held here under the owner signed in, and the ones
 * no owner holds, as this browser's. Another owner's documents are not listed:
 * they are that owner's, and come back with that owner's passkey. A document
 * with no data key yet, saved before there were any, is no owner's.
 */
export async function libraryHere(items: readonly { documentUuid: string; appName: string }[]): Promise<LibraryEntry[]> {
  const signedIn = await currentOwner();
  const entries: LibraryEntry[] = [];
  for (const { documentUuid, appName } of items) {
    const held = await dataKeyOf(documentUuid);
    if (!held?.owner) entries.push({ documentUuid, appName, holder: "this browser" });
    else if (held.owner === signedIn) entries.push({ documentUuid, appName, holder: "owner" });
  }
  return entries;
}
