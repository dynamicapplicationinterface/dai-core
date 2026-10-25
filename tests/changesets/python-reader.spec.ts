import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { SCENARIOS, base, verdictsOf } from "./scenarios.js";
import type { Copy } from "./copy.js";

/**
 * The Python reader applies changesets under the same policy.
 *
 * Every scenario's two pre-exchange copies go to the reference reader, which
 * admits the log with dai_merge.py (the authorship layer, unchanged) and then
 * rebuilds the application's tables from the admitted log alone
 * (conformance/reference/dai_changes.py). Its tables, flags and held rows must
 * equal the runtime's after the same merge, in both directions.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.platform === "win32" ? "python" : "python3";

const judged = (c: Copy): unknown => ({
  tables: c.dump(),
  flags: c.flags().map((f) => [f.tbl, f.pk, f.kind]).sort(),
  held: c.held().map((h) => [h.tbl, h.pk]).sort(),
  rejected: c.changes.refusedChanges().map((r: { ver: string; reason: string }) => [r.ver, r.reason]).sort(),
});

test("the Python reader agrees with the runtime in every scenario, both directions", async () => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), "dai-cs-python-"));
  const runtime = new Map<string, unknown>();
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const file = name.replace(/\W+/g, "-");
    const { a, b } = await base({ trigger: scenario.trigger, extra: scenario.extra });
    await scenario.write(a, b);
    const aBytes = await a.bytes();
    const bBytes = await b.bytes();
    writeFileSync(join(dir, `${file}-a.db`), aBytes);
    writeFileSync(join(dir, `${file}-b.db`), bBytes);
    writeFileSync(join(dir, `${file}-verdicts.json`), JSON.stringify({ a: await verdictsOf(aBytes), b: await verdictsOf(bBytes) }));
    await a.mergeFrom(bBytes);
    await b.mergeFrom(aBytes);
    runtime.set(`${file} ab`, judged(a));
    runtime.set(`${file} ba`, judged(b));
    a.close();
    b.close();
  }
  // UTF-8 out, whatever the console's own encoding (-I ignores PYTHONIOENCODING): a value outside the BMP (D289) is printed as it is.
  const run = spawnSync(PYTHON, ["-I", "-X", "utf8", join(repo, "conformance", "reference", "dai_changes.py"), dir], { encoding: "utf8" });
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  const lines = run.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  expect(lines.length).toBe(runtime.size);
  for (const line of lines) {
    const key = `${line.name} ${line.direction}`;
    expect(line.refused, key).toEqual([]);
    expect({ tables: line.tables, flags: line.flags, held: line.held, rejected: line.rejected }, key).toEqual(runtime.get(key));
  }
});
