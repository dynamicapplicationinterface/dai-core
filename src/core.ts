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
import { encode as cborEncode, type CborValue } from "./cbor.js";
import { KIT_ENTRY, KIT_SOURCE } from "./kit.js";
import { declareSchema, injectSchema, SCHEMA_FILE } from "./schema.js";
import { buildSign1 } from "./cose.js";
import { writeContainerFile } from "./format.js";

/** Bumped when the manifest's shape changes. */
/**
 * Bumped to 2 when the signature became a COSE_Sign1 envelope over CBOR.
 *
 * It should have been bumped in that commit and was not, which is how a
 * container built by one deployment came to be refused by another with
 * "Unsupported signature algorithm" — an accurate sentence that tells the
 * person holding the file nothing they can act on. This field exists precisely
 * so a reader can say "older format" instead of guessing from a value it does
 * not recognise.
 */
export const MANIFEST_VERSION = 2;

export const DEFAULT_APP_PREFIX = "app";
export const DEFAULT_SQLITE_ENTRY = "document.sqlite";
export const DEFAULT_WASM_ENTRY = "runtime/sqlite3.wasm";
export const DEFAULT_GLUE_ENTRY = "runtime/sqlite3.mjs";
export const CONTAINER_ENTRY = "runtime/container.html";
/** The application's declared schema and migration chain, when it declares one. */
export const SCHEMA_ENTRY = "runtime/schema.json";
export const MANIFEST_ENTRY = "runtime/manifest.json";

export const DEFAULT_FAVICON =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 rx=%2220%22 fill=%22%230f172a%22/%3E%3Cpath d=%22M30 25 L70 25 L70 40 L45 40 L45 60 L70 60 L70 75 L30 75 Z%22 fill=%22%233b82f6%22/%3E%3Ccircle cx=%2275%22 cy=%2270%22 r=%228%22 fill=%22%2310b981%22/%3E%3C/svg%3E';

/**
 * The timestamp every zip entry carries, so a payload is the same bytes twice.
 *
 * A zip records a modification time per entry, and fflate writes the clock
 * when it is not told otherwise — so two builds of identical inputs differed,
 * a few bytes apart, for no reason anybody could see. That made "an unsigned
 * container built twice from identical inputs is byte-identical" untrue, and
 * it would have made a re-fattened thin container merely equivalent to the
 * build it came from rather than the same file.
 *
 * Built from local components rather than an instant, because the format
 * stores local year, month, day, hour, minute and second: any fixed instant
 * reads back differently in a different timezone, and these read back as
 * themselves everywhere. Noon on the second day is clear of every daylight
 * transition, and of the 1980 floor the format imposes.
 */
export const ZIP_EPOCH = new Date(1980, 0, 2, 12, 0, 0);

/**
 * The entries a container may be built without, for a host to supply.
 *
 * The engine and its glue, and nothing else. They are the largest thing in a
 * container by an order of magnitude, they are identical across every
 * container built from the same compiler, and §6.1 already permits a host to
 * use its own copy of a runtime entry whose digest it holds. Everything else
 * is what makes this document this document.
 *
 * By name, deliberately. A build that renames its engine cannot be thin,
 * because a reader has to be able to tell a container published without its
 * engine from one somebody stripped an entry out of, and the names are all it
 * has to go on. The names are the compiler's defaults.
 */
export const SUBSTITUTABLE_ENTRIES = [DEFAULT_WASM_ENTRY, DEFAULT_GLUE_ENTRY] as const;


const PAYLOAD_PLACEHOLDER = "<!--DAI_PAYLOAD-->";
const RUNTIME_PLACEHOLDER = "<!--DAI_RUNTIME-->";
const APP_NAME_PLACEHOLDER = "<!--DAI_APP_NAME-->";
const FAVICON_PLACEHOLDER = "<!--DAI_FAVICON-->";
const INTEGRITY_PLACEHOLDER = "<!--DAI_INTEGRITY-->";
const PUBLIC_KEY_PLACEHOLDER = "<!--DAI_PUBLIC_KEY-->";
const NONCE_PLACEHOLDER = "<!--DAI_NONCE-->";

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

export interface Generator {
  tool: string;
  model?: string;
  provider?: string;
}

export interface ContainerManifest {
  manifestVersion: number;
  documentUuid: string;
  appName: string;
  favicon?: string;
  /**
   * Who signs it, by the name they sign under. Covered by the signature, so a
   * name cannot be changed without the key that chose it; not verified against
   * anything in the world, which is why a host shows it in states rather than
   * as fact. Absent when the publisher gave none.
   */
  publisherName?: string;
  /**
   * The document this one replaces, by UUID. Covered by the signature, and
   * honoured by a host only when this document is signed by the same key the
   * host pinned for that one — otherwise anybody could claim to be the next
   * version of anything and walk off with its data. Absent for a document that
   * replaces nothing.
   */
  supersedes?: string;
  /**
   * What produced the application: a tool, and the model and provider when
   * one wrote it. Asserted and never verified, and never the prompt. In the
   * signed set from version 3.
   */
  generator?: Generator;
  createdAt: string;
  algorithm: "SHA-256";
  integrityPolicy: "required" | "advisory";
  hashes: Record<string, string>;
  signatureAlgorithm?: string;
  publicKeyFingerprint?: string;
  signedEntries?: Record<string, string>;
  signature?: string;
  /**
   * Unix seconds after which this container should not be run. Optional, and
   * omitted by default: a cartridge with no expiry works forever, which is the
   * behaviour the format promises for an archived document.
   *
   * Covered by the signature, so it cannot be extended, shortened or deleted
   * without invalidating it. An unsigned container's expiry is editable and
   * therefore advisory only.
   */
  validUntil?: number;
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
  /** The name the publisher signs under. Goes into the signed set when given. */
  publisherName?: string;
  /** The document this build replaces (4.1). Goes into the signed set when given. */
  supersedes?: string;
  /** What produced the application. In the signed set from version 3. */
  generator?: Generator;
  /**
   * Which manifest version to write. Version 3 (spec §9) leaves the shell out
   * of the signed set and makes `signedEntries` the authority. The default is
   * the version every deployed reader accepts; it moves once they all do.
   */
  manifestVersion?: 2 | 3;
  /**
   * Leave the engine out, for a host that already has it (§6.2).
   *
   * The manifest still covers it: every digest is there and the signature is
   * the same one the complete build carries, so the two forms are one build.
   * Only the bytes are absent, and only a host holding those exact bytes can
   * put them back.
   */
  thin?: boolean;
  /** Seed database. Absent means an empty document. */
  sqlite?: Uint8Array;
  /**
   * The schema this application expects, and the migrations it carries.
   *
   * Sealed at `runtime/schema.json`, outside the application's own namespace
   * and inside the signed set, so a container's account of its own data shape
   * cannot be edited any more than its code can.
   */
  schema?: unknown;
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
  /**
   * Unix seconds after which hosts should refuse to run the container.
   *
   * Omit for a perpetual document, which is the default and the right choice
   * for anything meant to be readable years from now. An expiry cannot be
   * renewed without the signing key, so a container that outlives its publisher
   * outlives its usefulness.
   */
  validUntil?: number;
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
  /** Entries the manifest covers whose bytes were not packaged (§6.2). */
  elided?: string[];
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
/** The names an application may give its own icon. */
const ICON_ENTRIES = ["icon.svg", "favicon.svg"];

/**
 * An icon the application brought with it.
 *
 * A document's icon is what stands for it on a home screen and in a tab, and
 * every document was getting this project's mark — which is fine for a file
 * about this project and wrong for somebody's packing list. An assistant can
 * draw a simple SVG as easily as it writes the rest, so the recipe asks for
 * one, and if it is here it is used.
 *
 * SVG only. It is text, so it travels in the bundle an assistant writes; it
 * scales to every size a home screen wants; and anything that is not an SVG
 * is ignored rather than trusted, because this string ends up in the shell.
 */
function iconAmong(files: Record<string, Uint8Array>): string | undefined {
  for (const name of ICON_ENTRIES) {
    const bytes = files[name];
    if (!bytes) continue;
    const text = new TextDecoder().decode(bytes).trim();
    if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) continue;
    return "data:image/svg+xml," + encodeURIComponent(text);
  }
  return undefined;
}

/** The nonce a document's shell carries: derived from its identity, so builds reproduce. */
export async function nonceFor(documentUuid: string): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode("dai-nonce:" + documentUuid))).slice(0, 32);
}

export interface ShellInput {
  template: string;
  runtime: string;
  appName: string;
  favicon: string;
  integrityPolicy: "required" | "advisory";
  /** Base64 SPKI, or empty for an unsigned document. */
  publicKey: string;
  nonce: string;
}

/**
 * Fills the shell template: the document the bootloader runs in.
 *
 * One function, because two things build a shell. The compiler builds the
 * one sealed into a container. A host builds its own around an archive it has
 * just verified, so that the bootloader it executes is the host's and never
 * the publisher's — a publisher's shell runs with the host's origin, and a
 * hostile one would reach the host's storage and keys. The payload is left as
 * the placeholder; whoever assembles the shell splices the archive in.
 */
export function assembleShell(input: ShellInput): string {
  return input.template
    .split(NONCE_PLACEHOLDER)
    .join(input.nonce)
    .split(APP_NAME_PLACEHOLDER)
    .join(escapeHtml(input.appName))
    .split(FAVICON_PLACEHOLDER)
    // Attribute-escaped: a raw SVG data URI carries double quotes, which would
    // terminate the href early. The markup after it then parses as elements,
    // and an element in <head> closes it — putting the CSP meta in <body>,
    // where it is ignored entirely and the air gap silently disappears.
    .join(escapeHtml(input.favicon))
    .split(INTEGRITY_PLACEHOLDER)
    .join(input.integrityPolicy)
    .split(PUBLIC_KEY_PLACEHOLDER)
    .join(input.publicKey)
    .replace(RUNTIME_PLACEHOLDER, () => input.runtime);
}

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

  /*
   * The kit rides in every container, whichever door it was built through.
   *
   * It lived in the command-line door for a while, and the browser door — the
   * one the website uses — did not have it. Every file made on the make-one
   * page referenced ./dai-kit.js and got nothing: the page drew, no query ran,
   * no button did anything. The command line, and every test, was fine.
   *
   * An application references it or does not; either way it is there. Four
   * kilobytes against a container that carries a database engine, and it is
   * what lets an application be HTML and SQL rather than a state machine.
   * Never overwrites one the author supplied: somebody with their own
   * dai-kit.js has decided something, and replacing it would be overruling
   * them silently.
   */
  if (!files[KIT_ENTRY]) {
    files[KIT_ENTRY] = new TextEncoder().encode(KIT_SOURCE);
  }

  /*
   * The schema, declared from the files whichever door they came through.
   *
   * A door that already worked out the declaration — the command line, which
   * knows the container being upgraded — passes it in. Any other door gets it
   * here, from schema.sql and migrations/ in the files themselves, so the gate
   * against a version two destroying a version one runs for everything, not
   * only for people who use a terminal.
   */
  const schema = input.schema !== undefined ? input.schema : await declareSchema(files, undefined);

  // And the declared statements go into the page, so they run first and are
  // written once. See injectSchema.
  if (files[SCHEMA_FILE] && files["index.html"]) {
    const decoder = new TextDecoder();
    files["index.html"] = new TextEncoder().encode(
      injectSchema(decoder.decode(files["index.html"]), decoder.decode(files[SCHEMA_FILE])),
    );
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
  if (schema !== undefined) {
    archive[SCHEMA_ENTRY] = new TextEncoder().encode(JSON.stringify(schema, null, 2));
  }
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
  const favicon = input.favicon ?? iconAmong(files) ?? DEFAULT_FAVICON;
  /*
   * The nonce that replaces `'unsafe-inline'` in the shell's script policy.
   *
   * Derived from the document identity rather than drawn at random, because a
   * container is a static file: there is no response to vary, so the value is
   * fixed at compile time and legible to anyone who opens it. Deriving it keeps
   * builds reproducible, and costs nothing — an attacker reads it either way.
   *
   * Its unguessability is not what does the work. A nonce never authorises an
   * inline event handler or a `javascript:` URL, whatever its value, and those
   * are the sinks that content stored in the database can reach: a task title
   * rendered into the DOM can carry `onerror=`, and until now the policy
   * permitted it. Scripts the compiler sealed are stamped and still run;
   * anything introduced afterwards is not and does not.
   */
  const nonce = await nonceFor(documentUuid);

  const shell = assembleShell({
    template,
    runtime,
    appName,
    favicon,
    integrityPolicy,
    publicKey: signing ? signing.spki : "",
    nonce,
  });

  const shellBytes = new TextEncoder().encode(shell);
  archive[CONTAINER_ENTRY] = shellBytes;
  hashes[CONTAINER_ENTRY] = await sha256Hex(shellBytes);

  // Signed entries deliberately exclude the database: the application is
  // immutable but its database is not, and a container has no private key to
  // re-sign with after a save.
  const version = input.manifestVersion ?? MANIFEST_VERSION;
  // Version 3 (spec §9.2): the shell is an unsigned, self-attesting part and
  // leaves the signed set, so a host with its own shell verifies a signature
  // without reproducing the publisher's, and a template can change without
  // every signature it ever made becoming uncheckable.
  const signedEntries: Record<string, string> = {};
  for (const [name, digest] of Object.entries(hashes)) {
    if (name === sqliteEntry) continue;
    if (version >= 3 && name === CONTAINER_ENTRY) continue;
    signedEntries[name] = digest;
  }

  const validUntil = input.validUntil;
  const createdAt = now().toISOString();

  // Built before the manifest, because the manifest carries the signature and
  // cannot therefore be an input to it. Every field here ends up in the
  // manifest unchanged, and a verifier rebuilds this same view from it.
  const publisherName = input.publisherName?.trim() || undefined;
  const supersedes = input.supersedes?.trim() || undefined;
  const generator = version >= 3 && input.generator?.tool ? input.generator : undefined;
  if (supersedes === documentUuid) {
    throw new Error("DAI: a document cannot supersede itself.");
  }
  const signedView: SignedView = {
    manifestVersion: version,
    documentUuid,
    appName,
    favicon,
    publisherName,
    supersedes,
    generator,
    createdAt,
    algorithm: "SHA-256",
    integrityPolicy,
    signatureAlgorithm: signing ? "COSE-ES256" : "",
    publicKeyFingerprint: signing ? signing.fingerprint : "",
    validUntil,
    entries: signedEntries,
  };

  const signature = signing
    ? await sign(signing.key, signedView, signing.fingerprint)
    : undefined;

  const manifest: ContainerManifest = {
    manifestVersion: version,
    documentUuid,
    appName,
    favicon,
    ...(publisherName ? { publisherName } : {}),
    ...(supersedes ? { supersedes } : {}),
    ...(generator ? { generator } : {}),
    createdAt,
    algorithm: "SHA-256",
    // Informational only: the shell decides whether this is enforced.
    integrityPolicy,
    hashes,
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(signature
      ? {
          signatureAlgorithm: "COSE-ES256",
          publicKeyFingerprint: signing!.fingerprint,
          signedEntries,
          signature,
        }
      : {}),
  };

  archive[MANIFEST_ENTRY] = new TextEncoder().encode(
    JSON.stringify(manifest, null, 2) + "\n",
  );

  /*
   * Elided after the digests, never before.
   *
   * `hashes` and `signedEntries` are taken over the whole document, so a thin
   * container makes exactly the same claims as the complete one and carries
   * exactly the same signature. What changes is which bytes travel.
   */
  const elided = input.thin
    ? SUBSTITUTABLE_ENTRIES.filter((name) => name in archive)
    : [];
  const packaged: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(archive)) {
    if (!elided.includes(name as (typeof SUBSTITUTABLE_ENTRIES)[number])) packaged[name] = bytes;
  }

  const zipped = zipSync(packaged as Zippable, { level: compressionLevel, mtime: ZIP_EPOCH });
  // Base64 contains no `<`, so it cannot terminate the payload script tag.
  const payload = toBase64(zipped);
  const html = shell.replace(PAYLOAD_TAG_RE, (_match, open: string) => open + payload);

  return {
    html,
    // Complete, whatever travelled: this is what the document is made of, and
    // a caller re-fattening a thin build needs the bytes that were left out.
    archive,
    elided,
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
      bufferOf(fromPem(input, "PRIVATE KEY")),
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
export interface SignedView {
  manifestVersion: number;
  documentUuid: string;
  appName: string;
  favicon: string;
  /** Present only when the publisher signs under a name. */
  publisherName?: string;
  /** Present only when this document replaces another. */
  supersedes?: string;
  /** Present only when set; version 3. */
  generator?: Generator;
  createdAt: string;
  algorithm: string;
  integrityPolicy: string;
  signatureAlgorithm: string;
  publicKeyFingerprint: string;
  validUntil?: number;
  /** Entry digests, excluding the database. */
  entries: Record<string, string>;
}

/**
 * Everything the signature covers, in one place.
 *
 * The compiler and both verifiers derive the signed bytes from here, so what is
 * protected is decided once rather than agreed three times.
 *
 * The previous version covered the identity, the entry digests and the expiry,
 * and nothing else — which left every descriptive field editable under a
 * signature that still verified. A container could be renamed "Payroll Portal",
 * given a bank's icon and handed on, and the only claim it made about itself
 * that an attacker could not touch was a UUID nobody reads.
 *
 * `savedAt` is deliberately outside. It changes on every save, and a container
 * carries no private key to re-sign with afterwards; signing it would make the
 * first save invalidate the signature.
 */
export function canonicalPayload(view: SignedView): string {
  // Values are JSON-encoded rather than concatenated raw. An application named
  // `a\nfavicon:evil` would otherwise serialize to bytes indistinguishable from
  // a different manifest, which is the classic way a canonical form stops being
  // canonical.
  const line = (key: string, value: string | number): string =>
    key + ":" + JSON.stringify(value) + "\n";

  // A fixed order, not a sorted one: the field set is part of the format and is
  // meant to be read from the specification rather than inferred from an
  // implementation's key ordering.
  let payload =
    "dai-v2\n" +
    line("manifestVersion", view.manifestVersion) +
    line("documentUuid", view.documentUuid) +
    line("appName", view.appName) +
    line("favicon", view.favicon) +
    line("createdAt", view.createdAt) +
    line("algorithm", view.algorithm) +
    line("integrityPolicy", view.integrityPolicy) +
    line("signatureAlgorithm", view.signatureAlgorithm) +
    line("publicKeyFingerprint", view.publicKeyFingerprint);

  // Present only when set, so a perpetual container does not carry a field
  // describing an expiry it does not have.
  if (view.validUntil !== undefined) payload += line("validUntil", view.validUntil);

  payload += "entries\n";
  for (const name of Object.keys(view.entries).sort()) {
    payload += line(name, view.entries[name] as string);
  }
  return payload;
}

/**
 * The same container, in the sectioned binary form.
 *
 * Built from a finished result rather than by a second compile, so both forms
 * describe the identical application and carry the identical signature.
 *
 * The manifest written here drops the database's digest. That is not a loss:
 * `signedEntries` never included it, because a container holds no key to
 * re-sign with after a save, so the digest in `hashes` was only ever a
 * consistency note that whoever saved last was free to set. In this form the
 * footer records it instead, and the footer is rewritten by the same act that
 * changes the database — which is what allows a save to leave the manifest,
 * and therefore the signature, untouched.
 */
export async function toSectionedContainer(
  built: BuildContainerResult,
  options: { sqliteEntryName?: string } = {},
): Promise<Uint8Array> {
  const sqliteEntry = options.sqliteEntryName ?? DEFAULT_SQLITE_ENTRY;

  const hashes: Record<string, string> = {};
  for (const [name, digest] of Object.entries(built.manifest.hashes)) {
    if (name !== sqliteEntry) hashes[name] = digest;
  }

  const payload: Zippable = {};
  for (const [name, bytes] of Object.entries(built.archive)) {
    if (name === MANIFEST_ENTRY || name === sqliteEntry) continue;
    if (built.elided?.includes(name)) continue;
    payload[name] = bytes;
  }

  return writeContainerFile({
    manifest: new TextEncoder().encode(
      JSON.stringify({ ...built.manifest, hashes }, null, 2) + "\n",
    ),
    payload: zipSync(payload, { level: 9, mtime: ZIP_EPOCH }),
    data: built.archive[sqliteEntry] ?? new Uint8Array(0),
  });
}

/**
 * The signed view of a manifest that already exists.
 *
 * Verifiers reconstruct the signed bytes through this rather than assembling
 * them by hand, so a field added to the signed set reaches every verifier at
 * once instead of only the one that was remembered.
 */
export function signedViewOf(manifest: {
  manifestVersion: number;
  documentUuid: string;
  appName: string;
  favicon?: string;
  publisherName?: string;
  supersedes?: string;
  generator?: Generator;
  createdAt: string;
  algorithm: string;
  integrityPolicy: string;
  signatureAlgorithm?: string;
  publicKeyFingerprint?: string;
  validUntil?: number;
  signedEntries?: Record<string, string>;
}): SignedView {
  return {
    manifestVersion: manifest.manifestVersion,
    documentUuid: manifest.documentUuid,
    appName: manifest.appName,
    favicon: manifest.favicon ?? "",
    publisherName: manifest.publisherName,
    supersedes: manifest.supersedes,
    generator: manifest.generator,
    createdAt: manifest.createdAt,
    algorithm: manifest.algorithm,
    integrityPolicy: manifest.integrityPolicy,
    signatureAlgorithm: manifest.signatureAlgorithm ?? "",
    publicKeyFingerprint: manifest.publicKeyFingerprint ?? "",
    validUntil: manifest.validUntil,
    entries: manifest.signedEntries ?? {},
  };
}

/**
 * The signed bytes: the same named view, encoded as a deterministic CBOR map.
 *
 * A map rather than the concatenated lines it replaces. The lines needed their
 * values JSON-encoded to stop one field's content impersonating another, which
 * is a rule CBOR gets for free — every string carries its own length, so there
 * is no delimiter to smuggle.
 */
export function signedBytes(view: SignedView): Uint8Array {
  const fields = new Map<CborValue, CborValue>([
    ["manifestVersion", view.manifestVersion],
    ["documentUuid", view.documentUuid],
    ["appName", view.appName],
    ["favicon", view.favicon],
    ["createdAt", view.createdAt],
    ["algorithm", view.algorithm],
    ["integrityPolicy", view.integrityPolicy],
    ["signatureAlgorithm", view.signatureAlgorithm],
    ["publicKeyFingerprint", view.publicKeyFingerprint],
    ["entries", new Map<CborValue, CborValue>(Object.entries(view.entries))],
  ]);

  // Absent rather than null, so a perpetual document does not describe an
  // expiry it does not have.
  if (view.validUntil !== undefined) fields.set("validUntil", view.validUntil);
  // Likewise the publisher's name: present only when one was signed under, so
  // every container signed before names existed still verifies unchanged.
  if (view.publisherName) fields.set("publisherName", view.publisherName);
  if (view.supersedes) fields.set("supersedes", view.supersedes);
  if (view.generator?.tool) {
    const generator = new Map<CborValue, CborValue>([["tool", view.generator.tool]]);
    if (view.generator.model) generator.set("model", view.generator.model);
    if (view.generator.provider) generator.set("provider", view.generator.provider);
    fields.set("generator", generator);
  }

  return cborEncode(fields);
}

/**
 * ECDSA P-256 / SHA-256 inside a COSE_Sign1 envelope.
 *
 * WebCrypto emits IEEE P1363, which is exactly what COSE specifies for ES256 —
 * no re-encoding, which is one fewer place to be subtly wrong.
 *
 * The payload is detached. A verifier rebuilds it from the manifest it is
 * already holding, so carrying a second copy inside the envelope would mean two
 * versions that can disagree — and the one inside the signature would win
 * without anybody noticing.
 */
async function sign(key: WebCryptoKey, view: SignedView, kid: string): Promise<string> {
  const envelope = await buildSign1(
    signedBytes(view),
    async (bytes) =>
      new Uint8Array(
        // Cast because a Uint8Array over ArrayBufferLike is not assignable to
        // BufferSource under the DOM lib set, SharedArrayBuffer being in that
        // union. The bytes are an ordinary ArrayBuffer; the type is wider than
        // the value. Same treatment as the verifiers.
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          bytes as unknown as ArrayBuffer,
        ),
      ),
    { kid, detached: true },
  );
  return toBase64(envelope);
}

/**
 * A single value standing for everything a container carries.
 *
 * Derived from the entry digests a party actually verified, so two parties can
 * compare one string instead of a table. Different payloads produce different
 * values, because a different payload verifies against a different manifest.
 *
 * It is a comparison between two verifiers, not evidence on its own: a party
 * that computes it from bytes it never checked is only restating them.
 */
export async function payloadFingerprint(
  documentUuid: string,
  hashes: Record<string, string>,
): Promise<string> {
  // Its own canonical form rather than the signature's. The two answer
  // different questions — "are two parties holding the same payload" against
  // "did the publisher attest to this" — and sharing a string would have meant
  // every change to what is signed silently changing every fingerprint.
  const sorted = Object.keys(hashes)
    .sort()
    .map((name) => `${name}:${hashes[name]}`)
    .join("\n");
  return sha256Hex(new TextEncoder().encode(`dai-fingerprint-v1\n${documentUuid}\n${sorted}`));
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

/**
 * Copies bytes into a fresh ArrayBuffer for WebCrypto.
 *
 * A Uint8Array may be backed by a SharedArrayBuffer, which the crypto calls do
 * not accept — and under the runtime's DOM types that is a compile error rather
 * than a runtime surprise. Copying is cheap at these sizes and removes the
 * question.
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
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
