/**
 * Just enough X.509 to check a Sigstore certificate offline (spec §9.5).
 *
 * A Fulcio certificate is a small, regular thing: a P-256 key, ECDSA with
 * SHA-256, a validity window of minutes, a subject alternative name carrying
 * the identity, and a Fulcio extension carrying the issuer. This reads those
 * five things and verifies the signature over the certificate body with a
 * root's key. It does not implement X.509 — no name constraints, no policy,
 * no CRLs, no RSA — because a reader that pretended to would be trusted for
 * things it cannot do. What it reads is what §9.5 needs, and nothing more.
 *
 * DER is read with a tiny TLV walker. Certificates that use anything this
 * walker does not expect are refused, which for a Sigstore bundle means the
 * identity is treated as absent, never as verified.
 */

export class X509Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X509Error";
  }
}

interface Tlv {
  tag: number;
  /** The value bytes. */
  value: Uint8Array;
  /** The whole element, tag and length included. */
  raw: Uint8Array;
  /** Offset just past this element. */
  end: number;
}

function read(bytes: Uint8Array, at: number): Tlv {
  if (at + 2 > bytes.length) throw new X509Error("DER ended early.");
  const tag = bytes[at]!;
  let length = bytes[at + 1]!;
  let cursor = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new X509Error("DER length not supported.");
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[cursor++]!;
  }
  const end = cursor + length;
  if (end > bytes.length) throw new X509Error("DER ended early.");
  return { tag, value: bytes.subarray(cursor, end), raw: bytes.subarray(at, end), end };
}

function children(tlv: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let at = 0;
  while (at < tlv.value.length) {
    const child = read(tlv.value, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

function oidOf(value: Uint8Array): string {
  const parts: number[] = [];
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    n = n * 128 + (value[i]! & 0x7f);
    if ((value[i]! & 0x80) === 0) {
      if (parts.length === 0) {
        parts.push(Math.floor(n / 40), n % 40);
      } else parts.push(n);
      n = 0;
    }
  }
  return parts.join(".");
}

function timeOf(tlv: Tlv): number {
  const text = new TextDecoder().decode(tlv.value);
  // UTCTime YYMMDDHHMMSSZ or GeneralizedTime YYYYMMDDHHMMSSZ.
  const full = tlv.tag === 0x17 ? (Number(text.slice(0, 2)) >= 50 ? "19" : "20") + text : text;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(full);
  if (!m) throw new X509Error("Unreadable time in certificate.");
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000;
}

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_SAN = "2.5.29.17";
/** Fulcio: the OIDC issuer, as a DER UTF8String (the v2 form, 1.3.6.1.4.1.57264.1.8). */
const OID_FULCIO_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8";
/** Fulcio: the OIDC issuer, raw (the deprecated v1 form, 1.3.6.1.4.1.57264.1.1). */
const OID_FULCIO_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1";

export interface Certificate {
  /** The to-be-signed body, exactly as signed. */
  tbs: Uint8Array;
  /** SubjectPublicKeyInfo, DER. */
  spki: Uint8Array;
  /** Unix seconds. */
  notBefore: number;
  notAfter: number;
  /** Subject alternative names: rfc822Name and uniformResourceIdentifier entries. */
  identities: string[];
  /** The OIDC issuer Fulcio recorded, when present. */
  issuer?: string;
  /** The ECDSA signature over `tbs`, as DER (r, s). */
  signature: Uint8Array;
  signatureAlgorithm: string;
}

/** Reads a DER certificate. Refuses anything outside the shape §9.5 needs. */
export function parseCertificate(der: Uint8Array): Certificate {
  const cert = read(der, 0);
  if (cert.tag !== 0x30) throw new X509Error("Not a certificate.");
  const [tbsTlv, algTlv, sigTlv] = children(cert);
  if (!tbsTlv || !algTlv || !sigTlv) throw new X509Error("Not a certificate.");

  const alg = children(algTlv)[0];
  const signatureAlgorithm = alg ? oidOf(alg.value) : "";
  if (signatureAlgorithm !== OID_ECDSA_SHA256) throw new X509Error("Only ECDSA with SHA-256 is read.");
  // BIT STRING: first byte is the unused-bit count.
  const signature = sigTlv.value.subarray(1);

  const tbs = children(tbsTlv);
  let at = 0;
  // Optional explicit version [0].
  if (tbs[0]?.tag === 0xa0) at = 1;
  // serial, signature alg, issuer, validity, subject, spki, [extensions]
  const validity = tbs[at + 3];
  const spki = tbs[at + 5];
  if (!validity || !spki) throw new X509Error("Certificate body is incomplete.");
  const [nb, na] = children(validity);
  if (!nb || !na) throw new X509Error("Certificate has no validity.");

  const identities: string[] = [];
  let issuer: string | undefined;
  const extensionsWrapper = tbs.slice(at + 6).find((t) => t.tag === 0xa3);
  if (extensionsWrapper) {
    const extensions = children(extensionsWrapper)[0];
    for (const ext of extensions ? children(extensions) : []) {
      const parts = children(ext);
      const oid = parts[0] ? oidOf(parts[0].value) : "";
      const octets = parts.find((p) => p.tag === 0x04);
      if (!octets) continue;
      if (oid === OID_SAN) {
        const names = read(octets.value, 0);
        for (const name of children(names)) {
          // [1] rfc822Name, [6] uniformResourceIdentifier: IA5String bytes.
          if (name.tag === 0x81 || name.tag === 0x86) identities.push(new TextDecoder().decode(name.value));
        }
      } else if (oid === OID_FULCIO_ISSUER_V2) {
        const s = read(octets.value, 0);
        issuer = new TextDecoder().decode(s.value);
      } else if (oid === OID_FULCIO_ISSUER_V1 && issuer === undefined) {
        issuer = new TextDecoder().decode(octets.value);
      }
    }
  }

  return {
    tbs: tbsTlv.raw,
    spki: spki.raw,
    notBefore: timeOf(nb),
    notAfter: timeOf(na),
    identities,
    issuer,
    signature,
    signatureAlgorithm,
  };
}

/** DER ECDSA signature (SEQUENCE of two INTEGERs) to the raw 64 bytes WebCrypto wants. */
export function derSignatureToRaw(der: Uint8Array): Uint8Array {
  const seq = read(der, 0);
  const [r, s] = children(seq);
  if (!r || !s) throw new X509Error("Malformed ECDSA signature.");
  const fit = (v: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    const trimmed = v.subarray(i);
    if (trimmed.length > 32) throw new X509Error("ECDSA integer too long.");
    const out = new Uint8Array(32);
    out.set(trimmed, 32 - trimmed.length);
    return out;
  };
  const out = new Uint8Array(64);
  out.set(fit(r.value), 0);
  out.set(fit(s.value), 32);
  return out;
}

/**
 * Whether `child` was signed by the key in `parent`.
 *
 * One hop. A Sigstore bundle chains a leaf to a root through at most one
 * intermediate, and the caller walks it; this verifies one signature and says
 * nothing about anything else.
 */
export async function signedBy(child: Certificate, parent: Certificate): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      parent.spki as unknown as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      derSignatureToRaw(child.signature) as unknown as ArrayBuffer,
      child.tbs as unknown as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Walks a chain from a leaf to one of the roots the host holds.
 *
 * `chain` is the leaf first, then any intermediates, as a bundle carries them.
 * Returns the leaf when it chains to a held root, and `undefined` otherwise.
 * A root is matched by its key: a root the host holds is a root by that fact,
 * so the chain's own copy of the root, if any, is ignored.
 */
export async function chainsToRoot(
  chain: Certificate[],
  roots: Certificate[],
): Promise<boolean> {
  if (chain.length === 0 || roots.length === 0) return false;
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!;
    // Does this certificate's signer sit among the roots?
    for (const root of roots) {
      if (await signedBy(cert, root)) {
        // Every hop below it must be signed by the one above.
        for (let j = i; j > 0; j--) {
          if (!(await signedBy(chain[j - 1]!, chain[j]!))) return false;
        }
        return true;
      }
    }
    // Or is this certificate itself one of the roots by key?
    if (roots.some((root) => equalBytes(root.spki, cert.spki)) && i > 0) {
      for (let j = i; j > 0; j--) {
        if (!(await signedBy(chain[j - 1]!, chain[j]!))) return false;
      }
      return true;
    }
  }
  return false;
}

/** PEM to DER, for roots that arrive as text. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
