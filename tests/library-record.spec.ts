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

  /**
   * A write that can rewind the save counter (backlog D41).
   *
   * The save path takes a per-document lock, reads the record inside it, and
   * writes `revision` back one higher. Every other write read the record
   * outside that lock and wrote it back whole — so a read that straddled a
   * save's commit put `revision` back to what it was before, while the tab that
   * saved had already moved its own `knownRevision` on. From then on that
   * tab's every save was refused as "another tab saved this", with no recovery
   * but a reopen. Measured in CI: a copy filed a game's key at lane
   * construction and then refused 37 consecutive saves, and because its saves
   * never landed its cursor never moved, its lane never retired, and its push
   * subscription was never released — which is the assertion that failed.
   *
   * The rule: a library write either happens under the lock, from a record read
   * inside it, or it does not carry `revision`.
   */
  test("no library write outside the lock can carry the save counter", () => {
    const source = readFileSync(resolve(repo, MAIN), "utf8");

    // `amendLibraryRecord` is the locked helper: reads inside the lock, writes
    // there. Its own call is the one allowed to spread a record freely.
    expect(source, "the locked helper still exists").toContain("function amendLibraryRecord");
    expect(source, "and it is what takes the lock").toMatch(
      /function amendLibraryRecord[\s\S]{0,400}withLibraryLock/,
    );

    /*
     * Inside a lock, not merely few in number.
     *
     * The first cut of this test counted the writes that set `revision` and
     * allowed two. That measures the wrong thing: it cannot tell a writer that
     * takes the lock from one that does not, so moving a writer under the lock
     * left it still failing, and the only way to make it pass would have been to
     * raise the count — arguing with the guard instead of meeting it. So it asks
     * the question it means: is this write inside a `withLibraryLock` block?
     */
    /*
     * Two spellings, one lock, and a test that knows both by name.
     *
     * The save path wraps its work in `locked(...)`, a one-line alias declared
     * beside it that calls `withLibraryLock` for the same document. The write
     * therefore sits inside a closure passed to the alias, not lexically inside
     * a `withLibraryLock(` call — so a parser looking only for the long name
     * reports it unlocked, for ever, however the code is arranged.
     *
     * Rewriting the parser again, or bending the save path to satisfy it, is
     * debugging the instrument instead of the product. So the rule is stated as
     * the code states it: these are the two names the lock is taken under, and
     * a write carrying `revision` must be inside one of them. A third spelling
     * is what this test is for — it will appear as an unlocked write.
     */
    const lockSpans: { from: number; to: number }[] = [];
    const lock = /(?:withLibraryLock|\blocked)\s*\(/g;
    let opened: RegExpExecArray | null;
    while ((opened = lock.exec(source)) !== null) {
      let depth = 0;
      let index = opened.index + opened[0].length - 1;
      const from = index;
      for (; index < source.length; index += 1) {
        const char = source[index];
        if (char === "(") depth += 1;
        else if (char === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      lockSpans.push({ from, to: index });
    }
    expect(lockSpans.length, "the lock is taken somewhere").toBeGreaterThan(0);

    const offsetOf = (line: number): number => {
      const lines = source.split("\n").slice(0, line - 1);
      return lines.join("\n").length;
    };

    const unlocked = writes(source)
      .filter(({ argument }) => /revision\s*:/.test(argument))
      .filter(({ at }) => {
        const offset = offsetOf(at);
        return !lockSpans.some((span) => offset >= span.from && offset <= span.to);
      })
      .map(({ at }) => `${MAIN}:${at}`);

    expect(
      unlocked,
      "a write that carries the save counter must hold the document's library lock, " +
        "or a save committing between its read and its write is rewound and every " +
        "later save from that tab is refused",
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
