/**
 * A P-256 public key, in the two sizes it comes in.
 *
 * A container carries its publisher key as SubjectPublicKeyInfo: 91 bytes, of
 * which 26 are a fixed prefix saying "this is a P-256 key" and 65 are the point
 * itself with both coordinates. A link that has to fit in 32 KB does not want
 * to spend 58 of them saying what curve this is, and does not need the second
 * coordinate at all — it is determined by the first up to a sign, and the sign
 * is one bit. So a key travels as 33 bytes: a tag for the sign and the x
 * coordinate, which is SEC 1 §2.3.3, the form every other ECDSA system uses
 * when bytes are short.
 *
 * Recovering y is a modular square root, and P-256's prime is 3 mod 4, so the
 * root is one exponentiation. Done here with BigInt because WebCrypto will not
 * import a compressed point and there is no other arithmetic to share it with.
 */

/** The 26-byte SPKI prefix for an uncompressed P-256 key. Fixed by the standard. */
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

const P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
const A = P - 3n;

function toBig(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return n;
}

function toBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

/** SPKI in, 33 bytes out. Refuses anything that is not an uncompressed P-256 key. */
export function compressPublicKey(spki: Uint8Array): Uint8Array {
  if (spki.length !== 91 || spki[26] !== 0x04) {
    throw new Error("Not an uncompressed P-256 SubjectPublicKeyInfo.");
  }
  for (let i = 0; i < SPKI_PREFIX.length; i++) {
    if (spki[i] !== SPKI_PREFIX[i]) throw new Error("Not a P-256 SubjectPublicKeyInfo.");
  }
  const x = spki.subarray(27, 59);
  const y = spki.subarray(59, 91);
  const out = new Uint8Array(33);
  out[0] = (y[31]! & 1) === 0 ? 0x02 : 0x03;
  out.set(x, 1);
  return out;
}

/**
 * 33 bytes in, SPKI out.
 *
 * Checks that the recovered point is on the curve, because a compressed x with
 * no valid y is not a key and WebCrypto would refuse it later with a message
 * about nothing in particular.
 */
export function decompressPublicKey(compressed: Uint8Array): Uint8Array {
  if (compressed.length !== 33 || (compressed[0] !== 0x02 && compressed[0] !== 0x03)) {
    throw new Error("Not a compressed P-256 point.");
  }
  const x = toBig(compressed.subarray(1));
  if (x >= P) throw new Error("Not a P-256 point: x is out of range.");

  // y² = x³ + ax + b, and with p ≡ 3 (mod 4), y = (y²)^((p+1)/4).
  const rhs = (modPow(x, 3n, P) + A * x + B) % P;
  let y = modPow(rhs, (P + 1n) / 4n, P);
  if ((y * y) % P !== rhs) throw new Error("Not a P-256 point: no square root.");

  const wantOdd = compressed[0] === 0x03;
  if ((y & 1n) === 1n !== wantOdd) y = P - y;

  const out = new Uint8Array(91);
  out.set(SPKI_PREFIX, 0);
  out[26] = 0x04;
  out.set(toBytes(x, 32), 27);
  out.set(toBytes(y, 32), 59);
  return out;
}
