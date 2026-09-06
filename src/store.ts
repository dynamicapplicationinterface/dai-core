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
import type { Preview } from "./unfurl.js";
import { fromBase64, sha256Hex, toBase64, type ContainerManifest } from "./core.js";

/** What a DAI relay will hold. A general file host this is not. */
export const STORE_CAP = 5 * 1024 * 1024;

/** The fragment keys. `h` for the hash, `k` for the key, `u` for an any-host URL. */
export const REFERENCE_KEYS = { hash: "h", key: "k", url: "u", clear: "c" } as const;

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
  /** The manifest, for the store to verify the signature over. */
  manifest: ContainerManifest;
  /** Base64 SPKI, when signed. */
  publicKey?: string;
  /** The blob's length, which `put` checks against what it was handed. */
  size: number;
  /**
   * Held in the clear, on a store whose policy allows it.
   *
   * In the sidecar as well as in the link so a store can see what it is being
   * asked to hold, and refuse it before writing rather than after.
   */
  clear?: boolean;
  /**
   * What a link preview may show, when the sender said so (§3.3).
   *
   * Separate from everything above, and absent by default, because it is the
   * only part of a sidecar written to be served to strangers: a chat client
   * fetching `/d/<id>` gets this and nothing else. The manifest beside it is
   * what the store checks a document by, and carries the application's name
   * as it always has — so "no preview" means no name in a preview, not a name
   * nobody can read. A store operator can read the manifest; that is what a
   * store is, and an organisation that cannot accept it runs its own.
   */
  preview?: Preview;
}

/** The icon a preview shows, stored beside the blob as `<hash>.png`. */
export interface PreviewIcon {
  /** PNG bytes. 512×512 is what every client wants; larger is refused. */
  png: Uint8Array;
}

export interface Store {
  /**
   * Writes a blob under its hash, and its sidecar beside it. Returns the URL
   * the blob can be read from. Idempotent: a second put of the same hash is
   * the same object.
   */
  put(hash: string, ciphertext: Uint8Array, sidecar: Sidecar, icon?: PreviewIcon): Promise<string>;
  get(href: string): Promise<Uint8Array>;
  head(href: string): Promise<{ exists: boolean; size: number }>;
}

/** A document sealed for a store: what `put` is handed, and what a link names. */
export interface Sealed {
  /** The preview icon, when one was given, for the store to write beside it. */
  icon?: PreviewIcon;
  /** SHA-256 of the blob, hex. The address and the check. */
  hash: string;
  /** IV || ciphertext || tag. What the store holds. */
  blob: Uint8Array;
  /** 32 bytes, base64url. Goes in the fragment and nowhere else. Empty when clear. */
  key: string;
  /** Stored without encryption, by a store whose policy allows it. */
  clear?: boolean;
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
export interface SealOptions {
  /**
   * What a link preview may show. Absent means none, and none is the default
   * everywhere a person is not looking at the preview as they consent to it.
   */
  preview?: boolean;
  /** A PNG for the preview, from a caller that can make one. */
  icon?: PreviewIcon;
  /**
   * Store the document without encrypting it.
   *
   * Off everywhere by default, and refused outright by a store that has not
   * been configured to allow it. It exists for one deployment: a store inside
   * a perimeter that is already access-controlled, where the operator would
   * rather hold documents they can read than hold keys they cannot lose.
   *
   * It is a real weakening and is not presented as anything else. Encrypted,
   * the store *cannot* read a document; in the clear, the store is *trusted
   * not to*, and so is every proxy, log and backup between here and it. The
   * opener says so on the card, in those words, because the person opening it
   * did not make this choice and would otherwise have no way to know it was
   * made.
   */
  clear?: boolean;
}

export async function sealForStore(html: string, options: SealOptions = {}): Promise<Sealed> {
  const container = parseContainer(html);
  const thin = new TextEncoder().encode(thinned(container));

  if (options.clear) {
    // No key, because there is nothing to unlock. The hash still names the
    // bytes, so the document is still verified on arrival exactly as any
    // other is — what is given up is confidentiality, not integrity.
    if (thin.length > STORE_CAP) {
      throw new ContainerError(
        "STORE_REFUSED",
        `This document is ${(thin.length / 1024 / 1024).toFixed(1)} MB, and a store holds at most ${STORE_CAP / 1024 / 1024} MB.`,
      );
    }
    return {
      hash: await sha256Hex(thin),
      blob: thin,
      key: "",
      clear: true,
      icon: options.icon,
      sidecar: {
        documentUuid: container.manifest.documentUuid,
        manifest: container.manifest,
        ...(container.publicKey ? { publicKey: container.publicKey } : {}),
        size: thin.length,
        clear: true,
        ...(options.preview
          ? {
              preview: {
                name: container.manifest.appName,
                ...(container.manifest.publisherName
                  ? { publisherName: container.manifest.publisherName }
                  : {}),
                ...(options.icon ? { icon: true } : {}),
              },
            }
          : {}),
      },
    };
  }

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
    icon: options.icon,
    sidecar: {
      documentUuid: container.manifest.documentUuid,
      manifest: container.manifest,
      ...(container.publicKey ? { publicKey: container.publicKey } : {}),
      size: blob.length,
      ...(options.preview
        ? {
            preview: {
              name: container.manifest.appName,
              ...(container.manifest.publisherName
                ? { publisherName: container.manifest.publisherName }
                : {}),
              ...(options.icon ? { icon: true } : {}),
            },
          }
        : {}),
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

  /*
   * No key, because the sender said there is none.
   *
   * The hash has already matched, so this is the document the link names and
   * nothing has changed on the way. What is absent is confidentiality: the
   * store could read this, and so could anything between. The opener says so
   * on the card — this function's job is only to notice.
   *
   * Reached only for a link that says `c=1`. A link that has merely lost its
   * key never arrives here; it is caught before the fetch, by
   * `strippedReference`, and told what is missing.
   */
  if (key === "") return new TextDecoder().decode(blob);

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
/** The largest PNG a store will serve as a preview icon. A caption, not an asset. */
export const ICON_CAP = 100 * 1024;

/**
 * What a store will and will not hold.
 *
 * One flag today, and it is the one that matters: whether this store accepts
 * documents that are not encrypted. Off unless an operator turns it on, and
 * off on the public relay permanently — a store that can read what it holds is
 * a different promise from the one this project makes, and the default has to
 * be the promise.
 */
export interface StorePolicy {
  /**
   * Accept documents held in the clear.
   *
   * For a store inside a perimeter that is already access-controlled, where
   * the operator would rather hold documents they can read than hold keys
   * they cannot lose. That is a legitimate trade and it is somebody's to make
   * — but it is made by whoever runs the store, once, in configuration, and
   * never by whoever happens to be uploading.
   */
  allowClear?: boolean;
}

export async function admit(
  hash: string,
  ciphertext: Uint8Array,
  sidecar: Sidecar,
  icon?: PreviewIcon,
  policy: StorePolicy = {},
): Promise<void> {
  if (sidecar.clear && !policy.allowClear) {
    throw new ContainerError(
      "STORE_REFUSED",
      "This store holds encrypted documents only. A store that accepts documents in the clear " +
        "has to be configured to, because it is choosing to be able to read them.",
    );
  }
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
  if (sidecar.preview) {
    // Checked because this is the one part a store hands to anyone who asks.
    // A name is somebody's text; a store that took an unbounded one would be
    // holding a payload rather than a caption.
    if (typeof sidecar.preview.name !== "string" || sidecar.preview.name.length > 200) {
      throw new ContainerError("STORE_REFUSED", "A preview name must be text, and under 200 characters.");
    }
    if (sidecar.preview.publisherName && sidecar.preview.publisherName.length > 200) {
      throw new ContainerError("STORE_REFUSED", "A preview publisher name must be under 200 characters.");
    }
  }
  if (icon && icon.png.length > ICON_CAP) {
    throw new ContainerError("STORE_REFUSED", `A preview icon must be under ${ICON_CAP / 1024} KB.`);
  }
  if (icon && !sidecar.preview) {
    // An icon with nothing that claims one is a file the store would serve
    // and nothing would ever reference.
    throw new ContainerError("STORE_REFUSED", "An icon without a preview is a file nothing points at.");
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
  sealed: Pick<Sealed, "hash" | "key" | "clear">,
  href: string,
): { known: string; anyHost: string } {
  const base = opener.replace(/[#?].*$/, "").replace(/\/$/, "");
  const { hash, key, url, clear } = REFERENCE_KEYS;

  /*
   * A document held in the clear carries `c=1` instead of a key.
   *
   * Said rather than implied. If the absence of a key meant "this one is not
   * encrypted", then a link that merely lost its fragment on the way would
   * become a link claiming plaintext, and the opener would go and fetch it —
   * turning a recoverable mistake into a network request and a wrong sentence.
   * So clear carriage is a statement the sender makes, and a link with neither
   * `k` nor `c` is a damaged link, which is what §3.4 says about it.
   */
  const secret = sealed.clear ? `${clear}=1` : `${key}=${sealed.key}`;
  return {
    known: `${base}/d/${sealed.hash}#${hash}=${sealed.hash}&${secret}`,
    anyHost: `${base}/#${hash}=${sealed.hash}&${url}=${encodeURIComponent(href)}&${secret}`,
  };
}

/** What a reference link names, read from an address. */
export interface Reference {
  hash: string;
  /** Empty when the document is held in the clear. */
  key: string;
  /** The sender said this one is not encrypted. The card says so too. */
  clear?: boolean;
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
  // Clear carriage is stated, never inferred from a missing key: see
  // `referenceLinks`. A link may say one or the other and never both.
  const clear = fragment.get(REFERENCE_KEYS.clear) === "1";
  if (!h || !/^[0-9a-f]{64}$/i.test(h)) return undefined;
  if (clear && k) return undefined;
  if (!clear && (!k || !/^[A-Za-z0-9_-]{43}$/.test(k))) return undefined;

  const u = fragment.get(REFERENCE_KEYS.url);
  if (u) {
    try {
      const url = new URL(u);
      if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
      return { hash: h.toLowerCase(), key: k ?? "", ...(clear ? { clear } : {}), url: url.href };
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
  return { hash: h.toLowerCase(), key: k ?? "", ...(clear ? { clear } : {}) };
}

/**
 * What a link is missing, when it names a document but cannot open one.
 *
 * A reference link is a path and a fragment, and only the path survives being
 * copied by hand, retyped from a screenshot, shortened by a link wrapper, or
 * pasted out of a tool that strips fragments. The result is a URL that names a
 * real document and cannot open it — and the failure mode nobody should ever
 * see is the blank chooser, which looks exactly like a broken app.
 *
 * `undefined` here means the URL was never a reference link at all. A value
 * means it was one, and says which half is gone, so the opener can say a
 * sentence somebody can act on instead of nothing.
 */
export type StrippedReference =
  /** A document is named, and the key that opens it is not here. */
  | { named: string; missing: "key" }
  /** A key is here, and nothing says which document it opens. */
  | { named?: undefined; missing: "document" };

export function strippedReference(
  pathname: string,
  search: string,
  hash: string,
): StrippedReference | undefined {
  // A whole link is not a stripped one.
  if (referenceFrom(pathname, search, hash)) return undefined;

  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const h = fragment.get(REFERENCE_KEYS.hash);
  const k = fragment.get(REFERENCE_KEYS.key);
  const id =
    /\/d\/([0-9a-f]{64})\/?$/i.exec(pathname)?.[1] ?? new URLSearchParams(search).get("d") ?? undefined;

  // A link that says it is clear is not a link that lost its key. It is
  // refused above for other reasons if at all, and never described as damaged.
  if (fragment.get(REFERENCE_KEYS.clear) === "1") return undefined;

  const named = (id ?? h ?? undefined)?.toLowerCase();
  if (named && /^[0-9a-f]{64}$/.test(named) && !k) return { named, missing: "key" };
  if (k && !named) return { missing: "document" };
  return undefined;
}

/**
 * Seals, stores, and returns the links. The whole sender in one call.
 */
export async function publish(
  html: string,
  store: Store,
  opener: string,
  options: SealOptions = {},
): Promise<{ sealed: Sealed; href: string; links: { known: string; anyHost: string } }> {
  const sealed = await sealForStore(html, options);
  const href = await store.put(sealed.hash, sealed.blob, sealed.sidecar, sealed.icon);
  return { sealed, href, links: referenceLinks(opener, sealed, href) };
}
