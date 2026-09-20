import { expect, test } from "./fixtures.js";

/**
 * The fixture that closes what a test opened (D83).
 *
 * Proved rather than assumed, and in the only way that proves it: a test that
 * throws before its own closes, and a second test that reads what is left. The
 * two run in order in one worker (`fullyParallel: false`), and the reading is
 * `browser.contexts()`, which is the browser's own list.
 *
 * The first test is held as an expected failure — it is meant to throw, and a
 * run where it stops throwing is a run where this proves nothing, so the mark
 * fails the run then.
 */
test.describe("contexts a test could not close", () => {
  test("a test that throws leaves its contexts behind", async ({ browser }) => {
    test.fail(true, "this test throws on purpose: the next one reads what it left");
    const one = await browser.newContext();
    const two = await browser.newContext();
    await one.newPage();
    await two.newPage();
    expect(browser.contexts().length, "both are open while it runs").toBeGreaterThanOrEqual(2);
    throw new Error("thrown before either context is closed");
    // Unreachable on purpose: this is what a failing test never reaches.
  });

  test("and the fixture closed them anyway", async ({ browser }) => {
    expect(browser.contexts(), "nothing the last test opened is still open").toHaveLength(0);
  });
});
