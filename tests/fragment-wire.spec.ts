import { expect, test } from "@playwright/test";
import { FRAGMENT_KEYS } from "../src/fragment.js";

/**
 * A link's fragment fields, as links already sent spell them (D75).
 *
 * Written out in full on purpose; the strings are the subject. Every link
 * anyone has sent, and every icon on a home screen, carries these field names
 * in its fragment, and keeps carrying them. `src/fragment.ts` refuses a
 * collision and `fragment-keys.spec` holds each owner's constant to the
 * registry, but neither can see a consistent rename: change `h` to `x` in the
 * registry and every check agrees with itself, while every link already sent
 * stops opening. This is what fails instead.
 *
 * A new field means adding it here in the same change. An existing one never
 * changes or disappears.
 */
test("the fragment's fields are spelled as every link already sent spells them", () => {
  expect(FRAGMENT_KEYS).toEqual({
    inline: { payload: "a" },
    reference: { hash: "h", key: "k", url: "u", clear: "c", session: "s" },
    opener: { hint: "opener-doc" },
  });
});
