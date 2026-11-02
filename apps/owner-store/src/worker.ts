/// <reference path="../../relay/src/cloudflare.d.ts" />
/**
 * The owner's store's front door: routes `/o/<owner>/…` to the owner's object
 * and `/d/<owner>/<document>/…` to the document's, and nothing else.
 *
 * The objects reach each other on `/internal/…`, which this door never
 * forwards, so only an object can ask another which authors are enrolled.
 * CORS is open to any origin: no request carries a cookie or any ambient
 * authority, every one is signed by an enrolled author's key, and the host
 * that makes them may be a preview on any address.
 */
import { StoreDO, type StoreEnv } from "./store-do.js";

export { StoreDO };

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "content-type,x-dai-author,x-dai-time,x-dai-signature",
  "access-control-expose-headers": "x-dai-at",
  "access-control-max-age": "86400",
};

/** The object a public path belongs to, or null for any other path. */
export function objectName(pathname: string): string | null {
  const owner = /^\/o\/([A-Za-z0-9_-]{1,64})\/(?:enroll|admit|library)$/.exec(pathname);
  if (owner) return `o:${owner[1]}`;
  const document = /^\/d\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\/(?:key|append|heads|(?:e|c)\/[A-Za-z0-9_-]{43})$/.exec(pathname);
  if (document) return `d:${document[1]}:${document[2]}`;
  return null;
}

export default {
  async fetch(request: Request, env: StoreEnv): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const name = objectName(new URL(request.url).pathname);
    const answer = name
      ? await env.STORE.get(env.STORE.idFromName(name)).fetch(request)
      : new Response(JSON.stringify({ refused: "no such operation" }), { status: 404 });
    const out = new Response(answer.body, answer);
    for (const [key, value] of Object.entries(CORS)) out.headers.set(key, value);
    return out;
  },
};
