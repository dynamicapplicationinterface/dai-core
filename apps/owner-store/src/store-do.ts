/// <reference path="../../relay/src/cloudflare.d.ts" />
/**
 * The owner's store as Durable Objects (docs/store.md): one object per owner,
 * named `o:<owner>`, and one per working document, named `d:<owner>:<document>`.
 *
 * The owner object holds what docs/store.md lists per owner: the passkey's
 * credential id and public key, the keychain verifier, the owner key's two
 * wraps, the enrolled authors, and the documents in the library. The document
 * object holds the wrapped data key and the log: every envelope it accepted,
 * by digest with its parents, author, time and the key of its bytes in the
 * bucket (`ENVELOPES`), and which are heads. The bytes are never an object's
 * value. Single-threaded per object, so an append's compare-and-swap on the
 * parent needs no lock, so long as nothing outside is awaited between its
 * read of the heads and its write.
 *
 * Nothing here can read: every value it is sent is ciphertext, a digest, a
 * public key or an identifier, and it checks only what those let it check: a
 * signature, an author's enrollment, a parent's presence.
 */
import {
  ADMIT_CHALLENGE,
  REQUEST_WINDOW_MS,
  authorIdOf,
  b64u,
  concat,
  derToRaw,
  digestOf,
  envelopeSigned,
  fromB64u,
  isDigest,
  isId,
  parseEnvelope,
  requestBytes,
  sha256,
  utf8,
  verifyEd25519,
  verifyES256,
} from "./envelope.js";

export interface StoreEnv {
  STORE: DurableObjectNamespace;
  /**
   * The envelopes' bytes, as the relay keeps its sealed batches: an envelope
   * carries a release's container, about 1 MB, past what one Durable Object
   * value holds. The object keeps the chain and each envelope's key here.
   */
  ENVELOPES: R2Bucket;
}

/** Where an envelope's bytes are kept: by owner, document and digest, so a key names exactly one envelope. */
export const envelopeKey = (owner: string, document: string, digest: string): string => `envelopes/${owner}/${document}/${digest}`;

interface OwnerRecord {
  owner: string;
  credential: { id: string; publicKey: string; algorithm: number };
  /** The origin the passkey was registered from; an assertion from another is refused. */
  origin: string;
  verifier: string;
  wraps: { prf: string; keychain: string };
  enrolled: string;
}

interface AuthorRecord {
  pub: string;
  admitted: "registration" | "passkey" | "keychain";
  at: string;
}

interface LogEntry {
  parents: string[];
  author: string;
  /** The store's acknowledgment time, ISO 8601. */
  at: string;
  /** Whether it was appended as the head or kept as a branch. */
  as: "head" | "branch";
  /** The envelope's bytes, in the bucket. */
  r2: string;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const refuse = (why: string, status = 409): Response => json({ refused: why }, status);

/** A request's body, read once. */
async function bodyOf(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await request.arrayBuffer());
}

/** Whether a request is signed by an author key, within the window. */
async function signedBy(request: Request, path: string, body: Uint8Array, pub: string): Promise<boolean> {
  const time = request.headers.get("x-dai-time") ?? "";
  const signature = request.headers.get("x-dai-signature") ?? "";
  if (!/^\d{1,16}$/.test(time) || Math.abs(Date.now() - Number(time)) > REQUEST_WINDOW_MS) return false;
  try {
    return await verifyES256(fromB64u(pub), fromB64u(signature), requestBytes(request.method, path, time, await digestOf(body)));
  } catch {
    return false;
  }
}

/** Imports an SPKI P-256 public key and verifies a WebAuthn assertion with it. */
async function assertionHolds(spki: string, authenticatorData: Uint8Array, clientDataJSON: Uint8Array, der: Uint8Array): Promise<boolean> {
  const raw = derToRaw(der);
  if (!raw) return false;
  try {
    const key = await crypto.subtle.importKey("spki", fromB64u(spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      raw,
      concat(authenticatorData, await sha256(clientDataJSON)),
    );
  } catch {
    return false;
  }
}

export class StoreDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: StoreEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if ((m = /^\/internal\/author\/([A-Za-z0-9_-]{1,64})$/.exec(path))) return this.authorPub(m[1]!);
    if ((m = /^\/internal\/document\/([A-Za-z0-9_-]{1,64})$/.exec(path))) return this.listDocument(m[1]!);
    if ((m = /^\/o\/([A-Za-z0-9_-]{1,64})\/(enroll|admit|library)$/.exec(path))) {
      const [, owner, op] = m as unknown as [string, string, string];
      if (op === "enroll" && request.method === "POST") return this.enroll(request, path, owner);
      if (op === "admit" && request.method === "POST") return this.admit(request, path, owner);
      if (op === "library" && request.method === "GET") return this.library(request, path, owner);
    }
    if ((m = /^\/d\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\/(key|append|heads|e\/([A-Za-z0-9_-]{43}))$/.exec(path))) {
      const [, owner, document, op, digest] = m as unknown as [string, string, string, string, string | undefined];
      if (op === "key" && request.method === "PUT") return this.putKey(request, path, owner, document);
      if (op === "append" && request.method === "POST") return this.append(request, path, owner, document, url.searchParams.get("as"));
      if (op === "heads" && request.method === "GET") return this.heads(request, path, owner);
      if (digest && request.method === "GET") return this.get(request, path, owner, digest);
    }
    return refuse("no such operation", 404);
  }

  // ---- The owner object ------------------------------------------------------

  private async authorPub(author: string): Promise<Response> {
    const held = await this.state.storage.get<AuthorRecord>(`a:${author}`);
    return held ? json({ pub: held.pub }) : refuse("not enrolled", 404);
  }

  private async listDocument(document: string): Promise<Response> {
    await this.state.storage.put(`l:${document}`, true);
    return json({ listed: document });
  }

  /** Enroll: the owner's credential, verifier, both wraps, and the first author, signed by that author. */
  private async enroll(request: Request, path: string, owner: string): Promise<Response> {
    const body = await bodyOf(request);
    let sent: {
      owner: string;
      credential: { id: string; publicKey: string; algorithm: number };
      registration: { clientDataJSON: string };
      verifier: string;
      wraps: { prf: string; keychain: string };
      author: { id: string; pub: string };
    };
    try {
      sent = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return refuse("not JSON", 400);
    }
    if (sent?.owner !== owner || !isId(sent.credential?.id) || sent.credential.algorithm !== -7) return refuse("malformed enrollment", 400);
    if (typeof sent.credential.publicKey !== "string" || typeof sent.verifier !== "string") return refuse("malformed enrollment", 400);
    if (typeof sent.wraps?.prf !== "string" || typeof sent.wraps?.keychain !== "string") return refuse("malformed enrollment", 400);
    if (!isId(sent.author?.id) || typeof sent.author.pub !== "string") return refuse("malformed enrollment", 400);
    if ((await authorIdOf(fromB64u(sent.author.pub))) !== sent.author.id) return refuse("author id is not its key's");
    if (request.headers.get("x-dai-author") !== sent.author.id || !(await signedBy(request, path, body, sent.author.pub))) {
      return refuse("not signed by the author it enrolls", 401);
    }
    // The registration names the origin later assertions must come from. With
    // attestation "none" it proves no more than the key it carries.
    let origin: string;
    try {
      const client = JSON.parse(new TextDecoder().decode(fromB64u(sent.registration.clientDataJSON))) as { type?: string; origin?: string };
      if (client.type !== "webauthn.create" || typeof client.origin !== "string") return refuse("not a registration", 400);
      origin = client.origin;
    } catch {
      return refuse("not a registration", 400);
    }
    if (await this.state.storage.get<OwnerRecord>("owner")) return refuse("owner exists");
    const now = new Date().toISOString();
    const record: OwnerRecord = { owner, credential: sent.credential, origin, verifier: sent.verifier, wraps: sent.wraps, enrolled: now };
    await this.state.storage.put("owner", record);
    await this.state.storage.put(`a:${sent.author.id}`, { pub: sent.author.pub, admitted: "registration", at: now } satisfies AuthorRecord);
    return json({ owner });
  }

  /** Admit: a new author, under a passkey assertion or a keychain proof; answered with the owner key's two wraps. */
  private async admit(request: Request, path: string, owner: string): Promise<Response> {
    const record = await this.state.storage.get<OwnerRecord>("owner");
    if (!record) return refuse("no such owner", 404);
    const body = await bodyOf(request);
    let sent: {
      author: { id: string; pub: string };
      proof:
        | { kind: "passkey"; credential: string; clientDataJSON: string; authenticatorData: string; signature: string }
        | { kind: "keychain"; challenge: string; signature: string };
    };
    try {
      sent = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return refuse("not JSON", 400);
    }
    if (!isId(sent?.author?.id) || typeof sent.author.pub !== "string") return refuse("malformed admission", 400);
    if ((await authorIdOf(fromB64u(sent.author.pub))) !== sent.author.id) return refuse("author id is not its key's");
    if (request.headers.get("x-dai-author") !== sent.author.id || !(await signedBy(request, path, body, sent.author.pub))) {
      return refuse("not signed by the author it admits", 401);
    }
    let challenge: string;
    const proof = sent.proof;
    if (proof?.kind === "passkey") {
      if (proof.credential !== record.credential.id) return refuse("another passkey", 401);
      let client: { type?: string; challenge?: string; origin?: string };
      let authenticatorData: Uint8Array;
      let clientDataJSON: Uint8Array;
      try {
        clientDataJSON = fromB64u(proof.clientDataJSON);
        authenticatorData = fromB64u(proof.authenticatorData);
        client = JSON.parse(new TextDecoder().decode(clientDataJSON));
        challenge = new TextDecoder().decode(fromB64u(client.challenge ?? ""));
      } catch {
        return refuse("malformed assertion", 400);
      }
      if (client.type !== "webauthn.get" || client.origin !== record.origin) return refuse("not an assertion from the owner's origin", 401);
      // User present and user verified.
      if (authenticatorData.length < 37 || (authenticatorData[32]! & 0x05) !== 0x05) return refuse("not user-verified", 401);
      if (!(await assertionHolds(record.credential.publicKey, authenticatorData, clientDataJSON, fromB64u(proof.signature)))) {
        return refuse("the assertion does not verify", 401);
      }
    } else if (proof?.kind === "keychain") {
      challenge = String(proof.challenge);
      const suffix = `:${sent.author.id}`;
      if (!challenge.endsWith(suffix)) return refuse("the proof names another author", 401);
      if (!(await verifyEd25519(record.verifier, fromB64u(proof.signature), utf8(challenge)))) return refuse("the keychain proof does not verify", 401);
      challenge = challenge.slice(0, -suffix.length);
    } else {
      return refuse("no proof", 401);
    }
    const shaped = ADMIT_CHALLENGE.exec(challenge);
    if (!shaped || Math.abs(Date.now() - Number(shaped[1])) > REQUEST_WINDOW_MS) return refuse("a stale challenge", 401);
    const seen = `c:${b64u(await sha256(utf8(challenge)))}`;
    if (await this.state.storage.get(seen)) return refuse("a challenge already used", 401);
    await this.state.storage.put(seen, true);
    const held = await this.state.storage.get<AuthorRecord>(`a:${sent.author.id}`);
    if (!held) await this.state.storage.put(`a:${sent.author.id}`, { pub: sent.author.pub, admitted: proof.kind, at: new Date().toISOString() } satisfies AuthorRecord);
    return json({ author: sent.author.id, wraps: record.wraps, credential: record.credential.id });
  }

  private async library(request: Request, path: string, owner: string): Promise<Response> {
    const denied = await this.authorized(request, path, owner, new Uint8Array());
    if (denied) return denied;
    const listed = await this.state.storage.list<boolean>({ prefix: "l:" });
    const authors = await this.state.storage.list<AuthorRecord>({ prefix: "a:" });
    return json({
      documents: [...listed.keys()].map((k) => k.slice(2)).sort(),
      // Every enrolled author's public key: what a host verifies a checkpoint's author against (R-C).
      authors: Object.fromEntries([...authors].map(([k, a]) => [k.slice(2), a.pub])),
    });
  }

  // ---- The document object -----------------------------------------------------

  /** The enrolled author's public key, from the owner object, or null. */
  private async enrolledPub(owner: string, author: string): Promise<string | null> {
    const stub = this.env.STORE.get(this.env.STORE.idFromName(`o:${owner}`));
    const answer = await stub.fetch(new Request(`https://store.internal/internal/author/${author}`));
    if (!answer.ok) return null;
    return ((await answer.json()) as { pub: string }).pub;
  }

  /** Null when the request is signed by an author enrolled under `owner`; otherwise the refusal. */
  private async authorized(request: Request, path: string, owner: string, body: Uint8Array): Promise<Response | null> {
    const author = request.headers.get("x-dai-author") ?? "";
    if (!isId(author)) return refuse("unsigned", 401);
    const pub = await (this.state.storage.get<OwnerRecord>("owner").then((held) =>
      held ? this.state.storage.get<AuthorRecord>(`a:${author}`).then((a) => a?.pub ?? null) : this.enrolledPub(owner, author),
    ));
    if (!pub) return refuse("author not enrolled", 401);
    if (!(await signedBy(request, path, body, pub))) return refuse("bad request signature", 401);
    return null;
  }

  /** Put: the document's data key, wrapped under the owner key. The first stands. */
  private async putKey(request: Request, path: string, owner: string, document: string): Promise<Response> {
    const body = await bodyOf(request);
    const denied = await this.authorized(request, path, owner, body);
    if (denied) return denied;
    const wrapped = new TextDecoder().decode(body);
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(wrapped)) return refuse("not a wrapped key", 400);
    const held = await this.state.storage.get<string>("key");
    if (held && held !== wrapped) return refuse("the document has another key");
    if (!held) await this.state.storage.put("key", wrapped);
    const stub = this.env.STORE.get(this.env.STORE.idFromName(`o:${owner}`));
    await stub.fetch(new Request(`https://store.internal/internal/document/${document}`, { method: "POST" }));
    return json({ accepted: true });
  }

  /**
   * Append: compare-and-swap on the parent, or a branch kept on purpose.
   *
   * As `head`, the envelope's parents must be every current head: it becomes
   * the head, and a second append on the same parent is refused, naming the
   * heads, since its parent no longer is one. As `branch`, its parents need
   * only be held: it is kept beside the heads, and nothing accepted is ever
   * dropped (R-B). An envelope the store holds already is answered as it was.
   */
  private async append(request: Request, path: string, owner: string, document: string, as: string | null): Promise<Response> {
    if (as !== "head" && as !== "branch") return refuse("append as head or branch", 400);
    const body = await bodyOf(request);
    const denied = await this.authorized(request, path, owner, body);
    if (denied) return denied;
    let envelope: ReturnType<typeof parseEnvelope>;
    try {
      envelope = parseEnvelope(body);
    } catch {
      return refuse("not an envelope", 400);
    }
    if (envelope.owner !== owner || envelope.document !== document) return refuse("the envelope names another document");
    if (envelope.author !== request.headers.get("x-dai-author")) return refuse("the envelope names another author");
    const pub = await this.enrolledPub(owner, envelope.author);
    if (!pub) return refuse("author not enrolled", 401);
    if (!(await envelopeSigned(envelope, fromB64u(pub)))) return refuse("the envelope's signature does not hold");
    const digest = await digestOf(body);
    const held = await this.state.storage.get<LogEntry>(`m:${digest}`);
    if (held) return json({ result: held.as, digest, at: held.at, owner, document });
    for (const parent of envelope.parents) {
      if (!(await this.state.storage.get(`m:${parent}`))) return refuse("a parent the store does not hold");
    }
    /*
     * The bytes first: a log entry never names bytes the bucket does not hold,
     * and a put that lands without its entry is named by nothing and
     * acknowledges nothing. The bucket is outside I/O, which lets this
     * object's other requests run while it is awaited, so what the swap
     * depends on is read after it, with nothing awaited outside between that
     * read and the write.
     */
    const r2 = envelopeKey(owner, document, digest);
    await this.env.ENVELOPES.put(r2, body);
    const meanwhile = await this.state.storage.get<LogEntry>(`m:${digest}`);
    if (meanwhile) return json({ result: meanwhile.as, digest, at: meanwhile.at, owner, document });
    const heads = (await this.state.storage.get<string[]>("heads")) ?? [];
    if (as === "head") {
      const covers = heads.every((h) => envelope.parents.includes(h)) && envelope.parents.length === heads.length;
      if (!covers) return json({ refused: "stale", heads }, 409);
    }
    const at = new Date().toISOString();
    const next = [...heads.filter((h) => !envelope.parents.includes(h)), digest];
    await this.state.storage.put({
      [`m:${digest}`]: { parents: envelope.parents, author: envelope.author, at, as, r2 } satisfies LogEntry,
      heads: next,
    });
    return json({ result: as, digest, at, owner, document });
  }

  private async heads(request: Request, path: string, owner: string): Promise<Response> {
    const denied = await this.authorized(request, path, owner, new Uint8Array());
    if (denied) return denied;
    const heads = (await this.state.storage.get<string[]>("heads")) ?? [];
    const entries = await Promise.all(heads.map(async (digest) => ({ digest, at: (await this.state.storage.get<LogEntry>(`m:${digest}`))!.at })));
    return json({ key: (await this.state.storage.get<string>("key")) ?? null, heads: entries });
  }

  private async get(request: Request, path: string, owner: string, digest: string): Promise<Response> {
    const denied = await this.authorized(request, path, owner, new Uint8Array());
    if (denied) return denied;
    if (!isDigest(digest)) return refuse("not a digest", 400);
    const entry = await this.state.storage.get<LogEntry>(`m:${digest}`);
    if (!entry) return refuse("no such envelope", 404);
    const held = await this.env.ENVELOPES.get(entry.r2);
    // Named in the log and absent from the bucket: the store cannot serve it, which is not the same as not holding it.
    if (!held) return json({ unavailable: "the envelope's bytes are not in the bucket" }, 503);
    return new Response(new Uint8Array(await held.arrayBuffer()), { headers: { "content-type": "application/octet-stream", "x-dai-at": entry.at } });
  }
}
