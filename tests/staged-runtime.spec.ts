import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { auditContainer, parseContainer, verifyContainer } from "../src/container.js";
import { isPublishedTestKey } from "../src/test-keys.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/*
 * The staged runtime as it is *committed*, not as it sits in the working tree.
 *
 * The guard's whole job is to catch a staged file that a bootloader change left
 * behind, and the working tree is exactly where that staleness can be hidden: a
 * full `npm test` builds and could restage these files on disk, so a check that
 * read them from disk would be satisfied by the restage while the committed
 * copy — the one the site actually serves — stayed stale. Reading the bytes out
 * of `git HEAD` closes that door: what is asserted is what was committed.
 */
const committed = (name: string): Buffer =>
  execFileSync("git", ["show", `HEAD:website/public/runtime/${name}`], {
    cwd: repo,
    maxBuffer: 64 * 1024 * 1024,
  });
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

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

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
        digest(committed(name)),
        `website/public/runtime/${name} is stale — run: npm run build && node scripts/build-demo-pair.mjs, then commit it`,
      ).toBe(digest(readFileSync(source)));
    });
  }
});

/**
 * The signed demonstration pair, as committed.
 *
 * The tamper page hands a visitor two files that differ in one entry, and the
 * whole point is that one verifies and the other does not. They are signed, so
 * they cannot be rebuilt byte for byte and are committed rather than staged on
 * every build; this checks the committed bytes still hold the claim, and that
 * the signature is the conformance test key — the one a host is required to
 * show as a test key and never as a publisher, which is the honest thing for a
 * demonstration to carry. Read from git HEAD for the same reason the runtime
 * is: it is the committed pair the site serves, not whatever a build left on
 * disk, that has to keep the promise.
 */
const committedText = (path: string): string =>
  execFileSync("git", ["show", `HEAD:${path}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }).toString(
    "utf8",
  );

test.describe("the demonstration pair the site serves", () => {
  test("the intact sample verifies, signed with the conformance test key", async () => {
    const html = committedText("website/public/sample-intact.dai");
    expect(isPublishedTestKey(parseContainer(html).publicKey)).toBe(true);
    let mounted = true;
    try {
      await verifyContainer(html);
    } catch {
      mounted = false;
    }
    expect(mounted).toBe(true);
    const report = await auditContainer(parseContainer(html));
    expect(report.ok).toBe(true);
    expect(report.signature.status).toBe("valid");
    expect(report.shell.status).toBe("ok");
  });

  test("the tampered sample is caught, one entry against the rest", async () => {
    const html = committedText("website/public/sample-tampered.dai");
    let mounted = true;
    try {
      await verifyContainer(html);
    } catch {
      mounted = false;
    }
    expect(mounted).toBe(false);
    const report = await auditContainer(parseContainer(html));
    expect(report.ok).toBe(false);
    expect(report.entries.some((entry) => entry.status === "mismatch")).toBe(true);
  });
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
