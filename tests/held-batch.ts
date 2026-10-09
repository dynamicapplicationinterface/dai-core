import { createHash } from "node:crypto";
import type { Rows } from "../src/replicated-rows.js";

/**
 * The `_r_batch` a row has when a merge took it (D194,
 * docs/format.md#uncovered-row): a header this copy holds that lists it. A
 * session document's views read only such rows and the copy's own, so a test
 * that writes another author's row straight through `applyRow`, standing for a
 * row that arrived, gives it one.
 *
 * `batch` names a header the test made itself: the row is added to its list.
 * Otherwise a header listing this row alone is made, unless `author` is the
 * copy's own, whose row stays pending as written (undefined). Every header made
 * here carries one digest, so two of them over one seq of one author are never
 * equivocation; a test that wants equivocation makes its own headers.
 */
export function heldBatch(db: Rows, table: string, author: Uint8Array, seq: number, batch?: Uint8Array): Uint8Array | undefined {
  if (batch) {
    db.run("UPDATE _dai_batch SET covers = json_insert(covers, '$[#]', json_array(?, ?)) WHERE id = ?", [table, seq, batch]);
    return batch;
  }
  if (db.all("SELECT 1 FROM _dai_replica WHERE id = ?", [author]).length > 0) return undefined;
  const id = new Uint8Array(createHash("sha256").update(`held ${Buffer.from(author).toString("hex")} ${table} ${seq}`).digest().subarray(0, 16));
  db.run(
    "INSERT OR IGNORE INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers) VALUES (?, ?, 1, x'00', x'00', NULL, 2, ?, ?)",
    [id, author, new Uint8Array(32), JSON.stringify([[table, seq]])],
  );
  return id;
}
