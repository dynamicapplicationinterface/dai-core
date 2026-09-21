/**
 * The relay worker: routes `/m/<doc>…` to that document's mailbox object.
 *
 * A thin front door. It names the Durable Object by the document id and hands
 * the request straight to it — the object does the work, single-threaded per
 * mailbox. CORS is opened to the opener origins so the host (which holds the
 * key and does the sealing) can reach it from `opendai.app`; the frame never
 * can (`connect-src 'none'`), which is why the host carries these calls.
 *
 * Retention and entitlement are deferred by the ruling: this door asks nobody
 * who they are and trims nothing. Those are dials for later, on a mechanism
 * that runs.
 */
import { MailboxDO } from "./mailbox-do.js";
import { VersionDO } from "./version-do.js";

export { MailboxDO, VersionDO };

interface Env {
  MAILBOX: DurableObjectNamespace;
  /** One object per document, for version check-ins (`docs/version-ping.md`). */
  VERSION: DurableObjectNamespace;
}

const ALLOW_ORIGIN = /^https:\/\/(opendai\.app|[a-z0-9-]+\.opendai\.app)$/;

const cors = (origin: string | null): Record<string, string> => {
  const allow = origin && ALLOW_ORIGIN.test(origin) ? origin : "https://opendai.app";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    // `if-none-match` so a poll can send the tag; `etag` exposed so the client
    // can read it back — neither is CORS-safelisted, so both must be named.
    // `x-dai-sender` names the appender's own push subscription, so a move does
    // not wake the device that made it.
    "access-control-allow-headers": "content-type,if-none-match,x-dai-sender",
    "access-control-expose-headers": "etag",
    "access-control-max-age": "86400",
  };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    const headers = cors(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);

    /*
     * The version door: `/v/<doc>` and `/v/<doc>/announce`, one object per
     * document (`docs/version-ping.md`).
     *
     * Kept apart from the mailbox rather than folded into it. They hold
     * different things and learn different things — the mailbox holds sealed
     * bytes it cannot read, and this holds what an author published in the
     * open — and one object holding both would be one place where those two
     * facts sit together.
     */
    const version = /^\/v\/([0-9a-zA-Z._-]{1,128})(?:\/announce)?\/?$/.exec(url.pathname);
    if (version) {
      const stub = env.VERSION.get(env.VERSION.idFromName(version[1]!));
      const answer = await stub.fetch(request);
      const out = new Response(answer.body, answer);
      for (const [key, value] of Object.entries(headers)) out.headers.set(key, value);
      return out;
    }

    // /m/<doc>, /m/<doc>/head, /m/<doc>/subscribe, /m/<doc>/unsubscribe — the
    // mailbox id is the segment after /m/.
    const match = /^\/m\/([0-9a-zA-Z._-]{1,128})(?:\/head|\/subscribe|\/unsubscribe)?\/?$/.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404, headers });

    const doc = match[1]!;
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(doc));
    const response = await stub.fetch(request);

    // Re-attach CORS to the object's answer.
    const out = new Response(response.body, response);
    for (const [key, value] of Object.entries(headers)) out.headers.set(key, value);
    return out;
  },
};
