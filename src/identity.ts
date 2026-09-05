/**
 * Identity: a key bound to a name somebody else vouched for, checked offline.
 * Spec §9.5.
 *
 * The principle is that the publisher is online at build time and the
 * recipient may be offline at open time, so every network step happens at
 * build and the artifact carries a proof that verifies against a root the
 * host already holds. A host never fetches to verify an identity.
 *
 * The proof is a Sigstore bundle: a short-lived certificate from a Fulcio
 * instance binding an OpenID identity to the publisher's own signing key, and
 * a Rekor log entry with a signed timestamp proving the manifest signature was
 * made inside that certificate's window. Four checks, all offline:
 *
 *   1. the certificate chains to a Fulcio root the host holds;
 *   2. its key is the manifest's key;
 *   3. the log entry's signed timestamp verifies against a Rekor key the host
 *      holds and lies within the certificate's validity;
 *   4. the logged signature is the manifest's signature.
 *
 * Any failure, and any root the host does not hold, means ABSENT. Identity
 * never refuses a document; a document with a broken binding is a document
 * with no binding, trusted by continuity alone.
 */
import { fromBase64, sha256Hex, toBase64 } from "./core.js";
import { chainsToRoot, parseCertificate, pemToDer, type Certificate } from "./x509.js";

/** What a host holds to check identities against (§9.6, root lists: `sigstore`). */
export interface SigstoreRoot {
  name: string;
  /** PEM certificates. */
  fulcioRoots: string[];
  /** Base64 SPKI keys the Rekor instance signs entry timestamps with. */
  rekorKeys: string[];
}

/**
 * The parts of a Sigstore bundle this reads. The bundle JSON has more; a field
 * not listed here is not consulted.
 */
export interface SigstoreBundle {
  mediaType?: string;
  verificationMaterial?: {
    certificate?: { rawBytes: string };
    x509CertificateChain?: { certificates: { rawBytes: string }[] };
    tlogEntries?: {
      logIndex?: string | number;
      logId?: { keyId: string };
      integratedTime?: string | number;
      inclusionPromise?: { signedEntryTimestamp: string };
      canonicalizedBody?: string;
    }[];
  };
  messageSignature?: {
    messageDigest?: { algorithm?: string; digest?: string };
    signature?: string;
  };
}

export type IdentityVerdict =
  | { status: "shown"; identity: string; issuer?: string; root: string }
  | { status: "absent"; reason: string };

/**
 * RFC 8785 canonical JSON, for the flat objects Rekor signs. Rekor's signed
 * entry timestamp is over the JCS form of {body, integratedTime, logID,
 * logIndex}; keys sorted, no whitespace, numbers plain.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k])).join(",") + "}";
}

async function verifyRaw(spkiB64: string, signature: Uint8Array, bytes: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      fromBase64(spkiB64) as unknown as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature as unknown as ArrayBuffer,
      bytes as unknown as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

/** A DER ECDSA signature or a raw one, as raw 64 bytes. Rekor writes DER; WebCrypto wants raw. */
async function asRaw(signature: Uint8Array): Promise<Uint8Array> {
  if (signature.length === 64) return signature;
  const { derSignatureToRaw } = await import("./x509.js");
  return derSignatureToRaw(signature);
}

/**
 * Checks a bundle against the roots a host holds, and says what may be shown.
 *
 * `manifestKey` is the base64 SPKI from the shell; `manifestSignature` is the
 * manifest's `signature`, the base64 COSE envelope. The Rekor entry is
 * expected to have logged the envelope's bytes; a bundle whose entry logged
 * something else is bound to a different act of signing and is absent.
 */
export async function verifyIdentity(
  bundle: unknown,
  manifestKey: string,
  manifestSignature: string,
  roots: SigstoreRoot[],
): Promise<IdentityVerdict> {
  const b = bundle as SigstoreBundle | null;
  if (!b || typeof b !== "object") return { status: "absent", reason: "no bundle" };
  if (roots.length === 0) return { status: "absent", reason: "this host holds no identity roots" };

  // The certificate chain, leaf first.
  const rawChain = b.verificationMaterial?.certificate
    ? [b.verificationMaterial.certificate.rawBytes]
    : (b.verificationMaterial?.x509CertificateChain?.certificates ?? []).map((c) => c.rawBytes);
  if (rawChain.length === 0) return { status: "absent", reason: "the bundle carries no certificate" };

  let chain: Certificate[];
  try {
    chain = rawChain.map((raw) => parseCertificate(fromBase64(raw)));
  } catch (error) {
    return { status: "absent", reason: `the certificate could not be read (${(error as Error).message})` };
  }
  const leaf = chain[0]!;

  // 1. Chains to a root this host holds.
  let matched: SigstoreRoot | undefined;
  for (const root of roots) {
    let rootCerts: Certificate[];
    try {
      rootCerts = root.fulcioRoots.map((pem) => parseCertificate(pemToDer(pem)));
    } catch {
      continue;
    }
    if (await chainsToRoot(chain, rootCerts)) {
      matched = root;
      break;
    }
  }
  if (!matched) return { status: "absent", reason: "the certificate does not chain to a root this host holds" };

  // 2. The certificate's key is the manifest's key.
  if (toBase64(leaf.spki) !== manifestKey) {
    return { status: "absent", reason: "the certificate binds a different key from the one that signed this document" };
  }

  // 3. A log entry whose signed timestamp verifies against a held Rekor key,
  //    inside the certificate's validity.
  const entries = b.verificationMaterial?.tlogEntries ?? [];
  if (entries.length === 0) return { status: "absent", reason: "the bundle carries no log entry" };
  const entry = entries[0]!;
  const integratedTime = Number(entry.integratedTime);
  const logIndex = Number(entry.logIndex);
  const set = entry.inclusionPromise?.signedEntryTimestamp;
  const body = entry.canonicalizedBody;
  const logId = entry.logId?.keyId;
  if (!Number.isFinite(integratedTime) || !Number.isFinite(logIndex) || !set || !body || !logId) {
    return { status: "absent", reason: "the log entry is incomplete" };
  }
  if (integratedTime < leaf.notBefore || integratedTime > leaf.notAfter) {
    return { status: "absent", reason: "the log entry's time is outside the certificate's validity" };
  }
  // Rekor's logId.keyId is the base64 of the SHA-256 of the log's public key.
  const signedOver = new TextEncoder().encode(
    canonicalJson({
      body,
      integratedTime,
      logID: [...fromBase64(logId)].map((x) => x.toString(16).padStart(2, "0")).join(""),
      logIndex,
    }),
  );
  let timestampOk = false;
  for (const rekorKey of matched.rekorKeys) {
    const expectedId = toBase64(
      Uint8Array.from((await sha256Hex(fromBase64(rekorKey))).match(/../g)!.map((h) => parseInt(h, 16))),
    );
    if (expectedId !== logId) continue;
    if (await verifyRaw(rekorKey, await asRaw(fromBase64(set)), signedOver)) {
      timestampOk = true;
      break;
    }
  }
  if (!timestampOk) return { status: "absent", reason: "the log entry's timestamp does not verify against a Rekor key this host holds" };

  // 4. The logged signature is this manifest's signature.
  let logged: { spec?: { signature?: { content?: string } } };
  try {
    logged = JSON.parse(new TextDecoder().decode(fromBase64(body)));
  } catch {
    return { status: "absent", reason: "the log entry body is unreadable" };
  }
  const loggedSignature = logged.spec?.signature?.content ?? b.messageSignature?.signature;
  if (!loggedSignature || loggedSignature !== manifestSignature) {
    return { status: "absent", reason: "the log entry records a different signature from this document's" };
  }

  const identity = leaf.identities[0];
  if (!identity) return { status: "absent", reason: "the certificate names no identity" };
  return { status: "shown", identity, ...(leaf.issuer ? { issuer: leaf.issuer } : {}), root: matched.name };
}
