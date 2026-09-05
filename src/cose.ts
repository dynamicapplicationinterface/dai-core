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

/*
 * Countersignatures (RFC 9338), spec §9.4.
 *
 * A second party signs the same payload: a generator, a provider, a release
 * signer. The slot is the unprotected header, label 11, so adding or removing
 * one changes no signed byte and no digest. What is signed is the version 2
 * structure, which binds the countersignature to the publisher's protected
 * header and the publisher's signature as well as the payload — a
 * countersignature cannot be lifted onto a different signature over the same
 * bytes.
 */

/** RFC 9338 §3: header label for a COSE_Countersignature (version 2). */
export const HEADER_COUNTERSIGNATURE = 11;

export interface Countersignature {
  protectedBytes: Uint8Array;
  signature: Uint8Array;
  kid?: Uint8Array;
}

/** The bytes a countersigner signs (RFC 9338 §3.3). */
export function countersignStructure(
  bodyProtected: Uint8Array,
  signProtected: Uint8Array,
  payload: Uint8Array,
  bodySignature: Uint8Array,
): Uint8Array {
  return encode([
    "CounterSignatureV2",
    bodyProtected,
    signProtected,
    new Uint8Array(0),
    payload,
    [bodySignature],
  ]);
}

/** The countersigner's protected header: alg and a kid that names the key. */
export function countersignerHeader(kid: Uint8Array): Uint8Array {
  return encode(
    new Map<CborValue, CborValue>([
      [HEADER_ALG, ALG_ES256],
      [HEADER_KID, kid],
    ]),
  );
}

/**
 * Adds a countersignature to an envelope and returns the new envelope.
 *
 * The payload is a parameter because the envelope is detached: the signer
 * has to be handed the bytes the publisher signed, and sign the same ones.
 */
export async function countersign(
  envelope: Uint8Array,
  payload: Uint8Array,
  kid: Uint8Array,
  sign: (bytes: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const value = decode(envelope);
  if (!Array.isArray(value) || value.length !== 4) throw new CoseError("Not a COSE_Sign1.");
  const [bodyProtected, unprotected, carried, bodySignature] = value;
  if (
    !(bodyProtected instanceof Uint8Array) ||
    !(unprotected instanceof Map) ||
    !(bodySignature instanceof Uint8Array)
  ) {
    throw new CoseError("Not a COSE_Sign1.");
  }

  const signProtected = countersignerHeader(kid);
  const signature = await sign(
    countersignStructure(bodyProtected, signProtected, payload, bodySignature),
  );
  const entry: CborValue = [signProtected, new Map<CborValue, CborValue>(), signature];

  const existing = unprotected.get(HEADER_COUNTERSIGNATURE);
  const next = new Map<CborValue, CborValue>(unprotected);
  if (existing === undefined) next.set(HEADER_COUNTERSIGNATURE, entry);
  else if (Array.isArray(existing) && existing.length > 0 && Array.isArray(existing[0])) {
    next.set(HEADER_COUNTERSIGNATURE, [...(existing as CborValue[]), entry]);
  } else next.set(HEADER_COUNTERSIGNATURE, [existing as CborValue, entry]);

  return encode([bodyProtected, next, carried ?? null, bodySignature]);
}

/** The countersignatures an envelope carries, unverified. */
export function readCountersignatures(envelope: Uint8Array): Countersignature[] {
  const value = decode(envelope);
  if (!Array.isArray(value) || value.length !== 4 || !(value[1] instanceof Map)) return [];
  const slot = value[1].get(HEADER_COUNTERSIGNATURE);
  if (slot === undefined) return [];
  // One countersignature is an array of three; several are an array of those.
  const list = Array.isArray(slot) && slot.length > 0 && Array.isArray(slot[0]) ? slot : [slot];

  const out: Countersignature[] = [];
  for (const item of list) {
    if (!Array.isArray(item) || item.length !== 3) continue;
    const [protectedBytes, , signature] = item;
    if (!(protectedBytes instanceof Uint8Array) || !(signature instanceof Uint8Array)) continue;
    let kid: Uint8Array | undefined;
    try {
      const header = decode(protectedBytes);
      const k = header instanceof Map ? header.get(HEADER_KID) : undefined;
      if (k instanceof Uint8Array) kid = k;
    } catch {
      /* An unreadable header is reported as a countersignature with no kid. */
    }
    out.push({ protectedBytes, signature, kid });
  }
  return out;
}

export type CountersignatureVerdict = { kid: string; status: "valid" | "invalid" | "unheld" };

/**
 * Verifies each countersignature against a key the caller holds for its kid.
 *
 * `held` maps a kid, as hex, to a verifier for that key. A countersignature
 * whose kid is not held is `unheld`: treated as absent, never as verified and
 * never as a refusal (§9.4). One whose header lacks alg ES256 or a kid, or
 * whose signature fails, is `invalid`.
 */
export async function verifyCountersignatures(
  envelope: Uint8Array,
  payload: Uint8Array,
  held: (
    kidHex: string,
  ) => ((signature: Uint8Array, bytes: Uint8Array) => Promise<boolean>) | undefined,
): Promise<CountersignatureVerdict[]> {
  const value = decode(envelope);
  if (!Array.isArray(value) || value.length !== 4) return [];
  const [bodyProtected, , , bodySignature] = value;
  if (!(bodyProtected instanceof Uint8Array) || !(bodySignature instanceof Uint8Array)) return [];

  const out: CountersignatureVerdict[] = [];
  for (const cs of readCountersignatures(envelope)) {
    const kidHex = cs.kid ? [...cs.kid].map((b) => b.toString(16).padStart(2, "0")).join("") : "";
    let alg: unknown;
    try {
      const header = decode(cs.protectedBytes);
      alg = header instanceof Map ? header.get(HEADER_ALG) : undefined;
    } catch {
      alg = undefined;
    }
    if (!cs.kid || alg !== ALG_ES256) {
      out.push({ kid: kidHex, status: "invalid" });
      continue;
    }
    const verify = held(kidHex);
    if (!verify) {
      out.push({ kid: kidHex, status: "unheld" });
      continue;
    }
    const ok = await verify(
      cs.signature,
      countersignStructure(bodyProtected, cs.protectedBytes, payload, bodySignature),
    );
    out.push({ kid: kidHex, status: ok ? "valid" : "invalid" });
  }
  return out;
}
