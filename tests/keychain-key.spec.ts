import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { verifyAsync } from "@noble/ed25519";
import { carriedKeychainKey, keychainKey, webCryptoKeychainKey } from "../apps/runner/src/keychain-key.js";
import { fromB64u, keychainSeed, keychainVerifier, utf8, verifyEd25519 } from "../apps/owner-store/src/envelope.js";

/**
 * The keychain key the opener carries is WebCrypto's, byte for byte (D302,
 * ruled 30 October; Build 2b-2fr item 6).
 *
 * Where WebCrypto has no Ed25519 the opener derives the keychain path's
 * verifier and signs a keychain Admit with `@noble/ed25519`. The store holds
 * one verifier per owner and checks every proof against it with WebCrypto, so
 * the two must be one key: from the same seed, the same verifier, and a
 * signature each accepts from the other. RFC 8032 signatures are
 * deterministic, so the signatures are the same bytes too.
 */

test.describe("the keychain key, carried and WebCrypto's (D302)", () => {
  test("from the same seed: the same verifier, the same signature, and each accepts the other's", async () => {
    for (let n = 0; n < 16; n += 1) {
      const seed = await keychainSeed(randomBytes(32));
      const web = await webCryptoKeychainKey(seed);
      const carried = await carriedKeychainKey(seed);
      expect(carried.carried).toBe(true);
      expect(carried.pub, "the verifier").toBe(web.pub);
      const challenge = utf8(`dai admit v1:${Date.now()}:${n}:author-${n}`);
      const byWeb = await web.sign(challenge);
      const byCarried = await carried.sign(challenge);
      expect(Buffer.from(byCarried).toString("base64"), "the signature, byte for byte").toBe(Buffer.from(byWeb).toString("base64"));
      // The store's own check, WebCrypto's, accepts the carried signature; the carried check accepts WebCrypto's.
      expect(await verifyEd25519(web.pub, byCarried, challenge), "WebCrypto accepts the carried signature").toBe(true);
      expect(await verifyAsync(byWeb, challenge, fromB64u(carried.pub)), "the carried check accepts WebCrypto's").toBe(true);
      expect(await verifyEd25519(web.pub, byCarried, utf8("another challenge")), "and nothing else").toBe(false);
    }
  });

  test("the key for a keychain secret is the verifier enrollment has always derived from it", async () => {
    const secret = utf8(randomBytes(32).toString("base64url"));
    const key = await keychainKey(secret);
    expect(key.carried, "WebCrypto's where WebCrypto has Ed25519").toBe(false);
    expect(key.pub).toBe((await keychainVerifier(secret)).pub);
    expect((await carriedKeychainKey(await keychainSeed(secret))).pub).toBe(key.pub);
  });
});
