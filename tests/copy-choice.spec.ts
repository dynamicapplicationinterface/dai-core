import { expect, test } from "@playwright/test";
import { BLANK_DIGEST, HISTORY_LIMIT, afterSave, chooseCopy, databaseDigest, remember, type HeldCopy } from "../src/copy-choice.js";

/**
 * Which copy of a non-replicated document opens when one comes back (D36).
 *
 * Each case is one of the ways two copies of a document meet, named by what
 * happened to them. The guard has to fire on a genuine divergence and stay out
 * of the way of everything else, so both halves are here.
 */

const T = (minute: number): string => `2026-09-16T10:${String(minute).padStart(2, "0")}:00.000Z`;

/** A copy that took in database "base" at minute 10, and has held nothing else. */
const matched: HeldCopy = { savedAt: T(10), matchedAt: T(10), matchedDigest: "base", history: ["base"] };

test.describe("which copy opens", () => {
  test("a copy further along arrives at one that has written nothing since they matched: it opens", () => {
    // The move sent back. Also D36's own case: a save on open that changed
    // nothing moved savedAt past the move, and the move used to lose to it.
    const afterOpenSave: HeldCopy = { ...matched, savedAt: T(30) };
    expect(chooseCopy(afterOpenSave, "base", { savedAt: T(20), digest: "their-move" })).toEqual({ kind: "take" });
  });

  test("both copies changed since they matched: neither is picked", () => {
    const wroteHere: HeldCopy = { ...matched, savedAt: T(15), history: ["base", "my-move"] };
    expect(chooseCopy(wroteHere, "my-move", { savedAt: T(20), digest: "their-move" })).toEqual({ kind: "diverged" });
    // Whichever clock is later. The order of the stamps is not the order of events.
    expect(chooseCopy(wroteHere, "my-move", { savedAt: T(12), digest: "their-move" })).toEqual({ kind: "diverged" });
  });

  test("a link this copy sent earlier, opened again after more was written: this copy stays, and says so", () => {
    const sentThenMoved: HeldCopy = { savedAt: T(40), matchedAt: T(20), matchedDigest: "sent", history: ["base", "sent", "later"] };
    expect(chooseCopy(sentThenMoved, "later", { savedAt: T(20), digest: "sent" })).toEqual({ kind: "keep", older: true });
    // An even older copy of its own, from before it sent anything.
    expect(chooseCopy(sentThenMoved, "later", { savedAt: T(10), digest: "base" })).toEqual({ kind: "keep", older: true });
  });

  test("the same database arriving again is a resume, not news", () => {
    expect(chooseCopy(matched, "base", { savedAt: T(50), digest: "base" })).toEqual({ kind: "keep", older: false });
  });

  test("a copy stamped before the last match stays behind it", () => {
    expect(chooseCopy(matched, "base", { savedAt: T(5), digest: "stale" })).toEqual({ kind: "keep", older: true });
  });

  test("a turn taken back and forth: sent, answered, taken, with nothing written here in between", () => {
    // This copy moved and sent it at minute 20; the other side answered at 25.
    const sent: HeldCopy = { savedAt: T(20), matchedAt: T(20), matchedDigest: "my-move", history: ["base", "my-move"] };
    expect(chooseCopy(sent, "my-move", { savedAt: T(25), digest: "their-reply" })).toEqual({ kind: "take" });
    // And had this copy moved again before the answer came, that is a divergence.
    const movedAgain: HeldCopy = { ...sent, savedAt: T(22), history: ["base", "my-move", "my-second-move"] };
    expect(chooseCopy(movedAgain, "my-second-move", { savedAt: T(25), digest: "their-reply" })).toEqual({ kind: "diverged" });
  });

  test("a record from before this existed is decided by the old rule, and never refused", () => {
    const old: HeldCopy = { savedAt: T(10) };
    expect(chooseCopy(old, "x", { savedAt: T(20), digest: "y" })).toEqual({ kind: "take" });
    expect(chooseCopy(old, "x", { savedAt: T(5), digest: "y" })).toEqual({ kind: "keep", older: true });
    expect(chooseCopy(old, "x", { savedAt: undefined, digest: "y" })).toEqual({ kind: "keep", older: false });
  });
});

test.describe("what a save does to the match", () => {
  test("the first open's setup save, on a document that arrived blank, becomes the match", () => {
    // D36's own save: opening creates the schema and saves it. Every copy runs
    // the same SQL, so it is not a change one copy has that another has not.
    expect(afterSave({ matchedDigest: BLANK_DIGEST, history: [] }, "schema", true)).toEqual({
      matchedDigest: "schema",
      history: ["schema"],
    });
  });

  test("a setup save after a copy was taken in, with nothing written since, stays the match", () => {
    expect(afterSave({ matchedDigest: "taken", history: ["taken"] }, "taken-plus-setup", true)).toEqual({
      matchedDigest: "taken-plus-setup",
      history: ["taken", "taken-plus-setup"],
    });
  });

  test("a person's save is a change since the match, and never moves it", () => {
    expect(afterSave({ matchedDigest: "taken", history: ["taken"] }, "my-move", false)).toEqual({
      matchedDigest: "taken",
      history: ["taken", "my-move"],
    });
  });

  test("a setup save on top of a person's earlier change does not erase the change", () => {
    // Changed in an earlier session, then reopened: the setup flag is true for
    // this handle, but the copy already holds something the match does not.
    expect(afterSave({ matchedDigest: "taken", history: ["taken", "my-move"] }, "my-move-plus-setup", true)).toEqual({
      matchedDigest: "taken",
      history: ["taken", "my-move", "my-move-plus-setup"],
    });
    // Nor does a blank match, once anything has been saved over it.
    expect(afterSave({ matchedDigest: BLANK_DIGEST, history: ["my-move"] }, "later", true).matchedDigest).toBe(BLANK_DIGEST);
  });
});

test.describe("the history a copy keeps", () => {
  test("does not repeat a database saved twice unchanged, and keeps only the newest", () => {
    expect(remember(["a"], "a")).toEqual(["a"]);
    let history: string[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) history = remember(history, `d${i}`);
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]).toBe("d5");
    expect(history[HISTORY_LIMIT - 1]).toBe(`d${HISTORY_LIMIT + 4}`);
  });

  test("a digest is of the bytes: equal bytes agree, one changed byte does not", async () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(await databaseDigest(a)).toBe(await databaseDigest(new Uint8Array([1, 2, 3, 4])));
    expect(await databaseDigest(a)).not.toBe(await databaseDigest(new Uint8Array([1, 2, 3, 5])));
  });
});
