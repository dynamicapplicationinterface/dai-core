/**
 * The count gate over CI's browser parts (C8).
 *
 *     node scripts/count-parts.mjs <dir>   # dir holds one folder per part's kept report
 *
 * A shard's passed count is a fraction of the floor by intent, so the count
 * gate (tests/count-gate.ts) does not hold a part to it. Until 19 October that
 * left WebKit held by nothing: its count was "covered" by the whole engines,
 * which drop the same count when a test stops being collected — unless the
 * test stopped being collected on WebKit only. Chromium is sharded now too, so
 * nothing whole would be left to cover either.
 *
 * So every gating browser part keeps its count report (test.yml uploads
 * test-results/count-gate.json as count-<browser>-<part>), and the count-gate
 * job adds them up per project and holds the sum to the same rule a whole run
 * is held to (scripts/lib/count-check.mjs): every project at or above its
 * floor, every skip with its reason. A part with no report gave no count, so
 * the sum is not a sum: that is red by name, never read as zero.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BROWSER_PARTS, countArtifact } from "./ci-verdict.mjs";
import { countComplaints } from "./lib/count-check.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLOOR = join(repo, "tests", "count-floor.json");

/**
 * The sum of the parts and what the gate says about it. `reportOf(artifact)`
 * is a part's report, or undefined when it kept none.
 */
export function sumParts(reportOf, held) {
  const passed = {};
  const unexplained = [];
  const complaints = [];
  for (const part of BROWSER_PARTS) {
    const artifact = countArtifact(part);
    const report = reportOf(artifact);
    if (!report || typeof report.passed !== "object") {
      complaints.push(`${artifact}: no count report from that part, so the sum of the parts is not the suite's count.`);
      continue;
    }
    for (const [project, count] of Object.entries(report.passed)) passed[project] = (passed[project] ?? 0) + count;
    unexplained.push(...(report.unexplained ?? []));
  }
  complaints.push(...countComplaints(passed, held, unexplained));
  return { passed, complaints };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/count-parts.mjs <dir of count-<browser>-<part> folders>");
    process.exit(2);
  }
  const held = JSON.parse(readFileSync(FLOOR, "utf8"));
  const reportOf = (artifact) => {
    const file = join(dir, artifact, "count-gate.json");
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  };
  const { passed, complaints } = sumParts(reportOf, held);
  console.log(`count gate, the sum of ${BROWSER_PARTS.length} parts: ${JSON.stringify(passed)}`);
  for (const complaint of complaints) console.error(`count gate: ${complaint}`);
  process.exit(complaints.length === 0 ? 0 : 1);
}
