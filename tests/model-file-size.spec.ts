import { expect, test } from "@playwright/test";
import { RECIPE } from "../src/recipe.js";

/**
 * The model file has a budget, and this is what watches it.
 *
 * It is the one artifact a fresh model reads cold, whole, every time, so its
 * growth has a cost nothing else in the repository has. Growth is allowed; it
 * is meant to be a decision. When this fails because the model file grew on
 * purpose, set BUDGET_BYTES to the new size in the same commit and say in the
 * message what the bytes bought.
 *
 * It also fails when the file shrinks well below the number, so the number
 * stays close to the truth: a stale, generous budget would let the next
 * growth through unnoticed.
 */

/**
 * 126,773 bytes: SHARED-POINTER-HOLDS-THE-SCREEN (D79) — never redraw while a
 * pointer is down, draw when it lifts, read the state when you act. It bought
 * 4,402 bytes, and what it buys is every author avoiding a tap that vanishes
 * with no error whenever a merge lands mid-press: the failure is invisible to
 * the person, unreproducible on a desk, and routine with a live opponent.
 */
const BUDGET_BYTES = 126_773;

/** Headroom for a sentence or two before a change counts as growth. */
const GROWTH_ALLOWED = 0.02;

/** A shrink this large means the budget no longer describes the file. */
const SHRINK_BEFORE_RESET = 0.1;

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

test.describe("the model file's size", () => {
  test("stays within its stated budget, so growth is a decision rather than a discovery", () => {
    const bytes = bytesOf(RECIPE);
    const ceiling = Math.floor(BUDGET_BYTES * (1 + GROWTH_ALLOWED));
    expect(
      bytes,
      `The model file is ${bytes} bytes, over its budget of ${BUDGET_BYTES} (+${GROWTH_ALLOWED * 100}% allowed). ` +
        "If the growth is intended, set BUDGET_BYTES in tests/model-file-size.spec.ts to the new size and say what it bought.",
    ).toBeLessThanOrEqual(ceiling);
  });

  test("the budget is not stale: a large shrink resets the number", () => {
    const bytes = bytesOf(RECIPE);
    const floor = Math.ceil(BUDGET_BYTES * (1 - SHRINK_BEFORE_RESET));
    expect(
      bytes,
      `The model file is ${bytes} bytes, well under its budget of ${BUDGET_BYTES}. ` +
        "Lower BUDGET_BYTES to the new size, so the next growth is measured from here.",
    ).toBeGreaterThanOrEqual(floor);
  });
});
