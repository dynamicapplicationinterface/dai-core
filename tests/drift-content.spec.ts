import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
// @ts-expect-error a plain ES module with no types
import { contentOf } from "../scripts/drift.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The drift step holds a merge fixture's committed input to what the
 * generator writes by content, not bytes (scripts/drift.mjs). Its first run in
 * CI found every committed a.db and b.db different in bytes from the ones the
 * generator wrote there, with every text output agreeing: the file header
 * records the SQLite library that wrote it, and CI's Node 22 carries another
 * than Node 24 here. So two libraries writing the same rows must compare
 * equal, and one changed row must not.
 */
test.describe("a fixture database's content", () => {
  const committed = join(repo, "conformance", "merge", "merge-conflict", "a.db");

  test("a file written by another SQLite library compares equal", async () => {
    const other = join(mkdtempSync(join(tmpdir(), "dai-drift-")), "a.db");
    const bytes = Buffer.from(readFileSync(committed));
    // The header's "version-valid-for" and library version (offsets 92 and 96).
    bytes.writeUInt32BE(41, 92);
    bytes.writeUInt32BE(3045001, 96);
    writeFileSync(other, bytes);
    expect(Buffer.compare(bytes, readFileSync(committed))).not.toBe(0);
    expect(await contentOf(other)).toBe(await contentOf(committed));
  });

  test("a changed row does not", async () => {
    // Two scratch copies with the triggers dropped (they refuse any change to a
    // replicated row), differing only by one column of one table.
    const dir = mkdtempSync(join(tmpdir(), "dai-drift-"));
    const [same, other] = [join(dir, "same.db"), join(dir, "other.db")];
    for (const path of [same, other]) {
      copyFileSync(committed, path);
      const scratch = new DatabaseSync(path);
      for (const { name } of scratch.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all() as { name: string }[]) {
        scratch.exec(`DROP TRIGGER "${name}"`);
      }
      scratch.close();
    }
    const db = new DatabaseSync(other);
    // An application table and a column of its own: not SQLite's, not the protocol's (`_dai`, `_r_`), not a key.
    const table = (
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 1) <> '_' ORDER BY name")
        .get() as { name: string }
    ).name;
    const column = (
      db.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE pk = 0 AND substr(name, 1, 1) <> '_'`).get() as { name: string }
    ).name;
    const changed = db.prepare(`UPDATE "${table}" SET "${column}" = 'drifted'`).run().changes;
    expect(Number(changed), "a row was changed").toBeGreaterThan(0);
    db.close();
    expect(await contentOf(other)).not.toBe(await contentOf(same));
  });
});
