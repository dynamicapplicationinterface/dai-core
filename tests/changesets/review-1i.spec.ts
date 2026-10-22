import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { type Copy } from "./copy.js";
import { base, SCENARIOS, verdictsOf } from "./scenarios.js";

/**
 * The review of Build 1i (`handoff-2026-10-19.md`, "Code review — PR #9,
 * Build 1i"): its low finding (1i-L1), red first.
 *
 * Retired at Build 2a: the tests of the review's observation (a replaced
 * capi.sqlite3_step or wasm.cstrToJs, or every handle, Stmt.prototype, capi,
 * pstack and wasm function replaced, ran no code on the runtime's path). R-Y
 * supersedes them: an ordinary document's database and runtime live in a
 * worker the shell makes, and the application's realm holds none of those
 * to replace. R-Y's red test, tests/changesets/authority.spec.ts, holds that
 * boundary through the real runtime.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/* ---------------------------------------------- 1i-L1: an earlier receipt, read by the same rule */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.platform === "win32" ? "python" : "python3";
const rejected = (c: Copy): [string, string][] => c.changes.refusedChanges().map((r: Any) => [r.ver, r.reason]);
const judged = (c: Copy): unknown => ({
  tables: c.dump(),
  flags: c.flags().map((f) => [f.tbl, f.pk, f.kind]).sort(),
  held: c.held().map((h) => [h.tbl, h.pk]).sort(),
  rejected: rejected(c).sort(),
});

test('1i-L1: F signs ["9", d] for A, then an honest batch: both readers refuse the first and accept the second, the same table', async () => {
  const { a, b } = await base();
  await SCENARIOS["1i-L1 string seq, then honest"]!.write(a, b);
  const aBytes = await a.bytes();
  const bBytes = await b.bytes();
  const dir = mkdtempSync(join(tmpdir(), "dai-1i-l1-"));
  writeFileSync(join(dir, "s-a.db"), aBytes);
  writeFileSync(join(dir, "s-b.db"), bBytes);
  writeFileSync(join(dir, "s-verdicts.json"), JSON.stringify({ a: await verdictsOf(aBytes), b: await verdictsOf(bBytes) }));
  await a.mergeFrom(bBytes);
  await b.mergeFrom(aBytes);
  for (const [c, dir] of [[a, "ab"], [b, "ba"]] as const) {
    const refused = rejected(c);
    expect(refused.map(([, why]) => why), `${dir}: one batch refused, for its receipt's shape`).toEqual(["receipt-forged"]);
    const fHex = refused[0]![0].split(":")[0]!;
    const last = `${fHex}:${c.db.selectValue("SELECT max(_r_seq) FROM _cs_log WHERE lower(hex(_r_replica)) = ?", [fHex])}`;
    expect(refused[0]![0], `${dir}: the refused batch is F's first, not its honest second`).not.toBe(last);
    expect(c.rows.all("SELECT 1 FROM _cs_cell WHERE ver = ?", [last]), `${dir}: F's honest retitle is applied`).toHaveLength(1);
  }
  expect(a.state(), "the copies converge").toBe(b.state());
  const run = spawnSync(PYTHON, ["-I", join(repo, "conformance", "reference", "dai_changes.py"), dir], { encoding: "utf8" });
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  const lines = run.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  expect(lines.map((l) => l.direction).sort()).toEqual(["ab", "ba"]);
  for (const line of lines) {
    expect(line.refused, line.direction).toEqual([]);
    expect({ tables: line.tables, flags: line.flags, held: line.held, rejected: line.rejected }, `the Python reader, ${line.direction}`).toEqual(
      judged(line.direction === "ab" ? a : b),
    );
  }
  a.close();
  b.close();
});
