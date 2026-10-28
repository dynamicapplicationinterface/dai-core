/**
 * Recovery (R-Z sentence 5, R-E; docs/store.md, "Operations").
 *
 * On a browser with nothing, the person chooses Recover and authenticates with
 * their passkey. The passkey's user handle names the owner, and its PRF output
 * opens the owner key's wrap, which the store hands over on Admit: this
 * context is admitted as a new author under the same owner (R-E). Then the
 * library, each document's heads and envelopes, opened with the data key the
 * owner key unwraps.
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
import { admitChallenge, b64u, checkpointDigest, digestOf, fromB64u, openEnvelope, utf8, verifyOpened, type Author, type Opened, type Unverified } from "../../owner-store/src/envelope.js";
import { admitAuthor, getEnvelope, headsOf, isRefused, isUnavailable, libraryOf } from "../../owner-store/src/client.js";
import { keepInKeyStore, saveCartridgeToLibrary, saveDatabaseToOpfs } from "./opfs.js";
import { readCartridge, resealCartridge } from "./cartridge.js";
import { person } from "./person.js";
import { announceOwnerChange, type DataKeyRecord, type OwnerRecord } from "./owner.js";
import type { KeptRecord } from "./keeping.js";

const PRF_INPUT = utf8("dai owner prf v1");

export interface Restored {
  documentUuid: string;
  title: string;
  /** The store's acknowledgment of the restored checkpoint, ISO 8601. */
  at: string;
}

export type Recovered =
  | { restored: Restored[]; refused: { documentUuid: string; why: Unverified | string }[] }
  | { unavailable: string }
  | { cancelled: string }
  | { refused: string };

const bytesOf = (buffer: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> =>
  buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);

async function prfWrappingKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8("dai owner key v1"), info: utf8("prf") },
    base,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** Recovers this owner's library from the store at `base`. Call it from the tap. */
export function recover(base: string | undefined): Promise<Recovered> {
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
      return restore(base, {
        owner: b64u(bytesOf(response.userHandle)),
        credential: b64u(bytesOf(assertion.rawId)),
        prf: bytesOf(secret),
        proof: {
          kind: "passkey",
          credential: b64u(bytesOf(assertion.rawId)),
          clientDataJSON: b64u(bytesOf(response.clientDataJSON)),
          authenticatorData: b64u(bytesOf(response.authenticatorData)),
          signature: b64u(bytesOf(response.signature)),
        },
      });
    },
    (error: unknown) => ({ cancelled: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
  );
}

async function restore(
  base: string,
  asked: { owner: string; credential: string; prf: Uint8Array<ArrayBuffer>; proof: Parameters<typeof admitAuthor>[3] },
): Promise<Recovered> {
  const me = await person();
  const author: Author = { privateKey: me.keys.privateKey, pub: me.pub, id: me.author };
  const admitted = await admitAuthor(base, author, asked.owner, asked.proof);
  if (isUnavailable(admitted)) return { unavailable: admitted.unavailable };
  if (isRefused(admitted)) return { refused: admitted.refused };
  let ownerKey: CryptoKey;
  try {
    ownerKey = await crypto.subtle.unwrapKey("raw", fromB64u(admitted.wraps.prf), await prfWrappingKey(asked.prf), "AES-KW", { name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
  } catch {
    return { refused: "the passkey does not open the owner key" };
  }
  const library = await libraryOf(base, author, asked.owner);
  if (isUnavailable(library)) return { unavailable: library.unavailable };
  if (isRefused(library)) return { refused: library.refused };

  const enrolled = new Map(Object.entries(library.authors));
  const restored: Restored[] = [];
  const refused: { documentUuid: string; why: string }[] = [];
  for (const documentUuid of library.documents) {
    const outcome = await restoreOne(base, author, asked.owner, documentUuid, ownerKey, enrolled);
    if ("unavailable" in outcome) return { unavailable: outcome.unavailable };
    if ("why" in outcome) {
      console.warn(`dai: ${documentUuid} not restored: ${outcome.why}`);
      refused.push({ documentUuid, why: outcome.why });
    } else if (outcome.restored) restored.push(outcome.restored);
  }

  // Signed in only once there is something true to show: the owner's record, its key held non-extractable.
  const record: OwnerRecord = {
    owner: asked.owner,
    credential: asked.credential,
    key: ownerKey,
    wraps: { prf: fromB64u(admitted.wraps.prf), keychain: fromB64u(admitted.wraps.keychain) },
    keychain: "not offered",
    enrolled: new Date().toISOString(),
    atStore: true,
  };
  await keepInKeyStore(ownerRecordKey(asked.owner), record);
  await keepInKeyStore(KEYS.OWNER, asked.owner);
  announceOwnerChange();
  console.info(`dai: recovered owner ${asked.owner}: ${restored.length} restored, ${refused.length} refused`);
  return { restored, refused };
}

/** One document: its newest head, verified back to the root, installed at that revision. */
async function restoreOne(
  base: string,
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
  await saveDatabaseToOpfs(documentUuid, top.database);
  await saveCartridgeToLibrary({
    documentUuid,
    appName: top.inside.title,
    lastOpened: new Date().toISOString(),
    html: resealed.html,
    publicKeyFingerprint: resealed.publicKeyFingerprint,
    revision: top.inside.checkpoint.revision,
    wrote: true,
  });
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
  return { restored: { documentUuid, title: top.inside.title, at: head.at } };
}
