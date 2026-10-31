/**
 * The keychain path's Ed25519 key, on any engine (D302, ruled 30 October).
 *
 * The verifier the store's Enroll holds, and the signature a keychain Admit
 * carries, are Ed25519 under a key whose seed HKDF derives from the keychain
 * secret (docs/store.md, "Keys" and "The wire"). An engine can make a passkey
 * with PRF and still have no Ed25519 in WebCrypto: Playwright's Windows WebKit
 * does, and so would a Chromium release from before its WebCrypto had it. For
 * that engine alone the opener carries an Ed25519 implementation,
 * `@noble/ed25519` at an exact version (package.json). It is given the same
 * seed, so it derives the same verifier and signs the same challenge with the
 * same signature (RFC 8032 signatures are deterministic): the wire, the store
 * and the Python reader cannot tell which made them, and nothing new is
 * protocol surface (R-P). WebCrypto's is used wherever WebCrypto has it.
 */
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import { b64u, ed25519FromSeed, keychainSeed } from "../../owner-store/src/envelope.js";

export interface KeychainKey {
  /** The verifier: the Ed25519 public key, base64url, as the store's Enroll holds it. */
  pub: string;
  /** An Ed25519 signature over `bytes`, 64 bytes. */
  sign: (bytes: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
  /** Whether the opener's own Ed25519 made it, WebCrypto having none. */
  carried: boolean;
}

const plain = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

/** The key from its seed, in WebCrypto. Throws where WebCrypto has no Ed25519. */
export async function webCryptoKeychainKey(seed: Uint8Array): Promise<KeychainKey> {
  const { privateKey, pub } = await ed25519FromSeed(seed);
  return { pub, sign: async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, plain(bytes))), carried: false };
}

/** The key from its seed, by the Ed25519 the opener carries. */
export async function carriedKeychainKey(seed: Uint8Array): Promise<KeychainKey> {
  const secret = plain(seed);
  const pub = b64u(await getPublicKeyAsync(secret));
  return { pub, sign: async (bytes) => plain(await signAsync(plain(bytes), secret)), carried: true };
}

/** The keychain path's key for `secret`: WebCrypto's where it has Ed25519, the carried one only where it has none. */
export async function keychainKey(secret: Uint8Array): Promise<KeychainKey> {
  const seed = await keychainSeed(secret);
  try {
    return await webCryptoKeychainKey(seed);
  } catch (error: unknown) {
    console.info(`dai: WebCrypto has no Ed25519 here (${error instanceof Error ? error.message : String(error)}); the opener's own derives the keychain key`);
    return carriedKeychainKey(seed);
  }
}

/*
 * Whether this engine can derive a keychain key at all, asked once at load
 * with a secret that is no one's: enrollment reads it inside the tap, before
 * the passkey ceremony, which cannot wait for anything (owner.ts).
 */
let derivable: boolean | null = null;
const probe = typeof crypto !== "undefined" && crypto.subtle ? keychainKey(new TextEncoder().encode("dai keychain probe")).then(() => true, () => false) : Promise.resolve(false);
void probe.then((answer) => {
  derivable = answer;
  if (!answer) console.info("dai: no keychain key can be derived here: Keep beyond this browser refuses before a passkey is made");
});

/** Whether a keychain key can be derived here: false once the probe found none, null until it has answered. */
export function keychainKeyDerivable(): boolean | null {
  return derivable;
}
