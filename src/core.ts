/**
 * The container compiler, with no I/O of any kind.
 *
 * Everything here operates on strings and byte arrays and depends only on
 * `fflate` and WebCrypto, so the same code compiles a container from a Vite
 * plugin, a CLI, or an in-memory bundler in a browser. Reading files, resolving
 * paths and writing output belong to the caller.
 *
 * WebCrypto rather than `node:crypto`: it exists in Node 18+ and in browsers,
 * and its ECDSA signatures are already in the IEEE P1363 form the bootloader
 * verifies. Using the Node API here would have kept the core off the web.
 */
import { zipSync, type Zippable } from "fflate";

/** Bumped when the manifest's shape changes. */
export const MANIFEST_VERSION = 1;

export const DEFAULT_APP_PREFIX = "app";
export const DEFAULT_SQLITE_ENTRY = "document.sqlite";
export const DEFAULT_WASM_ENTRY = "runtime/sqlite3.wasm";
export const DEFAULT_GLUE_ENTRY = "runtime/sqlite3.mjs";
export const CONTAINER_ENTRY = "runtime/container.html";
export const MANIFEST_ENTRY = "runtime/manifest.json";

export const DEFAULT_FAVICON =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="%230f172a"/><path d="M30 25 L70 25 L70 40 L45 40 L45 60 L70 60 L70 75 L30 75 Z" fill="%233b82f6"/><circle cx="75" cy="70" r="8" fill="%2310b981"/></svg>';

const PAYLOAD_PLACEHOLDER = "<!--DAI_PAYLOAD-->";
const RUNTIME_PLACEHOLDER = "<!--DAI_RUNTIME-->";
const APP_NAME_PLACEHOLDER = "<!--DAI_APP_NAME-->";
const FAVICON_PLACEHOLDER = "<!--DAI_FAVICON-->";
const INTEGRITY_PLACEHOLDER = "<!--DAI_INTEGRITY-->";
const PUBLIC_KEY_PLACEHOLDER = "<!--DAI_PUBLIC_KEY-->";

/**
 * Anchors the payload substitution to the payload tag itself.
 *
 * A bare replace would hit the wrong occurrence: the bootloader carries the
 * placeholder literal too (it rebuilds the container on save) and is inlined
 * above the tag, so the first match is inside the runtime's own source.
 */
const PAYLOAD_TAG_RE = /(<script[^>]*id="dai-payload"[^>]*>)<!--DAI_PAYLOAD-->/;

/**
 * WebCrypto's key type, inferred rather than named: `CryptoKey` is a DOM global
 * and this module must typecheck under Node's lib set too.
 */
type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** A WebCrypto ECDSA P-256 pair. The private half is used but never exported. */
export interface SigningKeyPair {
  privateKey: WebCryptoKey;
  publicKey: WebCryptoKey;
}

export interface ContainerManifest {
  manifestVersion: number;
  documentUuid: string;
  appName: string;
  favicon?: string;
  createdAt: string;
  algorithm: "SHA-256";
  integrityPolicy: "required" | "advisory";
  hashes: Record<string, string>;
  signatureAlgorithm?: string;
  publicKeyFingerprint?: string;
  signedEntries?: Record<string, string>;
  signature?: string;
}

export interface BuildContainerInput {
  /** Compiled application files, keyed by path relative to the app root. */
  files: Record<string, Uint8Array>;
  /** The bootloader shell template, containing the placeholder comments. */
  template: string;
  /** The bundled bootloader runtime, inlined into the shell. */
  runtime: string;
  /** Names the container and its `<title>`. */
  appName: string;
  /** Custom favicon Data URL or SVG text. Defaults to clean DAI SVG icon. */
  favicon?: string;
  /** Seed database. Absent means an empty document. */
  sqlite?: Uint8Array;
  /** SQLite engine bytes. */
  wasm?: Uint8Array;
  /** Emscripten glue source. Only meaningful alongside `wasm`. */
  glue?: Uint8Array;
  /**
   * The signing identity. Never enters the container.
   *
   * Either PKCS#8 PEM text, or a WebCrypto key pair. The pair form exists for
   * hosts that hold a key they cannot or should not serialize — a browser
   * keeping a non-extractable key in IndexedDB, or a KMS-backed handle — since
   * only the public half needs exporting.
   */
  signingKey?: string | SigningKeyPair;
  /** Reuse an existing identity instead of minting one. */
  documentUuid?: string;
  /** Whether the shell demands verification. Defaults to true. */
  verifyIntegrity?: boolean;
  /** Deflate level, 0-9. Defaults to 9. */
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  appEntryPrefix?: string;
  sqliteEntryName?: string;
  wasmEntryName?: string;
  glueEntryName?: string;
  /** Injectable clock, so callers can build reproducibly. */
  now?: () => Date;
}

export interface BuildContainerResult {
  /** The finished container document. */
  html: string;
  /** Uncompressed archive entries, as they were sealed. */
  archive: Record<string, Uint8Array>;
  /** The compressed payload, before base64. */
  zipped: Uint8Array;
  manifest: ContainerManifest;
  documentUuid: string;
  /** Present only when the container was signed. */
  publicKeyFingerprint?: string;
}

/**
 * Assembles a container from already-loaded bytes.
 *
 * Entry order matters and is not incidental: every content entry must be in the
 * archive before anything is hashed, the shell must be hashed after it is built
 * (it carries the runtime and the public key), and the manifest is written last
 * because it describes everything else and cannot describe itself.
 */
export async function buildContainer(
  input: BuildContainerInput,
): Promise<BuildContainerResult> {
  const {
    files,
    template,
    runtime,
    appName,
    sqlite = new Uint8Array(0),
    wasm,
    glue,
    signingKey,
    verifyIntegrity,
    compressionLevel = 9,
    now = () => new Date(),
  } = input;

  if (!template.includes(RUNTIME_PLACEHOLDER)) {
    throw new Error(`DAI: template has no ${RUNTIME_PLACEHOLDER} placeholder.`);
  }
  if (!PAYLOAD_TAG_RE.test(template)) {
    throw new Error(`DAI: template has no ${PAYLOAD_PLACEHOLDER} placeholder.`);
  }
  if (Object.keys(files).length === 0) {
    throw new Error("DAI: no application files were provided.");
  }

  const prefix = normalizePrefix(input.appEntryPrefix ?? DEFAULT_APP_PREFIX);
  const sqliteEntry = input.sqliteEntryName ?? DEFAULT_SQLITE_ENTRY;
  const wasmEntry = input.wasmEntryName ?? DEFAULT_WASM_ENTRY;
  const glueEntry = input.glueEntryName ?? DEFAULT_GLUE_ENTRY;

  const archive: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(files)) {
    archive[prefix + name.split("\\").join("/")] = bytes;
  }
  archive[sqliteEntry] = sqlite;
  if (wasm) archive[wasmEntry] = wasm;
  if (wasm && glue) archive[glueEntry] = glue;

  // The public key lives in the shell, never in the payload it attests to: the
  // signature covers the shell's own digest, so a key inside the signed set
  // could not be written before signing.
  const signing = signingKey ? await readSigningKey(signingKey) : undefined;

  const documentUuid = input.documentUuid ?? crypto.randomUUID();
  const hashes: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(archive)) {
    hashes[name] = await sha256Hex(bytes);
  }

  // The policy lives in the shell, never in the payload it governs.
  const integrityPolicy = verifyIntegrity === false ? "advisory" : "required";
  const favicon = input.favicon ?? DEFAULT_FAVICON;
  const shell = template
    .split(APP_NAME_PLACEHOLDER)
    .join(escapeHtml(appName))
    .split(FAVICON_PLACEHOLDER)
    .join(favicon)
    .split(INTEGRITY_PLACEHOLDER)
    .join(integrityPolicy)
    .split(PUBLIC_KEY_PLACEHOLDER)
    .join(signing ? signing.spki : "")
    .replace(RUNTIME_PLACEHOLDER, () => runtime);

  const shellBytes = new TextEncoder().encode(shell);
  archive[CONTAINER_ENTRY] = shellBytes;
  hashes[CONTAINER_ENTRY] = await sha256Hex(shellBytes);

  // Signed entries deliberately exclude the database: the application is
  // immutable but its database is not, and a container has no private key to
  // re-sign with after a save.
  const signedEntries: Record<string, string> = {};
  for (const [name, digest] of Object.entries(hashes)) {
    if (name !== sqliteEntry) signedEntries[name] = digest;
  }

  const signature = signing
    ? await sign(signing.key, canonicalPayload(documentUuid, signedEntries))
    : undefined;

  const manifest: ContainerManifest = {
    manifestVersion: MANIFEST_VERSION,
    documentUuid,
    appName,
    favicon,
    createdAt: now().toISOString(),
    algorithm: "SHA-256",
    // Informational only: the shell decides whether this is enforced.
    integrityPolicy,
    hashes,
    ...(signature
      ? {
          signatureAlgorithm: "ECDSA-P256-SHA256",
          publicKeyFingerprint: signing!.fingerprint,
          signedEntries,
          signature,
        }
      : {}),
  };

  archive[MANIFEST_ENTRY] = new TextEncoder().encode(
    JSON.stringify(manifest, null, 2) + "\n",
  );

  const zipped = zipSync(archive as Zippable, { level: compressionLevel });
  // Base64 contains no `<`, so it cannot terminate the payload script tag.
  const payload = toBase64(zipped);
  const html = shell.replace(PAYLOAD_TAG_RE, (_match, open: string) => open + payload);

  return {
    html,
    archive,
    zipped,
    manifest,
    documentUuid,
    ...(signing ? { publicKeyFingerprint: signing.fingerprint } : {}),
  };
}

interface SigningMaterial {
  key: WebCryptoKey;
  /** Base64 SPKI of the matching public key, embedded in the shell. */
  spki: string;
  fingerprint: string;
}

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/**
 * Resolves the signing identity to a usable key plus the public SPKI to embed.
 *
 * Given a pair, the private half is used as-is and never exported — so it may
 * be non-extractable. Given PEM, the private key must be imported as extractable
 * because WebCrypto cannot derive a public key from a private one: the public
 * point has to be read back out of the JWK coordinates and re-imported.
 */
async function readSigningKey(
  input: string | SigningKeyPair,
): Promise<SigningMaterial> {
  let key: WebCryptoKey;
  let publicKey: WebCryptoKey;

  if (typeof input === "string") {
    key = await crypto.subtle.importKey(
      "pkcs8",
      fromPem(input, "PRIVATE KEY"),
      ECDSA_P256,
      true,
      ["sign"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", key);
    publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      ECDSA_P256,
      true,
      ["verify"],
    );
  } else {
    key = input.privateKey;
    publicKey = input.publicKey;
  }

  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  return {
    key,
    spki: toBase64(spki),
    fingerprint: (await sha256Hex(spki)).slice(0, 16),
  };
}

/**
 * The exact bytes that get signed.
 *
 * Entry names are sorted so the string depends only on content, never on the
 * order the archive happened to be assembled in — the verifier rebuilds this
 * from the manifest and must land on identical bytes.
 */
export function canonicalPayload(
  uuid: string,
  entries: Record<string, string>,
): string {
  const sorted = Object.keys(entries)
    .sort()
    .map((name) => name + ":" + entries[name])
    .join("\n");
  return "dai-v1\n" + uuid + "\n" + sorted + "\n";
}

/** ECDSA P-256 / SHA-256. WebCrypto emits IEEE P1363, which the verifier expects. */
async function sign(key: WebCryptoKey, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(payload),
  );
  return toBase64(new Uint8Array(signature));
}

/** Lowercase hex SHA-256 of the uncompressed entry bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Strips the PEM armour and decodes the DER body. */
function fromPem(pem: string, label: string): Uint8Array {
  const body = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error(`DAI: no ${label} found in the supplied PEM.`);
  return fromBase64(body);
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reverse lookup, built once. -1 marks a character that is not base64. */
const BASE64_LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Base64-encodes bytes.
 *
 * Implemented here rather than through `btoa` so the core carries no
 * environmental assumptions at all: `btoa`/`atob` are absent from some
 * runtimes, and `btoa` additionally throws on a string built from bytes above
 * 0xFF if a caller ever hands us one.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  const limit = bytes.length - (bytes.length % 3);

  for (let i = 0; i < limit; i += 3) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64_ALPHABET[(chunk >> 18) & 63]! +
      BASE64_ALPHABET[(chunk >> 12) & 63]! +
      BASE64_ALPHABET[(chunk >> 6) & 63]! +
      BASE64_ALPHABET[chunk & 63]!;
  }

  const remaining = bytes.length - limit;
  if (remaining === 1) {
    const chunk = bytes[limit]! << 16;
    out += BASE64_ALPHABET[(chunk >> 18) & 63]! + BASE64_ALPHABET[(chunk >> 12) & 63]! + "==";
  } else if (remaining === 2) {
    const chunk = (bytes[limit]! << 16) | (bytes[limit + 1]! << 8);
    out +=
      BASE64_ALPHABET[(chunk >> 18) & 63]! +
      BASE64_ALPHABET[(chunk >> 12) & 63]! +
      BASE64_ALPHABET[(chunk >> 6) & 63]! +
      "=";
  }

  return out;
}

/** Decodes base64, ignoring whitespace and padding. */
export function fromBase64(value: string): Uint8Array {
  let bits = 0;
  let accumulator = 0;
  const out: number[] = [];

  for (let i = 0; i < value.length; i++) {
    const code = BASE64_LOOKUP[value.charCodeAt(i)]!;
    if (code < 0) continue; // whitespace, padding, or a stray character
    accumulator = (accumulator << 6) | code;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }

  return Uint8Array.from(out);
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
