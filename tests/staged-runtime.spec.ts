import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staged = join(repo, "website", "public", "runtime");
/*
 * Where each staged file comes from. The shell and bootloader are this
 * project's build output; the engine is the package it depends on, copied
 * rather than rebuilt.
 */
const sources: Record<string, string> = {
  "template.html": join(repo, "dist", "template.html"),
  "dai-runtime.js": join(repo, "dist", "dai-runtime.js"),
  "sqlite3.wasm": join(repo, "node_modules", "@sqlite.org", "sqlite-wasm", "dist", "sqlite3.wasm"),
  "sqlite3.mjs": join(repo, "node_modules", "@sqlite.org", "sqlite-wasm", "dist", "index.mjs"),
};

const digest = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * The shell and bootloader the website hands out, against the ones this
 * repository builds.
 *
 * The site compiles containers in the visitor's browser, and fetches the shell,
 * the bootloader and the engine as static files from `website/public/runtime`.
 * Those files are committed, and nothing regenerates them: a change to
 * `src/template.html` or `src/runtime/bootloader.ts` lands in `dist` and in
 * every test here, while the site keeps serving whatever was staged last.
 *
 * It was already true when this was written. The shell had been given a
 * `noscript` block — the only message that reaches somebody whose viewer will
 * not run the container — and the site went on handing out the version without
 * it, with every test green and a deployment that looked current.
 *
 * There is no clever fix, only a loud one: `npm run build && node
 * scripts/build-demo-pair.mjs` restages them, and this fails until somebody
 * does.
 */
test.describe("what the website serves", () => {
  for (const [name, source] of Object.entries(sources)) {
    test(`${name} is the one this repository builds`, () => {
      expect(
        digest(join(staged, name)),
        `website/public/runtime/${name} is stale — run: npm run build && node scripts/build-demo-pair.mjs`,
      ).toBe(digest(source));
    });
  }
});

/**
 * A deployment can say what it is running.
 *
 * Written after an evening spent grepping deployed bundles for strings, hoping
 * the one I picked had changed, and drawing two wrong conclusions from it. The
 * question "which commit is production serving" should cost one request, and
 * the answer should include whether it is production at all — a preview
 * deployment that never got promoted looks exactly like a deployment that
 * did, from the outside.
 */
test("the site's build records the commit it came from", () => {
  const stamp = JSON.parse(
    readFileSync(join(repo, "website", ".vitepress", "dist", "version.json"), "utf8"),
  ) as { commit: string; builtAt: string; environment: string };

  expect(stamp.commit).toMatch(/^[0-9a-f]{7,40}$|^unknown$/);
  expect(stamp.environment).toBeTruthy();
  expect(Date.parse(stamp.builtAt)).not.toBeNaN();
});
