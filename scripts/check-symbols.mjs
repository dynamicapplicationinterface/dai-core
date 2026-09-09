/**
 * Syntax errors and undefined names, in the directories nothing else checks.
 *
 *     node scripts/check-symbols.mjs
 *
 * `tsconfig.json` covers `src` alone. `tests/` and `apps/runner/src` were
 * checked by no tsc invocation at all, and both shipped a defect through the
 * gap: a call to `describeMerge`, which did not exist, built cleanly and would
 * have thrown when somebody pressed the merge button; and an unterminated
 * string in a reporter passed `npm run typecheck` and failed later inside
 * Playwright's own parser, reported as a Babel error with nothing pointing at
 * the edit that caused it.
 *
 * This reports only those two classes. Holding those directories to the full
 * `strict` + `noUncheckedIndexedAccess` of the main project produces thirty-odd
 * findings that are almost entirely lib noise — `Uint8Array<ArrayBufferLike>`
 * against `BufferSource`, vite's `?raw` imports, Node and DOM disagreeing about
 * `crypto` — and no defects. A check that reports thirty things nobody will fix
 * is a check somebody turns off, and then the two that mattered go with it.
 *
 * So the filter is deliberate and narrow: a name that does not exist, and a
 * file that does not parse. Both real defects fail here; nothing else does.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Syntax (TS1xxx), and "cannot find name" / "did you mean" (TS2304, TS2552). */
const WANTED = /error (TS1\d{3}|TS2304|TS2552):/;

let output = "";
try {
  execFileSync("npx", ["tsc", "-p", "tsconfig.tests.json"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
} catch (error) {
  // tsc exits non-zero for the pre-existing findings this deliberately
  // ignores, so a non-zero exit is not the signal — the lines are.
  output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}

const found = output.split(/\r?\n/).filter((line) => WANTED.test(line));

if (found.length > 0) {
  console.error("A name that does not exist, or a file that does not parse:\n");
  for (const line of found) console.error(`  ${line}`);
  console.error(
    "\nBoth are the failure modes this check exists for. Neither is reported by " +
      "`npm run typecheck`, which does not cover these directories, nor by vite, " +
      "which does not typecheck at all.",
  );
  process.exit(1);
}

console.log("tests and apps/runner: no undefined names, nothing unparseable");
