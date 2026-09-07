/**
 * Keys this project publishes, and what a host must say about them.
 *
 * The conformance suite signs its cases with a known key and ships that key, so
 * anybody can regenerate the vectors and get the same bytes. A suite whose key
 * is secret is a suite nobody else can run against, which defeats the purpose
 * of having one.
 *
 * The consequence is that everybody has it. A signature made with it proves
 * only that whoever made the container had a file that is in this repository —
 * which is no evidence of anything. Worse, it is evidence-shaped: a container
 * signed with it verifies, and a host that showed "signed" without qualification
 * would be lending the word to any passer-by.
 *
 * So two rules, in the two places they belong:
 *
 * - **A host labels it.** A document signed with a published test key is shown
 *   as a test key and untrusted — never as a publisher, never with a name, and
 *   never pinned as one. `src/publisher.ts` treats it as its own state.
 * - **The compiler refuses to use it**, unless somebody says `--allow-test-key`.
 *   Signing with it by accident is the easy mistake — it is the key sitting in
 *   the repository, and it is what a copied command line reaches for — and the
 *   result looks signed to whoever is handed it.
 *
 * Recognised by public key rather than by file path, because the file can be
 * copied anywhere and renamed anything, and the thing that matters is which key
 * made the signature.
 */

/** Base64 SPKI of every key this project publishes. */
export const PUBLISHED_TEST_KEYS: Readonly<Record<string, string>> = {
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEMTKDZBbxhVnk//lqFtU5jD/CVo524ti2sf/xowCT8hnya3iGwFYjroNwPquGNSMRqsD32V4hTJ2P9wN2UrwZIQ==":
    "the conformance suite's signing key",
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAtuwVEhCbRQBZCeNyoPMARx0aZ2nvW/2Sr1nKajKAqN3FaCp4hJMMxPZU988S33MHC+VlUGxmeodAYUF5qrH1Q==":
    "the conformance suite's countersigning key",
};

/**
 * Whether this public key is one anybody could have.
 *
 * `publicKey` is base64 SPKI, as a container carries it. Whitespace is stripped
 * because a key that has been through a JSON file, a header and a copy-paste is
 * still the same key.
 */
export function isPublishedTestKey(publicKey: string | undefined): boolean {
  if (!publicKey) return false;
  return Object.prototype.hasOwnProperty.call(PUBLISHED_TEST_KEYS, publicKey.replace(/\s+/g, ""));
}

/** What to call it, for a message that has to say which one. */
export function describeTestKey(publicKey: string | undefined): string | undefined {
  if (!publicKey) return undefined;
  return PUBLISHED_TEST_KEYS[publicKey.replace(/\s+/g, "")];
}
