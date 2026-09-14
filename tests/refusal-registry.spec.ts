import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { REFUSALS } from "../src/refusals.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every refusal the source can raise is in the registry (backlog D2).
 *
 * `site-claims.spec.ts` holds the host-bridge table to the registry: every
 * registered name is documented. That check ran one way only, and passed
 * while the codes an application author actually meets — the replicated
 * tables' triggers, the write surface, the merge, the mailbox — were thrown in
 * the frame and registered nowhere: a checker covering less than it appeared
 * to. This runs the other way. It reads the codes out of the source, in the
 * positions where a code is raised, and fails on one the registry lacks — so
 * the next code cannot be added without its entry, and so its line in the
 * table.
 *
 * The positions, not every upper-case string: the bridge's own message names
 * (`DAI_HOST_*`), environment variables and constants are strings too, and are
 * not refusals.
 *
 * The scope is `src/`: the library and the runtime inside every container, the
 * vocabulary a second implementation and an application both meet. The
 * opener's own internal failures (an IndexedDB open that never answers) are
 * the host's business, not the format's. `src/rules.ts` quotes codes as
 * documentation, and the registry names them; neither raises anything.
 */

const CODE = "([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)";
const RAISED = [
  // new Error("CODE"), new ContainerError("CODE"), Error(`CODE (detail)`)
  new RegExp(`\\bError\\(\\s*[\`"']${CODE}\\b`, "g"),
  // refused: "CODE", refused: (…) || "CODE"
  new RegExp(`\\brefused:\\s*[\`"']${CODE}\\b`, "g"),
  new RegExp(`\\|\\|\\s*[\`"']${CODE}[\`"']`, "g"),
  // RAISE(ABORT, 'CODE') in the generated triggers
  new RegExp(`RAISE\\(ABORT,\\s*'${CODE}'`, "g"),
  // refuse("CODE"), refuseWriteRules("CODE")
  new RegExp(`\\brefuse\\w*\\(\\s*[\`"']${CODE}\\b`, "g"),
  // class SomeError { code = "CODE" }
  new RegExp(`\\bcode\\s*=\\s*[\`"']${CODE}[\`"']`, "g"),
];
const NOT_RAISING = new Set(["src/rules.ts", "src/refusals.ts"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Every code raised in `src/`, with the files that raise it. */
function raisedCodes(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const path of sources(join(repo, "src"))) {
    const file = relative(repo, path).split(sep).join("/");
    if (NOT_RAISING.has(file)) continue;
    const text = readFileSync(path, "utf8");
    for (const pattern of RAISED) {
      for (const match of text.matchAll(pattern)) {
        const code = match[1]!;
        if (!found.has(code)) found.set(code, new Set());
        found.get(code)!.add(file);
      }
    }
  }
  return found;
}

test.describe("the refusal registry", () => {
  test("every code the source raises is registered", () => {
    const raised = raisedCodes();
    const missing = [...raised.keys()]
      .filter((code) => !Object.prototype.hasOwnProperty.call(REFUSALS, code))
      .sort()
      .map((code) => `${code} (${[...raised.get(code)!].sort().join(", ")})`);
    expect(missing, `raised in src/ and missing from src/refusals.ts:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  test("the reading itself still finds the codes", () => {
    // A pattern that stops matching makes the test above pass by finding
    // nothing. So it must keep finding what it found when it was written:
    // at least this many codes, and the ones that motivated it.
    const raised = raisedCodes();
    expect(raised.size).toBeGreaterThanOrEqual(40);
    for (const code of ["REPLICATED_TABLE_IMMUTABLE", "WRITE_RULES_NOT_DELIVERED", "MAILBOX_BATCH_MALFORMED", "NO_PAYLOAD"]) {
      expect(raised.has(code), `${code} is still found in the source`).toBe(true);
    }
  });
});
