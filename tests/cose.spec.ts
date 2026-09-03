import { expect, test } from "@playwright/test";
import { Encoder } from "cbor-x";
import {
  ALG_ES256,
  CoseError,
  HEADER_ALG,
  HEADER_KID,
  buildSign1,
  parseSign1,
  sigStructure,
  verifySign1,
} from "../src/cose.js";

/*
 * Plain CBOR, and maps decoded as maps.
 *
 * cbor-x tags typed arrays and turns maps into plain objects by default. Both
 * are reasonable defaults for general use and neither is what COSE describes,
 * so the reference is configured to the standard rather than to its dialect —
 * otherwise the comparison tests the options and not the encoder.
 */
const reference = new Encoder({
  tagUint8Array: false,
  useRecords: false,
  mapsAsObjects: false,
});
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

async function keyPair() {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
}

const signWith = (key: CryptoKey) => async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));

const verifyWith = (key: CryptoKey) => async (signature: Uint8Array, data: Uint8Array) =>
  crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, data);

test.describe("the envelope", () => {
  test("is a COSE_Sign1 a foreign decoder can read", async () => {
    /*
     * The point of the exercise. A hand-rolled canonical string was not broken
     * — it had one implementation and no outside reader, so correctness meant
     * reading our own code back to ourselves. This asserts the envelope is the
     * structure RFC 9052 describes, as parsed by a decoder nobody here wrote.
     */
    const pair = await keyPair();
    const envelope = await buildSign1(bytes("the manifest"), signWith(pair.privateKey), {
      kid: "7da0d2dd9f71a948",
    });

    const read = reference.decode(Buffer.from(envelope)) as unknown[];
    expect(read).toHaveLength(4);

    const header = reference.decode(Buffer.from(read[0] as Uint8Array)) as Map<number, unknown>;
    expect(header.get(HEADER_ALG)).toBe(ALG_ES256);
    expect(new TextDecoder().decode(header.get(HEADER_KID) as Uint8Array)).toBe(
      "7da0d2dd9f71a948",
    );
    expect(new TextDecoder().decode(read[2] as Uint8Array)).toBe("the manifest");
  });

  test("signs Sig_structure, not the payload", async () => {
    // The context string is what stops a signature made for one purpose being
    // replayed as another, so the signature must not verify over the payload
    // alone however tempting that would be to implement.
    const pair = await keyPair();
    const payload = bytes("the manifest");
    const envelope = await buildSign1(payload, signWith(pair.privateKey));
    const parsed = parseSign1(envelope);

    expect(await verifyWith(pair.publicKey)(parsed.signature, payload)).toBe(false);
    expect(
      await verifyWith(pair.publicKey)(
        parsed.signature,
        sigStructure(parsed.protectedBytes, payload),
      ),
    ).toBe(true);
  });

  test("verifies, and stops verifying when the payload changes", async () => {
    const pair = await keyPair();
    const envelope = await buildSign1(bytes("the manifest"), signWith(pair.privateKey));

    expect(await verifySign1(envelope, bytes("the manifest"), verifyWith(pair.publicKey))).toBe(
      true,
    );
    expect(await verifySign1(envelope, bytes("another manifest"), verifyWith(pair.publicKey))).toBe(
      false,
    );
  });

  test("a detached payload leaves nothing in the envelope to disagree with", async () => {
    // The manifest is already in the container, so carrying it here as well
    // would mean two copies — and the one inside the signature would win
    // silently if they ever differed.
    const pair = await keyPair();
    const envelope = await buildSign1(bytes("the manifest"), signWith(pair.privateKey), {
      detached: true,
    });

    expect((reference.decode(Buffer.from(envelope)) as unknown[])[2]).toBeNull();
    expect(parseSign1(envelope).payload.byteLength).toBe(0);
    expect(await verifySign1(envelope, bytes("the manifest"), verifyWith(pair.publicKey))).toBe(
      true,
    );
  });
});

test.describe("what it refuses", () => {
  test("an algorithm it does not implement", async () => {
    // Named rather than skipped past: an attacker who can rewrite the algorithm
    // can otherwise talk a verifier down to whatever it happens to support.
    const forged = reference.encode([
      reference.encode(new Map([[HEADER_ALG, -8]])),
      new Map(),
      bytes("payload"),
      bytes("signature"),
    ]);
    expect(() => parseSign1(new Uint8Array(forged))).toThrow(/Unsupported signature algorithm/);
  });

  test("something that is not a Sign1 at all", () => {
    const notAnEnvelope = new Uint8Array(reference.encode(["only", "three", "things"]));
    expect(() => parseSign1(notAnEnvelope)).toThrow(CoseError);
  });

  test("an envelope with bytes appended", async () => {
    const pair = await keyPair();
    const envelope = await buildSign1(bytes("m"), signWith(pair.privateKey));
    expect(() => parseSign1(new Uint8Array([...envelope, 0]))).toThrow(/after the end/i);
  });
});
