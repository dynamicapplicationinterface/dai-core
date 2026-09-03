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
  MAGIC,
  SECTION,
  readContainerFile,
  sectionBytes,
  verifyContainerFile,
} from "./format.js";
import {
  CONTAINER_ENTRY,
  MANIFEST_ENTRY,
  canonicalPayload,
  signedViewOf,
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
  /**
   * Present only for the sectioned form, so the audit can check the table and
   * the footer as well as the entries.
   *
   * Carried rather than checked here because parsing is synchronous and a
   * digest is not. Reading what a file claims and deciding whether the claim
   * holds are separate acts in this module, and this keeps them so.
   */
  sectioned?: { bytes: Uint8Array };
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
export function parseContainer(source: string | Uint8Array): ParsedContainer {
  // Bytes are decoded as UTF-8, because a container is an HTML document however
  // it was read — from a file handle, an ArrayBuffer, or a native host. Every
  // caller was writing this line itself.
  //
  // There is deliberately no bare-archive form. A container's shell carries the
  // publisher key and the integrity policy, and is itself sealed inside the
  // payload; an archive on its own has no key to check a signature against and
  // nothing to compare a seal to, so it could be parsed but never verified.
  // The sectioned form is recognised by its leading magic, which is why the
  // magic is there. A container that arrived as bytes could be either, and
  // guessing from a file extension would be guessing.
  if (typeof source !== "string" && looksSectioned(source)) return parseSectioned(source);

  const html = typeof source === "string" ? source : new TextDecoder().decode(source);

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

/** True when these bytes begin with the sectioned container's magic. */
function looksSectioned(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= MAGIC.byteLength &&
    MAGIC.every((byte, index) => bytes[index] === byte)
  );
}

/**
 * The sectioned form, presented as the same shape the rest of this module reads.
 *
 * The shell is recovered from the payload rather than being the file itself:
 * in this form the file is a binary, and the shell it carries is what holds the
 * publisher key and the integrity policy. Everything downstream — the digest
 * check, the signature check, the audit — then works unchanged on either form.
 *
 * The database is placed back under its entry name so a host can read it, but
 * it is deliberately absent from the manifest's digests here. A save rewrites
 * the data section and the footer and touches nothing else, which is what lets
 * a container be saved by somebody holding no key; a digest in the manifest
 * would go stale on the first save and could not be corrected.
 */
function parseSectioned(bytes: Uint8Array): ParsedContainer {
  const file = readContainerFile(bytes);

  const manifestBytes = sectionBytes(bytes, file, SECTION.MANIFEST);
  const payloadBytes = sectionBytes(bytes, file, SECTION.PAYLOAD);
  if (!manifestBytes || !payloadBytes) {
    throw new ContainerError("This container is missing a manifest or a payload section.");
  }

  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(payloadBytes);
  } catch (cause) {
    throw new ContainerError(`The container's payload could not be read (${String(cause)}).`);
  }

  let manifest: ContainerManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ContainerManifest;
  } catch (cause) {
    throw new ContainerError(`The container's manifest is unreadable (${String(cause)}).`);
  }

  const shell = archive[CONTAINER_ENTRY];
  if (!shell) {
    throw new ContainerError(
      `This container has no ${CONTAINER_ENTRY}, so its publisher key cannot be read.`,
    );
  }
  const html = new TextDecoder().decode(shell);

  archive[MANIFEST_ENTRY] = manifestBytes;

  return {
    html,
    archive,
    manifest,
    integrityPolicy: metaContent(html, "dai-integrity") ?? "unknown",
    publicKey: metaContent(html, "dai-public-key") || undefined,
    publicKeyFingerprint: manifest.publicKeyFingerprint,
    database: sectionBytes(bytes, file, SECTION.DATA) ?? new Uint8Array(0),
    sectioned: { bytes },
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
      canonicalPayload(signedViewOf({ ...manifest, documentUuid })),
    ),
  );

  if (!ok) {
    throw new ContainerError(
      "This container is not authentic: the signature does not match the publisher key.",
    );
  }
}

/** How one entry fared against the manifest. */
export interface EntryAudit {
  name: string;
  /** The digest the manifest claims. Absent when the entry is unlisted. */
  expected?: string;
  /** What the bytes actually hash to. Absent when the entry is missing. */
  actual?: string;
  status: "ok" | "mismatch" | "unlisted" | "missing" | "unchecked";
}

export interface AuditReport {
  documentUuid: string;
  integrityPolicy: string;
  /** True only when every check that could be run, passed. */
  ok: boolean;
  entries: EntryAudit[];
  shell: { status: "ok" | "mismatch" | "absent" };
  signature: {
    status: "valid" | "invalid" | "unsigned" | "unverifiable";
    fingerprint?: string;
    reason?: string;
  };
  expiry: { status: "none" | "current" | "expired"; validUntil?: number };
  /** Present only for the sectioned form. */
  sections?: {
    mismatched: number[];
    /** The footer disagrees with the database it describes. */
    staleFooter: boolean;
    /** How many times this document has been saved. */
    generation: number;
  };
  /** Set when the environment prevented checking rather than a container failing. */
  unavailable?: string;
}

/**
 * Checks a container and reports everything it found, without throwing.
 *
 * `verifyContainer` answers "may this run", and stops at the first reason it
 * may not. That is right for a host and useless for a tool: a playground or a
 * linter wants to show *which* entry failed, and how the rest fared, which a
 * first-failure exception cannot express.
 *
 * This is the single implementation of what checking means. `verifyContainer`
 * runs this and throws on what it finds, so the two cannot disagree about
 * whether a container is sound — a second verifier written for the UI would
 * drift, and the drift would show up as a playground that passes a container a
 * host rejects.
 */
export async function auditContainer(parsed: ParsedContainer): Promise<AuditReport> {
  const { manifest, archive, html } = parsed;

  const report: AuditReport = {
    documentUuid: manifest.documentUuid,
    integrityPolicy: parsed.integrityPolicy,
    ok: false,
    entries: [],
    shell: { status: "absent" },
    signature: { status: "unsigned" },
    expiry: { status: "none" },
  };

  // Reported rather than thrown: a tool should be able to show what a container
  // claims even where it cannot check the claims.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    report.unavailable =
      "WebCrypto is unavailable, so nothing could be checked. Containers must be " +
      "opened from a file, from localhost, or over HTTPS.";
    report.entries = Object.keys(archive)
      .filter((name) => name !== MANIFEST_ENTRY)
      .sort()
      .map((name) => ({ name, expected: manifest.hashes?.[name], status: "unchecked" as const }));
    return report;
  }

  if (manifest.algorithm !== "SHA-256") {
    report.unavailable = `Unsupported digest algorithm: ${manifest.algorithm}.`;
    return report;
  }

  // Both directions, as the verifier does. An entry the manifest never listed
  // is as much a failure as one that mismatches, or content could be appended.
  const seen = new Set<string>();
  for (const [name, bytes] of Object.entries(archive)) {
    if (name === MANIFEST_ENTRY) continue;
    seen.add(name);

    const expected = manifest.hashes?.[name];
    const actual = await sha256Hex(bytes);
    if (!expected) {
      report.entries.push({ name, actual, status: "unlisted" });
    } else {
      report.entries.push({ name, expected, actual, status: expected === actual ? "ok" : "mismatch" });
    }
  }

  for (const name of Object.keys(manifest.hashes ?? {})) {
    if (!seen.has(name)) {
      report.entries.push({ name, expected: manifest.hashes[name], status: "missing" });
    }
  }
  report.entries.sort((a, b) => a.name.localeCompare(b.name));

  const sealed = archive[CONTAINER_ENTRY];
  if (sealed) {
    const stripped = html.replace(
      PAYLOAD_TAG_RE,
      (_match, open: string, close: string) => open + PAYLOAD_PLACEHOLDER + close,
    );
    report.shell.status =
      stripped === new TextDecoder().decode(sealed) ? "ok" : "mismatch";
  }

  if (manifest.validUntil !== undefined) {
    report.expiry = {
      validUntil: manifest.validUntil,
      status: Date.now() > manifest.validUntil * 1000 ? "expired" : "current",
    };
  }

  /*
   * The table and the footer, for a sectioned container.
   *
   * Without this the entry digests are the only check, and they are computed
   * after the payload has been unzipped — so a byte altered in the archive's
   * own framing, rather than in an entry, would survive unnoticed. The section
   * digest covers every byte of the section, framing included.
   */
  if (parsed.sectioned) {
    const audit = await verifyContainerFile(parsed.sectioned.bytes);
    report.sections = {
      mismatched: audit.mismatched,
      staleFooter: audit.staleFooter,
      generation: audit.file.generation,
    };
  }

  if (parsed.publicKey) {
    report.signature.fingerprint = manifest.publicKeyFingerprint;
    try {
      await checkSignature(manifest, parsed.publicKey, manifest.documentUuid);
      report.signature.status = "valid";
    } catch (error) {
      // A key that cannot be checked at all is reported apart from one that was
      // checked and did not match: the first is a malformed container, the
      // second is a container signed by somebody else.
      const message = error instanceof Error ? error.message : String(error);
      report.signature.status = /no signature|unsupported signature/i.test(message)
        ? "unverifiable"
        : "invalid";
      report.signature.reason = message;
    }
  }

  report.ok =
    (!report.sections ||
      (report.sections.mismatched.length === 0 && !report.sections.staleFooter)) &&
    report.entries.every((entry) => entry.status === "ok") &&
    report.shell.status === "ok" &&
    report.expiry.status !== "expired" &&
    (report.signature.status === "valid" || report.signature.status === "unsigned");

  return report;
}

/**
 * The gate every host runs before mounting a container.
 *
 * Throws `ContainerError` with a message meant for a person. Callers should
 * show it rather than replacing it with "failed to load", which leaves a user
 * unable to tell a corrupted download from a file that was never a container.
 */
export async function verifyContainer(source: string | Uint8Array): Promise<VerifiedContainer> {
  const parsed = parseContainer(source);
  const report = await auditContainer(parsed);

  // One implementation of what checking means, presented two ways: a report for
  // tools, an exception for hosts. A second verifier written for either would
  // drift, and the drift would surface as a playground passing what a host
  // refuses.
  if (report.unavailable) throw new ContainerError(report.unavailable);

  // Reported before the entries, because a section digest covers every byte of
  // a section and an entry digest covers only what unzipped out of one. When
  // both fail, the section is the more precise account of what changed.
  if (report.sections) {
    if (report.sections.mismatched.length > 0) {
      throw new ContainerError(
        "This container has been modified and will not be run.\n" +
          `section ${report.sections.mismatched.join(", ")} does not match its digest`,
      );
    }
    if (report.sections.staleFooter) {
      throw new ContainerError(
        "This container's database does not match the record of it kept at the end of " +
          "the file. It has been modified outside its own save path and will not be run.",
      );
    }
  }

  const broken = report.entries.filter((entry) => entry.status !== "ok");
  if (broken.length > 0) {
    const detail = broken
      .slice(0, 4)
      .map((entry) =>
        entry.status === "unlisted"
          ? `${entry.name} is not listed in the manifest`
          : entry.status === "missing"
            ? `${entry.name} is missing from the payload`
            : `${entry.name} does not match its digest`,
      )
      .join("\n");
    throw new ContainerError(`This container has been modified and will not be run.\n${detail}`);
  }

  if (report.shell.status === "absent") {
    throw new ContainerError(
      `This container has no ${CONTAINER_ENTRY}, so its bootloader cannot be checked.`,
    );
  }
  if (report.shell.status === "mismatch") {
    throw new ContainerError(
      "This container's bootloader does not match the sealed copy inside it. " +
        "The file has been modified outside its own payload and will not be run.",
    );
  }

  if (report.expiry.status === "expired") {
    const expiry = new Date(report.expiry.validUntil! * 1000).toISOString();
    throw new ContainerError(
      `This container expired on ${expiry} and will not be run. Only its publisher ` +
        `can issue a replacement; an expiry cannot be extended without the signing key.`,
    );
  }

  if (report.signature.status === "invalid" || report.signature.status === "unverifiable") {
    throw new ContainerError(report.signature.reason ?? "This container is not authentic.");
  }

  return { ...parsed, signature: report.signature.status === "valid" ? "valid" : "unsigned" };
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
/**
 * Rebuilds a container around a modified archive, leaving the manifest alone.
 *
 * The deliberate opposite of `resealContainer`, which recomputes the digests so
 * a saved document stays valid. Here the digests are left stale on purpose, so
 * the result is a container that no longer matches its own manifest — which is
 * what a tool demonstrating tamper detection needs, and what an attacker who
 * edits a file produces.
 *
 * It lives here rather than in the caller because repacking the payload means
 * knowing the archive layout and the payload tag, and every copy of that
 * knowledge is a copy that can fall out of step with the compiler.
 */
export function replacePayload(
  container: ParsedContainer,
  archive: Record<string, Uint8Array>,
): string {
  const payload = toBase64(zipSync(archive, { level: 9 }));
  return container.html.replace(
    PAYLOAD_TAG_RE,
    (_match, open: string, close: string) => open + payload + close,
  );
}

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
