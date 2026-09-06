import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { buildContainer, type BuildContainerInput } from "../src/core.js";
import { verifyContainer } from "../src/container.js";
import { publisherState, type PublisherStore } from "../src/publisher.js";
import { isPublishedTestKey, PUBLISHED_TEST_KEYS } from "../src/test-keys.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_KEY = readFileSync(join(repo, "conformance/signing-key.pem"), "utf8");
const PUBLISHER_KEY = readFileSync(join(repo, "conformance/trust-publisher-a-key.pem"), "utf8");

/**
 * A key everybody has, and what must be said about it.
 *
 * The conformance suite's key is committed so anyone can regenerate the
 * vectors and get the same bytes. The cost is that a signature made with it
 * proves only that whoever built the container had a file out of this
 * repository — which is no evidence at all, and is worse than no signature,
 * because it is evidence-shaped. A host showing "signed" without qualification
 * would be lending the word to any passer-by.
 *
 * Two rules, in the two places they belong: a writer refuses to use it, and a
 * host refuses to dignify it.
 */

/** No confusables loaded: none of these names is a lookalike of another. */
const TABLE = { unicode: "test", map: {} };

/** A device that has pinned nothing, so any ordinary key reads as new. */
function emptyStore(): PublisherStore {
  return {
    byKey: async () => null,
    bySkeleton: async () => [],
    save: async () => {},
    roots: async () => [],
  };
}

async function input(overrides: Partial<BuildContainerInput> = {}): Promise<BuildContainerInput> {
  const { packagedAsset } = await import("../src/compile.js");
  return {
    files: { "index.html": new TextEncoder().encode("<!doctype html><title>t</title><body>hi") },
    template: readFileSync(packagedAsset("template.html"), "utf8"),
    runtime: readFileSync(packagedAsset("dai-runtime.js"), "utf8"),
    appName: "Test",
    ...overrides,
  } as BuildContainerInput;
}

test.describe("a key that is published in this repository", () => {
  test("is recognised by key, not by where the file happens to live", () => {
    // Two, and both named, so a message can say which one.
    expect(Object.keys(PUBLISHED_TEST_KEYS)).toHaveLength(2);
    for (const description of Object.values(PUBLISHED_TEST_KEYS)) {
      expect(description).toMatch(/conformance/i);
    }

    const [first] = Object.keys(PUBLISHED_TEST_KEYS);
    expect(isPublishedTestKey(first)).toBe(true);
    // Whitespace a key picks up passing through JSON, a header, a paste.
    expect(isPublishedTestKey(`  ${first}\n`)).toBe(true);
    expect(isPublishedTestKey(undefined)).toBe(false);
    expect(isPublishedTestKey("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(52))).toBe(false);
  });

  test("the compiler refuses to sign with it, and says why", async () => {
    await expect(buildContainer(await input({ signingKey: TEST_KEY }))).rejects.toThrow(
      /published in the DAI source/,
    );

    // The message has to name the way out, or somebody's next move is to
    // delete the check.
    await expect(buildContainer(await input({ signingKey: TEST_KEY }))).rejects.toThrow(
      /--allow-test-key/,
    );
  });

  test("and signs with it when the caller says so, because the suite must", async () => {
    const built = await buildContainer(await input({ signingKey: TEST_KEY, allowTestKey: true }));
    expect(built.publicKeyFingerprint).toBeTruthy();
    expect(isPublishedTestKey((await verifyContainer(built.html)).publicKey)).toBe(true);
  });

  test("an ordinary key is untouched by any of this", async () => {
    const built = await buildContainer(await input({ signingKey: PUBLISHER_KEY }));
    expect(isPublishedTestKey((await verifyContainer(built.html)).publicKey)).toBe(false);
  });

  test("a host calls it a test key, never a publisher", async () => {
    const built = await buildContainer(
      await input({
        signingKey: TEST_KEY,
        allowTestKey: true,
        manifestVersion: 3,
        // A name on it changes nothing: the key is what is being judged.
        publisherName: "Acme Finance",
      }),
    );
    const container = await verifyContainer(built.html);
    expect(container.signature).toBe("valid");

    // An empty store: nothing has been pinned, so any other key here would be
    // "new" with a safety number.
    const who = await publisherState(emptyStore(), container, TABLE);

    expect(who.state).toBe("test-key");
    // Not "new", and not carrying the name the document asked to be shown as.
    expect(JSON.stringify(who)).not.toContain("Acme Finance");
    if (who.state === "test-key") expect(who.which).toMatch(/conformance/i);
  });

  test("the trust vectors' publishers are deliberately not test keys", async () => {
    // If they were, every reader would be required to report them as test
    // keys, and the vectors that exercise known / new / conflict could not
    // reach any of those states.
    const built = await buildContainer(
      await input({ signingKey: PUBLISHER_KEY, manifestVersion: 3, publisherName: "Ace Space" }),
    );
    const container = await verifyContainer(built.html);
    const who = await publisherState(emptyStore(), container, TABLE);
    expect(who.state).toBe("new");
  });
});
