import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What a person is told this is called.
 *
 * The code calls it the runner, because that is what it is: a host that runs a
 * container. Nothing a stranger reads should say so. A person opens a document,
 * and a message telling somebody to *run* a file they were sent is the sentence
 * everybody has been trained to delete — which is the opposite of what a format
 * claiming to be a document can afford.
 *
 * This is a naming decision rather than a mechanism, so it has no other way to
 * stay true. Copy drifts back, and the drift is invisible.
 */
const userFacing = [
  "website/open.md",
  "website/components/PhoneFlow.vue",
  "website/components/MakerWalkthrough.vue",
  "website/components/MakeYourOwn.vue",
  "apps/runner/index.html",
  "apps/runner/public/manifest.webmanifest",
];

test.describe("the public word is open, not run", () => {
  for (const file of userFacing) {
    test(`${file} does not call it the runner`, () => {
      const source = readFileSync(join(repo, file), "utf8");

      // Comments explain the distinction and are allowed to name both. What is
      // checked is the prose a reader sees.
      const prose = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*(\/\/|\*|<!--).*$/gm, "");

      expect(prose, `${file} says "the runner" where a person can read it`).not.toMatch(
        /\bthe runner\b/i,
      );
      expect(prose, `${file} calls the app "DAI Runner"`).not.toContain("DAI Runner");
    });
  }

  test("the code still calls it the runner, because that is what it is", () => {
    // The other half of the decision. If this ever fails, somebody has renamed
    // a directory for the sake of consistency and bought nothing with it.
    const readme = readFileSync(join(repo, "apps", "runner", "README.md"), "utf8");
    expect(readme).toContain("the runner");
    expect(readme).toMatch(/called \*\*the opener\*\*/i);
  });
});
