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
 * 34,000 bytes: Build 1d, the file at 33,754 rounded up. Three data rules
 * (INSERT-NAMES-COLUMNS, TOTALS-IN-QUERIES, COUNTERS-ARE-FLAGGED) bought
 * 1,742 bytes. What they buy is an author who names columns in an INSERT,
 * computes a total in the query that shows it, and expects a counter two
 * people change at once to be flagged rather than added up (R-T).
 *
 * Before that, 33,000 bytes: R-O, Build 1, the file at 32,012 rounded up. One shape: the
 * shape decision, the shared-table and session constraints, the surface, the
 * views and the two shared examples are no longer taught, because the author
 * writes ordinary tables and the host sets the policy. It freed 112,330 bytes.
 *
 * Before that, 145,000 bytes: the file's size on 2 October, 144,342, rounded up to the
 * next thousand (identity step 7b). Not a raise: step 7a's rebuild of the
 * examples brought the file down to 143,414 under the 144,370 identity step 6
 * took for D165, and step 7b's two rules (D170's data-dai-write mark, D177's
 * dai:kit-merged event) left it under that.
 *
 * Before that, 141,386 bytes: identity step 5's seat model, ruled 24 September. It bought
 * 5,936 bytes: IDENTITY-SEAT-CONFIRMED in place of the withdrawn first-signer
 * rule, the waiting state (pendingSeat, t_pending) through the session rules,
 * and the roster views an author reads. What it buys is an author who knows a
 * joiner is seated by the creator's copy and not by opening the link, so their
 * app says "waiting to be let in" instead of hiding the joiner's moves.
 *
 * Before that, 135,450 bytes: identity step 5, seats into the kit. It bought 8,677 bytes:
 * five constraints (IDENTITY-SEAT-ADMITS as built, IDENTITY-FIRST-SIGNER,
 * IDENTITY-KIT-SEATS, IDENTITY-LOSS-SENTENCE, IDENTITY-BOOT-WRITES), the
 * seat= marker and eight kit calls, and the session rules rewritten onto the
 * kit. What it buys is an author who names the seat a row acts for and reads
 * who this copy is from the host, which is what closes D80 for their app too.
 *
 * Before that, 126,773 bytes: SHARED-POINTER-HOLDS-THE-SCREEN (D79) — never
 * redraw while a pointer is down, draw when it lifts, read the state when you
 * act. It bought 4,402 bytes, and what it buys is every author avoiding a tap
 * that vanishes with no error whenever a merge lands mid-press: the failure is
 * invisible to the person, unreproducible on a desk, and routine with a live
 * opponent.
 */
const BUDGET_BYTES = 34_000;

/** Headroom for a sentence or two before a change counts as growth. */
const GROWTH_ALLOWED = 0.02;

/** A shrink this large means the budget no longer describes the file. */
const SHRINK_BEFORE_RESET = 0.1;

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

test("R-X: the model file teaches the handle's resolution call, a form saved whole, and nothing that resolves by writing", () => {
  expect(RECIPE).toContain("A form may save every field whole");
  expect(RECIPE, "1g-L4: where a whole save is not an echo").toContain("type a REAL column: untyped, 2.0 reads back as 2");
  expect(RECIPE).toContain("await db.conflict(table, [id], [column])");
  expect(RECIPE).toContain("await db.resolve(c.token, chosen.ver)");
  expect(RECIPE, "a pending row is not resolved by writing it").not.toMatch(/until someone writes it again|writing the row again resolves|editing is resolving/i);
  expect(RECIPE, "R-W refuses ALTER and DROP: never taught to run").not.toContain("Run ALTER and DROP TABLE through exec");
});

test("R-Y: the model file teaches the asynchronous handle, and never the synchronous one", () => {
  expect(RECIPE).toContain("await window.dai.database()");
  for (const old of ["openDatabase", "selectObjects", "selectValue", "db.exec(", "exportDatabase"]) expect(RECIPE, old).not.toContain(old);
});

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
