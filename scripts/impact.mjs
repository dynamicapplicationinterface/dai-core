/**
 * The specs a change can affect.
 *
 *     git diff --name-only HEAD | node scripts/impact.mjs
 *     node scripts/impact.mjs src/link.ts tests/sender.spec.ts
 *     node scripts/impact.mjs --explain src/link.ts
 *
 * Prints the spec files to run, one per line, or `ALL` when only a full run
 * will do. `--explain` also says which changed file pulled each one in. A
 * check that is not a spec prints as `check:<name>` (CHECKS below).
 *
 * The map is computed here from the specs as they are now (scripts/impact-map.mjs),
 * never read from the checked-in copy, so a stale map cannot under-select.
 * It errs wide on purpose:
 *
 *   - a file every run depends on (config, global setup, the build's own
 *     steps, this script) is a full run;
 *   - a source file no spec claims — new, or unclaimed — is a full run too,
 *     because "no spec is known to reach it" is not the same as "nothing
 *     reaches it";
 *   - a changed spec always runs itself.
 *
 * This chooses the subset for the inner tiers only. The push tier and CI run
 * everything and never ask it. Run less must not become check less.
 */
import { existsSync, readFileSync } from "node:fs";
import { build, covers } from "./impact-map.mjs";

const args = process.argv.slice(2);
const explain = args.includes("--explain");
let changed = args.filter((arg) => arg !== "--explain");
if (changed.length === 0 && !process.stdin.isTTY) changed = readFileSync(0, "utf8").split(/\r?\n/);
changed = [...new Set(changed.map((file) => file.trim().replace(/\\/g, "/")).filter(Boolean))];

/** Where source lives; kept in step with SCOPE in impact-map.mjs. */
const SOURCE = ["src/", "apps/", "website/", "examples/", "scripts/", "conformance/", "crates/", "eval/", "tests/"];

/**
 * Checks that are not specs, chosen by path (pass C's M6). A change under
 * docs/ selected no test: docs/spec-v0.2.md and docs/cddl.md are read by
 * `build-conformance.mjs --check`, and docs/format.md and
 * docs/replicated-tables.md are what the readers are written from.
 */
const CHECKS = [{ name: "build-conformance", when: (file) => file.startsWith("docs/") }];

const map = build();
const picked = new Map();
const all = [];

for (const file of changed) {
  if (map.global.includes(file)) {
    all.push(`${file} is something every run depends on`);
    continue;
  }
  if (map.specs[file]) {
    picked.set(file, [...(picked.get(file) ?? []), `${file} (the spec itself)`]);
    continue;
  }
  const claimed = Object.entries(map.specs).filter(([, claims]) => covers(claims, file));
  for (const [spec] of claimed) picked.set(spec, [...(picked.get(spec) ?? []), file]);
  if (claimed.length === 0 && SOURCE.some((prefix) => file.startsWith(prefix)) && existsSync(file)) {
    all.push(`no spec is known to reach ${file}`);
  }
}

if (all.length > 0) {
  console.log("ALL");
  if (explain) for (const reason of all) console.error(`full run: ${reason}`);
} else {
  for (const check of CHECKS) {
    const because = changed.filter(check.when);
    if (because.length === 0) continue;
    console.log(`check:${check.name}`);
    if (explain) console.error(`  check ${check.name} <- ${because.join(", ")}`);
  }
  for (const [spec, because] of [...picked].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(spec);
    if (explain) console.error(`  ${spec} <- ${because.join(", ")}`);
  }
  if (explain && picked.size === 0 && !CHECKS.some((check) => changed.some(check.when))) console.error("nothing a spec reaches changed");
}
