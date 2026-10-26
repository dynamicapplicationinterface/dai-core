import { expect, test } from "@playwright/test";
// @ts-expect-error a plain ES module with no types
import { installFacts, seconds } from "../scripts/ci-install-times.mjs";

/**
 * The D292 reader takes the cache's verdict from the Playwright cache's own
 * line. setup-node's npm cache prints the same words for its key, and reading
 * those read every cold job as a hit.
 */
test.describe("the install reader", () => {
  const npmHit = "Cache restored from key: node-cache-Linux-x64-npm-abc123";

  test("a hit and a miss are the Playwright cache's, not npm's", () => {
    expect(installFacts(`${npmHit}\nCache not found for input keys: playwright-Linux-1.63.0-webkit`).cache).toBe("miss");
    expect(installFacts(`${npmHit}\nCache restored from key: playwright-Linux-1.63.0-webkit`).cache).toBe("hit");
    expect(installFacts(npmHit).cache).toBeNull();
  });

  test("what apt had to fetch, with the share the cache already held", () => {
    expect(installFacts("Need to get 0 B/119 MB of archives.").needed).toBe("0 B/119 MB");
    expect(installFacts("Need to get 25.9 MB of archives.").needed).toBe("25.9 MB");
    expect(installFacts("Fetched 12.5 MB in 1s (9,876 kB/s)").fetched).toBe("12.5 MB");
  });

  test("a step's time is from its own start and end, and none without both", () => {
    expect(seconds("2026-10-25T20:40:00Z", "2026-10-25T20:40:51Z")).toBe(51);
    expect(seconds("2026-10-25T20:40:00Z", null)).toBeNull();
  });
});
