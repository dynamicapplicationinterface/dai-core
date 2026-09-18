import { expect, test } from "@playwright/test";
import { TO_DOCUMENT, TO_HOST } from "../src/bridge.js";
import { FRAME_INTERNAL, FRAME_PUBLIC } from "../src/frame.js";
import { bridgeValue, frameValue, nameProblems } from "../src/names-check.js";

/**
 * The owned message names are consistent (D68, D69, D70).
 *
 * The same check `scripts/check-names.mjs` runs at build, run here on the real
 * owners and on sets made wrong on purpose, so it is seen to fire as well as to
 * stay quiet. It used to run inside every document's runtime, where it could
 * never fire (D70).
 */
const BRIDGE_EXCEPTIONS = { "TO_HOST.ISOLATION_REPORT": "posted by document-carried code; wire format" };

test.describe("the owned message names", () => {
  test("the bridge's names follow their rule, with its one named exception", () => {
    expect(nameProblems({ TO_HOST, TO_DOCUMENT }, bridgeValue, BRIDGE_EXCEPTIONS)).toEqual([]);
  });

  test("the frame's names follow their rule, with no exception", () => {
    expect(nameProblems({ FRAME_PUBLIC, FRAME_INTERNAL }, frameValue)).toEqual([]);
  });

  test("a value used twice is named, with both of its places", () => {
    const twice = { FRAME_PUBLIC, FRAME_INTERNAL: { ...FRAME_INTERNAL, MERGED: "dai:merged" } };
    expect(nameProblems(twice, frameValue)).toEqual(['"dai:merged" is both FRAME_PUBLIC.MERGED and FRAME_INTERNAL.MERGED']);
  });

  test("a value that is not what its key says is named", () => {
    const off = { FRAME_PUBLIC, FRAME_INTERNAL: { ...FRAME_INTERNAL, INSETS_ASK: "dai:insets?" } };
    expect(nameProblems(off, frameValue)).toEqual(['FRAME_INTERNAL.INSETS_ASK is "dai:insets?", not "dai:insets-ask"']);
  });

  test("an exception excuses only its own key, and fails once it is not needed", () => {
    // Without it, the one bridge value off the rule is reported.
    expect(nameProblems({ TO_HOST, TO_DOCUMENT }, bridgeValue)).toEqual([
      'TO_HOST.ISOLATION_REPORT is "dai:isolation-report", not "DAI_HOST_ISOLATION_REPORT"',
    ]);
    // With it, but pointed at a key that follows the rule, the exception itself is the problem.
    expect(nameProblems({ TO_HOST, TO_DOCUMENT }, bridgeValue, { ...BRIDGE_EXCEPTIONS, "TO_HOST.SAVE": "no reason" })).toEqual([
      "the exception for TO_HOST.SAVE excuses nothing: it is missing or already follows the rule",
    ]);
  });
});
