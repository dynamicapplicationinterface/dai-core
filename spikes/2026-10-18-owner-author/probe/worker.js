/**
 * Spike probe, 18 October: an owner store for experiments C and D.
 *
 * One Worker serves the probe page (public/) and a small API backed by one
 * Durable Object. The owner is a passkey: the store verifies every WebAuthn
 * ceremony itself (origin, RP id hash, user presence and verification, the
 * signature) and keys everything by the owner id the passkey carries as its
 * user handle. Authors (each context's own ES256 key) are enrolled under the
 * owner with a proof of possession. A checkpoint is signed by an enrolled
 * author and must extend the owner's latest one.
 *
 * Nothing here is the protocol. It is a spike: it shares no binding, bucket or
 * object with the relay or the reference store.
 */

const enc = new TextEncoder();
const b64u = {
  from(bytes) {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  to(text) {
    const s = atob(String(text).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(text).length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** The smallest CBOR reader WebAuthn needs: one item from `bytes` at `at`, and where it ends. */
function cbor(bytes, at = 0) {
  const head = bytes[at++];
  const major = head >> 5;
  let n = head & 31;
  if (n === 24) n = bytes[at++];
  else if (n === 25) { n = (bytes[at] << 8) | bytes[at + 1]; at += 2; }
  else if (n === 26) { n = ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]; at += 4; }
  else if (n > 26) throw new Error("CBOR: length form not supported");
  switch (major) {
    case 0: return { value: n, end: at };
    case 1: return { value: -1 - n, end: at };
    case 2: return { value: bytes.slice(at, at + n), end: at + n };
    case 3: return { value: new TextDecoder().decode(bytes.slice(at, at + n)), end: at + n };
    case 4: {
      const out = [];
      for (let i = 0; i < n; i++) { const r = cbor(bytes, at); out.push(r.value); at = r.end; }
      return { value: out, end: at };
    }
    case 5: {
      const out = new Map();
      for (let i = 0; i < n; i++) { const k = cbor(bytes, at); const v = cbor(bytes, k.end); out.set(k.value, v.value); at = v.end; }
      return { value: out, end: at };
    }
    case 7: return { value: n === 20 ? false : n === 21 ? true : null, end: at };
    default: throw new Error(`CBOR: major type ${major} not supported`);
  }
}

/** authenticatorData, read: RP id hash, flags, counter, and the credential when attested. */
function authData(bytes) {
  const out = { rpIdHash: bytes.slice(0, 32), flags: bytes[32], counter: new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0) };
  if (out.flags & 0x40) {
    const len = (bytes[53] << 8) | bytes[54];
    out.credentialId = bytes.slice(55, 55 + len);
    const key = cbor(bytes, 55 + len).value;
    if (key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1) throw new Error("credential key is not ES256 P-256");
    out.jwk = { kty: "EC", crv: "P-256", x: b64u.from(key.get(-2)), y: b64u.from(key.get(-3)) };
  }
  return out;
}

/** A DER ECDSA signature as WebCrypto's r||s. */
function derToRaw(der) {
  let at = 2;
  const part = () => {
    if (der[at++] !== 0x02) throw new Error("bad DER");
    const len = der[at++];
    let v = der.slice(at, at + len);
    at += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = part();
  const s = part();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

const ES256 = { name: "ECDSA", namedCurve: "P-256" };
const verifyRaw = async (pubRaw, sig, data) =>
  crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await crypto.subtle.importKey("raw", pubRaw, ES256, false, ["verify"]), sig, data);

export class OwnerStore {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async challenge(kind, extra = {}) {
    const challenge = b64u.from(random(32));
    await this.storage.put(`chal:${challenge}`, { kind, exp: Date.now() + 5 * 60_000, ...extra });
    return challenge;
  }

  async takeChallenge(challenge, kind) {
    const held = await this.storage.get(`chal:${challenge}`);
    await this.storage.delete(`chal:${challenge}`);
    if (!held || held.kind !== kind || held.exp < Date.now()) throw new Error("challenge unknown or expired");
    return held;
  }

  /** clientDataJSON and authenticatorData checks every ceremony shares. */
  async ceremony(origin, kind, clientDataB64, authB64) {
    const clientBytes = b64u.to(clientDataB64);
    const client = JSON.parse(new TextDecoder().decode(clientBytes));
    if (client.type !== (kind === "register" ? "webauthn.create" : "webauthn.get")) throw new Error(`clientData type ${client.type}`);
    if (client.origin !== origin) throw new Error(`clientData origin ${client.origin}, expected ${origin}`);
    const held = await this.takeChallenge(client.challenge, kind);
    // A registration carries authenticatorData inside the attestation object.
    const auth = kind === "register" ? cbor(b64u.to(authB64)).value.get("authData") : b64u.to(authB64);
    const data = authData(auth);
    if (!equal(data.rpIdHash, await sha256(enc.encode(new URL(origin).hostname)))) throw new Error("RP id hash differs");
    if (!(data.flags & 0x01)) throw new Error("user not present");
    if (!(data.flags & 0x04)) throw new Error("user not verified");
    return { held, client, clientBytes, auth, data };
  }

  async session(owner) {
    const token = b64u.from(random(24));
    await this.storage.put(`sess:${token}`, { owner, exp: Date.now() + 60 * 60_000 });
    return token;
  }

  async ownerOf(request) {
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const s = token && (await this.storage.get(`sess:${token}`));
    if (!s || s.exp < Date.now()) return null;
    return s.owner;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const origin = url.origin;
    const route = `${request.method} ${url.pathname}`;
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    try {
      switch (route) {
        case "POST /api/register/options": {
          const owner = b64u.from(random(16));
          const challenge = await this.challenge("register", { owner });
          return json({ challenge, rp: { id: url.hostname, name: "DAI owner spike" }, user: { id: owner, name: `dai-spike-${owner.slice(0, 6)}`, displayName: "DAI spike owner" } });
        }
        case "POST /api/register/finish": {
          const { held, data } = await this.ceremony(origin, "register", body.clientDataJSON, body.attestationObject);
          if (b64u.from(data.credentialId) !== body.credentialId) throw new Error("credential id differs from the attested one");
          await this.storage.put(`cred:${body.credentialId}`, { owner: held.owner, jwk: data.jwk, counter: data.counter, createdAt: new Date().toISOString(), context: body.context ?? "" });
          await this.storage.put(`owner:${held.owner}`, { owner: held.owner, createdAt: new Date().toISOString(), creds: [body.credentialId], authors: {}, document: null, latest: 0, latestDigest: null });
          return json({ owner: held.owner, session: await this.session(held.owner), flags: data.flags });
        }
        case "POST /api/login/options":
          return json({ challenge: await this.challenge("login"), rpId: url.hostname });
        case "POST /api/login/finish": {
          const { clientBytes, auth, data } = await this.ceremony(origin, "login", body.clientDataJSON, body.authenticatorData);
          const cred = await this.storage.get(`cred:${body.credentialId}`);
          if (!cred) throw new Error("this passkey is not known to the store");
          if (body.userHandle && body.userHandle !== cred.owner) throw new Error("user handle is not the owner this passkey was made for");
          const signed = new Uint8Array(auth.length + 32);
          signed.set(auth, 0);
          signed.set(await sha256(clientBytes), auth.length);
          const key = await crypto.subtle.importKey("jwk", cred.jwk, ES256, false, ["verify"]);
          const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(b64u.to(body.signature)), signed);
          if (!ok) throw new Error("passkey signature does not verify");
          await this.storage.put(`cred:${body.credentialId}`, { ...cred, counter: data.counter });
          return json({ owner: cred.owner, session: await this.session(cred.owner), flags: data.flags });
        }
      }

      const owner = await this.ownerOf(request);
      if (!owner) return json({ error: "Sign in with the passkey first." }, 401);
      const record = await this.storage.get(`owner:${owner}`);

      switch (route) {
        case "GET /api/owner":
          return json({ owner, createdAt: record.createdAt, authors: record.authors, document: record.document, latest: record.latest, latestDigest: record.latestDigest });
        case "POST /api/enroll": {
          const pub = b64u.to(body.pub);
          const id = b64u.from((await sha256(pub)).slice(0, 16));
          if (id !== body.author) throw new Error("author id is not the first 16 bytes of SHA-256 of the key");
          const ok = await verifyRaw(pub, b64u.to(body.proof), enc.encode(`dai-spike enroll ${owner} ${id}`));
          if (!ok) throw new Error("proof of possession does not verify");
          if (!record.authors[id]) record.authors[id] = { pub: body.pub, enrolledAt: new Date().toISOString(), context: body.context ?? "", ua: body.ua ?? "" };
          await this.storage.put(`owner:${owner}`, record);
          return json({ owner, authors: record.authors });
        }
        case "POST /api/checkpoint": {
          const author = record.authors[body.author];
          if (!author) throw new Error("the signing author is not enrolled under this owner");
          const text = String(body.checkpoint);
          if (!(await verifyRaw(b64u.to(author.pub), b64u.to(body.signature), enc.encode(text)))) throw new Error("checkpoint signature does not verify");
          const cp = JSON.parse(text);
          if (record.document && cp.document !== record.document) throw new Error("checkpoint names another document");
          if (cp.revision !== record.latest + 1 || cp.previous !== record.latestDigest) {
            return json({ error: "Not the latest: restore first, then write.", latest: record.latest, latestDigest: record.latestDigest }, 409);
          }
          const digest = hex(await sha256(enc.encode(text)));
          await this.storage.put(`cp:${owner}:${String(cp.revision).padStart(8, "0")}`, {
            checkpoint: text, digest, signature: body.signature, author: body.author, envelope: body.envelope, iv: body.iv, ciphertext: body.ciphertext, uploadedAt: new Date().toISOString(),
          });
          record.document ??= cp.document;
          record.latest = cp.revision;
          record.latestDigest = digest;
          await this.storage.put(`owner:${owner}`, record);
          return json({ revision: cp.revision, digest });
        }
        case "GET /api/checkpoints": {
          const list = await this.storage.list({ prefix: `cp:${owner}:` });
          return json([...list.values()].map((c) => ({ revision: JSON.parse(c.checkpoint).revision, digest: c.digest, author: c.author, uploadedAt: c.uploadedAt, paths: Object.keys(c.envelope ?? {}) })));
        }
        case "GET /api/checkpoint/latest": {
          if (!record.latest) return json({ none: true });
          return json({ ...(await this.storage.get(`cp:${owner}:${String(record.latest).padStart(8, "0")}`)), authors: record.authors });
        }
      }
      return json({ error: `no route ${route}` }, 404);
    } catch (e) {
      return json({ error: String(e?.message ?? e) }, 400);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Where the keychain form posts, so Safari offers to save the password.
    // The body is never read: the secret is the device's, not the store's.
    if (url.pathname === "/api/sink") return Response.redirect(`${url.origin}/?saved=1`, 303);
    if (url.pathname.startsWith("/api/")) return env.STORE.get(env.STORE.idFromName("spike")).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
