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
  { name: "website", origin: "https://www.dynamicapplicationinterface.io" },
  { name: "opener", origin: "https://opendai.app" },
];

/**
 * The build id the page itself carries.
 *
 * `version.json` is a file beside the page; the meta tag is in the bytes that
 * run. During a promotion the two disagreed for several minutes — the page
 * served the new build while the sidecar still answered with the old one —
 * and reading only the sidecar produced two confident wrong answers about
 * whether a fix was live.
 *
 * So both are read, and a disagreement is reported rather than resolved,
 * because which one is right depends on which one you were about to trust.
 * The page wins when they differ: it is what a person is looking at.
 */
async function pageStamp(origin) {
  try {
    const response = await fetch(`${origin}/?at=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const html = await response.text();
    return /name="dai-build" content="([^"]*)"/.exec(html)?.[1] ?? null;
  } catch {
    return null;
  }
}

const head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const short = (sha) => (sha && sha !== "unknown" ? sha.slice(0, 7) : String(sha));

console.log(`this checkout: ${short(head)}\n`);

let stale = 0;

for (const site of SITES) {
  let stamp;
  try {
    const response = await fetch(`${site.origin}/version.json?at=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    stamp = await response.json();
  } catch (error) {
    // A site with no stamp is not necessarily broken: it may simply be serving
    // a build from before this existed, which is itself the answer.
    console.log(`${site.name.padEnd(8)} no version.json (${String(error)})`);
    stale += 1;
    continue;
  }

  // What the running page says about itself, beside what the file says.
  const onPage = await pageStamp(site.origin);
  const pageCommit = onPage ? onPage.split(" ")[0] : null;
  if (pageCommit && pageCommit !== short(stamp.commit)) {
    console.log(
      `${site.name.padEnd(8)} !!  the page says ${pageCommit}, version.json says ${short(stamp.commit)}. ` +
        "A promotion in flight looks like this for a few minutes; the page is the one running.",
    );
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
