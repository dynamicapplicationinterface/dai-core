import { expect, test } from "@playwright/test";
import { base, item } from "./scenarios.js";
import { Copy, DOC, openBytes } from "./copy.js";
import * as merge from "../../src/replicated-frame.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const m = merge as Any;

/**
 * The data-interface catalog's ten priority vectors (`handoff-2026-10-19.md`,
 * "Data-interface catalog (external review)", section 10), each from the
 * catalog's own scenario and named by its row ids. The rulings they hold the
 * runtime to are R-S (the capture-epoch boundary) and R-T (valid
 * materialization) in docs/backlog.md.
 */

/** Every value one author's log carries for one row, as [column, value], from the signed payloads. */
function wroteFor(c: Copy, table: string, key: unknown): [string, unknown][] {
  return c
    .written()
    .map((w) => JSON.parse(w) as [string, string, string, string, unknown])
    .filter(([t, k]) => t === table && JSON.stringify(JSON.parse(k)[0]) === JSON.stringify(key))
    .map(([, , col, , val]) => [col, val]);
}

/**
 * C07 / Q08. A local edit to column A, a remote edit to column B of the same
 * row, then a local save. The session records a row's current values when it
 * is extracted, so a remote value written into a row the session has already
 * touched becomes part of the local changeset however the session was paused
 * (SQLite documents it; the catalog reproduced it). Only A may be attributed
 * to the local author: in its log, and on the other copy.
 *
 * Twice: as the merge runs (the local edit saved before the apply), and with
 * the application holding a transaction when the apply would run (R-S: the
 * apply waits for the committed boundary, and the epoch is logged first).
 */
test("C07/Q08: a remote edit to another column of a locally edited row is never attributed to the local author", async () => {
  for (const held of [false, true]) {
    const { a, b } = await base();
    const bread = item(a, "Bread");
    b.db.exec({ sql: "UPDATE items SET note = 'B-note' WHERE id = ?", bind: [bread] });
    const bBytes = await b.bytes();

    // A merges step by step, as the frame does (bootloader.ts, mergeSibling):
    // capture, verify (an await), admit, apply. The local edit lands after the
    // frame's capture, so only the runtime's own boundary keeps it out of the apply.
    a.save();
    const sib = await openBytes(bBytes);
    const verifying = m.verifyBatches(sib.rows, m.mergeTablesOf(sib.rows), DOC);
    if (held) a.db.exec("BEGIN");
    a.db.exec({ sql: "UPDATE items SET qty = 7 WHERE id = ?", bind: [bread] });
    const verdicts = await verifying;
    m.mergeVerified(a.rows, sib.rows, { document: DOC, author: a.author.author, verdicts });
    sib.db.close();
    a.changes.projectAdmitted();
    if (held) {
      // Nothing of the remote edit is applied while the transaction is the application's.
      expect(a.db.selectObject("SELECT qty, note FROM items WHERE id = ?", [bread]), `held=${held}: inside the transaction`).toEqual({ qty: 7, note: null });
      a.db.exec("COMMIT");
    }
    a.save();

    const label = held ? "with the application's transaction open" : "as the merge runs";
    expect(a.db.selectObject("SELECT qty, note FROM items WHERE id = ?", [bread]), label).toEqual({ qty: 7, note: "B-note" });
    const aWrote = wroteFor(a, "items", bread);
    expect(aWrote, `${label}: A's log carries A's edit`).toContainEqual(["qty", 7]);
    expect(aWrote, `${label}: A's log never carries B's value`).not.toContainEqual(["note", "B-note"]);
    expect(a.flags(), label).toEqual([]);

    await b.mergeFrom(await a.bytes());
    expect(b.db.selectObject("SELECT qty, note FROM items WHERE id = ?", [bread]), label).toEqual({ qty: 7, note: "B-note" });
    // On the other copy, each column's one current version is its own author's.
    const heads = b.rows.all(
      `SELECT col, author FROM _cs_cell c WHERE tbl = 'items' AND pk = ? AND col IN ('qty', 'note')
        AND NOT EXISTS (SELECT 1 FROM _cs_sup s WHERE s.tbl = c.tbl AND s.pk = c.pk AND s.col = c.col AND s.ver = c.ver) ORDER BY col`,
      [JSON.stringify([bread])],
    );
    expect(heads, label).toEqual([
      { col: "note", author: b.changes.authorHex },
      { col: "qty", author: a.changes.authorHex },
    ]);
    expect(a.state(), label).toBe(b.state());
    a.close();
    b.close();
  }
});


