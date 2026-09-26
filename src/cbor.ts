/**
 * Just enough CBOR to build and read a COSE signature (RFC 8949).
 *
 * Written here rather than taken from a package because this one ships: the
 * runtime dependency list is two entries, deliberately, for a format whose
 * claim is self-containment. A test verifies the output against a real CBOR
 * implementation, which is a development dependency and does not travel.
 *
 * What a signature envelope and a replicated row need: integers to ±2^64 (a
 * BigInt past 2^53, as sqlite-wasm returns one), float64 (for a row's REAL
 * column), byte strings, text strings, arrays, maps and null. No other floats,
 * no tags, no indefinite lengths, no bignums. Anything outside that is rejected
 * rather than guessed at, and so is a whole JS number past 2^53: it has already
 * lost its low bits, and encoding it would sign a value nobody wrote.
 *
 * The encoding follows the deterministic rules in §4.2.1, because a signature
 * is over bytes: two encoders that agree on the value and disagree on the bytes
 * produce signatures that do not verify. Lengths are always the shortest form
 * that fits, and map keys are sorted by their encoded bytes rather than by
 * their values, which is what the specification requires and is not the same
 * ordering for anything but ASCII of equal length.
 */

export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | null
  | CborValue[]
  | Map<CborValue, CborValue>;

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

const MAJOR = {
  UNSIGNED: 0,
  NEGATIVE: 1,
  BYTES: 2,
  TEXT: 3,
  ARRAY: 4,
  MAP: 5,
  TAG: 6,
  SIMPLE: 7,
} as const;

/** A major type and a length, in the shortest form that holds the value. */
function head(major: number, value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new CborError(`Not a representable length: ${value}`);
  }
  if (value < 24) return new Uint8Array([(major << 5) | value]);
  if (value < 0x100) return new Uint8Array([(major << 5) | 24, value]);
  if (value < 0x10000) {
    return new Uint8Array([(major << 5) | 25, value >> 8, value & 0xff]);
  }
  if (value < 0x100000000) {
    return new Uint8Array([
      (major << 5) | 26,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ]);
  }
  // Eight bytes, up to 2^53: a millisecond timestamp in a replicated row is
  // past four bytes, and a row that cannot be encoded cannot be sealed. Past
  // 2^53 a JS number is not exact, and is encoded as a float64 instead.
  if (value <= Number.MAX_SAFE_INTEGER) {
    const high = Math.floor(value / 0x100000000);
    const low = value % 0x100000000;
    return new Uint8Array([
      (major << 5) | 27,
      0,
      (high >>> 16) & 0xff,
      (high >>> 8) & 0xff,
      high & 0xff,
      (low >>> 24) & 0xff,
      (low >>> 16) & 0xff,
      (low >>> 8) & 0xff,
      low & 0xff,
    ]);
  }
  throw new CborError("Values of this size are not supported.");
}

/** An eight-byte head for a BigInt past 2^53, up to 2^64 - 1. */
function head64(major: number, value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 64n) throw new CborError("Values of this size are not supported.");
  const out = new Uint8Array(9);
  out[0] = (major << 5) | 27;
  new DataView(out.buffer).setBigUint64(1, value, false);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Bytewise lexicographic order, as §4.2.1 specifies for map keys. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < shared; i++) {
    const difference = (a[i] as number) - (b[i] as number);
    if (difference !== 0) return difference;
  }
  return a.byteLength - b.byteLength;
}

export function encode(value: CborValue): Uint8Array {
  if (value === null) return new Uint8Array([(MAJOR.SIMPLE << 5) | 22]);

  if (typeof value === "bigint") {
    // The shortest form, as for a number, when it fits one exactly.
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return encode(Number(value));
    return value >= 0n ? head64(MAJOR.UNSIGNED, value) : head64(MAJOR.NEGATIVE, -1n - value);
  }

  if (typeof value === "number") {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CborError(
        "A whole number past 2^53 has already lost precision, and is not encoded; pass it as a BigInt.",
      );
    }
    if (!Number.isInteger(value)) {
      /*
       * A number with a fraction, which a replicated row's REAL column can hold:
       * always a float64 (0xfb, eight bytes, big-endian), never a shorter float.
       * One width is what keeps it deterministic, and a number with no fraction
       * is an integer above whatever its column's type, which is how SQLite
       * hands a whole REAL back. NaN has no place in a row and is refused.
       */
      if (Number.isNaN(value)) throw new CborError("NaN is not encodable.");
      const out = new Uint8Array(9);
      out[0] = (MAJOR.SIMPLE << 5) | 27;
      new DataView(out.buffer).setFloat64(1, value, false);
      return out;
    }
    // Negative integers are stored as -1 minus the encoded value, which is why
    // -1 is written as 0 rather than as a sign bit.
    return value >= 0 ? head(MAJOR.UNSIGNED, value) : head(MAJOR.NEGATIVE, -value - 1);
  }

  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat([head(MAJOR.TEXT, bytes.byteLength), bytes]);
  }

  if (value instanceof Uint8Array) {
    return concat([head(MAJOR.BYTES, value.byteLength), value]);
  }

  if (Array.isArray(value)) {
    return concat([head(MAJOR.ARRAY, value.length), ...value.map(encode)]);
  }

  if (value instanceof Map) {
    const pairs = [...value.entries()]
      .map(([key, item]) => ({ key: encode(key), item: encode(item) }))
      .sort((a, b) => compareBytes(a.key, b.key));

    for (let i = 1; i < pairs.length; i++) {
      if (compareBytes(pairs[i - 1]!.key, pairs[i]!.key) === 0) {
        throw new CborError("A map cannot carry the same key twice.");
      }
    }

    return concat([head(MAJOR.MAP, pairs.length), ...pairs.flatMap((p) => [p.key, p.item])]);
  }

  throw new CborError(`Nothing here encodes a ${typeof value}.`);
}

interface Cursor {
  bytes: Uint8Array;
  at: number;
}

function readHead(cursor: Cursor): { major: number; value: number | bigint } {
  if (cursor.at >= cursor.bytes.byteLength) throw new CborError("Ended mid-value.");

  const initial = cursor.bytes[cursor.at++] as number;
  const major = initial >> 5;
  const short = initial & 0x1f;

  if (short < 24) return { major, value: short };

  const width = short === 24 ? 1 : short === 25 ? 2 : short === 26 ? 4 : short === 27 ? 8 : 0;
  if (width === 0) {
    // 31 is indefinite: never produced by the encoder above, and accepting it
    // would mean decoding shapes no test covers.
    throw new CborError(`Unsupported length encoding: ${short}`);
  }
  if (cursor.at + width > cursor.bytes.byteLength) throw new CborError("Ended mid-length.");

  if (width === 8) {
    // Past 2^53 a JS number is not exact, and a value read wrong is worse than
    // one refused: it comes back as the BigInt it is.
    const big = new DataView(cursor.bytes.buffer, cursor.bytes.byteOffset + cursor.at, 8).getBigUint64(0, false);
    cursor.at += 8;
    return { major, value: big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big };
  }
  let value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + (cursor.bytes[cursor.at++] as number);
  return { major, value };
}

/**
 * How deep a value may nest. A COSE envelope is four levels; a crafted one of
 * nested arrays would otherwise run the decoder off the stack, and a reader
 * that throws a RangeError on the signature path is a reader that has been
 * made to misreport a container as damaged in an unplanned way.
 */
const MAX_DEPTH = 32;

function decodeAt(cursor: Cursor, depth = 0): CborValue {
  if (depth > MAX_DEPTH) throw new CborError(`Nested deeper than ${MAX_DEPTH} levels.`);
  // A float64, the one float this encoder writes. Read before the head, whose
  // length forms it would otherwise take it for.
  if (cursor.bytes[cursor.at] === ((MAJOR.SIMPLE << 5) | 27)) {
    if (cursor.at + 9 > cursor.bytes.byteLength) throw new CborError("Ended mid-value.");
    const view = new DataView(cursor.bytes.buffer, cursor.bytes.byteOffset + cursor.at + 1, 8);
    const float = view.getFloat64(0, false);
    cursor.at += 9;
    if (Number.isNaN(float)) throw new CborError("NaN is not a value here.");
    return float;
  }
  const { major, value: raw } = readHead(cursor);

  // An integer may be a BigInt; a length never is.
  if (major === MAJOR.UNSIGNED) return raw;
  if (major === MAJOR.NEGATIVE) {
    if (typeof raw === "bigint" || raw >= Number.MAX_SAFE_INTEGER) return -BigInt(raw) - 1n;
    return -raw - 1;
  }
  if (typeof raw === "bigint") throw new CborError("Values of this size are not supported.");
  const value = raw;

  switch (major) {
    case MAJOR.BYTES: {
      if (cursor.at + value > cursor.bytes.byteLength) throw new CborError("Ended mid-string.");
      const bytes = cursor.bytes.slice(cursor.at, cursor.at + value);
      cursor.at += value;
      return bytes;
    }
    case MAJOR.TEXT: {
      if (cursor.at + value > cursor.bytes.byteLength) throw new CborError("Ended mid-string.");
      const text = new TextDecoder().decode(cursor.bytes.subarray(cursor.at, cursor.at + value));
      cursor.at += value;
      return text;
    }
    case MAJOR.ARRAY: {
      const items: CborValue[] = [];
      for (let i = 0; i < value; i++) items.push(decodeAt(cursor, depth + 1));
      return items;
    }
    case MAJOR.MAP: {
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < value; i++) {
        const key = decodeAt(cursor, depth + 1);
        // Deterministic encoding (RFC 8949 §4.2.1) forbids a repeated key, and
        // "last wins" is a reading nobody agreed to; a strict reader refuses.
        if (map.has(key)) throw new CborError("Duplicate map key.");
        map.set(key, decodeAt(cursor, depth + 1));
      }
      return map;
    }
    case MAJOR.TAG:
      /*
       * One tag, and only as a wrapper: 18 marks a COSE_Sign1. The envelope is
       * written untagged (spec §9.4), but standard COSE libraries emit the tag
       * and a reader that refused it would refuse a correct signature. The tag
       * is dropped and the enclosed value returned; every other tag is a value
       * this decoder has no meaning for.
       */
      if (value !== 18) throw new CborError(`Unsupported tag: ${value}`);
      return decodeAt(cursor, depth + 1);
    case MAJOR.SIMPLE:
      if (value === 22) return null;
      throw new CborError(`Unsupported simple value: ${value}`);
    default:
      throw new CborError(`Unsupported major type: ${major}`);
  }
}

/** Decodes one value, and refuses anything trailing it. */
export function decode(bytes: Uint8Array): CborValue {
  const cursor: Cursor = { bytes, at: 0 };
  const value = decodeAt(cursor);
  if (cursor.at !== bytes.byteLength) {
    // Trailing bytes in a signature envelope are somebody appending to it.
    throw new CborError("Unexpected bytes after the end of the value.");
  }
  return value;
}
