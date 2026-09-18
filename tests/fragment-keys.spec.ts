import { expect, test } from "@playwright/test";
import { FRAGMENT_KEYS, fragmentCollisions } from "../src/fragment.js";
import { HINT_KEY, INLINE_KEY } from "../src/link.js";
import { REFERENCE_KEYS } from "../src/store.js";

/**
 * A link's fragment is one namespace, and no two fields may claim a key (D56).
 *
 * The icon hint was given `u`, which a store reference already used for its
 * URL, and every icon made from a link then lost the address it needed on the
 * one device it was for. Three definers in two files wrote into one fragment,
 * and no file could see all three. `src/fragment.ts` is now the one place the
 * namespace is written, and it refuses to load on a collision.
 *
 * Proved both ways: it stays silent on the set as it is, and it names the key
 * and both claimants when two fields collide. The load-time refusal is the same
 * function, run on the real set when the module is evaluated.
 */
test.describe("the fragment's field names", () => {
  test("no two fields claim one key in the set as it is", () => {
    expect(fragmentCollisions(FRAGMENT_KEYS)).toEqual([]);
  });

  test("a second field claiming a key is named, with both of its claimants", () => {
    // The defect as it was: the hint given the store reference's `u`.
    const asItWas = { ...FRAGMENT_KEYS, opener: { hint: "u" } };
    expect(fragmentCollisions(asItWas)).toEqual(['"u" is claimed by reference.url and opener.hint']);
  });

  test("each owner's own name for its fields is the registry's, not a copy", () => {
    // A constant spelled out again in its own file would leave the registry
    // checking a set nobody reads. These must be the same values.
    expect(INLINE_KEY).toBe(FRAGMENT_KEYS.inline.payload);
    expect(REFERENCE_KEYS).toBe(FRAGMENT_KEYS.reference);
    expect(HINT_KEY).toBe(FRAGMENT_KEYS.opener.hint);
  });
});
