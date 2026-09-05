/**
 * The reference link: a document too big for the address bar, kept somewhere
 * dumb.
 *
 * The inline carrier puts the document in the link. Above the cap something has
 * to hold the bytes, and the design question is how little that something is
 * allowed to know. The answer here is: nothing. The store holds ciphertext
 * under the hash of that ciphertext, and the key is in the fragment of the
 * link, which no browser ever sends to any server. Whoever runs the store can
 * count documents and measure them. They cannot read one, cannot tell which
 * link opens which blob, and cannot substitute one — the hash is checked
 * before anything else happens, and the signature inside is checked after.
 *
 *     <opener>/d/<id>#h=<sha256 of the blob>&k=<key>
 *     <opener>/#h=<sha256>&u=<where the blob is>&k=<key>
 *
 * The first names a store the opener knows; the second names any store at all,
 * so that a company with a bucket needs nothing from this project but the
 * opener. `id` is the hash, so the address is the content and a blob can be
 * mirrored anywhere without the link changing.
 *
 * A store is three calls. `put` writes ciphertext and a sidecar, `get` reads
 * bytes, `head` says whether they exist. Anything more would be logic, and
 * logic in a store is a store that has to be trusted. Two adapters ship: a
 * directory on disk, for tests and for a machine that is its own store, and any
 * S3-compatible bucket, which is what R2, MinIO, B2 and S3 itself all speak —
 * so the production host and the enterprise self-host are the same code.
 *
 * The opener never imports this file's adapters. It fetches a URL, checks a
 * hash, decrypts, and verifies what it finds exactly as it would a file.
 */
import { ContainerError, parseContainer, thinned, verifyManifestSignature } from "./container.js";
import { fromBase64, sha256Hex, toBase64, type ContainerManifest } from "./core.js";

/** What a DAI relay will hold. A general file host this is not. */
export const STORE_CAP = 5 * 1024 * 1024;

/** The fragment keys. `h` for the hash, `k` for the key, `u` for an any-host URL. */
export const REFERENCE_KEYS = { hash: "h", key: "k", url: "u" } as const;

/**
 * What travels beside the blob, in the clear.
 *
 * Enough for an unfurl — name, icon — and for the store to check that what it
 * is being handed is a DAI document rather than a file wearing the format's
 * name: the manifest with its signature, and the key that signature is under.
 * Nothing here is secret; all of it is also inside the ciphertext, where the
 * verifier reads it. This copy is for the parts of the world that cannot open
 * the document and only need to know what it is called.
 */
export interface Sidecar {
  documentUuid: string;
  appName: string;
  favicon?: string;
  /** The manifest, for the store to verify the signature over. */
  manifest: ContainerManifest;
  /** Base64 SPKI, when signed. */
  publicKey?: string;
  /** The ciphertext's length, which `put` checks against what it was handed. */
  size: number;
}

export interface Store {
  /**
   * Writes a blob under its hash, and its sidecar beside it. Returns the URL
   * the blob can be read from. Idempotent: a second put of the same hash is
   * the same object.
   */
  put(hash: string, ciphertext: Uint8Array, sidecar: Sidecar): Promise<string>;
  get(href: string): Promise<Uint8Array>;
  head(href: string): Promise<{ exists: boolean; size: number }>;
}

/** A document sealed for a store: what `put` is handed, and what a link names. */
export interface Sealed {
  /** SHA-256 of the blob, hex. The address and the check. */
  hash: string;
  /** IV || ciphertext || tag. What the store holds. */
  blob: Uint8Array;
  /** 32 bytes, base64url. Goes in the fragment and nowhere else. */
  key: string;
  sidecar: Sidecar;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  return fromBase64(value.replace(/-/g, "+").replace(/_/g, "/"));
}

/**
 * Seals a verified container for a store.
 *
 * Thin, because the store is on the path to an opener and an opener holds the
 * engine; a megabyte of SQLite in every blob would be the store paying for
 * what the reader already has. AES-256-GCM under a fresh random key, so the
 * store holds nothing it can read and two seals of one document are two
 * different blobs.
 */
export async function sealForStore(html: string): Promise<Sealed> {
  const container = parseContainer(html);
  const thin = new TextEncoder().encode(thinned(container));

  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, thin as unknown as ArrayBuffer),
  );

  const blob = new Uint8Array(iv.length + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, iv.length);

  if (blob.length > STORE_CAP) {
    throw new ContainerError(
      "STORE_REFUSED",
      `This document is ${(blob.length / 1024 / 1024).toFixed(1)} MB sealed, and a store holds at most ${STORE_CAP / 1024 / 1024} MB.`,
    );
  }

  return {
    hash: await sha256Hex(blob),
    blob,
    key: toBase64Url(rawKey),
    sidecar: {
      documentUuid: container.manifest.documentUuid,
      appName: container.manifest.appName,
      ...(container.manifest.favicon ? { favicon: container.manifest.favicon } : {}),
      manifest: container.manifest,
      ...(container.publicKey ? { publicKey: container.publicKey } : {}),
      size: blob.length,
    },
  };
}

/**
 * Opens a blob a link named.
 *
 * The hash first, always. A blob that does not hash to what the link said is
 * refused before the key is even imported: whoever holds the store could have
 * put anything under that name, and decrypting it would be running their
 * choice of bytes through our code. Only then the key, and only then is the
 * result a container — which the caller verifies exactly as it would a file.
 */
export async function openFromStore(blob: Uint8Array, hash: string, key: string): Promise<string> {
  if ((await sha256Hex(blob)) !== hash.toLowerCase()) {
    throw new ContainerError(
      "BLOB_MISMATCH",
      "What the store returned is not what this link names. The store has been changed, or the link has.",
    );
  }
  if (blob.length < 12 + 16) {
    throw new ContainerError("BLOB_MISMATCH", "What the store returned is too short to be a sealed document.");
  }

  let rawKey: Uint8Array;
  try {
    rawKey = fromBase64Url(key);
    if (rawKey.length !== 32) throw new Error("wrong length");
  } catch {
    throw new ContainerError("LINK_DAMAGED", "This link's key is damaged.");
  }

  try {
    const aes = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.subarray(0, 12) },
      aes,
      blob.subarray(12) as unknown as ArrayBuffer,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new ContainerError(
      "BLOB_UNDECRYPTABLE",
      "This link's key does not open what the store holds. The link was probably cut or edited on the way here.",
    );
  }
}

/**
 * What a store must check before it holds something.
 *
 * A store that holds anything it is handed is a file host, and this project
 * does not run one. So `put` checks that the sidecar describes a DAI document
 * whose signature verifies under the key it names, and that the ciphertext is
 * the size the sidecar says, before it writes a byte. Called by every adapter,
 * so the rule is written once.
 */
export async function admit(hash: string, ciphertext: Uint8Array, sidecar: Sidecar): Promise<void> {
  if (ciphertext.length > STORE_CAP) {
    throw new ContainerError("STORE_REFUSED", `A store holds at most ${STORE_CAP / 1024 / 1024} MB.`);
  }
  if (sidecar.size !== ciphertext.length) {
    throw new ContainerError(
      "STORE_REFUSED",
      `The sidecar says ${sidecar.size} bytes and the blob is ${ciphertext.length}.`,
    );
  }
  if ((await sha256Hex(ciphertext)) !== hash.toLowerCase()) {
    throw new ContainerError("STORE_REFUSED", "The blob does not hash to the name it is being stored under.");
  }
  const manifest = sidecar.manifest;
  if (
    !manifest ||
    typeof manifest.documentUuid !== "string" ||
    manifest.documentUuid !== sidecar.documentUuid ||
    typeof manifest.hashes !== "object"
  ) {
    throw new ContainerError("STORE_REFUSED", "The sidecar does not describe a DAI document.");
  }
  if (manifest.signature || sidecar.publicKey) {
    if (!sidecar.publicKey || !manifest.signature) {
      throw new ContainerError("STORE_REFUSED", "The sidecar carries a key without a signature, or the reverse.");
    }
    // Throws the reader's own refusal when the signature does not check out.
    await verifyManifestSignature(manifest, sidecar.publicKey);
  }
}

/** The two links for a sealed document that a store has taken. */
export function referenceLinks(
  opener: string,
  sealed: Pick<Sealed, "hash" | "key">,
  href: string,
): { known: string; anyHost: string } {
  const base = opener.replace(/[#?].*$/, "").replace(/\/$/, "");
  const { hash, key, url } = REFERENCE_KEYS;
  return {
    known: `${base}/d/${sealed.hash}#${hash}=${sealed.hash}&${key}=${sealed.key}`,
    anyHost: `${base}/#${hash}=${sealed.hash}&${url}=${encodeURIComponent(href)}&${key}=${sealed.key}`,
  };
}

/** What a reference link names, read from an address. */
export interface Reference {
  hash: string;
  key: string;
  /** Where the blob is. Absent for `/d/<id>`, which names the opener's own store. */
  url?: string;
}

/**
 * Reads a reference link out of an address's parts.
 *
 * Takes strings rather than a `location` so a native host uses the same reader
 * and a test can hand it anything.
 */
export function referenceFrom(pathname: string, search: string, hash: string): Reference | undefined {
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const h = fragment.get(REFERENCE_KEYS.hash);
  const k = fragment.get(REFERENCE_KEYS.key);
  if (!h || !k || !/^[0-9a-f]{64}$/i.test(h) || !/^[A-Za-z0-9_-]{43}$/.test(k)) return undefined;

  const u = fragment.get(REFERENCE_KEYS.url);
  if (u) {
    try {
      const url = new URL(u);
      if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
      return { hash: h.toLowerCase(), key: k, url: url.href };
    } catch {
      return undefined;
    }
  }

  // `/d/<id>`, or `?d=<id>` for a mirror with no rewrite rules. The id is the
  // hash; a link whose path disagrees with its fragment is refused as damaged
  // rather than trusted on either.
  const byPath = /\/d\/([0-9a-f]{64})\/?$/i.exec(pathname)?.[1];
  const byQuery = new URLSearchParams(search).get("d");
  const id = byPath ?? byQuery;
  if (id && id.toLowerCase() !== h.toLowerCase()) return undefined;
  return { hash: h.toLowerCase(), key: k };
}

/**
 * Seals, stores, and returns the links. The whole sender in one call.
 */
export async function publish(
  html: string,
  store: Store,
  opener: string,
): Promise<{ sealed: Sealed; href: string; links: { known: string; anyHost: string } }> {
  const sealed = await sealForStore(html);
  const href = await store.put(sealed.hash, sealed.blob, sealed.sidecar);
  return { sealed, href, links: referenceLinks(opener, sealed, href) };
}
