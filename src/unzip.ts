import { unzipSync } from "fflate";

/**
 * Reading an archive somebody else made, within bounds.
 *
 * Inflation runs before anything about the archive has been verified — it
 * has to, the manifest is inside — so it is the one step that takes an
 * untrusted file at its word. A few kilobytes of zeros compress to almost
 * nothing and inflate to whatever the header claims. These caps are what the
 * word is worth: an entry, the whole archive, and the count of entries, each
 * refused by its declared size before a byte of it is allocated. An entry
 * whose real size differs from its declared size comes out truncated and
 * fails its digest, which is a refusal too.
 *
 * The caps are generous for a document: a database of some hundreds of
 * megabytes fits, a decompression bomb does not.
 */
export const ENTRY_CAP = 512 * 1024 * 1024;
export const ARCHIVE_CAP = 768 * 1024 * 1024;
export const ENTRY_COUNT_CAP = 4096;

export class ArchiveTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveTooLarge";
  }
}

export function unzipBounded(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  let count = 0;
  return unzipSync(bytes, {
    filter: (entry) => {
      count += 1;
      if (count > ENTRY_COUNT_CAP) {
        throw new ArchiveTooLarge(`The archive declares more than ${ENTRY_COUNT_CAP} entries.`);
      }
      if (entry.originalSize > ENTRY_CAP) {
        throw new ArchiveTooLarge(`${entry.name} declares ${entry.originalSize} bytes, more than an entry may be.`);
      }
      total += entry.originalSize;
      if (total > ARCHIVE_CAP) {
        throw new ArchiveTooLarge(`The archive declares more than ${ARCHIVE_CAP} bytes in all.`);
      }
      return true;
    },
  });
}

/**
 * The most a DEFLATE stream of `compressed` bytes can honestly inflate to,
 * for sizing a fixed output buffer: the format's own ceiling is a little
 * over a thousand to one.
 */
export function inflateCeiling(compressed: number, cap: number): number {
  return Math.min(cap, compressed * 1032 + 1024);
}
