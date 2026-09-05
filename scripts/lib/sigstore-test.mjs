/**
 * A Fulcio and a Rekor small enough to keep in a test.
 *
 * The identity verifier (spec §9.5) checks a Sigstore bundle offline against
 * roots a host holds. To test it, the suite needs bundles that verify against
 * a root it publishes and bundles that fail in each of the ways §9.5 lists.
 * Public Sigstore cannot mint those on demand and its certificates expire in
 * minutes, so this is a minimal certificate authority and log: enough DER to
 * make a P-256 certificate with the extensions Fulcio writes, and enough Rekor
 * to sign an entry timestamp over canonical JSON. It signs with WebCrypto and
 * nothing else.
 *
 * Nothing here is in dai-core. It is a test tool, and a reader that trusted
 * a certificate because this could make one would have learned nothing.
 */

const encoder = new TextEncoder();

// ---- DER writing, the four constructions a certificate needs.

function len(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}
const tlv = (tag, value) => Uint8Array.from([tag, ...len(value.length), ...value]);
const seq = (...parts) => tlv(0x30, concat(parts));
const set = (...parts) => tlv(0x31, concat(parts));
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const integer = (n) => {
  const bytes = [];
  let v = BigInt(n);
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Uint8Array.from(bytes));
};
const oid = (text) => {
  const parts = text.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [];
    let v = p;
    do {
      chunk.unshift(v & 0x7f);
      v >>= 7;
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
};
const utf8 = (s) => tlv(0x0c, encoder.encode(s));
const ia5 = (tag, s) => tlv(tag, encoder.encode(s));
const time = (unixSeconds) => {
  const d = new Date(unixSeconds * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return tlv(
    0x18,
    encoder.encode(
      `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`,
    ),
  );
};
const name = (cn) =>
  seq(set(seq(oid("2.5.4.3"), utf8(cn))));
const ALG_ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

function rawToDerSignature(raw) {
  const int = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let trimmed = bytes.subarray(i);
    if (trimmed[0] & 0x80) trimmed = Uint8Array.from([0, ...trimmed]);
    return tlv(0x02, trimmed);
  };
  return seq(int(raw.subarray(0, 32)), int(raw.subarray(32, 64)));
}

async function ecdsaKey() {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
}
async function spkiOf(publicKey) {
  return new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
}
async function sign(privateKey, bytes) {
  return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, bytes));
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const pem = (der) => `-----BEGIN CERTIFICATE-----\n${b64(der).replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;

/**
 * Mints a certificate for `subjectSpki`, signed by `issuer` (or self-signed),
 * valid for the given window, with a SAN and Fulcio's issuer extension.
 */
async function certificate({ subjectSpki, subjectName, issuerName, issuerKey, notBefore, notAfter, identity, oidcIssuer, isCa, serial }) {
  const extensions = [];
  if (isCa) {
    extensions.push(seq(oid("2.5.29.19"), tlv(0x01, Uint8Array.from([0xff])), tlv(0x04, seq(tlv(0x01, Uint8Array.from([0xff]))))));
  }
  if (identity) {
    const generalName = identity.includes("@") ? ia5(0x81, identity) : ia5(0x86, identity);
    extensions.push(seq(oid("2.5.29.17"), tlv(0x04, seq(generalName))));
  }
  if (oidcIssuer) {
    extensions.push(seq(oid("1.3.6.1.4.1.57264.1.8"), tlv(0x04, utf8(oidcIssuer))));
  }
  const tbs = seq(
    tlv(0xa0, integer(2)), // version 3
    integer(serial ?? Date.now()),
    ALG_ECDSA_SHA256,
    name(issuerName),
    seq(time(notBefore), time(notAfter)),
    name(subjectName),
    subjectSpki,
    ...(extensions.length ? [tlv(0xa3, seq(...extensions))] : []),
  );
  const signature = rawToDerSignature(await sign(issuerKey, tbs));
  return seq(tbs, ALG_ECDSA_SHA256, tlv(0x03, Uint8Array.from([0, ...signature])));
}

/** RFC 8785 for the flat object Rekor signs. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

/**
 * A test Sigstore: one Fulcio root, one Rekor key. Returns the root list entry
 * a host would hold, and a function that issues bundles.
 */
export async function testSigstore(rootName = "Test Sigstore") {
  const fulcio = await ecdsaKey();
  const fulcioSpki = await spkiOf(fulcio.publicKey);
  const now = Math.floor(Date.now() / 1000);
  const rootDer = await certificate({
    subjectSpki: fulcioSpki,
    subjectName: "test fulcio root",
    issuerName: "test fulcio root",
    issuerKey: fulcio.privateKey,
    notBefore: now - 3600,
    notAfter: now + 10 * 365 * 86400,
    isCa: true,
    serial: 1,
  });
  const rekor = await ecdsaKey();
  const rekorSpki = await spkiOf(rekor.publicKey);
  const rekorKeyId = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", rekorSpki)));

  const root = { name: rootName, fulcioRoots: [pem(rootDer)], rekorKeys: [b64(rekorSpki)] };

  /**
   * Issues a bundle binding `identity` to `subjectSpki` (base64) and logging
   * `signatureB64` at `integratedTime`. Knobs for each way §9.5 can fail.
   */
  async function issue({ subjectSpki, identity, oidcIssuer = "https://accounts.example", signatureB64, integratedTime, certWindow, wrongLogKey = false }) {
    const t = integratedTime ?? now;
    const [nb, na] = certWindow ?? [t - 300, t + 300];
    const leaf = await certificate({
      subjectSpki: Buffer.from(subjectSpki, "base64"),
      subjectName: "sigstore-intermediate", // Fulcio leaves carry an empty subject; the name is irrelevant to the reader
      issuerName: "test fulcio root",
      issuerKey: fulcio.privateKey,
      notBefore: nb,
      notAfter: na,
      identity,
      oidcIssuer,
      serial: Math.floor(Math.random() * 1e9),
    });
    const body = b64(encoder.encode(JSON.stringify({ apiVersion: "0.0.1", kind: "hashedrekord", spec: { signature: { content: signatureB64 } } })));
    const logIndex = 42;
    const logIdHex = Buffer.from(rekorKeyId, "base64").toString("hex");
    const signedOver = encoder.encode(canonicalJson({ body, integratedTime: t, logID: logIdHex, logIndex }));
    const setKey = wrongLogKey ? (await ecdsaKey()).privateKey : rekor.privateKey;
    const setSig = rawToDerSignature(await sign(setKey, signedOver));
    return {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: { rawBytes: b64(leaf) },
        tlogEntries: [
          {
            logIndex: String(logIndex),
            logId: { keyId: rekorKeyId },
            kindVersion: { kind: "hashedrekord", version: "0.0.1" },
            integratedTime: String(t),
            inclusionPromise: { signedEntryTimestamp: b64(setSig) },
            canonicalizedBody: body,
          },
        ],
      },
      messageSignature: { messageDigest: { algorithm: "SHA2_256", digest: "" }, signature: signatureB64 },
    };
  }

  return { root, issue };
}
