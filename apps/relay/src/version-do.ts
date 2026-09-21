/**
 * The version relay, as one Durable Object per document (`docs/version-ping.md`).
 *
 * Two things happen here and nothing else. A copy says which build it holds and
 * is told whether the author has published a successor; and an author publishes
 * that successor, signed, so the relay cannot invent one and nobody without the
 * key can announce one. The counting falls out of the first.
 *
 * What it learns is the document id in its own name, a build digest, and a
 * publisher key. Not who, not when beyond a day's count, and nothing about what
 * is in the document. **It holds what the author published, never what a person
 * wrote** — which is the line the whole design draws, and the reason an
 * announcement is the only thing here that carries an address.
 *
 *   POST /v/<doc>           { version, publisher } → { current, label, note, successor }
 *   POST /v/<doc>/announce  { version, label, note, successor, publicKey, signature }
 *
 * One object per document, like the mailbox: a busy author does not serialize
 * every reader of everything they have published through one object.
 */

interface Env {
  /** Nothing yet. The announcement is signed, so there is no secret to hold. */
  readonly unused?: never;
}

/** What an author published, once verified. */
interface Announcement {
  version: string;
  label: string;
  note: string;
  successor: string;
  /** Base64 SPKI of the key that signed it. The copy checks this against its own pin. */
  publicKey: string;
  published: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/**
 * The bytes an announcement signs: its fields, in one order, and nothing else.
 *
 * Written out rather than `JSON.stringify(body)` so that what is signed cannot
 * change with a key's order or an extra field somebody adds later — the same
 * reason the container's signed set is derived in one place.
 */
export function announcementBytes(fields: {
  document: string;
  version: string;
  label: string;
  note: string;
  successor: string;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([fields.document, fields.version, fields.label, fields.note, fields.successor]),
  );
}

/** The day a check-in is counted under, in UTC. */
const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);

export class VersionDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["v", <doc>] or ["v", <doc>, "announce"]
    const document = parts[1];
    if (!document || parts[0] !== "v") return new Response("not found", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ error: "expected JSON" }, 400);

    if (parts[2] === "announce") return this.announce(document, body);
    if (parts.length === 2) return this.ping(document, body);
    return new Response("not found", { status: 404 });
  }

  /**
   * A copy checks in.
   *
   * Counted twice — under its version and under the document — because the two
   * answer different questions ("did the update reach anyone", "is this app
   * used") and neither is a count of copies: nothing here distinguishes one
   * copy from another, by design. They are check-ins, and the copy's own
   * once-a-day limit is what makes that a floor on copies used.
   */
  private async ping(document: string, body: Record<string, unknown>): Promise<Response> {
    const version = typeof body.version === "string" ? body.version : "";
    if (!version) return json({ error: "expected a version" }, 400);
    const day = dayOf(Date.now());

    const perVersion = `count:${version}:${day}`;
    const perDocument = `count:${day}`;
    const [versionCount, documentCount] = await Promise.all([
      this.state.storage.get<number>(perVersion),
      this.state.storage.get<number>(perDocument),
    ]);
    await this.state.storage.put({
      [perVersion]: (versionCount ?? 0) + 1,
      [perDocument]: (documentCount ?? 0) + 1,
    });

    const current = await this.state.storage.get<Announcement>("current");
    /*
     * Nothing to say unless there is something newer than what they hold. A
     * copy running the current build gets the same answer as one whose author
     * has published nothing: no successor, and no card.
     */
    if (!current || current.version === version) return json({ current: current?.version ?? null, successor: null });
    return json({
      current: current.version,
      label: current.label,
      note: current.note,
      successor: current.successor,
      publicKey: current.publicKey,
    });
  }

  /**
   * An author publishes a successor.
   *
   * Verified here, before it is stored: the signature must be by the key the
   * announcement carries. That is what makes this a noticeboard whose entries
   * the relay cannot forge — it can refuse to serve one, which any relay can
   * do to any message, and it cannot make one up.
   *
   * Whether that key is one to trust is not the relay's question and is never
   * asked here. The copy compares it with the publisher it already pinned for
   * the document, and refuses a successor under any other key however well
   * signed — the same check succession has always made.
   */
  private async announce(document: string, body: Record<string, unknown>): Promise<Response> {
    const version = typeof body.version === "string" ? body.version : "";
    const label = typeof body.label === "string" ? body.label : "";
    const note = typeof body.note === "string" ? body.note : "";
    const successor = typeof body.successor === "string" ? body.successor : "";
    const publicKey = typeof body.publicKey === "string" ? body.publicKey : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    if (!version || !successor || !publicKey || !signature) {
      return json({ error: "expected version, successor, publicKey and signature" }, 400);
    }

    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "spki",
        fromBase64(publicKey) as unknown as ArrayBuffer,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
    } catch {
      return json({ error: "that public key cannot be read" }, 400);
    }

    const signed = announcementBytes({ document, version, label, note, successor });
    const ok = await crypto.subtle
      .verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        fromBase64(signature) as unknown as ArrayBuffer,
        signed as unknown as ArrayBuffer,
      )
      .catch(() => false);
    if (!ok) return json({ error: "that announcement is not signed by the key it carries" }, 403);

    /*
     * One announcement stands at a time: the newest the author published is
     * what a copy is told about. An author who publishes twice replaces their
     * own notice, and nobody else can replace it, because the key would have
     * to match and the relay never had it.
     */
    const held = await this.state.storage.get<Announcement>("current");
    if (held && held.publicKey !== publicKey) {
      return json({ error: "this document is already announced under another key" }, 409);
    }
    const announcement: Announcement = {
      version,
      label,
      note,
      successor,
      publicKey,
      published: new Date().toISOString(),
    };
    await this.state.storage.put("current", announcement);
    return json({ current: version });
  }
}
