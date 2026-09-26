import { expect, test } from "@playwright/test";
import { FRAME_PUBLIC } from "../src/frame.js";
import { KIT_SOURCE } from "../src/kit.js";

/**
 * The kit says the frame's public names as the owner spells them (D69).
 *
 * The kit is text written into every document, and it spells `dai:used` as a
 * literal rather than interpolating it from `src/frame.ts`: interpolation made
 * the bundler keep the whole kit in every runtime (about 17 KB). So this holds
 * the literal to the owner instead. The value itself is frozen by
 * `tests/frame-wire.spec.ts`; this catches the kit and the owner drifting apart.
 */
test("the kit posts the frame's public 'used' name, as the owner spells it", () => {
  expect(KIT_SOURCE).toContain(`postMessage({ type: '${FRAME_PUBLIC.USED}' }, '*')`);
});

test("the kit listens for the frame's public new-player name, as the owner spells it", () => {
  // Spelled as a literal for the reason 'dai:used' is (D69); held to the owner here.
  expect(KIT_SOURCE).toContain(`window.addEventListener('${FRAME_PUBLIC.NEW_PLAYER}',`);
});
