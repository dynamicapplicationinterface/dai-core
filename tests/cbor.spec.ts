import { expect, test } from "@playwright/test";
import { Encoder } from "cbor-x";

/*
 * The reference, configured to plain CBOR.
 *
 * cbor-x wraps a Uint8Array in tag 64 by default — a legal annotation saying
 * "this was a typed array", and not what a COSE byte string is. Turning it off
 * is what makes the comparison meaningful rather than a comparison against a
 * dialect. The first run of these tests reported a mismatch that was this
 * option and not an encoder bug.
 */
const reference = new Encoder({ tagUint8Array: false, useRecords: false });
const referenceEncode = (value: unknown): Uint8Array => new Uint8Array(reference.encode(value));
const referenceDecode = (bytes: Uint8Array): unknown => reference.decode(Buffer.from(bytes));
import { CborError, decode, encode, type CborValue } from "../src/cbor.js";

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The encoder is checked against an implementation nobody here wrote.
 *
 * That is the whole reason for using a standard encoding rather than a
 * hand-rolled string: correctness stops being a matter of reading our own code
 * back to ourselves. `cbor-x` is a development dependency and does not ship —
 * the runtime dependency list stays at two, which a packaging test enforces.
 */
test.describe("against a reference implementation", () => {
  const cases: Record<string, CborValue> = {
    zero: 0,
    "one byte": 23,
    "the 24 boundary": 24,
    "two bytes": 300,
    "four bytes": 70000,
    "negative one": -1,
    "the algorithm identifier ES256 uses": -7,
    "empty text": "",
    text: "documentUuid",
    "text with a newline": "a\nfavicon:evil",
    "text outside ASCII": "Tâches — 日本語",
    "empty bytes": new Uint8Array(0),
    bytes: new Uint8Array([0, 1, 2, 253, 254, 255]),
    null: null,
    "empty array": [],
    array: [1, "two", new Uint8Array([3])],
    nested: [[1, [2, [3]]]],
  };

  for (const [name, value] of Object.entries(cases)) {
    test(`encodes ${name} the same way`, () => {
      expect(hex(encode(value))).toBe(hex(referenceEncode(value)));
    });
  }

  test("a reference decoder reads what we write", () => {
    const value = new Map<CborValue, CborValue>([
      [1, -7],
      ["kid", new Uint8Array([9, 9])],
    ]);
    const read = referenceDecode(encode(value)) as Record<string, unknown>;
    expect(read[1]).toBe(-7);
    expect(hex(read.kid as Uint8Array)).toBe("0909");
  });

  test("we read what a reference encoder writes", () => {
    const bytes = referenceEncode(["Signature1", new Uint8Array([1]), "x"]);
    expect(decode(bytes)).toEqual(["Signature1", new Uint8Array([1]), "x"]);
  });
});

test.describe("deterministic encoding", () => {
  test("map keys are ordered by their encoded bytes, not their values", () => {
    /*
     * The rule that matters for a signature. Bytewise order is not the same as
     * lexicographic order over the values: a shorter key sorts first regardless
     * of its characters, because its length prefix is smaller. Two encoders
     * that disagree here produce signatures that do not verify, and the
     * disagreement is invisible until somebody else's verifier says no.
     */
    const one = encode(
      new Map<CborValue, CborValue>([
        ["zz", 1],
        ["a", 2],
      ]),
    );
    const other = encode(
      new Map<CborValue, CborValue>([
        ["a", 2],
        ["zz", 1],
      ]),
    );

    expect(hex(one)).toBe(hex(other));
    // "a" is one byte and sorts before "zz" whichever order it was given in.
    expect(hex(one)).toBe("a2616102627a7a01");
  });

  test("integer keys sort before text keys, as their major type demands", () => {
    const bytes = encode(
      new Map<CborValue, CborValue>([
        ["alg", 1],
        [1, -7],
      ]),
    );
    expect(hex(bytes).startsWith("a201")).toBe(true);
  });

  test("lengths use the shortest form that fits", () => {
    expect(hex(encode(23))).toBe("17");
    expect(hex(encode(24))).toBe("1818");
    expect(hex(encode(255))).toBe("18ff");
    expect(hex(encode(256))).toBe("190100");
  });

  test("a duplicated key is refused rather than silently collapsed", () => {
    const map = new Map<CborValue, CborValue>();
    map.set("a", 1);
    // Distinct object identities that encode identically: a Map keeps both, and
    // emitting both would be a structurally invalid document.
    map.set(new Uint8Array([1]), 2);
    map.set(new Uint8Array([1]), 3);
    expect(() => encode(map)).toThrow(CborError);
  });
});

test.describe("what it refuses", () => {
  test("a non-integer number", () => {
    expect(() => encode(1.5)).toThrow(/integers/i);
  });

  test("bytes after the end of a value", () => {
    // In a signature envelope this is somebody appending to it.
    const bytes = new Uint8Array([...encode([1, 2]), 0x00]);
    expect(() => decode(bytes)).toThrow(/after the end/i);
  });

  test("a truncated value", () => {
    const bytes = encode("documentUuid").subarray(0, 4);
    expect(() => decode(bytes)).toThrow(CborError);
  });

  test("an indefinite length", () => {
    // 0x9f is an indefinite-length array. Legal CBOR, never produced here, and
    // accepting it would mean decoding shapes nothing tests.
    expect(() => decode(new Uint8Array([0x9f, 0x01, 0xff]))).toThrow(/Unsupported length/i);
  });
});

test("round-trips everything it encodes", () => {
  const value: CborValue = [
    new Map<CborValue, CborValue>([
      [1, -7],
      ["nested", ["a", new Uint8Array([1, 2, 3]), null]],
    ]),
    0,
    "end",
  ];
  expect(decode(encode(value))).toEqual(value);
});
