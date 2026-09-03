/**
 * The sectioned `.dai` container: a reader and a writer, and nothing else.
 *
 * The polyglot `.dai.html` is what makes the format demonstrable — a file that
 * opens in any browser with nothing installed — and it is a poor thing to build
 * on. Every save rewrites it whole: the database is exported, deflated,
 * base64-encoded, spliced into a string of HTML and structured-cloned, five
 * copies and time proportional to the entire document to change one row. It
 * stalls perceptibly around twenty megabytes. And mail gateways routinely
 * quarantine `.html` attachments, which is a problem for a format whose promise
 * is that you can send one to somebody.
 *
 * So this is the canonical form and the HTML stays as a viewer. The layout is
 * arranged around one property: the database is a section of its own, and
 * changing it touches nothing else. The manifest is not rewritten on a save, so
 * the publisher's signature — which covers the manifest and deliberately not
 * the database — survives every save without a key being present.
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ header    magic, version, flags, section count       │
 *   │ TOC       id, offset, length, digest — one per       │
 *   │           section, so a reader learns the shape      │
 *   │           without reading the contents               │
 *   ├──────────────────────────────────────────────────────┤
 *   │ MANIFEST  what the publisher signed                  │
 *   │ PAYLOAD   application, runtime and engine, as a zip   │
 *   │ DATA      the SQLite database, page-aligned          │
 *   ├──────────────────────────────────────────────────────┤
 *   │ footer    generation, data digest, trailing magic    │
 *   └──────────────────────────────────────────────────────┘
 *
 * The footer sits at a fixed distance from the end, so a reader can establish
 * that a two-gigabyte file is intact and current by reading sixty-four bytes
 * plus the table — rather than hashing the whole thing to discover the same.
 *
 * Isomorphic, like the rest of the core: byte arrays in, byte arrays out, and
 * WebCrypto for digests. No filesystem, no Node built-ins.
 */
import { sha256Hex } from "./core.js";

/** "DAI\0" — chosen so `file(1)` and mail scanners see a binary, not markup. */
export const MAGIC = new Uint8Array([0x44, 0x41, 0x49, 0x00]);
/** The same bytes reversed, at the very end, so truncation is obvious. */
export const FOOTER_MAGIC = new Uint8Array([0x00, 0x49, 0x41, 0x44]);

export const FORMAT_VERSION = 2;

/** Fixed sizes, named so the arithmetic below reads as layout rather than magic. */
export const HEADER_BYTES = 12;
/**
 * One table entry: id, three bytes of padding, offset, length, digest.
 *
 * 52 bytes of fields rounded up to 56 so every entry starts on an eight-byte
 * boundary and the 64-bit reads stay aligned. Declared as 48 to begin with,
 * which is less than the fields occupy — each digest overran into the next
 * entry and nothing verified.
 */
export const TOC_ENTRY_BYTES = 56;
export const FOOTER_BYTES = 64;

/**
 * Sections are aligned so a host can write the database with a positioned
 * write rather than a rewrite. SQLite's page size is pinned at 4096, so a page
 * boundary and a section boundary are the same thing.
 */
export const ALIGNMENT = 4096;

export const SECTION = {
  MANIFEST: 1,
  PAYLOAD: 2,
  DATA: 3,
} as const;

export type SectionId = (typeof SECTION)[keyof typeof SECTION];

export interface Section {
  id: SectionId;
  offset: number;
  length: number;
  digest: string;
}

export interface ContainerFile {
  version: number;
  flags: number;
  sections: Section[];
  /** Increments on every save. A reader that has seen a later one knows. */
  generation: number;
  dataDigest: string;
}

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

const align = (value: number): number => Math.ceil(value / ALIGNMENT) * ALIGNMENT;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * Sixty-four-bit lengths, written and read as two 32-bit halves.
 *
 * `DataView` has `setBigUint64`, and using it would push a BigInt through every
 * call site for a number that will not exceed 2^53 in any file anyone can
 * store. Two halves keep the arithmetic in ordinary numbers.
 */
function writeU64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
}

function readU64(view: DataView, offset: number): number {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000;
}

export interface WriteInput {
  manifest: Uint8Array;
  payload: Uint8Array;
  data: Uint8Array;
  /** Defaults to 1: the generation a freshly compiled container starts at. */
  generation?: number;
}

/** Assembles a container. Sections are laid out in the order they are declared. */
export async function writeContainerFile(input: WriteInput): Promise<Uint8Array> {
  const bodies: { id: SectionId; bytes: Uint8Array }[] = [
    { id: SECTION.MANIFEST, bytes: input.manifest },
    { id: SECTION.PAYLOAD, bytes: input.payload },
    { id: SECTION.DATA, bytes: input.data },
  ];

  const tocBytes = TOC_ENTRY_BYTES * bodies.length;
  let cursor = align(HEADER_BYTES + tocBytes);

  const sections: Section[] = [];
  for (const body of bodies) {
    sections.push({
      id: body.id,
      offset: cursor,
      length: body.bytes.byteLength,
      digest: await sha256Hex(body.bytes),
    });
    cursor += align(body.bytes.byteLength);
  }

  const total = cursor + FOOTER_BYTES;
  const file = new Uint8Array(total);
  const view = new DataView(file.buffer);

  file.set(MAGIC, 0);
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, sections.length, true);

  sections.forEach((section, index) => {
    const at = HEADER_BYTES + index * TOC_ENTRY_BYTES;
    view.setUint8(at, section.id);
    writeU64(view, at + 4, section.offset);
    writeU64(view, at + 12, section.length);
    file.set(fromHex(section.digest), at + 20);
  });

  bodies.forEach((body, index) => file.set(body.bytes, sections[index]!.offset));

  const dataDigest = sections.find((section) => section.id === SECTION.DATA)!.digest;
  const footerAt = total - FOOTER_BYTES;
  writeU64(view, footerAt, input.generation ?? 1);
  file.set(fromHex(dataDigest), footerAt + 8);
  file.set(FOOTER_MAGIC, total - FOOTER_MAGIC.length);

  return file;
}

/**
 * Reads the shape of a container without reading its contents.
 *
 * Deliberately cheap, and deliberately not a verification: it establishes what
 * the file claims about itself. `verifyContainerFile` decides whether the claim
 * holds, and the two are separate so a caller can report on a file it is not
 * willing to trust.
 */
export function readContainerFile(bytes: Uint8Array): ContainerFile {
  if (bytes.byteLength < HEADER_BYTES + FOOTER_BYTES) {
    throw new FormatError("Too short to be a container.");
  }
  if (!sameBytes(bytes.subarray(0, 4), MAGIC)) {
    throw new FormatError("Not a DAI container: the leading magic is wrong.");
  }
  if (!sameBytes(bytes.subarray(bytes.byteLength - 4), FOOTER_MAGIC)) {
    // The common cause is a truncated download or a transfer that stopped
    // early, which is worth saying rather than reporting a corrupt section.
    throw new FormatError("Container is truncated: the trailing magic is missing.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== FORMAT_VERSION) {
    throw new FormatError(
      `Container format version ${version}; this reader understands ${FORMAT_VERSION}.`,
    );
  }

  const count = view.getUint32(8, true);
  if (HEADER_BYTES + count * TOC_ENTRY_BYTES > bytes.byteLength) {
    throw new FormatError("The section table does not fit inside the file.");
  }

  const sections: Section[] = [];
  for (let index = 0; index < count; index++) {
    const at = HEADER_BYTES + index * TOC_ENTRY_BYTES;
    const section: Section = {
      id: view.getUint8(at) as SectionId,
      offset: readU64(view, at + 4),
      length: readU64(view, at + 12),
      digest: toHex(bytes.subarray(at + 20, at + 52)),
    };
    if (section.offset + section.length > bytes.byteLength) {
      throw new FormatError(`Section ${section.id} runs past the end of the file.`);
    }
    sections.push(section);
  }

  const footerAt = bytes.byteLength - FOOTER_BYTES;
  return {
    version,
    flags: view.getUint16(6, true),
    sections,
    generation: readU64(view, footerAt),
    dataDigest: toHex(bytes.subarray(footerAt + 8, footerAt + 40)),
  };
}

/** The bytes of one section, or undefined when the container has none. */
export function sectionBytes(
  bytes: Uint8Array,
  file: ContainerFile,
  id: SectionId,
): Uint8Array | undefined {
  const section = file.sections.find((candidate) => candidate.id === id);
  return section ? bytes.subarray(section.offset, section.offset + section.length) : undefined;
}

export interface FileAudit {
  ok: boolean;
  file: ContainerFile;
  /** Sections whose contents do not match the digest recorded for them. */
  mismatched: SectionId[];
  /** True when the footer disagrees with the data section it describes. */
  staleFooter: boolean;
  /** Sections the format requires that this file does not have. */
  missing: SectionId[];
}

/**
 * Every section a container must carry.
 *
 * A writer always emits all three, so a file lacking one has been altered or
 * damaged. Saying so matters most for the database: without this, a file whose
 * table simply omits it verifies cleanly and mounts an application whose data
 * has silently become empty.
 */
const REQUIRED_SECTIONS: SectionId[] = [SECTION.MANIFEST, SECTION.PAYLOAD, SECTION.DATA];

/**
 * Checks every section against the table, and the footer against the data.
 *
 * Non-throwing, like `auditContainer`: a tool showing somebody why a file was
 * refused needs the whole picture, and a first-failure exception cannot express
 * "the application is intact and only the database is wrong".
 */
export async function verifyContainerFile(bytes: Uint8Array): Promise<FileAudit> {
  const file = readContainerFile(bytes);
  const mismatched: SectionId[] = [];

  for (const section of file.sections) {
    const body = bytes.subarray(section.offset, section.offset + section.length);
    if ((await sha256Hex(body)) !== section.digest) mismatched.push(section.id);
  }

  const missing = REQUIRED_SECTIONS.filter(
    (id) => !file.sections.some((section) => section.id === id),
  );

  const data = sectionBytes(bytes, file, SECTION.DATA);
  // A file with no data section is not a container with an empty database; it
  // is a container missing a section, and the two must not report the same.
  const staleFooter = data ? (await sha256Hex(data)) !== file.dataDigest : false;

  return {
    ok: mismatched.length === 0 && !staleFooter && missing.length === 0,
    file,
    mismatched,
    staleFooter,
    missing,
  };
}

/**
 * Replaces the database and nothing else.
 *
 * The point of the layout. A save rewrites the data section, its table entry
 * and the footer; the manifest and the payload are copied through untouched, so
 * the publisher's signature still covers exactly what it covered before. The
 * generation counter advances, which is what lets a host notice a file rolled
 * back to an earlier state.
 *
 * The whole file is still rebuilt in memory here, because a `Uint8Array` is all
 * this layer has. A host holding a file descriptor can do the same thing with
 * two positioned writes, and the layout is what makes that possible.
 */
export async function replaceData(bytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const file = readContainerFile(bytes);
  const manifest = sectionBytes(bytes, file, SECTION.MANIFEST);
  const payload = sectionBytes(bytes, file, SECTION.PAYLOAD);

  if (!manifest || !payload) {
    throw new FormatError("Container is missing a manifest or a payload section.");
  }

  return writeContainerFile({
    manifest,
    payload,
    data,
    generation: file.generation + 1,
  });
}
