import { expect, test } from "@playwright/test";
import { FRAME_PUBLIC } from "../src/frame.js";

/**
 * The frame's public names, as the code a document carries uses them (D69).
 *
 * The one place these are written out instead of imported, on purpose: the
 * strings are the subject. The opener mounts every document in its own current
 * shell, so the kit and the author's own code inside a document built long ago
 * talk to today's runtime. Those documents say exactly these strings forever.
 * A rename made in `src/frame.ts` would pass its own check (key and value still
 * agree) and every program here would still talk to itself, while every
 * document already in the world stopped being heard. This is what fails
 * instead.
 *
 * Adding a public name means adding it here in the same change. An existing
 * string must never change or disappear. `FRAME_INTERNAL` is deliberately not
 * listed: both of its ends ship in one runtime bundle, and it can be renamed.
 */
const FRAME_PUBLIC_ON_THE_WIRE = [
  "dai:merged",
  "dai:used",
  "dai:new-player",
];

test("the frame's public names are spelled as they always were", () => {
  expect(Object.values(FRAME_PUBLIC).sort()).toEqual([...FRAME_PUBLIC_ON_THE_WIRE].sort());
});
