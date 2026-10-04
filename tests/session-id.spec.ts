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

/*
 * The frozen vectors were refrozen on 3 October (R15): the id hashes the roster
 * the creator's seat row declares after its author and seq. Before, it hashed
 * the author and the seq alone (D158): SHA-256(author ‖ seq), whose vectors for
 * this author were 0ec101b7… (seq 1), c30e1e37… (256) and bc4d38c6… (2^40 + 3).
 */
const SEAT = new Uint8Array(16).fill(0xa1);
const OPEN = new Uint8Array(16).fill(0xb1);
const THIRD = new Uint8Array(16).fill(0xb5);

test("batch format version 2 (D158, R15): a session id is SHA-256(author ‖ seq ‖ CBOR([seat, seats, close])), frozen", () => {
  // Derived with node:crypto and the CBOR assembled by hand: the seq as eight
  // bytes, unsigned, big-endian, then 0x83 and the row's three columns.
  const author = new Uint8Array(Buffer.from("a3a8b56f9591737fca3854a36eb4583f", "hex"));
  expect(hex(sessionIdOf(author, 1, SEAT, OPEN, "any")!)).toBe("ea45a57ec6e9e904105cea3e64546408");
  expect(hex(sessionIdOf(author, 256, SEAT, new Uint8Array([...OPEN, ...THIRD]), "creator")!)).toBe("2152ab64f3f5b83485e5ac523836fbfb");
  expect(hex(sessionIdOf(author, 2 ** 40 + 3, SEAT, new Uint8Array(0), "any")!)).toBe("ab63076b384fc251580e1ceba4aece87");
  // A roster that is not valid still names its session (and that session is void).
  expect(hex(sessionIdOf(author, 1, SEAT, null, null)!)).toBe("790ad3cce7904ff5318edcbbe9a00633");
  expect(sessionIdOf(author, 0, SEAT, OPEN, "any"), "no row has seq 0").toBeNull();
  expect(sessionIdOf(author, 1.5, SEAT, OPEN, "any"), "a seq is a whole number").toBeNull();
});

test("a session id agrees with WebCrypto, reads a BigInt seq as its number, and malformed input names none", async () => {
  const author = new Uint8Array(SESSION_ID_BYTES).fill(0xc0);
  const seq = new Uint8Array([0, 0, 0, 0, 0, 0, 0x01, 0x2c]); // 300, eight bytes big-endian
  const roster = new Uint8Array([0x83, 0x50, ...SEAT, 0x50, ...OPEN, 0x63, 0x61, 0x6e, 0x79]);
  const full = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new Uint8Array([...author, ...seq, ...roster])));
  expect(hex(sessionIdOf(author, 300, SEAT, OPEN, "any")!)).toBe(hex(full.slice(0, SESSION_ID_BYTES)));
  // sqlite-wasm may hand an integer back as a BigInt; it is the same seq.
  expect(hex(sessionIdOf(author, 300n, SEAT, OPEN, "any")!)).toBe(hex(sessionIdOf(author, 300, SEAT, OPEN, "any")!));
  // The roster is hashed as the row holds it: another roster is another session.
  expect(hex(sessionIdOf(author, 300, SEAT, THIRD, "any")!)).not.toBe(hex(sessionIdOf(author, 300, SEAT, OPEN, "any")!));
  expect(hex(sessionIdOf(author, 300, SEAT, OPEN, "creator")!)).not.toBe(hex(sessionIdOf(author, 300, SEAT, OPEN, "any")!));
  expect(sessionIdOf(new Uint8Array(15), 1, SEAT, OPEN, "any"), "a short author").toBeNull();
  expect(sessionIdOf(null, 1, SEAT, OPEN, "any"), "no author").toBeNull();
  expect(sessionIdOf(author, "1", SEAT, OPEN, "any"), "a seq as text").toBeNull();
  expect(sessionIdOf(author, -1, SEAT, OPEN, "any"), "a negative seq").toBeNull();
  expect(sessionIdOf(author, new Uint8Array(16), SEAT, OPEN, "any"), "bytes, as the nonce was").toBeNull();
  expect(sessionIdOf(author, 1, SEAT, Number.NaN, "any"), "a column no signed row can hold").toBeNull();
});
