/**
 * Client-side signing identity for the Web Studio.
 *
 * The key pair is generated in the tab and stored in IndexedDB, scoped to this
 * origin. Nothing is ever sent anywhere: there is no signing server, and a
 * private key that left the browser would stop being the developer's alone.
 *
 * CryptoKey objects are stored directly rather than as PEM. IndexedDB
 * structured-clones them, so the key material never has to exist as a string in
 * JS memory for normal use — only an explicit export produces one.
 */
import type { SigningKeyPair } from "../../../src/core.js";

const DB_NAME = "dai-studio";
const DB_VERSION = 1;
const STORE = "keys";
const RECORD = "signing-identity";

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function loadKeyPair(): Promise<SigningKeyPair | undefined> {
  const stored = await withStore<SigningKeyPair | undefined>("readonly", (store) =>
    store.get(RECORD),
  );
  return stored?.privateKey ? stored : undefined;
}

/**
 * Generates and stores a new identity.
 *
 * The private key is created extractable so it can be exported and backed up.
 * That is a deliberate trade: a non-extractable key would be safer against
 * script access, but an identity that cannot be backed up is one the developer
 * loses with their browser profile — and losing it means losing the ability to
 * publish updates under the same fingerprint.
 */
export async function generateKeyPair(): Promise<SigningKeyPair> {
  const pair = (await crypto.subtle.generateKey(ECDSA_P256, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const identity: SigningKeyPair = {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
  await withStore("readwrite", (store) => store.put(identity, RECORD));
  return identity;
}

export async function clearKeyPair(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(RECORD));
}

/** Short, comparable identity, matching what the compiler writes to a manifest. */
export async function fingerprintOf(pair: SigningKeyPair): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const digest = await crypto.subtle.digest("SHA-256", spki);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function toPem(der: ArrayBuffer, label: string): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function fromPem(pem: string, label: string): Uint8Array {
  const body = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error(`No ${label} block found.`);
  const binary = atob(body);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function exportPrivateKeyPem(pair: SigningKeyPair): Promise<string> {
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return toPem(der, "PRIVATE KEY");
}

export async function exportPublicKeyPem(pair: SigningKeyPair): Promise<string> {
  const der = await crypto.subtle.exportKey("spki", pair.publicKey);
  return toPem(der, "PUBLIC KEY");
}

/**
 * Imports a PKCS#8 PEM and stores it as this Studio's identity.
 *
 * WebCrypto cannot derive a public key from a private one, so the public half is
 * rebuilt from the JWK coordinates — the same route the compiler takes for PEM
 * input.
 */
export async function importPrivateKeyPem(pem: string): Promise<SigningKeyPair> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    fromPem(pem, "PRIVATE KEY") as unknown as BufferSource,
    ECDSA_P256,
    true,
    ["sign"],
  );

  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    ECDSA_P256,
    true,
    ["verify"],
  );

  const identity: SigningKeyPair = { privateKey, publicKey };
  await withStore("readwrite", (store) => store.put(identity, RECORD));
  return identity;
}
