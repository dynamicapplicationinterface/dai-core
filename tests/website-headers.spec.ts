import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Rule {
  source: string;
  headers: { key: string; value: string }[];
}

const rules = (): Rule[] =>
  (JSON.parse(readFileSync(join(repo, "website", "vercel.json"), "utf8")) as { headers: Rule[] })
    .headers;

const cacheFor = (source: string): string | undefined =>
  rules()
    .find((rule) => rule.source === source)
    ?.headers.find((header) => header.key.toLowerCase() === "cache-control")?.value;

/**
 * What the site tells a browser it may keep, and for how long.
 *
 * One of these is a straightforward speed improvement and the other would be a
 * bug nobody could fix afterwards, which is why they are written down rather
 * than left to whoever next reads the config and notices an inconsistency.
 */
test.describe("caching", () => {
  test("hashed assets are cached for a year", () => {
    // Their names carry a hash of their contents, so a change produces a new
    // name and the old one is never requested again. Safe to keep for ever, and
    // it saves every returning visitor a revalidation round trip.
    const value = cacheFor("/assets/(.*)");
    expect(value).toContain("immutable");
    expect(value).toMatch(/max-age=\d{7,}/);
  });

  for (const path of ["/runtime/(.*)", "/shots/(.*)"]) {
    test(`${path} is not cached immutably`, () => {
      /*
       * The names here are stable and the contents are not. `sqlite3.wasm` and
       * `dai-runtime.js` are rebuilt whenever the shell or the bootloader
       * changes, and a browser told to keep them for a year would go on
       * compiling containers with a months-old runtime — in a cache we cannot
       * reach.
       *
       * When the committed copies of these went stale, one redeploy fixed it.
       * A stale copy in somebody's browser cannot be fixed at all, which is why
       * this is a test and not a comment.
       */
      const value = cacheFor(path);
      expect(
        value,
        `${path} must not be immutable: its filenames are stable and its contents are not`,
      ).toBeUndefined();
    });
  }

  test("the runtime is not swept up by a broader rule", () => {
    // A catch-all that happened to match /runtime would do the same damage as
    // naming it directly.
    for (const rule of rules()) {
      const caching = rule.headers.find((header) => header.key.toLowerCase() === "cache-control");
      if (!caching?.value.includes("immutable")) continue;
      expect(
        rule.source.startsWith("/assets/"),
        `${rule.source} caches immutably and would cover paths whose names do not change`,
      ).toBe(true);
    }
  });
});
