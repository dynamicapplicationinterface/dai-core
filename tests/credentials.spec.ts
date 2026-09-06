import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { STORE_VARIABLES, loadEnvFile } from "../src/env.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where a store's credentials live, held as a rule rather than a paragraph.
 *
 * A write credential for a bucket is the one secret this project has. It
 * belongs on the machine doing the publishing and nowhere else — not in the
 * repository, not in a deployed service, not in a browser bundle, not sealed
 * into a container that somebody is about to mail to a stranger.
 *
 * That last one is why this is a test. Every other rule here is about what a
 * program does; this one is about what a file contains, and a file is exactly
 * the thing that gets committed by accident at eleven at night.
 */
test.describe("credentials, and the places they must not be", () => {
  test("git ignores the real file and tracks only the example", () => {
    const ignored = (path: string): boolean => {
      try {
        execFileSync("git", ["check-ignore", "-q", path], { cwd: repo });
        return true;
      } catch {
        return false;
      }
    };

    // The file somebody actually puts a secret in.
    expect(ignored(".env.local"), ".env.local must be ignored").toBe(true);
    expect(ignored(".env"), ".env must be ignored").toBe(true);
    expect(ignored(".env.production"), "any .env.* must be ignored").toBe(true);

    // And the one that documents the shape, which has to stay committed or
    // nobody knows what to fill in.
    expect(ignored(".env.example"), ".env.example must NOT be ignored").toBe(false);
    expect(existsSync(join(repo, ".env.example"))).toBe(true);
  });

  test("the example documents every name the code reads, and holds no values", () => {
    const example = readFileSync(join(repo, ".env.example"), "utf8");

    for (const name of STORE_VARIABLES) {
      expect(example, `.env.example should mention ${name}`).toContain(name);
    }

    // Every non-comment line would be a value somebody committed.
    const live = example
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"));
    expect(live, `.env.example must be entirely commented: ${live.join(", ")}`).toEqual([]);
  });

  test("nothing tracked in the repository looks like a live secret", () => {
    // Tracked files only: a build output or somebody's scratch directory is
    // not what gets pushed.
    const tracked = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      // Binary and generated containers: the conformance cases and samples are
      // built artefacts whose bytes are checked elsewhere.
      .filter((path) => !/\.(dai|png|ico|woff2?|wasm|zip)$/i.test(path));

    const shapes: [string, RegExp][] = [
      // An assignment with something after the equals sign.
      ["a store secret", /DAI_STORE_SECRET_ACCESS_KEY\s*[=:]\s*['"]?[A-Za-z0-9/+_-]{16,}/],
      ["a store key id", /DAI_STORE_ACCESS_KEY_ID\s*[=:]\s*['"]?[A-Za-z0-9]{16,}/],
      ["an AWS key id", /\bAKIA[0-9A-Z]{16}\b/],
      /*
       * A whole PEM block, not the words on their own.
       *
       * Source that parses or assembles PEM says "BEGIN PRIVATE KEY" and holds
       * no key; a placeholder in a textarea says it too. What makes a file a
       * key is the header followed by actual base64, so that is what this
       * matches.
       */
      [
        "a PEM private key",
        /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{64,}-----END/,
      ],
    ];

    /*
     * Keys this project publishes on purpose.
     *
     * The conformance suite signs its cases with a known key and ships it, so
     * anybody can regenerate the vectors and get the same bytes. A suite whose
     * key is secret is a suite nobody else can run, which defeats the point of
     * having one. Both are documented as public in conformance/README.md and
     * are used for nothing else.
     */
    const published = new Set([
      "conformance/signing-key.pem",
      "conformance/countersign-key.pem",
      // The trust vectors' two stand-in publishers. Committed for the same
      // reason and, unlike the two above, deliberately not on the declared
      // test-key list — see conformance/README.md.
      "conformance/trust-publisher-a-key.pem",
      "conformance/trust-publisher-b-key.pem",
    ]);

    const found: string[] = [];
    for (const path of tracked) {
      const full = join(repo, path);
      if (!existsSync(full)) continue;
      let body: string;
      try {
        body = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      // The test's own patterns are not a finding, and neither is a key this
      // project publishes deliberately.
      if (path === "tests/credentials.spec.ts" || published.has(path)) continue;
      for (const [what, pattern] of shapes) {
        if (pattern.test(body)) found.push(`${path}: ${what}`);
      }
    }

    expect(found, `possible credentials committed:\n${found.join("\n")}`).toEqual([]);
  });

  test("a real environment variable beats the file, and the file is read at all", () => {
    const work = mkdtempSync(join(tmpdir(), "dai-env-"));
    writeFileSync(
      join(work, ".env.local"),
      [
        "# a comment",
        "",
        "DAI_TEST_FROM_FILE=file-value",
        'DAI_TEST_QUOTED="quoted value"',
        "DAI_TEST_ALREADY_SET=file-value",
      ].join("\n"),
      "utf8",
    );

    // Set beforehand: an export is a deliberate act and has to win, or CI
    // cannot override what somebody left in a file.
    process.env.DAI_TEST_ALREADY_SET = "environment-value";
    delete process.env.DAI_TEST_FROM_FILE;
    delete process.env.DAI_TEST_QUOTED;

    try {
      expect(loadEnvFile(work)).toBe(join(work, ".env.local"));
      expect(process.env.DAI_TEST_FROM_FILE).toBe("file-value");
      expect(process.env.DAI_TEST_QUOTED).toBe("quoted value");
      expect(process.env.DAI_TEST_ALREADY_SET).toBe("environment-value");
    } finally {
      delete process.env.DAI_TEST_FROM_FILE;
      delete process.env.DAI_TEST_QUOTED;
      delete process.env.DAI_TEST_ALREADY_SET;
    }

    // No file is not an error. A machine that publishes nowhere is a machine
    // that builds files, which is most of them.
    expect(loadEnvFile(mkdtempSync(join(tmpdir(), "dai-env-none-")))).toBeUndefined();
  });

  test("a half-configured store refuses rather than quietly writing somewhere else", async () => {
    const { storeFromEnvironment } = await import("../src/env.js");
    const empty = mkdtempSync(join(tmpdir(), "dai-env-partial-"));

    const before = { ...process.env };
    try {
      for (const name of STORE_VARIABLES) delete process.env[name];
      process.env.DAI_STORE_BUCKET = "dai-store";
      process.env.DAI_STORE_ENDPOINT = "https://example.r2.cloudflarestorage.com";
      // and no key, no secret, no public base

      await expect(storeFromEnvironment(empty)).rejects.toThrow(/Missing: .*DAI_STORE_ACCESS_KEY_ID/);
    } finally {
      for (const name of STORE_VARIABLES) delete process.env[name];
      Object.assign(process.env, before);
    }
  });

  test("nothing deployed asks for a credential", () => {
    // The opener and the edge middleware read public objects over HTTPS. If
    // either ever needs a secret, the design has changed in a way that should
    // not pass quietly: a credential in a browser bundle is readable by whoever
    // was sent the link, and one at the edge is a key this project holds on
    // behalf of documents it should not be able to read.
    for (const path of ["apps/runner/middleware.ts", "apps/runner/src/main.ts"]) {
      const body = readFileSync(join(repo, path), "utf8");
      expect(body, `${path} must not read a store credential`).not.toMatch(
        /DAI_S3_SECRET_ACCESS_KEY|DAI_S3_ACCESS_KEY_ID|secretAccessKey/,
      );
    }
  });
});
