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
 */

interface Env {
  MAILBOX_R2: R2Bucket;
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
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
    const isHead = parts[parts.length - 1] === "head";
    const doc = isHead ? parts[parts.length - 2] : parts[parts.length - 1];
    if (!doc || !/^[0-9a-zA-Z._-]{1,128}$/.test(doc)) return new Response("bad document id", { status: 400 });

    if (request.method === "POST") return this.append(doc, request);
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
    return text(String(seq));
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
