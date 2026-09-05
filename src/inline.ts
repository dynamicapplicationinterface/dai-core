/**
 * The compact inline carrier: a document in a link, small enough to send.
 *
 * The first inline link carried the whole file — gzip of the viewer form — and
 * a real application came to 115 KB, against the 32 KB that survives a chat
 * client. The application itself was about 9 kB. The rest was the runtime: the
 * shell the bootloader runs in, the kit, and the engine, none of which the
 * opener needs sent because it already holds every one of them.
 *
 * So this carrier sends what is the document's and rebuilds what is the
 * host's, and proves the rebuilt bytes are the sealed ones before running
 * anything. The rule is the one §6.1 already has — exact digest, never name —
 * applied to more entries:
 *
 *  - the sealed shell, rebuilt from the host's own template and bootloader
 *    with the document's name, icon, key, policy and nonce, then hashed and
 *    compared with the signed digest. A publisher who built with a different
 *    compiler produces a shell the host cannot rebuild; the sender notices
 *    that when packing and carries the bytes instead.
 *  - the kit, whose source the host has;
 *  - the engine, which the host holds (§6.2).
 *
 * Everything else travels: the application's files, its schema declaration,
 * and its database when it has one. Nothing about the manifest travels except
 * what cannot be recomputed — the identity, the descriptive fields the
 * signature covers, the signature itself, and the digests of the entries that
 * were left out. Carried entries' digests are recomputed on arrival and the
 * manifest rebuilt, so a link cannot describe bytes other than the ones in it.
 *
 * Then one DEFLATE stream over the lot, against a preset dictionary of what
 * small applications tend to share (see build-dictionary.mjs). The fragment is
 *
 *     #a= base64url( version:1 byte | dictionary id:4 bytes | deflate )
 *
 * and an opener that does not hold that dictionary refuses the link by name
 * rather than inflating garbage.
 *
 * What comes out the other end is an ordinary container — the same bytes the
 * complete build produced, when the sender's and receiver's hosts agree — and
 * it is verified by the ordinary path. This module builds files; it does not
 * decide whether they may run.
 */
import { deflateSync, inflateSync, zipSync } from "fflate";
import { decode, encode, type CborValue } from "./cbor.js";
import { applicationFiles, ContainerError, type ParsedContainer, type Supplier } from "./container.js";
import { parseSign1, protectedHeader } from "./cose.js";
import {
  assembleShell,
  CONTAINER_ENTRY,
  DEFAULT_APP_PREFIX,
  DEFAULT_SQLITE_ENTRY,
  fromBase64,
  MANIFEST_ENTRY,
  nonceFor,
  sha256Hex,
  SUBSTITUTABLE_ENTRIES,
  toBase64,
  wantsTrustedTypes,
  ZIP_EPOCH,
  type ContainerManifest,
} from "./core.js";
import { DICTIONARY, DICTIONARY_ID } from "./dictionary.js";
import { KIT_ENTRY, KIT_SOURCE } from "./kit.js";
import { compressPublicKey, decompressPublicKey } from "./p256.js";

export const CARRIER_VERSION = 1;

/** The kit's entry name inside a container. */
const KIT_PATH = `${DEFAULT_APP_PREFIX}/${KIT_ENTRY}`;

/** What the opener has and therefore need not be sent. */
const HOST_OWNED: readonly string[] = [CONTAINER_ENTRY, KIT_PATH, ...SUBSTITUTABLE_ENTRIES];

const PAYLOAD_TAG_RE = /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/;

/** The host's side of the shell: what it runs documents in. */
export interface Host {
  template: string;
  runtime: string;
}

/* CBOR map labels. Integers, because every byte of a link is paid for. */
const L = {
  uuid: 1,
  appName: 2,
  favicon: 3,
  createdAt: 4,
  required: 5,
  validUntil: 6,
  key: 7,
  signature: 8,
  entries: 9,
  publisherName: 10,
  supersedes: 11,
  /** Absent means 2. Version 3 leaves the shell out of the signed set (§9.2). */
  version: 12,
  /** `[tool, model?, provider?]`, empty strings for absent. Version 3. */
  generator: 13,
} as const;

const CARRIED = 0;
const ELIDED = 1;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function uuidToBytes(uuid: string): Uint8Array {
  return hexToBytes(uuid.replace(/-/g, ""));
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  return fromBase64(value.replace(/-/g, "+").replace(/_/g, "/"));
}

/**
 * The shell this document's compiler sealed, rebuilt from a host's parts.
 *
 * Whether the result is the sealed one is for the caller to decide by digest.
 * The same function serves the sender, asking "can the receiver rebuild this",
 * and the receiver, rebuilding it — one implementation, so they agree.
 */
async function rebuildShell(
  host: Host,
  fields: {
    appName: string;
    favicon: string;
    required: boolean;
    publicKey: string;
    uuid: string;
    /** The application's files, so Trusted Types is decided as the compiler decided it. */
    files: Record<string, Uint8Array>;
  },
): Promise<Uint8Array> {
  return new TextEncoder().encode(
    assembleShell({
      template: host.template,
      runtime: host.runtime,
      appName: fields.appName,
      favicon: fields.favicon,
      integrityPolicy: fields.required ? "required" : "advisory",
      publicKey: fields.publicKey,
      nonce: await nonceFor(fields.uuid),
      trustedTypes: wantsTrustedTypes(fields.files),
    }),
  );
}

/**
 * Packs a verified container into the fragment value.
 *
 * Takes a parsed container rather than a file so the caller has already
 * decided the document is what it claims; this only decides what to send. An
 * entry the host owns is elided when this host can rebuild it to the sealed
 * digest, and carried otherwise — so a link is never built that the same
 * software could not open.
 */
export async function packInline(container: ParsedContainer, host: Host): Promise<string> {
  const manifest = container.manifest;
  const favicon = manifest.favicon ?? "";
  const required = container.integrityPolicy !== "advisory";
  const publicKey = container.publicKey ?? "";

  const rebuilt = bytesToHex(
    hexToBytes(
      await sha256Hex(
        await rebuildShell(host, {
          appName: manifest.appName,
          favicon,
          required,
          publicKey,
          uuid: manifest.documentUuid,
          files: applicationFiles(container.archive),
        }),
      ),
    ),
  );
  const kitDigest = await sha256Hex(new TextEncoder().encode(KIT_SOURCE));

  const entries: CborValue[] = [];
  for (const [name, digest] of Object.entries(manifest.hashes)) {
    if (name === MANIFEST_ENTRY) continue;
    const bytes = container.archive[name];

    const reconstructable =
      (name === CONTAINER_ENTRY && digest === rebuilt) ||
      (name === KIT_PATH && digest === kitDigest) ||
      (SUBSTITUTABLE_ENTRIES as readonly string[]).includes(name);

    if (reconstructable) {
      entries.push([name, ELIDED, hexToBytes(digest)]);
      continue;
    }
    if (!bytes) {
      // Listed, absent, and not something a host puts back: this container is
      // damaged, and a link must not be built from it.
      throw new ContainerError("DIGEST_MISMATCH", `${name} is listed in the manifest and absent.`);
    }
    // An empty database still travels, as zero bytes. Leaving it out would
    // save eighteen bytes and lose its place in the archive, and its place is
    // what makes the unpacked file the same file the build produced.
    entries.push([name, CARRIED, bytes]);
  }

  const fields = new Map<CborValue, CborValue>([
    [L.uuid, uuidToBytes(manifest.documentUuid)],
    [L.appName, manifest.appName],
    [L.favicon, favicon],
    [L.createdAt, manifest.createdAt],
    [L.required, required ? 1 : 0],
    [L.entries, entries],
  ]);
  if (manifest.validUntil !== undefined) fields.set(L.validUntil, manifest.validUntil);
  if (manifest.publisherName) fields.set(L.publisherName, manifest.publisherName);
  if (manifest.supersedes) fields.set(L.supersedes, uuidToBytes(manifest.supersedes));
  if (manifest.manifestVersion >= 3) fields.set(L.version, manifest.manifestVersion);
  if (manifest.generator?.tool) {
    fields.set(L.generator, [
      manifest.generator.tool,
      manifest.generator.model ?? "",
      manifest.generator.provider ?? "",
    ]);
  }
  if (publicKey && manifest.signature) {
    fields.set(L.key, compressPublicKey(fromBase64(publicKey)));
    fields.set(L.signature, parseSign1(fromBase64(manifest.signature)).signature);
  }

  const packed = deflateSync(encode(fields), { level: 9, dictionary: DICTIONARY });
  const out = new Uint8Array(1 + DICTIONARY_ID.length + packed.length);
  out[0] = CARRIER_VERSION;
  out.set(DICTIONARY_ID, 1);
  out.set(packed, 1 + DICTIONARY_ID.length);
  return toBase64Url(out);
}

export interface UnpackOptions {
  /** The engine this host holds, by digest (§6.2). */
  supply?: Supplier;
}

/**
 * Unpacks a fragment value into a complete container, ready to be verified.
 *
 * Every elided entry is rebuilt and checked against the digest the link named
 * for it before it goes into the archive. The result is then an ordinary
 * container, and the caller verifies it exactly as it would a file: this
 * function builds bytes and refuses to build wrong ones, and nothing more.
 */
export async function unpackInline(
  value: string,
  host: Host,
  options: UnpackOptions = {},
): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(value);
  } catch {
    throw new ContainerError("LINK_DAMAGED", "This link is damaged.");
  }
  if (bytes.length < 1 + DICTIONARY_ID.length + 1) {
    throw new ContainerError("LINK_DAMAGED", "This link is damaged: it is too short to carry a document.");
  }
  if (bytes[0] !== CARRIER_VERSION) {
    throw new ContainerError(
      "LINK_UNSUPPORTED",
      `This link was made for a newer or older version of this app (carrier ${bytes[0]}).`,
    );
  }
  for (let i = 0; i < DICTIONARY_ID.length; i++) {
    if (bytes[1 + i] !== DICTIONARY_ID[i]) {
      throw new ContainerError(
        "LINK_UNSUPPORTED",
        "This link was compressed against a dictionary this app does not have. " +
          "It may have been made by a newer version; ask for the file instead.",
      );
    }
  }

  let fields: Map<CborValue, CborValue>;
  try {
    const inflated = inflateSync(bytes.subarray(1 + DICTIONARY_ID.length), { dictionary: DICTIONARY });
    const decoded = decode(inflated);
    if (!(decoded instanceof Map)) throw new Error("not a map");
    fields = decoded;
  } catch {
    throw new ContainerError(
      "LINK_DAMAGED",
      "This link is damaged. It was probably shortened or wrapped on the way here.",
    );
  }

  const uuidBytes = fields.get(L.uuid);
  const appName = fields.get(L.appName);
  const favicon = fields.get(L.favicon);
  const createdAt = fields.get(L.createdAt);
  const required = fields.get(L.required) === 1;
  const validUntil = fields.get(L.validUntil);
  const publisherName = fields.get(L.publisherName);
  const supersedesBytes = fields.get(L.supersedes);
  const versionField = fields.get(L.version);
  const version = typeof versionField === "number" ? versionField : 2;
  const generatorField = fields.get(L.generator);
  const generator =
    Array.isArray(generatorField) && typeof generatorField[0] === "string" && generatorField[0]
      ? {
          tool: generatorField[0],
          ...(typeof generatorField[1] === "string" && generatorField[1] ? { model: generatorField[1] } : {}),
          ...(typeof generatorField[2] === "string" && generatorField[2] ? { provider: generatorField[2] } : {}),
        }
      : undefined;
  const key = fields.get(L.key);
  const signature = fields.get(L.signature);
  const entries = fields.get(L.entries);
  if (
    !(uuidBytes instanceof Uint8Array) ||
    uuidBytes.length !== 16 ||
    typeof appName !== "string" ||
    typeof favicon !== "string" ||
    typeof createdAt !== "string" ||
    !Array.isArray(entries)
  ) {
    throw new ContainerError("LINK_DAMAGED", "This link does not describe a document.");
  }
  const uuid = bytesToUuid(uuidBytes);

  let publicKey = "";
  let fingerprint = "";
  if (key instanceof Uint8Array) {
    let spki: Uint8Array;
    try {
      spki = decompressPublicKey(key);
    } catch {
      throw new ContainerError("LINK_DAMAGED", "This link carries a publisher key that is not a key.");
    }
    publicKey = toBase64(spki);
    fingerprint = (await sha256Hex(spki)).slice(0, 16);
  }

  const archive: Record<string, Uint8Array> = {};
  const hashes: Record<string, string> = {};
  let sawDatabase = false;

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw new ContainerError("LINK_DAMAGED", "This link does not describe a document.");
    }
    const [name, flag, payload] = entry;
    if (typeof name !== "string" || !(payload instanceof Uint8Array)) {
      throw new ContainerError("LINK_DAMAGED", "This link does not describe a document.");
    }
    if (name === DEFAULT_SQLITE_ENTRY) sawDatabase = true;

    if (flag === CARRIED) {
      archive[name] = payload;
      hashes[name] = await sha256Hex(payload);
      continue;
    }
    if (flag !== ELIDED || payload.length !== 32 || !HOST_OWNED.includes(name)) {
      throw new ContainerError("LINK_DAMAGED", `This link leaves out ${name}, which a link may not leave out.`);
    }

    const digest = bytesToHex(payload);
    let rebuilt: Uint8Array | undefined;
    if (name === CONTAINER_ENTRY) {
      // The shell needs the application's files to decide its policy, and
      // they were carried ahead of it: the manifest lists app/ entries first.
      rebuilt = await rebuildShell(host, {
        appName,
        favicon,
        required,
        publicKey,
        uuid,
        files: applicationFiles(archive),
      });
    } else if (name === KIT_PATH) {
      rebuilt = new TextEncoder().encode(KIT_SOURCE);
    } else {
      rebuilt = options.supply?.(digest);
      if (!rebuilt) {
        throw new ContainerError(
          "RUNTIME_UNAVAILABLE",
          `This link was sent for a host that holds the engine it names, and this one does not have ${name}.`,
        );
      }
    }

    // The rule that makes all of this safe: what went in is what was sealed,
    // proven by digest before it is trusted for anything.
    if ((await sha256Hex(rebuilt)) !== digest) {
      throw new ContainerError(
        "LINK_UNRECONSTRUCTABLE",
        `This link leaves out ${name} expecting this app to have the same one, and this app's is different. ` +
          `It was probably made with another version; ask for the file instead.`,
      );
    }
    archive[name] = rebuilt;
    hashes[name] = digest;
  }

  if (!sawDatabase) {
    throw new ContainerError("LINK_DAMAGED", "This link does not describe a document: it has no database entry.");
  }

  const signedEntries: Record<string, string> = {};
  for (const [name, digest] of Object.entries(hashes)) {
    if (name === DEFAULT_SQLITE_ENTRY) continue;
    if (version >= 3 && name === CONTAINER_ENTRY) continue;
    signedEntries[name] = digest;
  }

  // Field order matches the compiler's, so that when both hosts agree the
  // manifest — and therefore the whole file — is the one the build produced.
  const manifest: ContainerManifest = {
    manifestVersion: version,
    documentUuid: uuid,
    appName,
    favicon,
    ...(typeof publisherName === "string" && publisherName ? { publisherName } : {}),
    ...(supersedesBytes instanceof Uint8Array && supersedesBytes.length === 16
      ? { supersedes: bytesToUuid(supersedesBytes) }
      : {}),
    ...(generator ? { generator } : {}),
    createdAt,
    algorithm: "SHA-256",
    integrityPolicy: required ? "required" : "advisory",
    hashes,
    ...(typeof validUntil === "number" ? { validUntil } : {}),
    ...(publicKey && signature instanceof Uint8Array
      ? {
          signatureAlgorithm: "COSE-ES256",
          publicKeyFingerprint: fingerprint,
          signedEntries,
          signature: toBase64(
            encode([protectedHeader(fingerprint), new Map<CborValue, CborValue>(), null, signature]),
          ),
        }
      : {}),
  };
  archive[MANIFEST_ENTRY] = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n");

  const shell = new TextDecoder().decode(archive[CONTAINER_ENTRY]!);
  const payload = toBase64(zipSync(archive, { level: 9, mtime: ZIP_EPOCH }));
  return shell.replace(PAYLOAD_TAG_RE, (_m, open: string, close: string) => open + payload + close);
}
