import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  SECTION,
  readContainerFile,
  sectionBytes,
  verifyContainerFile,
  writeContainerFile,
} from "../src/format.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(repo, "crates", "sectioned");

/**
 * The host's writer, checked by this project's reader.
 *
 * A container is written in TypeScript and saved by the Rust host, which is the
 * only place the two implementations of this format meet. Each has its own
 * tests, and passing them separately proves only that each agrees with itself:
 * a disagreement about the offset of a digest, or the order of a length field,
 * would leave both suites green and every saved file unreadable.
 *
 * The Rust side is driven through an example binary rather than reimplemented
 * here, so what runs is the code the desktop app calls.
 */
const sqlite = (fill: number, length: number): Uint8Array => {
  const header = new TextEncoder().encode("SQLite format 3\0");
  const data = new Uint8Array(length).fill(fill);
  data.set(header, 0);
  return data;
};

const container = (data: Uint8Array) =>
  writeContainerFile({
    manifest: new TextEncoder().encode('{"documentUuid":"a-b-c","manifestVersion":1}'),
    payload: new TextEncoder().encode("PK-pretend-this-is-a-zip"),
    data,
    generation: 4,
  });

const save = (file: string, database: string, expectedGeneration?: number): number => {
  const output = execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--example",
      "replace-data",
      "--",
      file,
      database,
      ...(expectedGeneration === undefined ? [] : [String(expectedGeneration)]),
    ],
    { cwd: crate, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return Number(output.trim());
};

const roundTrip = async (
  before: Uint8Array,
  next: Uint8Array,
): Promise<{ generation: number; after: Uint8Array }> => {
  const directory = mkdtempSync(join(tmpdir(), "dai-sectioned-"));
  const file = join(directory, "document.dai");
  const database = join(directory, "next.sqlite");

  writeFileSync(file, before);
  writeFileSync(database, next);

  const generation = save(file, database);
  return { generation, after: new Uint8Array(readFileSync(file)) };
};

test.describe("a container saved by the host", () => {
  test("still verifies, with the new database recorded", async () => {
    const next = sqlite(0x22, 9000);
    const { generation, after } = await roundTrip(await container(sqlite(0x11, 200)), next);

    const audit = await verifyContainerFile(after);
    // Every digest in the table, and the footer against the data it describes.
    // This is the assertion that fails if either side disagrees about the
    // layout by so much as a byte.
    expect(audit.mismatched).toEqual([]);
    expect(audit.staleFooter).toBe(false);
    expect(audit.missing).toEqual([]);
    expect(audit.ok).toBe(true);

    const read = readContainerFile(after);
    expect(read.generation).toBe(generation);
    // The fixture is written at generation 4, and a save advances it: a host
    // that has seen 5 can tell that a file offering 4 is a rollback.
    expect(generation).toBe(5);
    expect(sectionBytes(after, read, SECTION.DATA)).toEqual(next);
  });

  test("leaves the manifest and the payload untouched", async () => {
    // The reason the format is sectioned at all. The publisher's signature
    // covers the manifest; a save carries no key, so anything that rewrote it
    // would produce a file whose signature no longer describes it.
    const before = await container(sqlite(0x11, 200));
    const original = readContainerFile(before);
    const { after } = await roundTrip(before, sqlite(0x33, 40000));
    const saved = readContainerFile(after);

    for (const id of [SECTION.MANIFEST, SECTION.PAYLOAD] as const) {
      expect(sectionBytes(after, saved, id)).toEqual(sectionBytes(before, original, id));
      const wasAt = original.sections.find((section) => section.id === id)!;
      const isAt = saved.sections.find((section) => section.id === id)!;
      expect({ offset: isAt.offset, digest: isAt.digest }).toEqual({
        offset: wasAt.offset,
        digest: wasAt.digest,
      });
    }
  });

  test("shrinks the file when the database shrinks", async () => {
    const large = await roundTrip(await container(sqlite(0x11, 200)), sqlite(0x44, 60000));
    const small = await roundTrip(large.after, sqlite(0x55, 100));

    expect(small.after.byteLength).toBeLessThan(large.after.byteLength);
    expect((await verifyContainerFile(small.after)).ok).toBe(true);
  });

  test("refuses to write something that is not a database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dai-sectioned-"));
    const file = join(directory, "document.dai");
    const database = join(directory, "not-a-database");
    writeFileSync(file, await container(sqlite(0x11, 200)));
    writeFileSync(database, "<html>this is a document, not a database</html>");

    expect(() => save(file, database)).toThrow();
    // The refusal has to leave the original intact: a host that damages a file
    // on its way to rejecting the save is worse than one that never tried.
    expect((await verifyContainerFile(new Uint8Array(readFileSync(file)))).ok).toBe(true);
  });

  test("refuses to write over a save it never saw", async () => {
    /*
     * Two windows on one document, which nothing locks. The footer counts
     * saves, so a window holding save 4 can be told that the file is now at 5
     * rather than quietly overwriting somebody else's afternoon.
     */
    const directory = mkdtempSync(join(tmpdir(), "dai-sectioned-"));
    const file = join(directory, "document.dai");
    const first = join(directory, "first.sqlite");
    const second = join(directory, "second.sqlite");

    writeFileSync(file, await container(sqlite(0x11, 200)));
    writeFileSync(first, sqlite(0x22, 200));
    writeFileSync(second, sqlite(0x33, 200));

    // One window saves, taking the document from 4 to 5.
    expect(save(file, first, 4)).toBe(5);

    // The other still believes it is at 4.
    let refusal = "";
    try {
      save(file, second, 4);
    } catch (error) {
      refusal = String((error as { stderr?: Buffer }).stderr ?? error);
    }

    expect(refusal).toContain("saved somewhere else");

    // And the first window's work is still there.
    const after = new Uint8Array(readFileSync(file));
    const read = readContainerFile(after);
    expect(read.generation).toBe(5);
    expect(sectionBytes(after, read, SECTION.DATA)).toEqual(sqlite(0x22, 200));
    expect((await verifyContainerFile(after)).ok).toBe(true);
  });
});

test("a lost race is refused by name", async () => {
  // The sentence changes; the code does not. A host reads the first word.
  const directory = mkdtempSync(join(tmpdir(), "dai-sectioned-"));
  const file = join(directory, "document.dai");
  const next = join(directory, "next.sqlite");
  writeFileSync(file, await container(sqlite(0x11, 200)));
  writeFileSync(next, sqlite(0x22, 200));

  let message = "";
  try {
    save(file, next, 99);
  } catch (error) {
    message = String((error as { stderr?: string }).stderr ?? error);
  }
  expect(message).toContain("GENERATION_CONFLICT:");
});
