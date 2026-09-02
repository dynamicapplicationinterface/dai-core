/**
 * Reading and checking a container before the runner will mount it.
 *
 * The container verifies itself once it boots — that is the check that actually
 * gates execution, and it happens inside the container's own shell where it
 * cannot be skipped. This pass exists so the runner can refuse an obviously
 * broken file with a useful message instead of mounting a document that will
 * fail silently behind an iframe.
 */
import { unzipSync, zipSync } from "fflate";
import { sha256Hex } from "../../../src/core.js";

const PAYLOAD_RE = /<script[^>]*id="dai-payload"[^>]*>([\s\S]*?)<\/script>/;
const PAYLOAD_TAG_RE = /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/;
const PAYLOAD_PLACEHOLDER = "<!--DAI_PAYLOAD-->";
const MANIFEST_ENTRY = "runtime/manifest.json";
const CONTAINER_ENTRY = "runtime/container.html";

export interface CartridgeManifest {
  manifestVersion: number;
  documentUuid: string;
  appName?: string;
  algorithm: string;
  hashes: Record<string, string>;
  publicKeyFingerprint?: string;
  signature?: string;
}

export interface Cartridge {
  /** The container document, verbatim. Mounted as-is; never rewritten. */
  html: string;
  archive: Record<string, Uint8Array>;
  manifest: CartridgeManifest;
  /** Whether the shell demands verification. */
  integrityPolicy: string;
  /** Present only if the container carries a publisher key. */
  publicKeyFingerprint?: string;
  /** The current database, for the runner's own storage layer. */
  database: Uint8Array;
}

export class CartridgeError extends Error {}

/** Reads the file as text. Containers are HTML, whatever their extension. */
async function readText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return new TextDecoder().decode(new Uint8Array(buffer));
}

function metaContent(html: string, name: string): string | undefined {
  const pattern = new RegExp(`<meta[^>]*name="${name}"[^>]*content="([^"]*)"`, "i");
  return pattern.exec(html)?.[1];
}

/**
 * Parses and verifies a container.
 *
 * Verification is bidirectional, matching the bootloader: an entry missing from
 * the manifest is as much a failure as a digest that does not match, or content
 * could simply be appended.
 */
export async function readCartridge(file: File): Promise<Cartridge> {
  const html = await readText(file);

  const payload = PAYLOAD_RE.exec(html)?.[1]?.trim();
  if (!payload) {
    throw new CartridgeError(
      "This file has no DAI payload. It may be an ordinary web page rather than a container.",
    );
  }

  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(base64ToBytes(payload));
  } catch (cause) {
    throw new CartridgeError(`The container's payload could not be read (${String(cause)}).`);
  }

  const manifestBytes = archive[MANIFEST_ENTRY];
  if (!manifestBytes) {
    throw new CartridgeError(
      `This container has no ${MANIFEST_ENTRY}, so its contents cannot be verified.`,
    );
  }

  let manifest: CartridgeManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as CartridgeManifest;
  } catch (cause) {
    throw new CartridgeError(`The container's manifest is unreadable (${String(cause)}).`);
  }

  if (manifest.algorithm !== "SHA-256") {
    throw new CartridgeError(`Unsupported digest algorithm: ${manifest.algorithm}.`);
  }

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

  if (problems.length > 0) {
    throw new CartridgeError(
      `This container has been modified and will not be run.\n${problems.slice(0, 4).join("\n")}`,
    );
  }

  // The outer shell is the one thing the container cannot check about itself.
  // Its own verification runs inside that shell, so an attacker who edits the
  // bootloader — to skip verification, or to exfiltrate — is checked by the
  // code they just rewrote. A player holds the sealed copy and can compare.
  const embeddedShell = archive[CONTAINER_ENTRY];
  if (!embeddedShell) {
    throw new CartridgeError(
      `This container has no ${CONTAINER_ENTRY}, so its bootloader cannot be checked.`,
    );
  }

  const strippedShell = html.replace(
    PAYLOAD_TAG_RE,
    (_match, open: string, close: string) => open + PAYLOAD_PLACEHOLDER + close,
  );
  if (strippedShell !== new TextDecoder().decode(embeddedShell)) {
    throw new CartridgeError(
      "This container's bootloader does not match the sealed copy inside it. " +
        "The file has been modified outside its own payload and will not be run.",
    );
  }

  return {
    html,
    archive,
    manifest,
    integrityPolicy: metaContent(html, "dai-integrity") ?? "unknown",
    publicKeyFingerprint: manifest.publicKeyFingerprint,
    database: archive["document.sqlite"] ?? new Uint8Array(0),
  };
}

/** Decodes base64 without assuming `atob`, matching the core's helper. */
function base64ToBytes(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < alphabet.length; i++) lookup[alphabet.charCodeAt(i)] = i;

  let bits = 0;
  let accumulator = 0;
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const code = lookup[value.charCodeAt(i)]!;
    if (code < 0) continue;
    accumulator = (accumulator << 6) | code;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  const limit = bytes.length - (bytes.length % 3);

  for (let i = 0; i < limit; i += 3) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      alphabet[(chunk >> 18) & 63]! +
      alphabet[(chunk >> 12) & 63]! +
      alphabet[(chunk >> 6) & 63]! +
      alphabet[chunk & 63]!;
  }

  const remaining = bytes.length - limit;
  if (remaining === 1) {
    const chunk = bytes[limit]! << 16;
    out += alphabet[(chunk >> 18) & 63]! + alphabet[(chunk >> 12) & 63]! + "==";
  } else if (remaining === 2) {
    const chunk = (bytes[limit]! << 16) | (bytes[limit + 1]! << 8);
    out +=
      alphabet[(chunk >> 18) & 63]! +
      alphabet[(chunk >> 12) & 63]! +
      alphabet[(chunk >> 6) & 63]! +
      "=";
  }

  return out;
}

/**
 * Reseals a cartridge with updated database bytes.
 */
export async function resealCartridge(
  cartridge: Cartridge,
  newSqliteBytes: Uint8Array,
): Promise<Cartridge> {
  const next: Record<string, Uint8Array> = {
    ...cartridge.archive,
    ["document.sqlite"]: newSqliteBytes,
  };

  const hashes: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(next)) {
    if (name === MANIFEST_ENTRY) continue;
    hashes[name] = await sha256Hex(bytes);
  }

  const updatedManifestBytes = new TextEncoder().encode(
    JSON.stringify(
      { ...cartridge.manifest, savedAt: new Date().toISOString(), hashes },
      null,
      2,
    ) + "\n",
  );
  next[MANIFEST_ENTRY] = updatedManifestBytes;

  const zipped = zipSync(next, { level: 9 });
  const payloadB64 = bytesToBase64(zipped);

  const newHtml = cartridge.html.replace(
    PAYLOAD_TAG_RE,
    (_match, open: string, close: string) => open + payloadB64 + close,
  );

  const updatedManifest = JSON.parse(
    new TextDecoder().decode(updatedManifestBytes),
  ) as CartridgeManifest;

  return {
    ...cartridge,
    html: newHtml,
    archive: next,
    manifest: updatedManifest,
    database: newSqliteBytes,
  };
}

