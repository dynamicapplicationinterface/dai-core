/**
 * The mailbox relay, as one Durable Object per document (Track 5, slice one).
 *
 * A Durable Object is single-threaded per id, so the one operation that must be
 * atomic — allocate the next cursor, but only after checking the batch is not
 * already here — is a plain sequence of reads and writes with no lock and no
 * race. That is exactly the primitive the cursor invariant asks for and the
 * reason the relay is a DO and not a KV counter: a KV counter is eventually
 * consistent and would mint a second cursor for a retried batch under two
 * simultaneous moves.
 *
 * The DO holds only the counter and the digest→cursor index. The sealed bytes
 * go to R2 under `mailbox/<doc>/<seq>` — content this relay cannot read, the
 * same promise the reference store keeps. Retention and entitlement are
 * deferred by the ruling; this is the mechanism, and nothing here trims a
 * mailbox or asks who is appending.
 *
 * The wire contract is the one `src/mailbox-http.ts` speaks and its test pins:
 *   POST  /<doc>          body = sealed bytes → the cursor, as text
 *   GET   /<doc>/head     → the head cursor, as text
 *   GET   /<doc>?since=N  → { cursor, batches: [base64, …] }
 *
 * And push (slice two), payloadless — see `push.ts`:
 *   POST  /<doc>/subscribe    body = { endpoint } → "ok"
 *   POST  /<doc>/unsubscribe  body = { endpoint } → "ok"
 * An append with `x-dai-sender: <sha256 of an endpoint>` wakes every other
 * subscription, not that one.
 */

import { acceptableEndpoint, endpointId, sendPush, type Vapid } from "./push.js";

interface Env {
  MAILBOX_R2: R2Bucket;
  /** VAPID keys (Worker vars/secrets). Without them the relay stores subscriptions and wakes nobody. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  /** "1" admits a loopback push endpoint. For tests only; a deploy never sets it. */
  PUSH_ALLOW_LOOPBACK?: string;
}

/**
 * How many subscriptions one mailbox holds. A game has two players, each with a
 * device or a few; eight is room for that and a bound on how many pushes one
 * append can cause, so an allowlisted push service is the most a hostile
 * subscriber can aim the relay at, and only this many times per move.
 */
const MAX_SUBSCRIPTIONS = 8;

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const text = (body: string): Response => new Response(body, { status: 200 });
const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

/** One document's mailbox. Named by the document id via `idFromName`. */
export class MailboxDO {
  /**
   * The counter, held in memory across requests while the object is warm.
   *
   * The object is single-threaded, so this cannot race, and a `head` — the poll
   * every open copy makes on a timer — answers from it without a storage read.
   * Undefined until the first load, and after an eviction, when it is read once.
   */
  private counter?: number;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private async getCounter(): Promise<number> {
    if (this.counter === undefined) this.counter = (await this.state.storage.get<number>("counter")) ?? 0;
    return this.counter;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    const verb = last === "head" || last === "subscribe" || last === "unsubscribe" ? last : undefined;
    const isHead = verb === "head";
    const doc = verb ? parts[parts.length - 2] : last;
    if (!doc || !/^[0-9a-zA-Z._-]{1,128}$/.test(doc)) return new Response("bad document id", { status: 400 });

    if (request.method === "POST" && (verb === "subscribe" || verb === "unsubscribe")) {
      return this.subscription(request, verb === "subscribe");
    }
    if (request.method === "POST" && !verb) return this.append(doc, request);
    if (isHead) {
      // The head, with the cursor as an ETag: an unchanged mailbox is a 304
      // with no body, which is the answer to a poll that found nothing.
      const counter = await this.getCounter();
      const tag = `"${counter}"`;
      if (request.headers.get("if-none-match") === tag) {
        return new Response(null, { status: 304, headers: { etag: tag } });
      }
      return new Response(String(counter), { status: 200, headers: { etag: tag } });
    }
    return this.since(doc, Number(url.searchParams.get("since") ?? "0") || 0);
  }

  private async append(doc: string, request: Request): Promise<Response> {
    const sealed = new Uint8Array(await request.arrayBuffer());
    if (sealed.byteLength === 0) return new Response("empty batch", { status: 400 });
    const digest = await sha256Hex(sealed);

    /*
     * The whole atomic section, race-free because the object is single-
     * threaded: a batch already here returns its *original* cursor and does
     * not move `head`; a new one takes the next cursor, and the blob is in R2
     * before the index commits, so a crash between the two leaves an orphan the
     * next append overwrites rather than a cursor pointing at nothing.
     */
    const already = await this.state.storage.get<number>(`d:${digest}`);
    if (typeof already === "number") return text(String(already));

    const counter = await this.getCounter();
    const seq = counter + 1;
    await this.env.MAILBOX_R2.put(`mailbox/${doc}/${seq}`, sealed);
    await this.state.storage.put<number>({ counter: seq, [`d:${digest}`]: seq });
    this.counter = seq; // keep the in-memory copy the head answers from fresh.
    // Only a new batch wakes anyone; a retried one already did.
    this.state.waitUntil(this.wake(doc, request.headers.get("x-dai-sender")));
    return text(String(seq));
  }

  /**
   * Subscribe or unsubscribe a push endpoint to this mailbox.
   *
   * Stored under the SHA-256 of the endpoint, so the sender header can name a
   * subscription without the relay handing endpoints back to anyone. Only a
   * real push service's endpoint is accepted, and only MAX_SUBSCRIPTIONS of
   * them per mailbox (see `acceptableEndpoint`).
   *
   * Nothing asks who is subscribing, or who is appending: entitlement is
   * deferred by the ruling, and this is the open tier — anyone who holds a
   * mailbox's address can append to it, subscribe to it, and name any
   * subscription as the sender of an append to spare it the wake. That last is
   * the same property as anyone-with-the-link-can-append, not a new one. A
   * subscriber learns only that this mailbox moved, which polling `head`
   * already tells anyone who knows the address.
   */
  private async subscription(request: Request, add: boolean): Promise<Response> {
    let endpoint: unknown;
    try {
      endpoint = ((await request.json()) as { endpoint?: unknown }).endpoint;
    } catch {
      return new Response("bad subscription", { status: 400 });
    }
    if (!acceptableEndpoint(endpoint, this.env.PUSH_ALLOW_LOOPBACK === "1")) {
      return new Response("bad subscription", { status: 400 });
    }
    const name = `s:${await endpointId(endpoint)}`;
    if (!add) {
      await this.state.storage.delete(name);
      return text("ok");
    }
    const held = await this.state.storage.get<string>(name);
    if (held === undefined && (await this.state.storage.list<string>({ prefix: "s:" })).size >= MAX_SUBSCRIPTIONS) {
      return new Response("too many subscriptions", { status: 429 });
    }
    await this.state.storage.put<string>(name, endpoint);
    return text("ok");
  }

  /** Wakes every subscription but the appender's own; forgets the ones the push service says are gone. */
  private async wake(doc: string, sender: string | null): Promise<void> {
    const vapid = this.vapid();
    if (!vapid) return;
    const subscriptions = await this.state.storage.list<string>({ prefix: "s:" });
    await Promise.all(
      [...subscriptions].map(async ([name, endpoint]) => {
        if (sender && name === `s:${sender}`) return;
        if ((await sendPush(endpoint, vapid)) === "gone") await this.state.storage.delete(name);
      }),
    );
  }

  private vapid(): Vapid | null {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_JWK, VAPID_SUBJECT } = this.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_JWK) return null;
    try {
      return {
        publicKey: VAPID_PUBLIC_KEY,
        privateKey: JSON.parse(VAPID_PRIVATE_JWK) as JsonWebKey,
        subject: VAPID_SUBJECT || "https://opendai.app",
      };
    } catch {
      return null;
    }
  }

  private async since(doc: string, since: number): Promise<Response> {
    const counter = (await this.state.storage.get<number>("counter")) ?? 0;
    const batches: string[] = [];
    for (let seq = since + 1; seq <= counter; seq += 1) {
      const object = await this.env.MAILBOX_R2.get(`mailbox/${doc}/${seq}`);
      if (object) batches.push(toBase64(new Uint8Array(await object.arrayBuffer())));
    }
    return json({ cursor: String(counter), batches });
  }
}
