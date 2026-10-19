/**
 * The count gate's rule, in one place: a run's passed count per project
 * against the floor, and its unexplained skips. tests/count-gate.ts holds a
 * whole run to it; scripts/count-parts.mjs holds the sum of CI's parts to it
 * (the sharded engines, whose single parts are fractions by intent).
 *
 * @param {Record<string, number>} passed  passed tests per project
 * @param {Record<string, unknown>} held   the floor (tests/count-floor.json)
 * @param {string[]} unexplained           tests skipped with no reason given
 * @returns {string[]} the complaints; none is a pass
 */
export function countComplaints(passed, held, unexplained) {
  const complaints = [];
  // A project that ran and has no floor is a project nothing holds: every
  // test in it could stop being collected and this gate would say nothing.
  // Adding a project means adding its floor in the same change.
  for (const project of Object.keys(passed)) {
    if (held[project] === undefined) {
      complaints.push(
        `${project}: ran, and has no floor in tests/count-floor.json, so a drop in it would go unseen. ` +
          "Set one from a whole run with DAI_UPDATE_FLOOR=1.",
      );
    }
  }
  for (const [project, minimum] of Object.entries(held)) {
    // `_from` records which CI run the floor was taken from; not a project.
    if (project.startsWith("_") || typeof minimum !== "number") continue;
    // A project that did not run this time is not a project that shrank.
    const ran = passed[project];
    if (ran === undefined || ran >= minimum) continue;
    complaints.push(
      `${project}: ${ran} passed, and this suite has held at least ${minimum}. ` +
        "Tests that stop being collected report as success, so a drop is a failure here. " +
        "If the removal is deliberate, lower the floor in tests/count-floor.json in the same commit.",
    );
  }
  for (const name of unexplained) {
    complaints.push(`skipped with no reason given: ${name} — use test.skip(condition, "why").`);
  }
  return complaints;
}
