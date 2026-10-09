/**
 * The person key, and the author id it fingerprints to (docs/identity.md).
 *
 * A person is a keypair made once on their device and held there. Everything
 * they write into a document is signed by it. This module owns the names: what
 * a person key is, what an author id is, how a signature is made and checked.
 * Where the key is kept is the host's business (`src/keys.ts` names it); this
 * module holds no state.
 *
 * The author id **is** the replica id. The two names collapse into one: the id
 * a copy writes rows under is the fingerprint of the key this device holds, so
 * a copy on another device cannot write as this one, whatever rows arrived
 * with it.
 *
 * ES256 on P-256, the curve the publisher key already uses, so one verifier
 * serves both. Signatures are raw `r || s`, 64 bytes, which is what WebCrypto
 * produces and checks.
 *
 * The Sigstore check of a publisher's identity is `src/publisher-identity.ts`.
 */

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;

/** Bytes of an author id: the first 16 of SHA-256 over the raw public key. */
export const AUTHOR_ID_BYTES = 16;

/** A WebCrypto key, named without the DOM library. */
export type SubtleKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
export type SubtleKeyPair = Awaited<ReturnType<typeof crypto.subtle.generateKey>> & {
  publicKey: SubtleKey;
  privateKey: SubtleKey;
};

/** A copy on a plain ArrayBuffer, which is what WebCrypto's types accept. */
const plain = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

function subtle() {
  const found = globalThis.crypto?.subtle;
  if (!found) throw new Error("UNSUPPORTED_CRYPTO");
  return found;
}

/**
 * A new person key.
 *
 * Extractable on purpose: a key that can never leave the device can never
 * become a recovery phrase, and a person locked out of their own back
 * catalogue is the failure the enterprise story cannot have. The private half
 * still never leaves the host; the frame asks the host to sign.
 */
export async function mintPersonKey(): Promise<SubtleKeyPair> {
  return (await subtle().generateKey(ECDSA, true, ["sign", "verify"])) as SubtleKeyPair;
}

/** The raw public key: 65 bytes, uncompressed. What an author id is the fingerprint of, and what `pub` carries. */
export async function rawPublicKey(publicKey: SubtleKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle().exportKey("raw", publicKey));
}

/** The author id of a raw public key: SHA-256, first 16 bytes. */
export async function authorIdOf(rawPublic: Uint8Array): Promise<Uint8Array> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", plain(rawPublic)));
  return digest.slice(0, AUTHOR_ID_BYTES);
}

/** An author id as it is shown and passed around: base64url, no padding. */
export function showAuthorId(id: Uint8Array): string {
  let binary = "";
  for (const byte of id) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** ES256 over `bytes`, raw r||s. The host calls this; the frame never holds a private key. */
export async function signBytes(privateKey: SubtleKey, bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign(ES256, privateKey, plain(bytes)));
}

/**
 * Whether `signature` is ES256 over `bytes` under the raw public key given.
 * False, never a throw, for anything malformed: a key that is not a P-256
 * point, a signature of the wrong length. A verifier only answers yes or no.
 */
export async function verifySignature(rawPublic: Uint8Array, bytes: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await subtle().importKey("raw", plain(rawPublic), ECDSA, false, ["verify"]);
    return await subtle().verify(ES256, key, plain(signature), plain(bytes));
  } catch {
    return false;
  }
}

/**
 * What a device's key store said when asked for the person key: three answers,
 * never two. "None kept" is the only one that may make a key. "Unreadable" is a
 * store that did not answer, and a device that has a key and could not read it
 * for a moment is not a new author: reading it as "none" is how a throwaway key
 * would write in the person's seat.
 */
export type KeptPersonKey =
  | { kept: "key"; keys: SubtleKeyPair }
  | { kept: "none" }
  | { kept: "unreadable"; why: string };

/**
 * An authority's signed statement that a public key belongs to a named
 * principal. Reserved on the wire (`att` in a batch header); nothing produces
 * or checks one in V1.
 */
export type Attestation = Uint8Array;
