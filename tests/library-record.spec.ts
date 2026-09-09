import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A library write keeps what it does not own.
 *
 * `saveCartridgeToLibrary` replaces the whole record. A caller that builds a
 * fresh object literal therefore *deletes* every field it did not think to
 * name — and the fields worth keeping are exactly the ones a caller has no
 * reason to be thinking about: standing consent to merge (T1-D23) and the
 * shares this copy has issued.
 *
 * This has now happened three times, in three different callers, and each
 * instance reads perfectly well on its own:
 *
 *   - Opening from the library dropped `savedAt`, so a copy had no account of
 *     when its data was last written and an arriving copy had nothing to be
 *     newer than. Fixed by naming `savedAt` — which fixed the field and left
 *     the shape, so the same caller went on dropping `mergeStanding`.
 *   - The autosave path dropped `mergeStanding`, so playing a move revoked
 *     the consent given a moment earlier and the person was asked again on
 *     every exchange: the friction T1-D23 exists to remove, produced by the
 *     code that implements it.
 *   - The open-a-document path dropped it too, for the same reason.
 *
 * None of those is a typo, and none would be caught by testing the value: a
 * unit test asserting "consent survives a save" passes the day it is written
 * and says nothing about the next caller. The defect is a shape, so this is a
 * test over the shape.
 *
 * The rule: every call spreads an existing record before naming its own
 * fields. A caller with genuinely no prior record — there is none today — has
 * to say so where this can see it.
 */
const MAIN = "apps/runner/src/main.ts";

/** Each `saveCartridgeToLibrary({ … })` call, with its argument. */
function writes(source: string): { at: number; argument: string }[] {
  const found: { at: number; argument: string }[] = [];
  const call = /saveCartridgeToLibrary\(\{/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source)) !== null) {
    // From the opening brace to the one that closes it, counting depth so a
    // nested object or a comment brace does not end the argument early.
    let depth = 0;
    let index = match.index + match[0].length - 1;
    const start = index;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push({
      at: source.slice(0, match.index).split("\n").length,
      argument: source.slice(start, index + 1),
    });
  }
  return found;
}

test.describe("writing a document's record in the library", () => {
  test("every write carries the record it is replacing", () => {
    const source = readFileSync(resolve(repo, MAIN), "utf8");
    const calls = writes(source);

    // If this ever reads zero, the calls have been renamed and this test has
    // quietly stopped checking anything.
    expect(calls.length, "no library writes found — has the function been renamed?").toBeGreaterThan(
      3,
    );

    const bare = calls
      .filter(({ argument }) => !/\.\.\.[A-Za-z_$]/.test(argument))
      .map(({ at }) => `${MAIN}:${at}`);

    expect(
      bare,
      "A library write replaces the whole record, so one that does not spread the " +
        "record it replaces deletes every field it did not name — including standing " +
        "consent to merge and the shares this copy has issued, which no caller has a " +
        "reason to be thinking about. Spread the held record first, then name what " +
        "this write owns.",
    ).toEqual([]);
  });

  test("the fields that get dropped are the ones nothing else would notice", () => {
    /*
     * Named here so the reason survives the next refactor.
     *
     * `savedAt` going missing had a symptom somebody could see: an arriving
     * copy was refused as older. `mergeStanding` and `shares` have none. The
     * person is simply asked a question they already answered, or a link they
     * issued stops being listed — both read as the application being like
     * that, rather than as something having gone wrong.
     */
    const opfs = readFileSync(resolve(repo, "apps/runner/src/opfs.ts"), "utf8");
    for (const field of ["mergeStanding", "shares"]) {
      expect(opfs, `${field} is no longer part of a library record`).toContain(field);
    }
  });
});
