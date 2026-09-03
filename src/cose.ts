/**
 * COSE_Sign1, the signature envelope from RFC 9052.
 *
 * Replaces a hand-rolled canonical string. The string was not broken, and that
 * was never the objection: it had one implementation, one reader, and no way
 * for anybody else to check our arithmetic. COSE has a defined canonical form,
 * carries the algorithm and key identifier in the signed part, and has
 * verifiers in every language — so a container can be checked by somebody who
 * has never seen this repository.
 *
 * A `COSE_Sign1` is four things in an array:
 *
 *   [ protected: bstr, unprotected: map, payload: bstr / nil, signature: bstr ]
 *
 * `protected` is a CBOR map encoded to bytes and then signed, so nothing in it
 * can be edited without breaking the signature — which is where the algorithm
 * belongs, since an attacker who can change it can otherwise talk a verifier
 * into a weaker one.
 *
 * The signature is over `Sig_structure`, not over the payload directly:
 *
 *   [ "Signature1", protected: bstr, external_aad: bstr, payload: bstr ]
 *
 * The context string is what stops a signature made for one purpose being
 * replayed as another.
 */
import { decode, encode, type CborValue } from "./cbor.js";

/** COSE header label 1 is `alg`; -7 is ES256, ECDSA over P-256 with SHA-256. */
export const HEADER_ALG = 1;
/** Label 4 is `kid`, a hint identifying which key signed. Never trusted alone. */
export const HEADER_KID = 4;
export const ALG_ES256 = -7;

export class CoseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoseError";
  }
}

export interface Sign1 {
  protectedBytes: Uint8Array;
  payload: Uint8Array;
  signature: Uint8Array;
  /** The key hint, when the envelope carried one. */
  kid?: string;
}

/** The protected header as bytes: a CBOR map, encoded once and then signed. */
export function protectedHeader(kid?: string): Uint8Array {
  const header = new Map<CborValue, CborValue>([[HEADER_ALG, ALG_ES256]]);
  if (kid) header.set(HEADER_KID, new TextEncoder().encode(kid));
  return encode(header);
}

/**
 * The bytes a signature is actually computed over.
 *
 * `external_aad` is empty here: everything this format authenticates is inside
 * the payload, and a field nobody sets is a field that will disagree between
 * implementations.
 */
export function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  return encode(["Signature1", protectedBytes, new Uint8Array(0), payload]);
}

/** Assembles the envelope. `sign` receives exactly the bytes to be signed. */
export async function buildSign1(
  payload: Uint8Array,
  sign: (bytes: Uint8Array) => Promise<Uint8Array>,
  options: { kid?: string; detached?: boolean } = {},
): Promise<Uint8Array> {
  const protectedBytes = protectedHeader(options.kid);
  const signature = await sign(sigStructure(protectedBytes, payload));

  return encode([
    protectedBytes,
    new Map<CborValue, CborValue>(),
    // A detached payload is omitted from the envelope because the verifier can
    // rebuild it from the manifest it already holds. Carrying it as well would
    // mean two copies that can disagree, and the one inside the signature would
    // win silently.
    options.detached ? null : payload,
    signature,
  ]);
}

/** Reads an envelope, refusing anything that is not the shape above. */
export function parseSign1(bytes: Uint8Array): Sign1 {
  const value = decode(bytes);

  if (!Array.isArray(value) || value.length !== 4) {
    throw new CoseError("Not a COSE_Sign1: expected an array of four elements.");
  }

  const [protectedBytes, unprotected, payload, signature] = value;

  if (!(protectedBytes instanceof Uint8Array)) {
    throw new CoseError("The protected header is not a byte string.");
  }
  if (!(unprotected instanceof Map)) {
    throw new CoseError("The unprotected header is not a map.");
  }
  if (!(signature instanceof Uint8Array)) {
    throw new CoseError("The signature is not a byte string.");
  }
  if (payload !== null && !(payload instanceof Uint8Array)) {
    throw new CoseError("The payload is neither bytes nor absent.");
  }

  const header = decode(protectedBytes);
  if (!(header instanceof Map)) {
    throw new CoseError("The protected header does not decode to a map.");
  }

  const alg = header.get(HEADER_ALG);
  if (alg !== ALG_ES256) {
    // Named rather than ignored: an unrecognised algorithm must stop a
    // verifier, not be skipped past to whatever it happens to support.
    throw new CoseError(`Unsupported signature algorithm: ${String(alg)}`);
  }

  const kid = header.get(HEADER_KID);

  return {
    protectedBytes,
    payload: payload ?? new Uint8Array(0),
    signature,
    kid: kid instanceof Uint8Array ? new TextDecoder().decode(kid) : undefined,
  };
}

/**
 * Verifies an envelope against a payload the caller supplies.
 *
 * The payload is a parameter rather than being taken from the envelope, because
 * for a detached signature there is nothing in the envelope to take — and
 * because a verifier should be checking the bytes it already decided to trust,
 * not the ones the envelope offers it.
 */
export async function verifySign1(
  envelope: Uint8Array,
  payload: Uint8Array,
  verify: (signature: Uint8Array, bytes: Uint8Array) => Promise<boolean>,
): Promise<boolean> {
  const sign1 = parseSign1(envelope);
  return verify(sign1.signature, sigStructure(sign1.protectedBytes, payload));
}
