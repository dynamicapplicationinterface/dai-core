import { expect, test } from "@playwright/test";
import { Copy, DOC, openBytes } from "./copy.js";
import { decode as cborDecode } from "../../src/cbor.js";
import * as merge from "../../src/replicated-frame.js";
import { base, item } from "./scenarios.js";

/**
 * R-S's provenance invariant, as the catalog states it: "Remote application
 * and runtime bookkeeping cannot become newly authored local changes." The
 * local delta is frozen before any reprojection; the baseline advances only
 * after the batch is durable; a resolution to the displayed value is recorded
 * though no byte changed.
 *
 * External review 2026-10-20, RW-09 to RW-12; the review of Build 1e, 1e-H4.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** The ops of this author's save at `seq`: [table, key, code, columns written]. */
function opsAt(c: Copy, seq: number): [string, unknown[], string, string[]][] {
  const row = c.rows.all("SELECT payload FROM _cs_log WHERE _r_replica = ? AND _r_seq = ?", [c.author.author, seq])[0];
  if (!row) return [];
  return (cborDecode(row["payload"] as Uint8Array) as Any)[1].map(([t, k, code, n]: Any) => [t, k, code, [...(n as Map<string, unknown>).keys()].sort()]);
}

const lastSeq = (c: Copy): number => Number(c.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE _r_replica = ?", [c.author.author]) ?? 0);

/** A's and B's concurrent titles for Tent, exchanged: the row is pending on both. */
async function pendingTitle(): Promise<{ a: Copy; b: Copy }> {
  const { a, b } = await base();
  a.db.exec("UPDATE items SET title = 'Tent (2p)' WHERE title = 'Tent'");
  b.db.exec("UPDATE items SET title = 'Tent (4p)' WHERE title = 'Tent'");
  const [ab, bb] = [await a.bytes(), await b.bytes()];
  await a.mergeFrom(bb);
  await b.mergeFrom(ab);
  for (const c of [a, b]) expect(c.flags().map((f: Any) => f.kind), "pending on both").toEqual(["pending"]);
  return { a, b };
}

const tentOf = (c: Copy): number => Number(c.db.selectValue("SELECT id FROM items WHERE title LIKE 'Tent%'"));

test("RW-09: beside a projected conflict, only the edited column acquires authorship", async () => {
  const { a, b } = await pendingTitle();
  const tent = tentOf(a);
  a.db.exec({ sql: "UPDATE items SET qty = 4 WHERE id = ?", bind: [tent] });
  expect(a.save()).not.toBeNull();
  expect(opsAt(a, lastSeq(a)), "the save writes qty, and no other column").toEqual([["items", [tent], "U", ["qty"]]]);
  await b.mergeFrom(await a.bytes());
  for (const c of [a, b]) {
    const pending = c.flags().find((f: Any) => f.kind === "pending");
    expect(JSON.parse(pending.detail).map((e: Any) => e.col), "the title conflict stands").toEqual(["title"]);
    expect(c.db.selectValue("SELECT qty FROM items WHERE id = ?", [tent])).toBe(4);
  }

  // The same beside a constraint conflict (M02), whose shown candidate is not the heads.
  const o = await base({
    extra: ["CREATE TABLE spans (id INTEGER PRIMARY KEY, start INTEGER NOT NULL, finish INTEGER NOT NULL, label TEXT, CHECK (start <= finish))", "INSERT INTO spans (id, start, finish) VALUES (1, 0, 10)"],
  });
  o.a.db.exec("UPDATE spans SET start = 8 WHERE id = 1");
  o.b.db.exec("UPDATE spans SET finish = 5 WHERE id = 1");
  const [ab, bb] = [await o.a.bytes(), await o.b.bytes()];
  await o.a.mergeFrom(bb);
  await o.b.mergeFrom(ab);
  // Which proposal is set aside follows the authors' order; either way the row shown is never the invalid (8, 5).
  expect(o.a.db.selectObject("SELECT start, finish FROM spans")).not.toEqual({ start: 8, finish: 5 });
  expect(o.a.flags().map((f: Any) => f.kind)).toEqual(["pending"]);
  o.a.db.exec("UPDATE spans SET label = 'A' WHERE id = 1");
  o.a.save();
  expect(opsAt(o.a, lastSeq(o.a)), "the label, never the shown start").toEqual([["spans", [1], "U", ["label"]]]);
  await o.b.mergeFrom(await o.a.bytes());
  for (const c of [o.a, o.b]) expect(c.flags().map((f: Any) => f.kind), "the constraint conflict stands").toEqual(["pending"]);
  for (const c of [a, b, o.a, o.b]) c.close();
});

test("RW-10: a local edit survives a remote reprojection, and no remote value enters the local log", async () => {
  const { a, b } = await base();
  const bread = item(a, "Bread");
  b.db.exec({ sql: "UPDATE items SET qty = 9 WHERE id = ?", bind: [bread] });
  const bBytes = await b.bytes();
  // A's edit to another column of the same row lands after A's last save and before the apply, as during the
  // verify wait: the apply freezes it into A's log first, then projects B's.
  a.save();
  const seq0 = lastSeq(a);
  a.db.exec({ sql: "UPDATE items SET note = 'A note' WHERE id = ?", bind: [bread] });
  const sib = await openBytes(bBytes);
  const m = merge as Any;
  const verdicts = await m.verifyBatches(sib.rows, m.mergeTablesOf(sib.rows), DOC);
  a.changes.trusted(() => m.mergeVerified(a.rows, sib.rows, { document: DOC, author: a.author.author, verdicts }));
  sib.db.close();
  a.changes.projectAdmitted();
  expect(a.db.selectObject("SELECT qty, note FROM items WHERE id = ?", [bread]), "both land").toEqual({ qty: 9, note: "A note" });
  const mine = a.written().map((w) => JSON.parse(w) as [string, string, string, string, unknown]).filter(([t, k, , ver]) => t === "items" && k === JSON.stringify([bread]) && Number(ver.split(":")[1]) > seq0);
  expect(mine.map(([, , col, , val]) => [col, val]), "A's log carries A's note, never B's qty").toEqual([["note", "A note"]]);
  expect(a.save(), "and nothing is left to log").toBeNull();
  a.close();
  b.close();
});

test("RW-11: a save that fails after extraction, after logging, or after the baseline leaves exactly the recoverable effects", async () => {
  // A clean run, for what each failed one must end equal to.
  const clean = await pendingTitle();
  clean.a.db.exec({ sql: "UPDATE items SET title = 'Tent (3p)' WHERE id = ?", bind: [tentOf(clean.a)] });
  clean.a.save();
  // The batch by shape: table, code and columns (each run's authors draw their own key range).
  const shape = (c: Copy, seq: number): unknown => opsAt(c, seq).map(([t, , code, cols]) => [t, code, cols]);
  const want = { flags: clean.a.flags(), ops: shape(clean.a, lastSeq(clean.a)) };
  expect(want.flags, "the resolution clears the flag").toEqual([]);

  for (const at of ["extraction", "logging", "baseline"] as const) {
    const { a, b } = await pendingTitle();
    const seq = lastSeq(a);
    a.db.exec({ sql: "UPDATE items SET title = 'Tent (3p)' WHERE id = ?", bind: [tentOf(a)] });
    const changes = a.changes as Any;
    const restore: (() => void)[] = [];
    const once = (obj: Any, name: string): void => {
      const original = obj[name];
      obj[name] = (...args: Any[]) => {
        obj[name] = original;
        throw new Error(`forced at ${at}`);
      };
      restore.push(() => (obj[name] = original));
    };
    if (at === "extraction") once(changes, "withBases");
    if (at === "logging") once(changes, "ingest");
    if (at === "baseline") once(changes, "project");
    let failed = false;
    try {
      a.save();
    } catch {
      failed = true;
    }
    for (const r of restore) r();
    if (at !== "baseline") expect(failed, `${at}: the save fails`).toBe(true);
    if (at !== "baseline") expect(lastSeq(a), `${at}: nothing of it is logged`).toBe(seq);
    a.save();
    expect(lastSeq(a), `${at}: one batch, once`).toBe(seq + 1);
    expect(shape(a, seq + 1), `${at}: the batch the clean run logged`).toEqual(want.ops);
    expect(a.save(), `${at}: nothing left to log`).toBeNull();
    expect(a.flags(), `${at}: the flags the clean run left`).toEqual(want.flags);
    a.close();
    b.close();
  }
  clean.a.close();
  clean.b.close();
});

/*
 * RW-12's outcome stands: a resolution to the displayed value is recorded
 * though no byte changed. Its mechanism, a write of the displayed value read
 * as a resolution, is retired by R-X: that SQL is indistinguishable from a
 * form writing an untouched field back. The resolution is the kit's explicit
 * call (`resolution.spec.ts`); the write is an echo.
 */
test("RW-12, under R-X: writing the displayed value back is an echo, which logs nothing and resolves nothing", async () => {
  const { a, b } = await pendingTitle();
  const tent = tentOf(a);
  const shown = a.db.selectValue("SELECT title FROM items WHERE id = ?", [tent]);
  const seq = lastSeq(a);
  a.db.exec({ sql: "UPDATE items SET title = ? WHERE id = ?", bind: [shown, tent] });
  expect(a.changes.dirty, "nothing to save").toBe(false);
  expect(a.save()).toBeNull();
  expect(lastSeq(a), "nothing logged").toBe(seq);
  expect(a.flags().map((f: Any) => f.kind), "still pending").toEqual(["pending"]);
  await b.mergeFrom(await a.bytes());
  expect(b.flags().map((f: Any) => f.kind), "and on the other copy").toEqual(["pending"]);
  a.close();
  b.close();
});
