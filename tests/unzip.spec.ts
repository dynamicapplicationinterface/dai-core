import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { ENTRY_COUNT_CAP, unzipBounded, ArchiveTooLarge } from "../src/unzip.js";

/**
 * An archive is read within bounds.
 *
 * Inflation happens before the manifest can be checked, so it is the one step
 * that takes an untrusted file at its word. The word is worth a cap on each
 * entry, on the whole, and on the count — each applied to the declared size,
 * before the bytes are allocated.
 */
test.describe("reading an archive within bounds", () => {
  test("an ordinary archive comes through whole", () => {
    const files = unzipBounded(zipSync({ "a.txt": new TextEncoder().encode("hello"), "b/c.bin": new Uint8Array([1, 2, 3]) }));
    expect(Object.keys(files).sort()).toEqual(["a.txt", "b/c.bin"]);
    expect(new TextDecoder().decode(files["a.txt"]!)).toBe("hello");
  });

  test("too many entries are refused before they are read", () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i <= ENTRY_COUNT_CAP; i += 1) many[`f${i}`] = new Uint8Array(1);
    const archive = zipSync(many, { level: 0 });
    expect(() => unzipBounded(archive)).toThrow(/more than \d+ entries/);
  });

  test("an entry that declares more than it may is refused by its header", () => {
    // A real entry, its declared uncompressed size rewritten to a gigabyte.
    // Nothing that size is allocated: the filter reads the header and refuses.
    const archive = zipSync({ "big.bin": new Uint8Array(64) }, { level: 0 });
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    // Local header: uncompressed size at offset 22. Central directory entry:
    // signature 0x02014b50, uncompressed size at offset 24 from it.
    view.setUint32(22, 1024 * 1024 * 1024, true);
    for (let i = 0; i + 4 <= archive.length; i += 1) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 1024 * 1024 * 1024, true);
        break;
      }
    }
    const started = Date.now();
    expect(() => unzipBounded(archive)).toThrow(/more than an entry may be/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("the limits are the reader's: a host may set them lower", () => {
    // An archive well inside the defaults is refused against a tighter bound a
    // host under memory pressure chose. Nothing in the file may raise them.
    const archive = zipSync({ "modest.bin": new Uint8Array(4096) }, { level: 0 });
    expect(() => unzipBounded(archive, { entry: 1024, archive: 1024, count: 16 })).toThrow(ArchiveTooLarge);
    expect(Object.keys(unzipBounded(archive))).toEqual(["modest.bin"]);
  });
});
