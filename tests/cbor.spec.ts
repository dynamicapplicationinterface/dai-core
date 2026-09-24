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

test.describe("a number with a fraction", () => {
  /*
   * A replicated row's REAL column can hold one, and a row that cannot be
   * encoded cannot be sealed, so a document with a decimal in a shared table
   * could never be saved (identity step 3). Always float64, never shorter: one
   * width is what keeps it deterministic.
   */
  test("is a float64, byte for byte what a reference writes for one", () => {
    // 0.1 needs all 64 bits, so the reference writes a float64 too.
    expect(hex(encode(0.1))).toBe(hex(new Uint8Array(reference.encode(0.1))));
    expect(hex(encode(0.1))).toBe("fb3fb999999999999a");
  });

  test("reads back through a reference implementation, and through this one", () => {
    for (const value of [1.5, -2.25, 0.1, 1.5e-300, -Infinity]) {
      expect(new Encoder({ tagUint8Array: false, useRecords: false }).decode(encode(value))).toBe(value);
      expect(decode(encode(value))).toBe(value);
    }
  });

  test("a whole number stays an integer", () => {
    expect(hex(encode(2))).toBe("02");
  });
});

test("an integer past four bytes, like a millisecond timestamp, is eight bytes, and reads back exactly", () => {
  // A shared row with a time in it could not be encoded, so could not travel
  // by mailbox, and under seal-on-leave could not be saved (identity step 3).
  const at = 1_727_150_400_123;
  expect(hex(encode(at))).toBe("1b00000192222fa27b");
  // The reference reads any eight-byte integer as a BigInt; the value is the same.
  expect(Number(new Encoder({ tagUint8Array: false, useRecords: false }).decode(encode(at)))).toBe(at);
  expect(decode(encode(at))).toBe(at);
  expect(decode(encode(-at))).toBe(-at);
  expect(decode(encode(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
});

test.describe("integers to 64 bits (identity step 3 review, #5)", () => {
  /*
   * sqlite-wasm hands back a BigInt for an integer past 2^53, and a row that
   * cannot be encoded cannot be sealed, so every save of that document would
   * fail. A BigInt is a CBOR integer to ±2^64. A JS number that is whole and past
   * 2^53 has already lost its low bits: signing it would sign a value nobody
   * wrote, so it is refused, never turned into a float.
   */
  test("a BigInt is a CBOR integer, byte for byte what a reference writes", () => {
    for (const value of [2n ** 63n, 2n ** 64n - 1n, -(2n ** 63n)]) {
      expect(hex(encode(value)), String(value)).toBe(hex(new Uint8Array(reference.encode(value))));
      expect(decode(encode(value)), String(value)).toBe(value);
    }
    expect(hex(encode(2n ** 63n))).toBe("1b8000000000000000");
    // -2^64 is the last value a CBOR integer holds (major type 1, 2^64 - 1). The
    // reference writes it as a tagged bignum instead; the plain integer is the
    // deterministic form, and the reference reads it back to the same value.
    expect(hex(encode(-(2n ** 64n)))).toBe("3bffffffffffffffff");
    expect(BigInt(referenceDecode(encode(-(2n ** 64n))) as bigint)).toBe(-(2n ** 64n));
    expect(decode(encode(-(2n ** 64n)))).toBe(-(2n ** 64n));
  });

  test("a BigInt that fits a safe integer is written the shortest way, like the number it equals", () => {
    expect(hex(encode(7n))).toBe(hex(encode(7)));
    expect(hex(encode(1_727_150_400_123n))).toBe(hex(encode(1_727_150_400_123)));
  });

  test("past ±2^64 is refused", () => {
    expect(() => encode(2n ** 64n)).toThrow(CborError);
    expect(() => encode(-(2n ** 64n) - 1n)).toThrow(CborError);
  });

  test("a whole JS number past 2^53 is refused, not floated", () => {
    expect(() => encode(2 ** 53 + 2)).toThrow(/2\^53|precision/);
    expect(() => encode(1e300)).toThrow(/2\^53|precision/);
  });
});

test.describe("what it refuses", () => {
  test("NaN, which has no place in a row", () => {
    expect(() => encode(Number.NaN)).toThrow(/NaN/);
    expect(() => decode(new Uint8Array([0xfb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0]))).toThrow(/NaN/);
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

  test("nesting past any envelope's depth, by name rather than by stack overflow", () => {
    // 0x81 is a one-element array; a thousand of them is a value nobody
    // wrote for a reason. Before the cap this threw a RangeError from the
    // engine, which the signature path reported as damage of an unplanned kind.
    const deep = new Uint8Array([...new Array(1000).fill(0x81), 0x00]);
    expect(() => decode(deep)).toThrow(/deeper than/i);
    // Four levels — a COSE_Sign1 with a protected header map — is fine.
    expect(decode(encode([[[[1]]]]))).toEqual([[[[1]]]]);
  });

  test("a repeated map key", () => {
    // {1: 1, 1: 2} — deterministic encoding forbids it, and "last wins" is a
    // reading nobody agreed to.
    expect(() => decode(new Uint8Array([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow(/duplicate/i);
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
