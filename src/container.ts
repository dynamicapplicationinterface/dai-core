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
import { isRefusalCode, type RefusalCode } from "./refusals.js";
import { verifySign1 } from "./cose.js";
import {
  MAGIC,
  SECTION,
  readContainerFile,
  sectionBytes,
  verifyContainerFile,
} from "./format.js";
import { CONTAINER_ENTRY, MANIFEST_ENTRY, signedBytes, signedViewOf, fromBase64, sha256Hex, toBase64, type ContainerManifest, assembleShell, nonceFor, DEFAULT_FAVICON } from "./core.js";

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
  /** Why, as a name from the registry, so a host can act without parsing prose. */
  readonly code: RefusalCode;

  constructor(code: RefusalCode, message: string);
  /** @deprecated Name the reason. Kept so a host built against the old shape still compiles. */
  constructor(message: string);
  constructor(codeOrMessage: string, message?: string) {
    const coded = message !== undefined && isRefusalCode(codeOrMessage);
    super(coded ? (message as string) : codeOrMessage);
    this.name = "ContainerError";
    this.code = coded ? (codeOrMessage as RefusalCode) : "HOST_REFUSED";
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
    throw new ContainerError("NO_PAYLOAD", 
      "This file has no DAI payload. It may be an ordinary web page rather than a container.",
    );
  }

  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(fromBase64(payload));
  } catch (cause) {
    throw new ContainerError("PAYLOAD_UNREADABLE", `The container's payload could not be read (${String(cause)}).`);
  }

  const manifestBytes = archive[MANIFEST_ENTRY];
  if (!manifestBytes) {
    throw new ContainerError("MANIFEST_MISSING", 
      `This container has no ${MANIFEST_ENTRY}, so its contents cannot be verified.`,
    );
  }

  let manifest: ContainerManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ContainerManifest;
  } catch (cause) {
    throw new ContainerError("MANIFEST_UNREADABLE", `The container's manifest is unreadable (${String(cause)}).`);
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
export function looksSectioned(bytes: Uint8Array): boolean {
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
    throw new ContainerError("SECTION_MISSING", "This container is missing a manifest or a payload section.");
  }

  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(payloadBytes);
  } catch (cause) {
    throw new ContainerError("PAYLOAD_UNREADABLE", `The container's payload could not be read (${String(cause)}).`);
  }

  let manifest: ContainerManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ContainerManifest;
  } catch (cause) {
    throw new ContainerError("MANIFEST_UNREADABLE", `The container's manifest is unreadable (${String(cause)}).`);
  }

  const shell = archive[CONTAINER_ENTRY];
  if (!shell) {
    throw new ContainerError("SHELL_MISSING", 
      `This container has no ${CONTAINER_ENTRY}, so its publisher key cannot be read.`,
    );
  }
  const sealedShell = new TextDecoder().decode(shell);

  archive[MANIFEST_ENTRY] = manifestBytes;

  /*
   * A document a host can actually mount.
   *
   * Two things stand between the sectioned form and a running container, and
   * both follow from the layout rather than being mistakes in it. The sealed
   * shell carries a placeholder where its payload goes, because a shell
   * containing its own payload could not be compared against anything. And the
   * manifest is a section of the file rather than an entry in the archive,
   * which is what lets a save leave the publisher's signature untouched.
   *
   * So a host mounting the sealed shell mounts a document with the literal
   * string `<!--DAI_PAYLOAD-->` where the application should be; a container
   * that got past that would then find no manifest and refuse itself. Both
   * happened, in that order, and neither was noticed for weeks because the
   * runner marks itself loaded when it mounts rather than when the container
   * answers — and the test asserted the same thing the host had assumed.
   *
   * Stored uncompressed: this archive lives for the length of one mount and
   * never reaches a disk, and deflating it again costs more time than the
   * memory it would save.
   */
  const html = sealedShell.replace(
    PAYLOAD_TAG_RE,
    (_match, open: string, close: string) =>
      open + toBase64(zipSync(archive, { level: 0 })) + close,
  );

  return {
    html,
    archive,
    manifest,
    integrityPolicy: metaContent(sealedShell, "dai-integrity") ?? "unknown",
    publicKey: metaContent(sealedShell, "dai-public-key") || undefined,
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
    throw new ContainerError("SHELL_MISSING", 
      `This container has no ${CONTAINER_ENTRY}, so its bootloader cannot be checked.`,
    );
  }

  const stripped = html.replace(
    PAYLOAD_TAG_RE,
    (_match, open: string, close: string) => open + PAYLOAD_PLACEHOLDER + close,
  );

  if (stripped !== new TextDecoder().decode(sealed)) {
    throw new ContainerError("SHELL_MISMATCH", 
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
    throw new ContainerError("SIGNATURE_UNVERIFIABLE", 
      "This container carries a publisher key but no signature, so the key cannot be checked.",
    );
  }
  // A container from before the signature became a COSE envelope. The manifest
  // is intelligible and the signature is not checkable by anything current, so
  // the refusal says what happened and what to do rather than naming a constant
  // the reader has never heard of.
  if (manifest.signatureAlgorithm === "ECDSA-P256-SHA256" || manifest.manifestVersion < 2) {
    throw new ContainerError("SIGNATURE_UNSUPPORTED", 
      "This container was built before the signature format changed, so its " +
        "signature cannot be checked here. Rebuild it and it will open.",
    );
  }
  if (manifest.signatureAlgorithm !== "COSE-ES256") {
    throw new ContainerError("SIGNATURE_UNSUPPORTED", 
      `Unsupported signature algorithm: ${manifest.signatureAlgorithm}.`,
    );
  }

  for (const [name, digest] of Object.entries(manifest.signedEntries)) {
    if (manifest.hashes[name] !== digest) {
      throw new ContainerError("SIGNED_SET_MISMATCH", 
        `This container is not authentic: ${name} is signed with a different digest.`,
      );
    }
  }

  /*
   * And the other direction, which was missing.
   *
   * `hashes` is outside the signature. Checking only that every signed entry
   * matches `hashes` lets an entry be *added* — to the archive and to
   * `hashes`, with a matching digest — without touching `signedEntries` or
   * the signature. Integrity passes, the signature passes, and the addition
   * runs under the badge of the pinned publisher. One such entry is executed
   * by the host: `runtime/schema.json`, whose migration SQL runs against the
   * person's data. So every digested entry except the database, which is
   * unsigned by design, must be in the signed set.
   */
  for (const name of Object.keys(manifest.hashes)) {
    if (name === SQLITE_ENTRY) continue;
    if (!(name in manifest.signedEntries)) {
      throw new ContainerError("SIGNED_SET_MISMATCH", 
        `This container is not authentic: ${name} is not covered by the signature.`,
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
    throw new ContainerError("SIGNATURE_UNVERIFIABLE", `The container's publisher key is unreadable (${String(cause)}).`);
  }

  // The payload is rebuilt from the manifest rather than taken from the
  // envelope. The envelope carries none — the signature is detached — and a
  // verifier should be checking the bytes it decided to trust, not the ones it
  // was handed alongside the signature over them.
  const ok = await verifySign1(
    fromBase64(manifest.signature),
    signedBytes(signedViewOf({ ...manifest, documentUuid })),
    (signature, bytes) =>
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature as unknown as ArrayBuffer,
        bytes as unknown as ArrayBuffer,
      ),
  ).catch((cause: unknown) => {
    // A malformed envelope is a refusal with a reason, not a stack trace: a
    // host shows this to somebody.
    throw new ContainerError("UNVERIFIED_SIGNATURE", `The container's signature is unreadable (${String(cause)}).`);
  });

  if (!ok) {
    throw new ContainerError("UNVERIFIED_SIGNATURE", 
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
    /** The registry name for a refusal, when the status is not valid or unsigned. */
    code?: RefusalCode;
    fingerprint?: string;
    reason?: string;
  };
  expiry: { status: "none" | "current" | "expired"; validUntil?: number };
  /** Present only for the sectioned form. */
  sections?: {
    mismatched: number[];
    /** Sections the format requires that this file does not have. */
    missing: number[];
    /** The footer disagrees with the database it describes. */
    staleFooter: boolean;
    /** How many times this document has been saved. */
    generation: number;
  };
  /** Set when the environment prevented checking rather than a container failing. */
  unavailable?: string;
}

/** Section numbers, in the words somebody reading a refusal would use. */
function sectionName(id: number): string {
  if (id === SECTION.MANIFEST) return "manifest";
  if (id === SECTION.PAYLOAD) return "application";
  if (id === SECTION.DATA) return "database";
  return `section ${id}`;
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
    if (parsed.sectioned) {
      /*
       * The sectioned form has no live shell to compare the sealed one against:
       * the file is a binary, and the only shell it holds is the sealed copy
       * itself. Comparing it to itself would always agree, and reporting "ok"
       * from a comparison that cannot fail is the kind of check this project
       * exists to avoid.
       *
       * The shell is verified here, by a different route: it is an ordinary
       * entry in the payload, so it is covered by its manifest digest and by
       * the section digest over every byte of the payload. That entry's status
       * is the honest answer.
       */
      const entry = report.entries.find((candidate) => candidate.name === CONTAINER_ENTRY);
      report.shell.status = entry?.status === "ok" ? "ok" : "mismatch";
    } else {
      const stripped = html.replace(
        PAYLOAD_TAG_RE,
        (_match, open: string, close: string) => open + PAYLOAD_PLACEHOLDER + close,
      );
      report.shell.status =
        stripped === new TextDecoder().decode(sealed) ? "ok" : "mismatch";
    }
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
      missing: audit.missing,
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
      if (error instanceof ContainerError) report.signature.code = error.code;
    }
  }

  report.ok =
    (!report.sections ||
      (report.sections.mismatched.length === 0 &&
        report.sections.missing.length === 0 &&
        !report.sections.staleFooter)) &&
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
  if (report.unavailable) {
    throw new ContainerError(
      report.unavailable.startsWith("Unsupported digest") ? "UNSUPPORTED_ALGORITHM" : "UNSUPPORTED_CRYPTO",
      report.unavailable,
    );
  }

  // Reported before the entries, because a section digest covers every byte of
  // a section and an entry digest covers only what unzipped out of one. When
  // both fail, the section is the more precise account of what changed.
  if (report.sections) {
    /*
     * Which part is damaged decides what a person should do about it, and the
     * two cases could not be less alike.
     *
     * A manifest or an application that does not match its digest is a file
     * that has been changed: what is inside is not what was sealed, and the
     * answer is to get the file again from wherever it came from.
     *
     * A database that does not match is almost always an interrupted save. The
     * write order exists to make exactly this detectable — data first, then the
     * table entry and the footer that vouch for it — so a crash between the two
     * leaves the application intact and its own record of the database wrong.
     * Nothing here can repair that, and reporting it as modification would send
     * somebody looking for an attacker when their laptop lost power.
     */
    const damaged = report.sections.mismatched;
    const onlyTheDatabase =
      damaged.every((id) => id === SECTION.DATA) &&
      (damaged.length > 0 || report.sections.staleFooter);

    if (onlyTheDatabase) {
      throw new ContainerError("DATA_DAMAGED", 
        "This document's data is damaged and it will not be opened.\n" +
          "The application inside it is intact and correctly sealed — it is the database " +
          "that does not match the record kept of it, which is what an interrupted save " +
          "looks like. An earlier copy of the file, if you have one, will still open.",
      );
    }

    if (damaged.length > 0) {
      throw new ContainerError("SECTION_MISMATCH", 
        "This container has been modified and will not be run.\n" +
          `the ${damaged.map(sectionName).join(" and the ")} does not match its digest`,
      );
    }

    if (report.sections.missing.length > 0) {
      throw new ContainerError("SECTION_MISSING", 
        "This container is incomplete and will not be run.\n" +
          `it has no ${report.sections.missing.map(sectionName).join(" and no ")}`,
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
    throw new ContainerError("DIGEST_MISMATCH", `This container has been modified and will not be run.\n${detail}`);
  }

  if (report.shell.status === "absent") {
    throw new ContainerError("SHELL_MISSING", 
      `This container has no ${CONTAINER_ENTRY}, so its bootloader cannot be checked.`,
    );
  }
  if (report.shell.status === "mismatch") {
    throw new ContainerError("SHELL_MISMATCH", 
      "This container's bootloader does not match the sealed copy inside it. " +
        "The file has been modified outside its own payload and will not be run.",
    );
  }

  if (report.expiry.status === "expired") {
    const expiry = new Date(report.expiry.validUntil! * 1000).toISOString();
    throw new ContainerError("KEY_EXPIRED", 
      `This container expired on ${expiry} and will not be run. Only its publisher ` +
        `can issue a replacement; an expiry cannot be extended without the signing key.`,
    );
  }

  if (report.signature.status === "invalid" || report.signature.status === "unverifiable") {
    throw new ContainerError(
      report.signature.code ?? "UNVERIFIED_SIGNATURE",
      report.signature.reason ?? "This container is not authentic.",
    );
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

/** The meta a host-built shell carries, so it can be told from a sealed one. */
export const HOST_SHELL_META = '<meta name="dai-shell" content="host">';

/**
 * A shell of the host's own, around an archive the host has verified.
 *
 * A container carries its own bootloader, and a host that loads the
 * container's document executes that bootloader with the host's origin — in
 * a frame that has `allow-same-origin`, because the bridge and the host's
 * storage need it. The bootloader is verified only against its own sealed
 * copy, which proves the publisher wrote it and nothing else. A hostile
 * publisher's shell therefore ran as the host: with its library, its pinned
 * keys and its OPFS in reach. The launch card cannot say "your data stays
 * here" while that is so.
 *
 * So a host does not execute the container's shell. It takes the archive it
 * has just verified, and assembles a document around it from the template
 * and bootloader it ships itself — the same function the compiler uses, so
 * the shell a host runs is the shell a compiler would have sealed today, not
 * whatever a publisher sealed. The publisher's `runtime/container.html` stays
 * in the archive, checked and inert; it is executed only where there is no
 * host to protect, which is the `file://` double-click path.
 *
 * The archive is re-zipped without compression: it is unpacked again a
 * moment later by the bootloader, and the bytes never leave this process.
 */
export async function hostShell(
  container: ParsedContainer,
  host: { template: string; runtime: string },
): Promise<string> {
  const archive: Record<string, Uint8Array> = { ...container.archive };
  if (!archive[MANIFEST_ENTRY]) {
    archive[MANIFEST_ENTRY] = new TextEncoder().encode(JSON.stringify(container.manifest, null, 2));
  }

  const shell = assembleShell({
    template: host.template,
    runtime: host.runtime,
    appName: container.manifest.appName ?? "container",
    favicon: container.manifest.favicon || DEFAULT_FAVICON,
    integrityPolicy: container.integrityPolicy === "advisory" ? "advisory" : "required",
    publicKey: container.publicKey ?? "",
    nonce: await nonceFor(container.manifest.documentUuid),
  });

  const payload = toBase64(zipSync(archive, { level: 0 }));
  return shell
    .replace(PAYLOAD_TAG_RE, (_match, open: string, close: string) => open + payload + close)
    .replace(/<meta charset[^>]*>/i, (tag) => tag + "\n  " + HOST_SHELL_META);
}
