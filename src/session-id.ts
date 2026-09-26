/**
 * A session id commits to its creator (identity step 5, ruled 24 September).
 *
 * `session = SHA-256(creator author id ‖ nonce)`, first 16 bytes, with the
 * nonce on the creator's first seat row. Anyone can check it from the rows, and
 * nobody but the creator can produce a seat row that passes: another author's
 * id with the same nonce hashes to a different session. So who created a
 * session is a fact about the rows, not a race on a clock.
 *
 * The check runs inside SQL, in the views that decide who the creator is, so
 * it holds over every row a copy holds however it got there. SQL functions are
 * synchronous and WebCrypto is not, hence this small SHA-256 of its own. It is
 * held to WebCrypto's answer by tests/session-id.spec.ts.
 */

/** The SQL function the roster views call: `dai_session_id(author, nonce)`. */
export const SESSION_ID_FUNCTION = "dai_session_id";

/** Bytes in an author id, a nonce and a session id. */
export const SESSION_ID_BYTES = 16;

/**
 * The hash and the session id, made by one self-contained function.
 *
 * Self-contained because the frame's code is serialized with `toString()` and
 * cannot reference an import (src/runtime/bootloader.ts, `bridgeMain`): the
 * runtime passes this function's source into the frame, and everything else
 * imports its result below. One implementation, run in both places. Nothing in
 * the body may reach outside it but the language's own globals.
 */
export function sessionIdTools(): {
  sha256: (message: Uint8Array) => Uint8Array;
  sessionIdOf: (author: unknown, nonce: unknown) => Uint8Array | null;
} {
  const K = Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const BYTES = 16;

  /** SHA-256 (FIPS 180-4), synchronously. */
  function sha256(message: Uint8Array): Uint8Array {
    const h = Uint32Array.from([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    // Padding: 0x80, zeros, then the bit length as 64 bits big-endian.
    const blocks = Math.ceil((message.length + 9) / 64);
    const padded = new Uint8Array(blocks * 64);
    padded.set(message);
    padded[message.length] = 0x80;
    const view = new DataView(padded.buffer);
    const bits = message.length * 8;
    view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padded.length - 4, bits >>> 0);

    const w = new Uint32Array(64);
    for (let block = 0; block < blocks; block += 1) {
      for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(block * 64 + t * 4);
      for (let t = 16; t < 64; t += 1) {
        const a = w[t - 15]!;
        const b = w[t - 2]!;
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
      }
      let a = h[0]!;
      let b = h[1]!;
      let c = h[2]!;
      let d = h[3]!;
      let e = h[4]!;
      let f = h[5]!;
      let g = h[6]!;
      let hh = h[7]!;
      for (let t = 0; t < 64; t += 1) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[t]! + w[t]!) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0]! + a) >>> 0;
      h[1] = (h[1]! + b) >>> 0;
      h[2] = (h[2]! + c) >>> 0;
      h[3] = (h[3]! + d) >>> 0;
      h[4] = (h[4]! + e) >>> 0;
      h[5] = (h[5]! + f) >>> 0;
      h[6] = (h[6]! + g) >>> 0;
      h[7] = (h[7]! + hh) >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i]!);
    return out;
  }

  /**
   * The session id a creator and a nonce make: SHA-256 of the author id then
   * the nonce, first 16 bytes. Null when either is not 16 bytes, so a malformed
   * row names no session rather than throwing inside a view.
   */
  function sessionIdOf(author: unknown, nonce: unknown): Uint8Array | null {
    if (!(author instanceof Uint8Array) || author.length !== BYTES) return null;
    if (!(nonce instanceof Uint8Array) || nonce.length !== BYTES) return null;
    const joined = new Uint8Array(BYTES * 2);
    joined.set(author, 0);
    joined.set(nonce, BYTES);
    return sha256(joined).slice(0, BYTES);
  }

  return { sha256, sessionIdOf };
}

export const { sha256, sessionIdOf } = sessionIdTools();
