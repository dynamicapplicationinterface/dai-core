/**
 * Just enough CBOR to build and read a COSE signature (RFC 8949).
 *
 * Written here rather than taken from a package because this one ships: the
 * runtime dependency list is two entries, deliberately, for a format whose
 * claim is self-containment. A test verifies the output against a real CBOR
 * implementation, which is a development dependency and does not travel.
 *
 * Only what a signature envelope needs — unsigned integers, byte strings, text
 * strings, arrays, maps and null. No floats, no tags, no indefinite lengths,
 * no bignums. Anything outside that is rejected rather than guessed at.
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
  // 64-bit lengths are legal CBOR and are not reachable from anything this
  // encodes; refusing beats emitting something only half-tested.
  throw new CborError("Values of this size are not supported.");
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

  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new CborError("Only integers are encodable; this is not one.");
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

function readHead(cursor: Cursor): { major: number; value: number } {
  if (cursor.at >= cursor.bytes.byteLength) throw new CborError("Ended mid-value.");

  const initial = cursor.bytes[cursor.at++] as number;
  const major = initial >> 5;
  const short = initial & 0x1f;

  if (short < 24) return { major, value: short };

  const width = short === 24 ? 1 : short === 25 ? 2 : short === 26 ? 4 : 0;
  if (width === 0) {
    // 27 is a 64-bit length and 31 is indefinite; neither is produced by the
    // encoder above, and accepting them would mean decoding shapes no test
    // covers.
    throw new CborError(`Unsupported length encoding: ${short}`);
  }
  if (cursor.at + width > cursor.bytes.byteLength) throw new CborError("Ended mid-length.");

  let value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + (cursor.bytes[cursor.at++] as number);
  return { major, value };
}

function decodeAt(cursor: Cursor): CborValue {
  const { major, value } = readHead(cursor);

  switch (major) {
    case MAJOR.UNSIGNED:
      return value;
    case MAJOR.NEGATIVE:
      return -value - 1;
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
      for (let i = 0; i < value; i++) items.push(decodeAt(cursor));
      return items;
    }
    case MAJOR.MAP: {
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < value; i++) {
        const key = decodeAt(cursor);
        map.set(key, decodeAt(cursor));
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
      return decodeAt(cursor);
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
