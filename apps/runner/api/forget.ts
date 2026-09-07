import { presignDelete } from "../../../src/store-s3.js";
import { retireDigest } from "../../../src/store.js";

/*
 * Retiring a shared document before its time is up.
 *
 * The store keeps what it is given for a fixed time and then removes it
 * (infra/r2-lifecycle.json). Before then, the person who shared it may want
 * it gone: sent to the wrong thread, or thought better of. The proof of
 * standing is the retire token — derived from the link's key, so anyone who
 * holds the link holds it, and the store holds only its hash (see
 * `Sidecar.retire` in src/store.ts). This endpoint checks the token against
 * the sidecar and, when it matches, removes the blob, the sidecar and the
 * icon. It never learns the key and can retire nothing on its own.
 *
 * Edge runtime, for the same reasons as presign.ts beside this file.
 */
export const config = { runtime: "edge" };

/** How many retirements one address may ask for per hour. */
const PER_HOUR = Number(process.env.DAI_FORGET_PER_HOUR ?? 30);

const seen = new Map<string, number[]>();

function withinRate(address: string, now: number): boolean {
  const hourAgo = now - 3_600_000;
  const recent = (seen.get(address) ?? []).filter((at) => at > hourAgo);
  if (recent.length >= PER_HOUR) {
    seen.set(address, recent);
    return false;
  }
  recent.push(now);
  seen.set(address, recent);
  if (seen.size > 10_000) {
    for (const [key, times] of seen) {
      if (times.every((at) => at <= hourAgo)) seen.delete(key);
    }
  }
  return true;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-max-age": "86400",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differ = 0;
  for (let i = 0; i < a.length; i++) differ |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differ === 0;
}

export default async function handler(request: Request, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json({ error: "POST only." }, 405);

  const endpoint = process.env.DAI_STORE_ENDPOINT;
  const bucket = process.env.DAI_STORE_BUCKET;
  const accessKeyId = process.env.DAI_STORE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.DAI_STORE_SECRET_ACCESS_KEY;
  const publicBase = process.env.DAI_STORE_PUBLIC_BASE;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !publicBase) {
    return json({ error: "This deployment has no store configured." }, 503);
  }

  let body: { hash?: unknown; token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Expected a JSON object." }, 400);
  }
  const hash = typeof body.hash === "string" ? body.hash.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return json({ error: "hash must be 64 hex characters: the name the document is stored under." }, 400);
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return json({ error: "token must be the retire token that came with the link." }, 400);
  }

  const now = Date.now();
  const address =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? "unknown";
  if (!withinRate(address, now)) return json({ error: "Too many requests from here in the last hour." }, 429);

  // What the store holds beside the document says who may retire it.
  const base = publicBase.endsWith("/") ? publicBase : publicBase + "/";
  const sidecarResponse = await fetchImpl(new URL(`${hash}.json`, base).href, { cache: "no-store" });
  if (sidecarResponse.status === 404 || sidecarResponse.status === 410) {
    // Already gone, by this or by time. The outcome asked for is the case.
    return json({ gone: true, already: true }, 200);
  }
  if (!sidecarResponse.ok) return json({ error: "The store could not be read." }, 502);
  let sidecar: { retire?: unknown };
  try {
    sidecar = (await sidecarResponse.json()) as typeof sidecar;
  } catch {
    return json({ error: "The store's record of this document could not be read." }, 502);
  }
  if (!sidecar || typeof sidecar !== "object" || typeof sidecar.retire !== "string") {
    return json({ error: "This document was shared before links could be retired. It goes when its time is up." }, 403);
  }
  if (!same(await retireDigest(token), sidecar.retire)) {
    return json({ error: "That token does not retire this document." }, 403);
  }

  const options = {
    endpoint,
    bucket,
    region: process.env.DAI_STORE_REGION ?? "auto",
    accessKeyId,
    secretAccessKey,
    publicBase,
    pathStyle: true,
  };
  // The blob last: a sidecar that outlives its blob is a preview of nothing,
  // and a blob that outlives its sidecar cannot be retired again.
  for (const key of [`${hash}.png`, `${hash}.json`, hash]) {
    const url = await presignDelete(options, key, 60, new Date(now));
    const deleted = await fetchImpl(url, { method: "DELETE" });
    if (!deleted.ok && deleted.status !== 404) {
      return json({ error: `The store refused to remove ${key === hash ? "the document" : key.endsWith(".json") ? "its record" : "its icon"}.` }, 502);
    }
  }
  return json({ gone: true }, 200);
}
