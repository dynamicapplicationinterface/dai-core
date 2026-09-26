import { webcrypto } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SESSION_ID_BYTES, sessionIdOf, sha256 } from "../src/session-id.js";

/**
 * The session id's hash (src/session-id.ts). The roster views decide who
 * created a session with it, so it is held to the standard's own vectors and to
 * WebCrypto's answer over every length a padding boundary can fall on.
 */

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("the FIPS 180-4 vectors: empty, abc, and the two-block message", () => {
  // These spell the digests on purpose: the subject is the published answer.
  expect(hex(sha256(new Uint8Array()))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(hex(sha256(new TextEncoder().encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(hex(sha256(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("agrees with WebCrypto at every length from 0 to 200 bytes", async () => {
  for (let length = 0; length <= 200; length += 1) {
    const message = new Uint8Array(length).map((_, i) => (i * 31 + length) & 0xff);
    const expected = new Uint8Array(await webcrypto.subtle.digest("SHA-256", message));
    expect(hex(sha256(message)), `length ${length}`).toBe(hex(expected));
  }
});

test("a session id is the first 16 bytes of SHA-256(author ‖ nonce), and malformed input names none", async () => {
  const author = new Uint8Array(SESSION_ID_BYTES).fill(0xc0);
  const nonce = new Uint8Array(SESSION_ID_BYTES).fill(0x07);
  const joined = new Uint8Array([...author, ...nonce]);
  const full = new Uint8Array(await webcrypto.subtle.digest("SHA-256", joined));
  expect(hex(sessionIdOf(author, nonce)!)).toBe(hex(full.slice(0, SESSION_ID_BYTES)));
  expect(sessionIdOf(author, new Uint8Array(15)), "a short nonce").toBeNull();
  expect(sessionIdOf(null, nonce), "no author").toBeNull();
  expect(sessionIdOf(author, "07".repeat(16)), "a nonce as text").toBeNull();
});
