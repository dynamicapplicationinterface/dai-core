/**
 * A same-origin `page.route` mock in a test that does not block the worker.
 *
 *     node scripts/check-routes.mjs
 *
 * The runner registers a service worker that claims the page and answers
 * same-origin GETs from a cache-first `fetch` handler. When it controls the
 * page, a request the app makes is served by the worker and never reaches
 * `page.route` — so the mock is silently bypassed. Whether the worker wins is a
 * timing race, so the test passes on one machine and fails on another. This has
 * cost the project three times (the reference-link head, stale route globs, and
 * a mocked roots.json / aborted sqlite3 both served by the worker). The fix is
 * one line — `test.use({ serviceWorkers: "block" })` — and the knowledge did not
 * travel on its own, so this makes the build carry it. See tests/README.md.
 *
 * Scope, kept narrow so it reports defects and not noise:
 *   - Only `page.route` / `context.route` whose pattern is SAME-ORIGIN: a
 *     relative glob (a leading `**`, `/`, or `.`) or one of the app origins the suite
 *     serves (localhost:5174/5175/5176). A cross-origin absolute URL — a relay
 *     on another host or port — is outside the worker's scope and never
 *     intercepted, so it is ignored (that is how the relay and store mocks are
 *     allowed to stand without blocking the worker).
 *   - A file that contains `serviceWorkers: "block"` anywhere is treated as
 *     handled. The mitigation is set per-describe/test with `test.use`, and the
 *     files that need it scope it to the describe that mocks; a file-level proxy
 *     is enough for a cheap guard and matches how the standing examples are
 *     written.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests");

/** The origins the suite serves itself, where its own worker can take control. */
const APP_ORIGINS = ["localhost:5174", "localhost:5175", "localhost:5176"];

/**
 * Every `page.route("<pattern>"` — capturing the first string arg.
 *
 * `page.route` only; `context.route` is deliberately not flagged. A page route
 * never sees a request the service worker makes — that is the whole bug — so a
 * same-origin page route is bypassed the moment the worker controls the page.
 * A context route does see the worker's own requests (on the engines where
 * Playwright supports it), and is the correct tool for a test whose request is
 * made BY the worker, such as reference-head. Flagging it would push those
 * toward blocking the very worker they exist to exercise.
 */
const ROUTE = /\bpage\.route\(\s*(["'`])([^"'`]+)\1/g;

/**
 * Does this route pattern name a same-origin request the runner's worker could
 * serve? A relative glob does; an app-origin URL does; a URL to any other host
 * or port does not (the worker's scope does not reach it).
 */
function sameOrigin(pattern) {
  const absolute = /^[a-z]+:\/\//i.test(pattern);
  if (!absolute) return true; // a relative glob matches this origin too
  try {
    const { host } = new URL(pattern.replace(/\*/g, "x"));
    return APP_ORIGINS.includes(host);
  } catch {
    return false; // an unparseable absolute-looking pattern is not our concern
  }
}

const offenders = [];
for (const name of readdirSync(testsDir)) {
  if (!name.endsWith(".spec.ts")) continue;
  const source = readFileSync(join(testsDir, name), "utf8");
  if (source.includes('serviceWorkers: "block"') || source.includes("serviceWorkers: 'block'")) {
    continue;
  }
  for (const match of source.matchAll(ROUTE)) {
    if (!sameOrigin(match[2])) continue;
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    offenders.push({ name, line, pattern: match[2] });
  }
}

if (offenders.length > 0) {
  console.error(
    "A same-origin page.route mock in a test that does not block the service worker:\n",
  );
  for (const o of offenders) console.error(`  tests/${o.name}:${o.line}  route("${o.pattern}")`);
  console.error(
    "\nThe runner's worker serves same-origin requests cache-first and wins the race\n" +
      "non-deterministically, so the mock is bypassed on some machines and not others.\n" +
      'Add `test.use({ serviceWorkers: "block" })` to the describe that mocks. See\n' +
      "tests/README.md, and idb-timeout / launch-failsafe / the write-rules specs.",
  );
  process.exit(1);
}

console.log("routes: every same-origin page.route mock blocks the service worker");
