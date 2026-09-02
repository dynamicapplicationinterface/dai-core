/**
 * Reading and verifying a compiled container.
 *
 * The counterpart to `buildContainer`: that one seals, this one checks the
 * seal. It lives in the core so every host performs the same checks — a
 * container refused by the mobile runner must not open in the desktop shell,
 * and two implementations of "is this cartridge intact" will not stay in
 * agreement for long.
 *
 * Isomorphic, like the rest of the core: strings and byte arrays in, no `node:`
 * imports, no DOM types. A host that has a `File` reads the text itself.
 */
import { unzipSync, zipSync } from "fflate";
import {
  CONTAINER_ENTRY,
  MANIFEST_ENTRY,
  canonicalPayload,
  fromBase64,
  sha256Hex,
  toBase64,
  type ContainerManifest,
} from "./core.js";

/** Captures the payload's base64 for reading. */
const PAYLOAD_RE = /<script[^>]*id="dai-payload"[^>]*>([\s\S]*?)<\/script>/;
/** Captures the tag around the payload for replacing. */
const PAYLOAD_TAG_RE = /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/;
const PAYLOAD_PLACEHOLDER = "<!--DAI_PAYLOAD-->";
const SQLITE_ENTRY = "document.sqlite";

/**
 * A container was rejected, as opposed to something going wrong while reading
 * it. Hosts show these messages to users, so they name what is wrong with the
 * file rather than which line threw.
 */
export class ContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerError";
  }
}

export interface ParsedContainer {
  /** The container document, verbatim. Hosts mount this; never a rebuilt copy. */
  html: string;
  archive: Record<string, Uint8Array>;
  manifest: ContainerManifest;
  /** `required` or `advisory`, read from the shell rather than the manifest. */
  integrityPolicy: string;
  /** The publisher key the shell carries, if any. Base64 SPKI. */
  publicKey?: string;
  /** Present when the manifest names one. Only meaningful once verified. */
  publicKeyFingerprint?: string;
  /** The current database, for hosts that keep their own copy. */
  database: Uint8Array;
}

export interface VerifiedContainer extends ParsedContainer {
  /**
   * `valid` means a signature was present and checked against the key in the
   * shell. `unsigned` means no key was carried — not that the file is
   * untrustworthy, and not that its publisher is known.
   */
  signature: "valid" | "unsigned";
}

function metaContent(html: string, name: string): string | undefined {
  const pattern = new RegExp(`<meta[^>]*name="${name}"[^>]*content="([^"]*)"`, "i");
  return pattern.exec(html)?.[1];
}

/**
 * Reads a container's structure without checking anything.
 *
 * Useful for inspection and for reporting on a file that fails verification.
 * Never use it to decide whether to mount: it proves only that the bytes are
 * shaped like a container.
 */
export function parseContainer(html: string): ParsedContainer {
  const payload = PAYLOAD_RE.exec(html)?.[1]?.trim();
  if (!payload) {
    throw new ContainerError(
      "This file has no DAI payload. It may be an ordinary web page rather than a container.",
    );
  }

  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(fromBase64(payload));
  } catch (cause) {
    throw new ContainerError(`The container's payload could not be read (${String(cause)}).`);
  }

  const manifestBytes = archive[MANIFEST_ENTRY];
  if (!manifestBytes) {
    throw new ContainerError(
      `This container has no ${MANIFEST_ENTRY}, so its contents cannot be verified.`,
    );
  }

  let manifest: ContainerManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ContainerManifest;
  } catch (cause) {
    throw new ContainerError(`The container's manifest is unreadable (${String(cause)}).`);
  }

  const publicKey = metaContent(html, "dai-public-key") || undefined;

  return {
    html,
    archive,
    manifest,
    integrityPolicy: metaContent(html, "dai-integrity") ?? "unknown",
    publicKey,
    publicKeyFingerprint: manifest.publicKeyFingerprint,
    database: archive[SQLITE_ENTRY] ?? new Uint8Array(0),
  };
}

/**
 * Checks every entry against the manifest, in both directions.
 *
 * A digest that does not match is the obvious failure. An entry present in the
 * payload but absent from the manifest is the same failure wearing a different
 * hat: without that direction, content could simply be appended to a container
 * and nothing would object.
 */
async function checkDigests(
  archive: Record<string, Uint8Array>,
  manifest: ContainerManifest,
): Promise<string[]> {
  const problems: string[] = [];

  for (const [name, bytes] of Object.entries(archive)) {
    if (name === MANIFEST_ENTRY) continue;
    const expected = manifest.hashes[name];
    if (!expected) {
      problems.push(`${name} is not listed in the manifest`);
    } else if ((await sha256Hex(bytes)) !== expected) {
      problems.push(`${name} does not match its digest`);
    }
  }

  for (const name of Object.keys(manifest.hashes)) {
    if (!(name in archive)) problems.push(`${name} is missing from the payload`);
  }

  return problems;
}

/**
 * Compares the outer document against the sealed copy inside it.
 *
 * This is the check a container cannot perform on itself. Its own verification
 * runs inside its own bootloader, so anyone who rewrites that shell — to set
 * `dai-integrity` to `advisory`, or to delete the check outright — is audited by
 * the code they just replaced. Only a separate reader, holding the sealed copy,
 * can catch it.
 *
 * The payload region is masked before comparing, because the sealed copy is the
 * shell as it was before its own payload was injected.
 */
function checkShellSeal(html: string, archive: Record<string, Uint8Array>): void {
  const sealed = archive[CONTAINER_ENTRY];
  if (!sealed) {
    throw new ContainerError(
      `This container has no ${CONTAINER_ENTRY}, so its bootloader cannot be checked.`,
    );
  }

  const stripped = html.replace(
    PAYLOAD_TAG_RE,
    (_match, open: string, close: string) => open + PAYLOAD_PLACEHOLDER + close,
  );

  if (stripped !== new TextDecoder().decode(sealed)) {
    throw new ContainerError(
      "This container's bootloader does not match the sealed copy inside it. " +
        "The file has been modified outside its own payload and will not be run.",
    );
  }
}

/**
 * Checks the publisher's signature over the application and runtime.
 *
 * `document.sqlite` is deliberately outside the signed set: the application is
 * immutable while its database is not, and a container carries no private key
 * to re-sign with after a save.
 *
 * `signedEntries` is re-checked against `hashes` rather than trusted, so a
 * signature can never be validated over digests different from the ones just
 * verified.
 *
 * Note what a pass does and does not mean. It proves the payload was signed by
 * whoever holds the key *this file carries*, and that nothing has changed since.
 * It does not establish who that is: a container is self-contained, so an
 * attacker can substitute the key and re-sign. See docs/backlog.md.
 */
async function checkSignature(
  manifest: ContainerManifest,
  publicKey: string,
  documentUuid: string,
): Promise<void> {
  if (!manifest.signature || !manifest.signedEntries) {
    throw new ContainerError(
      "This container carries a publisher key but no signature, so the key cannot be checked.",
    );
  }
  if (manifest.signatureAlgorithm !== "ECDSA-P256-SHA256") {
    throw new ContainerError(
      `Unsupported signature algorithm: ${manifest.signatureAlgorithm}.`,
    );
  }

  for (const [name, digest] of Object.entries(manifest.signedEntries)) {
    if (manifest.hashes[name] !== digest) {
      throw new ContainerError(
        `This container is not authentic: ${name} is signed with a different digest.`,
      );
    }
  }

  let key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    key = await crypto.subtle.importKey(
      "spki",
      fromBase64(publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch (cause) {
    throw new ContainerError(`The container's publisher key is unreadable (${String(cause)}).`);
  }

  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64(manifest.signature),
    new TextEncoder().encode(
      canonicalPayload(documentUuid, manifest.signedEntries, manifest.validUntil),
    ),
  );

  if (!ok) {
    throw new ContainerError(
      "This container is not authentic: the signature does not match the publisher key.",
    );
  }
}

/**
 * The gate every host runs before mounting a container.
 *
 * Throws `ContainerError` with a message meant for a person. Callers should
 * show it rather than replacing it with "failed to load", which leaves a user
 * unable to tell a corrupted download from a file that was never a container.
 */
export async function verifyContainer(html: string): Promise<VerifiedContainer> {
  const parsed = parseContainer(html);

  // WebCrypto exists only in a secure context. Saying so beats failing inside
  // the digest call with "Cannot read properties of undefined".
  if (!globalThis.crypto?.subtle) {
    throw new ContainerError(
      "This container cannot be verified here: WebCrypto is unavailable. " +
        "Containers must be opened from a file, from localhost, or over HTTPS.",
    );
  }

  if (parsed.manifest.algorithm !== "SHA-256") {
    throw new ContainerError(`Unsupported digest algorithm: ${parsed.manifest.algorithm}.`);
  }

  const problems = await checkDigests(parsed.archive, parsed.manifest);
  if (problems.length > 0) {
    throw new ContainerError(
      `This container has been modified and will not be run.\n${problems.slice(0, 4).join("\n")}`,
    );
  }

  checkShellSeal(parsed.html, parsed.archive);

  // Checked after the digests and before the signature is trusted, because an
  // expiry only means anything once the manifest carrying it has been verified.
  //
  // The clock belongs to whoever opens the file, so this stops an honest host
  // running a stale container. It is not a control against someone determined
  // to run one anyway: they can set the clock back, and no offline format can
  // prevent that. Treat it as policy, not enforcement.
  if (parsed.manifest.validUntil !== undefined) {
    const expiry = parsed.manifest.validUntil * 1000;
    if (Date.now() > expiry) {
      throw new ContainerError(
        `This container expired on ${new Date(expiry).toISOString()} and will not be run. ` +
          `Only its publisher can issue a replacement; an expiry cannot be extended ` +
          `without the signing key.`,
      );
    }
  }

  // A container that ships a key must satisfy it, or the key is decorative.
  if (parsed.publicKey) {
    await checkSignature(parsed.manifest, parsed.publicKey, parsed.manifest.documentUuid);
    return { ...parsed, signature: "valid" };
  }

  return { ...parsed, signature: "unsigned" };
}

/**
 * Rebuilds a container around a new database.
 *
 * The database changed, so its digest in the manifest is stale; leaving it
 * would produce a file that refuses to open. The document UUID is carried
 * forward deliberately — a save is a new revision of the same document, not a
 * new document — and the signature stays valid because `document.sqlite` was
 * never in the signed set.
 */
export async function resealContainer(
  container: ParsedContainer,
  database: Uint8Array,
): Promise<ParsedContainer> {
  const next: Record<string, Uint8Array> = {
    ...container.archive,
    [SQLITE_ENTRY]: database,
  };

  const hashes: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(next)) {
    if (name === MANIFEST_ENTRY) continue;
    hashes[name] = await sha256Hex(bytes);
  }

  const manifest: ContainerManifest = {
    ...container.manifest,
    hashes,
  };
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({ ...manifest, savedAt: new Date().toISOString() }, null, 2) + "\n",
  );
  next[MANIFEST_ENTRY] = manifestBytes;

  const payload = toBase64(zipSync(next, { level: 9 }));
  const html = container.html.replace(
    PAYLOAD_TAG_RE,
    (_match, open: string, close: string) => open + payload + close,
  );

  return {
    ...container,
    html,
    archive: next,
    manifest: JSON.parse(new TextDecoder().decode(manifestBytes)) as ContainerManifest,
    database,
  };
}
