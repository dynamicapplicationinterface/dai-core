import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { WORKER } from "../src/worker.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worker = readFileSync(resolve(repo, "apps/runner/public/sw.js"), "utf8");

/**
 * The service worker's names, held to their owner (D72).
 *
 * `sw.js` is a classic worker and cannot import `src/worker.ts`, so it spells
 * these four by hand. That is the kit's arrangement and it has the kit's
 * danger: two files, one namespace, and nothing that sees both. Here is the
 * thing that sees both.
 *
 * Read from the file's text rather than by running it: a service worker cannot
 * be imported into a test, and what matters is the literal on the line, which
 * is what a running worker will send.
 */
test.describe("the names the opener and its worker share", () => {
  test("every one the owner holds is spelled that way in sw.js", () => {
    const missing = Object.entries(WORKER)
      .filter(([, value]) => !worker.includes(`"${value}"`))
      .map(([key, value]) => `${key} ("${value}")`);
    expect(missing, `named in src/worker.ts and not spelled in sw.js:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  test("and sw.js spells no dai: message the owner does not hold", () => {
    /*
     * The other direction, which is how a namespace grows a name nobody owns.
     *
     * Two exceptions, each named rather than pattern-matched:
     * - `dai:isolation-report` is the bridge's, posted by document-carried
     *   code, and `src/bridge.ts` owns it (the same exception names-check
     *   makes).
     * - `dai:ground:` and `dai:mailbox:` are prefixes of storage keys and
     *   mailbox labels, not messages, and belong to D73 and `src/mailbox.ts`.
     */
    const allowed = new Set<string>([...Object.values(WORKER), "dai:isolation-report"]);
    const prefixes = ["dai:ground:", "dai:mailbox:"];
    const spelled = [...worker.matchAll(/"(dai:[a-z][a-z0-9:-]*)"/g)].map((match) => match[1]!);
    const unowned = [...new Set(spelled)]
      .filter((name) => !allowed.has(name) && !prefixes.some((prefix) => name.startsWith(prefix)))
      .sort();
    expect(unowned, `spelled in sw.js and owned nowhere:\n  ${unowned.join("\n  ")}`).toEqual([]);
  });

  test("the reading finds what it found when it was written", () => {
    // A regular expression that stops matching would make both tests above
    // pass by finding nothing.
    const spelled = [...worker.matchAll(/"(dai:[a-z][a-z0-9:-]*)"/g)].map((match) => match[1]!);
    expect(spelled.length, "sw.js still spells dai: names this test can see").toBeGreaterThanOrEqual(4);
  });
});
