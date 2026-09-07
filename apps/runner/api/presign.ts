/**
 * The one deployed thing that holds a store credential.
 *
 * A browser cannot be given a bucket key. It runs on somebody else's device,
 * and a key in a page is a key belonging to whoever was sent the link. But a
 * browser is exactly where documents get made — the site builds them, the
 * opener re-seals them — so something has to bridge that, and this is it: a
 * function that checks what is being asked for, and hands back a URL that may
 * be written to once, for a few minutes, and to one address.
 *
 * Presigned rather than proxied. A function that relayed the body would have a
 * body size limit, and a document is allowed to be five megabytes; it would
 * also mean every document passing through a machine this project runs, which
 * is the opposite of what a store is for. The bytes go from the device to the
 * bucket and are never seen here.
 *
 * ## What this checks before it signs anything
 *
 * The credential's whole value to an attacker is that it writes to a bucket
 * somebody else pays for. So:
 *
 * - **The address is a hash.** 64 hex characters, lowercase, and nothing else.
 *   A key this endpoint will sign for cannot be a path, cannot traverse, and
 *   cannot collide with anything already stored under a different name.
 * - **The size is declared and capped.** Above the cap there is no URL, and the
 *   cap is the same one the store itself enforces.
 * - **The rate is limited per address.** In memory, per instance — which is
 *   weak, and honest about being weak: it stops a loop, not a botnet. The
 *   bucket's own limits and the token's scope are what stand behind it.
 * - **The token is scoped.** Object read/write on one bucket, one token per
 *   environment. Losing it costs the contents of `dai-store` and nothing else.
 *
 * What it does not check is what is in the document, because it never sees it.
 * The store's `admit()` runs where the sidecar is written; this endpoint's job
 * is narrower and it should stay narrow.
 */
import { presignPut } from "../../../src/store-s3.js";
import { ICON_CAP, STORE_CAP } from "../../../src/store.js";

/*
 * The edge runtime, and it has to be.
 *
 * This handler is written the way the platform's edge functions are: it takes
 * a `Request` and returns a `Response`. Vercel's Node runtime expects the
 * other shape — `(req, res)`, ending the response by calling a method on it —
 * and a fetch-style handler there never ends anything. The symptom is not an
 * error: the request simply hangs until the gateway gives up, with nothing in
 * the logs, which is how this was first shipped.
 *
 * Nothing here wants Node anyway. The signing is WebCrypto, which the edge has,
 * and `src/store-s3.ts` imports nothing from `node:` — the same reason the
 * middleware beside this file already runs there.
 */
export const config = { runtime: "edge" };

/** The largest object this will hand out a URL for. Same cap as the store. */
const MAX_BYTES = Number(process.env.DAI_PRESIGN_MAX_BYTES ?? STORE_CAP);

/** How many URLs one address may be given per hour. */
const PER_HOUR = Number(process.env.DAI_PRESIGN_PER_HOUR ?? 20);

/** How long a signed URL is good for. Long enough to upload, short enough to lose. */
const EXPIRES_SECONDS = 300;

/**
 * Recent requests per address.
 *
 * Per instance and in memory, so it resets on a cold start and does not exist
 * across regions. That is a real limit and is stated rather than papered over:
 * this is a speed bump in front of a scoped token, not an access control. A
 * shared counter would mean a database, and a database on the path of every
 * upload is a dependency this project should not take for a speed bump.
 */
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

  // Unbounded growth is a leak in a long-lived instance.
  if (seen.size > 10_000) {
    for (const [key, times] of seen) {
      if (times.every((at) => at <= hourAgo)) seen.delete(key);
    }
  }
  return true;
}

// The site and the opener are different origins from this function.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-max-age": "86400",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
    },
  });
}

/*
 * Who may write beside a document.
 *
 * The blob is bound to its name by its hash. The sidecar and the icon are not:
 * they sit under the blob's hash with a digest the caller declares, so anyone
 * who had seen a link — and so knew the hash — could mint a URL for its
 * sidecar and rewrite the preview, or put a shape in it the unfurl could not
 * read. The answer is a token minted with the blob's URL and required for the
 * two that go beside it: an HMAC over the hash and an expiry, under a key
 * this function already holds. Whoever stored the document may describe it;
 * nobody else. Fifteen minutes, which is the same upload session.
 */
const TOKEN_SECONDS = 15 * 60;

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mintToken(secret: string, hash: string, now: number): Promise<string> {
  const expires = Math.floor(now / 1000) + TOKEN_SECONDS;
  return `${expires}.${await hmac(secret, `${hash}:${expires}`)}`;
}

async function tokenAllows(secret: string, hash: string, token: unknown, now: number): Promise<boolean> {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expires = Number(token.slice(0, dot));
  if (!Number.isInteger(expires) || expires * 1000 < now) return false;
  const expected = await hmac(secret, `${hash}:${expires}`);
  const given = token.slice(dot + 1);
  if (given.length !== expected.length) return false;
  let differ = 0;
  for (let i = 0; i < expected.length; i++) differ |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return differ === 0;
}

export default async function handler(request: Request): Promise<Response> {
  // A preflight has no body: a 204 with one is refused by the Response
  // constructor itself, and every cross-origin upload died there.
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json({ error: "POST only." }, 405);

  const endpoint = process.env.DAI_STORE_ENDPOINT;
  const bucket = process.env.DAI_STORE_BUCKET;
  const accessKeyId = process.env.DAI_STORE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.DAI_STORE_SECRET_ACCESS_KEY;
  const publicBase = process.env.DAI_STORE_PUBLIC_BASE;

  /*
   * Which ones are missing, by name.
   *
   * Names only, never values — a diagnostic endpoint that echoed a secret
   * would be a worse bug than the one it is helping to find. But "no store
   * configured" on its own sends somebody to check six variables across two
   * projects with no way to tell which is wrong, and one of these is
   * genuinely easy to get wrong: on Vercel, a variable marked Sensitive is
   * write-only and is not exposed to the edge runtime, so a correctly-typed
   * secret can be present in the dashboard and absent here.
   */
  const missing = Object.entries({
    DAI_STORE_ENDPOINT: endpoint,
    DAI_STORE_BUCKET: bucket,
    DAI_STORE_ACCESS_KEY_ID: accessKeyId,
    DAI_STORE_SECRET_ACCESS_KEY: secretAccessKey,
    DAI_STORE_PUBLIC_BASE: publicBase,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    return json(
      {
        error: "This deployment has no store configured.",
        missing,
        hint:
          "These names are not visible to this function. On Vercel, check they are set on " +
          "the project that serves this domain, for this environment — and that they are " +
          "not marked Sensitive, which withholds the value from the edge runtime.",
      },
      503,
    );
  }

  let body: { hash?: unknown; size?: unknown; kind?: unknown; sha256?: unknown; token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }
  // Valid JSON is not the same as the right shape: `null` parses.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Expected a JSON object." }, 400);
  }

  const hash = typeof body.hash === "string" ? body.hash.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return json({ error: "hash must be 64 hex characters: the SHA-256 of what you are storing." }, 400);
  }

  /*
   * Which object, of the three a document can have.
   *
   * The blob is the document; the sidecar is what a store checks it by and
   * what a preview is built from; the icon is the picture in that preview.
   * Named here rather than taken from the caller so a request cannot ask for a
   * key of its own devising.
   */
  const kind = body.kind === "sidecar" ? "sidecar" : body.kind === "icon" ? "icon" : "blob";
  const key = kind === "blob" ? hash : kind === "sidecar" ? `${hash}.json` : `${hash}.png`;
  const contentType =
    kind === "sidecar" ? "application/json" : kind === "icon" ? "image/png" : "application/octet-stream";

  /*
   * The size, and the digest, both signed into the URL.
   *
   * Neither was, and a review checked what that meant against production: a
   * request declaring one kilobyte was granted a URL, sixty-four kilobytes
   * went through it, and the object now sits under a name that is not its
   * hash. The cap was advice and the address was a fiction.
   *
   * So both are bound by the bucket rather than trusted from the caller. The
   * size goes into the signature as `content-length`; a body of any other
   * length is refused by the store. The digest goes in as
   * `x-amz-content-sha256`; a body that does not hash to it is refused the
   * same way. For the blob the digest *is* the key, so it is not asked for:
   * the name and the content are one claim. For the sidecar and the icon the
   * caller declares it, and the store holds them to it.
   */
  const size = typeof body.size === "number" ? body.size : NaN;
  if (!Number.isFinite(size) || size <= 0 || !Number.isInteger(size)) {
    return json({ error: "size must be the number of bytes you are about to upload." }, 400);
  }
  // A caption, not an asset: the same cap the store's own admission applies.
  const cap = kind === "icon" ? ICON_CAP : MAX_BYTES;
  if (size > cap) {
    return json(
      {
        error:
          kind === "icon"
            ? `A preview icon must be under ${ICON_CAP / 1024} KB, and that is ${(size / 1024).toFixed(0)} KB.`
            : `That is ${(size / 1024 / 1024).toFixed(1)} MB and the limit is ` +
              `${MAX_BYTES / 1024 / 1024} MB. Send the file itself instead.`,
      },
      413,
    );
  }

  let sha256: string;
  if (kind === "blob") {
    if (typeof body.sha256 === "string" && body.sha256.toLowerCase() !== hash) {
      return json({ error: "For the document itself, sha256 must equal hash: the name is the digest." }, 400);
    }
    sha256 = hash;
  } else {
    const declared = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(declared)) {
      return json(
        { error: `sha256 must be the SHA-256 of the ${kind} you are about to upload, as 64 hex characters.` },
        400,
      );
    }
    sha256 = declared;
  }

  const now = Date.now();
  if (kind !== "blob" && !(await tokenAllows(secretAccessKey, hash, body.token, now))) {
    return json(
      {
        error:
          `The ${kind} beside a document may be written only by whoever stored the document, ` +
          "with the token that came back when it was stored.",
      },
      403,
    );
  }

  const address =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";
  if (!withinRate(address, now)) {
    return json({ error: "Too many uploads from here in the last hour." }, 429);
  }

  const signed = await presignPut(
    { endpoint, bucket, region: process.env.DAI_STORE_REGION ?? "auto", accessKeyId, secretAccessKey, publicBase, pathStyle: true },
    key,
    contentType,
    { size, sha256 },
    EXPIRES_SECONDS,
  );

  return json(
    {
      url: signed.url,
      // What the caller must send, exactly: every one of these is inside the
      // signature, so a mismatch is refused by the bucket rather than by us.
      // A browser sets content-length itself from the body and ignores one
      // set by hand, which is fine — the body was declared at this size.
      method: "PUT",
      headers: signed.headers,
      expiresIn: EXPIRES_SECONDS,
      // Where it will be readable once written. Public, no credential.
      href: new URL(key, publicBase.endsWith("/") ? publicBase : publicBase + "/").href,
      // For the document itself: what the sidecar and the icon must present.
      ...(kind === "blob" ? { token: await mintToken(secretAccessKey, hash, now) } : {}),
    },
    200,
  );
}
