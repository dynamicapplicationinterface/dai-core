import { expect, test } from "@playwright/test";
import { Copy, person } from "./copy.js";
import { SCENARIOS, base, exchange, item, forgingFull } from "./scenarios.js";

/**
 * The review of Build 1h (`handoff-2026-10-19.md`, "Code review — PR #9,
 * Build 1h"): its receipt finding (1h-M1) and its version-grammar finding
 * (1h-L1), each red first.
 *
 * Retired at Build 2a: the tests of 1h-H1 (application code ran as the
 * runtime through a replaced handle or Stmt.prototype method) and 1h-M2 (a
 * VACUUM's exec ran application code by five routes). R-Y supersedes them:
 * an ordinary document's database and runtime live in a worker the shell
 * makes, and the application holds no handle, statement, capi or engine
 * memory to replace. R-Y's red test, tests/changesets/authority.spec.ts,
 * holds that boundary through the real runtime.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/* ------------------------------------------------------------ 1h-M1: receipts */

const rejected = (c: Copy): [string, string][] => c.changes.refusedChanges().map((r: Any) => [r.ver, r.reason]);
/** F's own version at its highest seq. */
const fVer = (f: Copy): string => `${f.changes.authorHex}:${f.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE _r_replica = ?", [f.author.author])}`;

function pendingTitles(c: Copy, tent: number): unknown[] {
  const flag = c.flags().find((x: Any) => x.tbl === "items" && x.pk === JSON.stringify([tent]) && x.kind === "pending");
  if (!flag) return [];
  for (const e of JSON.parse(flag.detail) as Any[]) if (e.col === "title") return e.values.map((v: Any) => v.val);
  return [];
}

/**
 * 1h-M1's arrangement: F opened from A's base and edited elsewhere (so its clock runs ahead), never having
 * seen A retitle Tent. F then edits Tent, its basis naming A's retitle, and signs a receipt it did not earn.
 * The reader A holds its own batches, so it checks each receipt entry against the batch it holds.
 */
async function arrange(): Promise<{ a: Copy; f: Copy; tent: number; aTitle: string }> {
  const { a, b } = await base();
  b.close();
  const tent = item(a, "Tent");
  const f = await Copy.open(await person(), await a.bytes(), a.schema);
  for (const note of ["f1", "f2", "f3"]) {
    f.db.exec({ sql: "UPDATE items SET note = ? WHERE title = 'Rope'", bind: [note] });
    f.save();
  }
  a.db.exec({ sql: "UPDATE items SET title = 'Tent (A)' WHERE id = ?", bind: [tent] });
  a.save();
  const aTitle = `${a.changes.authorHex}:${a.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE _r_replica = ?", [a.author.author])}`;
  return { a, f, tent, aTitle };
}

/** F's title edit, its basis naming A's retitle (so it would erase it) and its receipt forged by `receipt`. */
function forgeTitle(f: Copy, tent: number, aTitle: string, receipt: (r: Map<string, Any>) => Map<string, Any> | void): void {
  f.db.exec({ sql: "UPDATE items SET title = 'Tent (F)' WHERE id = ?", bind: [tent] });
  forgingFull(f, {
    bases: (op) => {
      if (op[0] === "items" && op[3] instanceof Map && op[3].has("title")) op[5].set("title", [...(op[5].get("title") ?? []), aTitle]);
    },
    receipt,
  });
}

test("1h-M1 control: an honest edit and receipt are accepted; A's retitle and F's are both pending", async () => {
  const { a, f, tent } = await arrange();
  // F's honest edit supersedes only what it showed (A's base title); its receipt is what the runtime built.
  f.db.exec({ sql: "UPDATE items SET title = 'Tent (F)' WHERE id = ?", bind: [tent] });
  f.save();
  await a.mergeFrom(await f.bytes());
  expect(rejected(a), "nothing refused").toEqual([]);
  expect(pendingTitles(a, tent).sort(), "both titles pending").toEqual(["Tent (A)", "Tent (F)"]);
  a.close();
  f.close();
});

for (const [name, receipt] of [
  ["raised to a seq it did not receive, with a forged digest", (r: Map<string, Any>, aTitle: string): void => void r.set(aTitle.split(":")[0]!, [Number(aTitle.split(":")[1]), "00000000000000000000000000000000"])],
  ["a seq at or above its own clock", (r: Map<string, Any>, aTitle: string): void => void r.set(aTitle.split(":")[0]!, [999, "00000000000000000000000000000000"])],
] as const) {
  test(`1h-M1: a receipt ${name} is refused; A's retitle stands`, async () => {
    const { a, f, tent, aTitle } = await arrange();
    forgeTitle(f, tent, aTitle, (r) => receipt(r, aTitle));
    const fv = fVer(f);
    await a.mergeFrom(await f.bytes());
    expect(rejected(a), `${name}: refused receipt-forged`).toEqual([[fv, "receipt-forged"]]);
    expect(a.db.selectValue("SELECT title FROM items WHERE id = ?", [tent]), "A's retitle stands").toBe("Tent (A)");
    expect(a.rows.all("SELECT 1 FROM _cs_cell WHERE ver = ?", [fv]), "F's version in no cell").toEqual([]);
    a.close();
    f.close();
  });
}

test("1h-M1: a receipt going backwards between two of a signer's batches is refused", async () => {
  const { a, f } = await arrange();
  const by = a.changes.authorHex;
  // F's first batch carries its honest receipt (it holds A's base batch); its second un-claims it — backwards.
  f.db.exec({ sql: "UPDATE items SET note = 'f-first' WHERE title = 'Rope'" });
  f.save();
  const first = fVer(f);
  f.db.exec({ sql: "UPDATE items SET note = 'f-second' WHERE title = 'Rope'" });
  forgingFull(f, { receipt: (r) => void r.delete(by) });
  const second = fVer(f);
  await a.mergeFrom(await f.bytes());
  const reasons = Object.fromEntries(rejected(a));
  expect(reasons[first], "the first, honest batch is not refused").toBeUndefined();
  expect(reasons[second], "the backwards batch refused").toBe("receipt-forged");
  a.close();
  f.close();
});

/* ------------------------------------------------------------ 1h-L1: one seq grammar */

for (const [label, scenario] of [
  ["a Unicode digit", "1h-L1 non-ascii seq"],
  ["leading whitespace", "1h-L1 space seq"],
] as const) {
  test(`1h-L1: a version seq written with ${label} is refused basis-forged by both copies, the same word`, async () => {
    const o = await exchange(SCENARIOS[scenario]!.write);
    expect(o.converged, "converged").toBe(true);
    const reasons = rejected(o.a);
    expect(reasons.map(([, r]) => r), "refused basis-forged").toEqual(["basis-forged"]);
    expect(rejected(o.b), "the same on the copy that carried it").toEqual(reasons);
    for (const c of [o.a, o.b]) {
      expect(c.db.selectValue("SELECT title FROM items WHERE title LIKE 'Tent%'"), "A's edit stands").toBe("Tent (A)");
      expect(c.rows.all("SELECT 1 FROM _cs_cell WHERE ver = ?", [reasons[0]![0]]), "F's version in no cell").toEqual([]);
    }
    o.a.close();
    o.b.close();
  });
}
