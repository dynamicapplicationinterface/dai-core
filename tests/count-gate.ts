import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLOOR = join(repo, "tests", "count-floor.json");

/**
 * A run that quietly got smaller is a failed run.
 *
 * A change once took six tests out of the suite and the run still exited zero:
 * the tests did not fail, they stopped being tests — the assertions moved to a
 * shape nothing collected any more. What caught it was noticing that the
 * number printed at the end had gone from 748 to 739, by eye, three commits
 * later than it should have been noticed. Nothing else would have caught it,
 * because every signal a green run produces was green.
 *
 * So the count is a gate. It is crude on purpose: it holds a floor, not an
 * exact figure, so adding tests never needs a ceremony and removing them
 * always does. Raise the floor when the suite grows —
 * `DAI_UPDATE_FLOOR=1 npm test` writes what actually ran — and lowering it is a
 * deliberate edit somebody has to justify in a diff. An environment variable
 * and not a flag: Playwright rejects command-line options it does not know,
 * and exits zero while doing it. Held per project, so a run of one engine is still a
 * whole run of that engine and still gated.
 *
 * One hole worth knowing: `--reporter=` on the command line *replaces* the
 * reporters in the config, this one included. `npm test` and CI go through the
 * config and are gated; an ad-hoc run with an explicit reporter is not.
 *
 * Skips are held to the same standard for the same reason: a test that skips
 * itself on a condition that silently stopped holding is a test that is not
 * running, and it reports as success. One that is meant to skip says so:
 *
 *     test.skip(condition, "why this cannot run here");
 *
 * An unexplained skip fails the run.
 */
export default class CountGate implements Reporter {
  /** Per project, because a run of one engine is still a whole run of that engine. */
  private readonly passed = new Map<string, number>();
  private readonly unexplained: string[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? "unknown";
    if (result.status === "passed") this.passed.set(project, (this.passed.get(project) ?? 0) + 1);
    if (result.status !== "skipped") return;
    // Playwright records the reason a skip was asked for as an annotation.
    // One with nothing said about it is the case this exists to catch.
    const said = test.annotations.some(
      (note) => (note.type === "skip" || note.type === "fixme") && (note.description ?? "").trim().length > 0,
    );
    if (!said) this.unexplained.push(test.titlePath().slice(1).join(" › "));
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult["status"] } | void> {
    // Only a whole run of a project can be measured. A filtered run — named
    // files, or -g — is smaller by intent and says nothing about the suite.
    const filtered =
      process.argv.some((argument) => argument === "-g" || argument === "--grep") ||
      // A `--shard=i/n` run holds only its slice of the suite, so its passing
      // count is a fraction of the floor by intent — gating it would fail every
      // shard. The unsharded engines (chromium, firefox) stay gated, and a test
      // that stops being collected drops their counts too, so the shrink guard
      // still bites; a sharded engine is covered by them.
      process.argv.some((argument) => argument === "--shard" || argument.startsWith("--shard=")) ||
      process.argv.slice(2).some((argument) => !argument.startsWith("-") && argument.includes("spec"));

    let held: Record<string, number> = {};
    try {
      held = JSON.parse(readFileSync(FLOOR, "utf8")) as Record<string, number>;
    } catch {
      held = {};
    }

    if (process.env.DAI_UPDATE_FLOOR) {
      if (filtered) {
        console.error("count gate: refusing to set a floor from a filtered run.");
        return { status: "failed" };
      }
      // Merged, so setting one engine's floor does not erase the others'.
      const written: Record<string, number> = { ...held };
      for (const [project, count] of this.passed) written[project] = count;
      writeFileSync(FLOOR, `${JSON.stringify(written, null, 2)}
`, "utf8");
      console.log(`count gate: floor now ${JSON.stringify(written)}`);
      return;
    }

    if (filtered) return;

    const complaints: string[] = [];
    for (const [project, minimum] of Object.entries(held)) {
      // A project that did not run this time is not a project that shrank.
      const ran = this.passed.get(project);
      if (ran === undefined || ran >= minimum) continue;
      complaints.push(
        `${project}: ${ran} passed, and this suite has held at least ${minimum}. ` +
          "Tests that stop being collected report as success, so a drop is a failure here. " +
          "If the removal is deliberate, lower the floor in tests/count-floor.json in the same commit.",
      );
    }
    for (const name of this.unexplained) {
      complaints.push(`skipped with no reason given: ${name} — use test.skip(condition, "why").`);
    }
    if (complaints.length === 0) return;

    for (const complaint of complaints) console.error(`count gate: ${complaint}`);
    return { status: result.status === "passed" ? "failed" : result.status };
  }
}
