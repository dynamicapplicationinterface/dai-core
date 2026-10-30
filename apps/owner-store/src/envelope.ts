/**
 * The owner's store's wire (docs/store.md): the envelope a save sends, the
 * checkpoint sealed inside it, and the signature every request carries.
 *
 * Shared by the store, which verifies what it can without reading anything,
 * and by the host, which seals, and which verifies everything after opening.
 * WebCrypto only, so the same code runs in a browser, in Node and in a Worker.
 *
 * Every signature here is ES256 (ECDSA P-256, SHA-256, the raw r‖s form
 * WebCrypto makes) under an author key, except the keychain path's proof,
 * which is Ed25519 under a key derived from the keychain secret, and a
 * passkey's assertion, which is the authenticator's own.
 */

export const b64u = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const fromB64u = (text: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
};

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

/** A copy on its own buffer, which every WebCrypto call accepts. */
export const plain = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
};

export async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", plain(bytes)));
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The author id of a raw P-256 public key: SHA-256, first 16 bytes, base64url (docs/identity.md). */
export async function authorIdOf(rawPublic: Uint8Array): Promise<string> {
  return b64u((await sha256(rawPublic)).slice(0, 16));
}

export async function signES256(privateKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign(ES256, privateKey, plain(bytes)));
}

/** Whether `signature` is ES256 over `bytes` under a raw public key. False for anything malformed. */
export async function verifyES256(rawPublic: Uint8Array, signature: Uint8Array, bytes: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", plain(rawPublic), P256, false, ["verify"]);
    return await crypto.subtle.verify(ES256, key, plain(signature), plain(bytes));
  } catch {
    return false;
  }
}

/** A store digest: SHA-256, base64url. The name of an envelope, a checkpoint, a database. */
export async function digestOf(bytes: Uint8Array): Promise<string> {
  return b64u(await sha256(bytes));
}

const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);
export const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

/*
 * The checkpoint (R-C): {release digest, document id, revision, database
 * digest, parent checkpoint digest(s)}, signed by the author key. Its digest
 * is SHA-256 of the bytes signed, so two checkpoints with the same contents
 * are one checkpoint whoever signed them; the signature travels beside it.
 */
export interface Checkpoint {
  release: string;
  document: string;
  revision: number;
  database: string;
  parents: string[];
}

export const checkpointBytes = (c: Checkpoint): Uint8Array<ArrayBuffer> =>
  utf8(JSON.stringify(["dai checkpoint v1", c.release, c.document, c.revision, c.database, [...c.parents]]));

export async function checkpointDigest(c: Checkpoint): Promise<string> {
  return digestOf(checkpointBytes(c));
}

/*
 * The envelope (docs/store.md, "The envelope"). The clear part is what the
 * store links and authorizes by; the sealed part is AES-GCM under the
 * document's data key, with the clear part as associated data, so a store
 * that moves a sealed part under another clear part, another author or other
 * parents, makes something that does not open. The author signs the clear part
 * with the ciphertext's digest.
 */
export interface Clear {
  owner: string;
  document: string;
  author: string;
  /** The envelope digests of its parents. */
  parents: string[];
}

export interface Envelope extends Clear {
  v: 1;
  /** Nonce ‖ ciphertext, base64url. */
  sealed: string;
  signature: string;
}

const clearBytes = (c: Clear): Uint8Array<ArrayBuffer> => utf8(JSON.stringify(["dai envelope v1", c.owner, c.document, c.author, [...c.parents]]));

const signedClearBytes = (c: Clear, sealedDigest: string): Uint8Array<ArrayBuffer> =>
  utf8(JSON.stringify(["dai envelope v1", c.owner, c.document, c.author, [...c.parents], sealedDigest]));

/** What the sealed part holds, besides the database. */
export interface Inside {
  checkpoint: Checkpoint;
  /** The author's ES256 signature over the checkpoint, base64url. */
  signature: string;
  /** The author's raw public key, base64url: the key the checkpoint verifies under. */
  pub: string;
  /** The document's title, for the library. */
  title: string;
  /**
   * The release's container, as this host keeps it, when the parent's release
   * differs or there is no parent: what a host with nothing opens the database
   * in. Absent otherwise, and found up the chain.
   */
  container?: string;
  /**
   * Where the container is, when this envelope does not carry it: the digest
   * of the envelope up the chain that does, so a host with nothing fetches
   * that one envelope and not every one between.
   */
  containerIn?: string;
}

export interface Opened {
  clear: Clear;
  inside: Inside;
  database: Uint8Array<ArrayBuffer>;
}

/** Parses an envelope's bytes, checking only its shape. Throws on anything else. */
export function parseEnvelope(bytes: Uint8Array): Envelope {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Envelope;
  const ok =
    value &&
    value.v === 1 &&
    isId(value.owner) &&
    isId(value.document) &&
    isId(value.author) &&
    Array.isArray(value.parents) &&
    value.parents.length <= 16 &&
    value.parents.every(isDigest) &&
    new Set(value.parents).size === value.parents.length &&
    typeof value.sealed === "string" &&
    typeof value.signature === "string";
  if (!ok) throw new Error("not an envelope");
  return value;
}

/** Whether the author's signature over the clear part and the sealed digest holds, under a raw public key. */
export async function envelopeSigned(envelope: Envelope, rawPublic: Uint8Array): Promise<boolean> {
  try {
    const sealedDigest = await digestOf(fromB64u(envelope.sealed));
    return await verifyES256(rawPublic, fromB64u(envelope.signature), signedClearBytes(envelope, sealedDigest));
  } catch {
    return false;
  }
}

export interface Author {
  /** The author key pair; only its private half signs. */
  privateKey: CryptoKey;
  /** The raw public key, 65 bytes. */
  pub: Uint8Array;
  id: string;
}

/** Seals and signs an envelope. Returns its bytes, its digest and the checkpoint's digest. */
export async function sealEnvelope(
  clear: Clear,
  content: { checkpoint: Checkpoint; title: string; database: Uint8Array; container?: string; containerIn?: string },
  dataKey: CryptoKey,
  author: Author,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; digest: string; checkpoint: string }> {
  if (clear.author !== author.id) throw new Error("the envelope names another author");
  const inside: Inside = {
    checkpoint: content.checkpoint,
    signature: b64u(await signES256(author.privateKey, checkpointBytes(content.checkpoint))),
    pub: b64u(author.pub),
    title: content.title,
    ...(content.container !== undefined ? { container: content.container } : {}),
    ...(content.containerIn !== undefined ? { containerIn: content.containerIn } : {}),
  };
  // The header is JSON, which never holds a raw newline, then a newline, then the database.
  const plaintext = concat(utf8(JSON.stringify(inside)), utf8("\n"), content.database);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: clearBytes(clear) }, dataKey, plaintext));
  const sealed = concat(nonce, ciphertext);
  const signature = await signES256(author.privateKey, signedClearBytes(clear, await digestOf(sealed)));
  const envelope: Envelope = { v: 1, ...pick(clear), sealed: b64u(sealed), signature: b64u(signature) };
  const bytes = utf8(JSON.stringify(envelope));
  return { bytes, digest: await digestOf(bytes), checkpoint: await checkpointDigest(content.checkpoint) };
}

const pick = (c: Clear): Clear => ({ owner: c.owner, document: c.document, author: c.author, parents: [...c.parents] });

/**
 * Opens an envelope under a data key. Throws when it does not open: another
 * key, or a clear part changed since it was sealed. Opening proves nothing
 * about the checkpoint inside; `verifyOpened` does.
 */
export async function openEnvelope(bytes: Uint8Array, dataKey: CryptoKey): Promise<Opened> {
  const envelope = parseEnvelope(bytes);
  const sealed = fromB64u(envelope.sealed);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: clearBytes(envelope) }, dataKey, sealed.slice(12)),
  );
  const cut = plaintext.indexOf(10);
  if (cut < 0) throw new Error("no header in the sealed part");
  const inside = JSON.parse(new TextDecoder().decode(plaintext.slice(0, cut))) as Inside;
  return { clear: pick(envelope), inside, database: plaintext.slice(cut + 1) };
}

/** Why a kept revision is refused (item 8, R-C). */
export type Unverified =
  | "signature"
  | "author-not-enrolled"
  | "author-key"
  | "database"
  | "document"
  | "parent-chain"
  | "envelope-signature";

/**
 * Verifies an opened envelope against its author's enrolled key and its
 * parents (R-C): the envelope's own signature and the checkpoint's under the
 * key the store enrolled for that author, which must be the key sealed inside
 * and the one the author id is the fingerprint of; the database digest; the
 * document; and the checkpoint's parents, which must be the checkpoints sealed
 * in the envelopes the clear part names, given here opened and verified. Null
 * for an envelope whose parents were not fetched: then only as many as the
 * clear part names.
 */
export async function verifyOpened(
  bytes: Uint8Array,
  opened: Opened,
  enrolled: ReadonlyMap<string, string>,
  parentCheckpoints: readonly string[] | null,
): Promise<Unverified | null> {
  const pub = enrolled.get(opened.clear.author);
  if (!pub) return "author-not-enrolled";
  if (pub !== opened.inside.pub || (await authorIdOf(fromB64u(pub))) !== opened.clear.author) return "author-key";
  if (!(await envelopeSigned(parseEnvelope(bytes), fromB64u(pub)))) return "envelope-signature";
  if (!(await verifyES256(fromB64u(pub), fromB64u(opened.inside.signature), checkpointBytes(opened.inside.checkpoint)))) return "signature";
  if (opened.inside.checkpoint.document !== opened.clear.document) return "document";
  if ((await digestOf(opened.database)) !== opened.inside.checkpoint.database) return "database";
  if (parentCheckpoints === null) return opened.inside.checkpoint.parents.length === opened.clear.parents.length ? null : "parent-chain";
  const named = [...opened.inside.checkpoint.parents].sort();
  const held = [...parentCheckpoints].sort();
  if (named.length !== held.length || named.some((d, i) => d !== held[i])) return "parent-chain";
  return null;
}

/*
 * A request's signature. Every request but Enroll and Admit is made by an
 * author enrolled under the owner it names; Enroll and Admit carry the new
 * author's public key and are signed by it, so the store knows the author
 * holds the key it enrolls. The time bounds a replay to the store's window.
 */
export const REQUEST_WINDOW_MS = 5 * 60_000;

export const requestBytes = (method: string, path: string, time: string, bodyDigest: string): Uint8Array<ArrayBuffer> =>
  utf8(JSON.stringify(["dai store request v1", method, path, time, bodyDigest]));

export async function signRequest(author: Author, method: string, path: string, body: Uint8Array): Promise<Record<string, string>> {
  const time = String(Date.now());
  const signature = await signES256(author.privateKey, requestBytes(method, path, time, await digestOf(body)));
  return { "x-dai-author": author.id, "x-dai-time": time, "x-dai-signature": b64u(signature) };
}

/*
 * The keychain path's verifier (docs/store.md, "What the store holds"): an
 * Ed25519 key derived from the keychain secret, so the store can check a
 * keychain proof and holds nothing that opens a wrap. Its seed is HKDF-SHA-256
 * over the secret, salt "dai owner key v1", info "keychain verifier".
 */
const ED25519_PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

export async function keychainVerifier(secret: Uint8Array): Promise<{ privateKey: CryptoKey; pub: string }> {
  const base = await crypto.subtle.importKey("raw", plain(secret), "HKDF", false, ["deriveBits"]);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8("dai owner key v1"), info: utf8("keychain verifier") }, base, 256),
  );
  const privateKey = await crypto.subtle.importKey("pkcs8", concat(new Uint8Array(ED25519_PKCS8_PREFIX), seed), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!jwk.x) throw new Error("no public key derived");
  return { privateKey, pub: jwk.x };
}

export async function verifyEd25519(pub: string, signature: Uint8Array, bytes: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromB64u(pub), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, plain(signature), plain(bytes));
  } catch {
    return false;
  }
}

/*
 * An Admit's challenge: "dai admit v1:<ms>:<nonce>", made synchronously, since
 * a passkey ceremony must start inside the tap, before any await. The keychain
 * path appends ":<author id>" and signs it; the passkey path binds the author
 * by the request's own signature. The store refuses a challenge outside its
 * window or one it has seen.
 */
export function admitChallenge(): string {
  return `dai admit v1:${Date.now()}:${b64u(crypto.getRandomValues(new Uint8Array(16)))}`;
}

export const ADMIT_CHALLENGE = /^dai admit v1:(\d{1,16}):([A-Za-z0-9_-]{22})$/;

/** A DER ECDSA signature (what an authenticator returns) as WebCrypto's raw r‖s, or null. */
export function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (der[0] !== 0x30) return null;
  let at = 2;
  const take = (): Uint8Array | null => {
    if (der[at] !== 0x02) return null;
    const length = der[at + 1]!;
    const value = der.slice(at + 2, at + 2 + length);
    at += 2 + length;
    let start = 0;
    while (value.length - start > 32 && value[start] === 0) start += 1;
    if (value.length - start > 32) return null;
    const out = new Uint8Array(32);
    out.set(value.slice(start), 32 - (value.length - start));
    return out;
  };
  const r = take();
  const s = take();
  return r && s ? concat(r, s) : null;
}
