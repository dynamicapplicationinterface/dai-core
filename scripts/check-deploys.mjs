/**
 * Asks each deployment which commit it is serving.
 *
 * Production is promoted by hand, so a push is not a release and nothing on the
 * machine knows the difference. This turns "is it live" into one command with
 * an answer, instead of an inference from a bundle that may not have changed
 * for reasons of its own.
 *
 *     npm run deploys
 *
 * Exits non-zero when a site is serving something other than the commit checked
 * out here, so it can gate anything that ought to wait for a promotion. A
 * deployment reporting `preview` is one that was built and never promoted,
 * which is indistinguishable from a live one to anybody looking at the page.
 */
import { execSync } from "node:child_process";

const SITES = [
  { name: "website", url: "https://www.dynamicapplicationinterface.io/version.json" },
  { name: "opener", url: "https://opendai.app/version.json" },
];

const head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const short = (sha) => (sha && sha !== "unknown" ? sha.slice(0, 7) : String(sha));

console.log(`this checkout: ${short(head)}\n`);

let stale = 0;

for (const site of SITES) {
  let stamp;
  try {
    const response = await fetch(`${site.url}?at=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    stamp = await response.json();
  } catch (error) {
    // A site with no stamp is not necessarily broken: it may simply be serving
    // a build from before this existed, which is itself the answer.
    console.log(`${site.name.padEnd(8)} no version.json (${String(error)})`);
    stale += 1;
    continue;
  }

  const current = stamp.commit === head;
  const promoted = stamp.environment === "production";
  const note = current
    ? promoted
      ? "current"
      : `current, but this is a ${stamp.environment} deployment — promote it`
    : `serving ${short(stamp.commit)}, built ${stamp.builtAt}`;

  console.log(`${site.name.padEnd(8)} ${current && promoted ? "ok " : "-> "} ${note}`);
  if (!current || !promoted) stale += 1;
}

if (stale > 0) {
  console.log(`\n${stale} deployment${stale === 1 ? "" : "s"} not serving ${short(head)}.`);
  process.exit(1);
}
