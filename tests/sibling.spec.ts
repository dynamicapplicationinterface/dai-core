import { expect, test } from "@playwright/test";
import { siblingTest, whyNotSibling } from "../src/sibling.js";

/**
 * Whether a merge is offered at all (docs/replicated-tables.md §7).
 *
 * The host's half of the decision, and the half a person sees: this is what
 * puts *Merge into my copy* on the launch card or replaces it with a sentence
 * saying why not. The frame's half — whether the merge can actually run — is
 * separate, because only the frame has both databases open.
 *
 * Every refusal here has words, not a code alone. A card that says a merge is
 * unavailable and stops has told somebody their document is broken.
 */

const KEY = "aabbccddeeff0011";
const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const signed = { documentUuid: UUID, publicKeyFingerprint: KEY, replicated: true };
const unsigned = { documentUuid: UUID, replicated: true };

test.describe("when a merge is offered", () => {
  test("two signed copies of one document, by the same publisher", () => {
    expect(siblingTest(signed, signed)).toEqual({ sibling: true });
  });

  test("two unsigned copies of one document", () => {
    // Ordinary here, and the weakest case: at Level 1 a replica id is a claim,
    // so this is a merge with whoever sent the file. §10 says so plainly.
    expect(siblingTest(unsigned, unsigned)).toEqual({ sibling: true });
  });
});

test.describe("when it is not", () => {
  test("a different document is unrelated, not a failure", () => {
    const other = { ...signed, documentUuid: "11111111-2222-4333-8444-555555555555" };
    expect(siblingTest(other, signed)).toEqual({ sibling: false, because: "unrelated" });
    expect(whyNotSibling("unrelated")).toMatch(/different document/i);
  });

  test("the same id under a different key is refused", () => {
    const stranger = { ...signed, publicKeyFingerprint: "ffffffffffffffff" };
    expect(siblingTest(stranger, signed)).toEqual({ sibling: false, because: "different-publisher" });
  });

  test("signed on one side and not the other is refused, because two absences are not a match", () => {
    /*
     * T1-D4. Draft 1 assumes a signed document and compares SPKIs; treating
     * "both absent" as agreement would let any unsigned file claiming this
     * UUID present itself as a sibling. Both signed by one key, or both
     * unsigned — one of each is a refusal.
     */
    expect(siblingTest(unsigned, signed)).toEqual({ sibling: false, because: "different-publisher" });
    expect(siblingTest(signed, unsigned)).toEqual({ sibling: false, because: "different-publisher" });
  });

  test("a document with no replicated tables is succession, not a failed merge", () => {
    const plain = { ...signed, replicated: false };
    expect(siblingTest(plain, signed)).toEqual({ sibling: false, because: "not-replicated" });
    expect(siblingTest(signed, plain)).toEqual({ sibling: false, because: "not-replicated" });
    expect(whyNotSibling("not-replicated")).toMatch(/whole|newer copy/i);
  });

  test("this device's own copy coming back is not a sibling", () => {
    // Merging a copy with itself. The offer would be nonsense on screen:
    // *merge into my copy*, pointing at the copy it already is.
    expect(siblingTest(signed, signed, { sameReplica: true })).toEqual({
      sibling: false,
      because: "same-copy",
    });
  });

  test("every refusal has words a person can act on", () => {
    for (const because of ["unrelated", "different-publisher", "not-replicated", "same-copy"] as const) {
      const said = whyNotSibling(because);
      expect(said.length, because).toBeGreaterThan(20);
      expect(said, because).not.toMatch(/error|failed|invalid/i);
    }
  });
});
