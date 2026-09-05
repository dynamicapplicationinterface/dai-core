/**
 * A store that is any S3-compatible bucket.
 *
 * Cloudflare R2, MinIO, Backblaze B2, Google Cloud Storage and S3 itself all
 * speak this, so this one adapter is both the production host and the
 * reference for a company hosting its own. No SDK: signing a request is HMAC
 * over a fixed string, which WebCrypto does in Node and in a browser alike,
 * and a dependency the size of an SDK to do it would weigh more than the
 * opener.
 *
 * Reads are unsigned. The bucket is public for GET — a blob is ciphertext
 * under a name nobody can guess, and the opener reads it with a plain fetch
 * from any origin. That needs the bucket to send:
 *
 *     Access-Control-Allow-Origin: *
 *     Cache-Control: public, max-age=31536000, immutable
 *     Content-Type: application/octet-stream
 *
 * The first is bucket CORS configuration. The other two are set here on every
 * object as it is written, because a content-addressed object never changes
 * and should be cached as such. `scripts/check-store.mjs` checks a live bucket
 * sends all three.
 *
 * Writes are signed with AWS Signature Version 4. A browser should not hold
 * the secret: it asks a server for a presigned PUT URL (`presignPut`), which is
 * one signed URL good for a few minutes, and PUTs the blob straight to the
 * bucket. No body passes through a function with a size limit.
 */
import { admit, type Sidecar, type Store } from "./store.js";

export interface S3StoreOptions {
  /** e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  /** R2 takes "auto"; S3 takes its region name. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Where the public reads the bucket: a custom domain, or the endpoint itself. */
  publicBase: string;
  /** Path-style (`endpoint/bucket/key`) or virtual-hosted (`bucket.endpoint/key`). R2 is path-style. */
  pathStyle?: boolean;
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(data)));
}

/** RFC 3986 encoding, which is what SigV4 wants and `encodeURIComponent` nearly does. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function stamp(now: Date): { date: string; time: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { date: iso.slice(0, 8), time: iso };
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Signs one request. Written from the SigV4 specification; the canonical
 * request is the part everybody gets wrong, and the way to get it right is to
 * build it in exactly the order the document lists.
 */
async function sign(
  options: S3StoreOptions,
  method: string,
  key: string,
  headers: Record<string, string>,
  payloadHash: string,
  query: Record<string, string> = {},
  now = new Date(),
): Promise<SignedRequest> {
  const endpoint = new URL(options.endpoint);
  const host = options.pathStyle === false ? `${options.bucket}.${endpoint.host}` : endpoint.host;
  const path = (options.pathStyle === false ? "" : `/${options.bucket}`) + "/" + key.split("/").map(rfc3986).join("/");
  const { date, time } = stamp(now);

  const all: Record<string, string> = { ...headers, host, "x-amz-date": time, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[Object.keys(all).find((k) => k.toLowerCase() === n)!]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k]!)}`)
    .join("&");

  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${options.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", time, scope, await sha256(canonicalRequest)].join("\n");

  let signingKey = await hmac(encoder.encode("AWS4" + options.secretAccessKey), date);
  signingKey = await hmac(signingKey, options.region);
  signingKey = await hmac(signingKey, "s3");
  signingKey = await hmac(signingKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${endpoint.protocol}//${host}${path}${canonicalQuery ? "?" + canonicalQuery : ""}`;
  return { url, headers: { ...all, authorization } };
}

/**
 * A URL a browser can PUT to for a few minutes, with no secret in the page.
 *
 * Presigned rather than proxied: a function that relays the body has a body
 * size limit, and a document is allowed to be five megabytes.
 */
export async function presignPut(
  options: S3StoreOptions,
  key: string,
  contentType: string,
  expiresSeconds = 300,
  now = new Date(),
): Promise<string> {
  const endpoint = new URL(options.endpoint);
  const host = options.pathStyle === false ? `${options.bucket}.${endpoint.host}` : endpoint.host;
  const path = (options.pathStyle === false ? "" : `/${options.bucket}`) + "/" + key.split("/").map(rfc3986).join("/");
  const { date, time } = stamp(now);
  const scope = `${date}/${options.region}/s3/aws4_request`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${options.accessKeyId}/${scope}`,
    "X-Amz-Date": time,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "content-type;host",
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k]!)}`)
    .join("&");
  const canonicalRequest = [
    "PUT",
    path,
    canonicalQuery,
    `content-type:${contentType}\nhost:${host}\n`,
    "content-type;host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", time, scope, await sha256(canonicalRequest)].join("\n");

  let signingKey = await hmac(encoder.encode("AWS4" + options.secretAccessKey), date);
  signingKey = await hmac(signingKey, options.region);
  signingKey = await hmac(signingKey, "s3");
  signingKey = await hmac(signingKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));

  return `${endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** The headers every stored object carries. Content-addressed, so immutable is true. */
export const OBJECT_HEADERS = {
  "content-type": "application/octet-stream",
  "cache-control": "public, max-age=31536000, immutable",
} as const;

export function s3Store(options: S3StoreOptions, fetchImpl: typeof fetch = fetch): Store {
  const publicHref = (key: string): string => options.publicBase.replace(/\/$/, "") + "/" + key;

  const putObject = async (key: string, body: Uint8Array, contentType: string): Promise<void> => {
    const signed = await sign(options, "PUT", key, { "content-type": contentType, "cache-control": OBJECT_HEADERS["cache-control"] }, await sha256(body));
    const response = await fetchImpl(signed.url, { method: "PUT", headers: signed.headers, body: body as never });
    if (!response.ok) throw new Error(`The store answered ${response.status} to PUT ${key}.`);
  };

  return {
    async put(hash, ciphertext, sidecar: Sidecar) {
      await admit(hash, ciphertext, sidecar);
      const key = hash.toLowerCase();
      const existing = await this.head(publicHref(key));
      if (!existing.exists) {
        await putObject(key, ciphertext, OBJECT_HEADERS["content-type"]);
        await putObject(key + ".json", new TextEncoder().encode(JSON.stringify(sidecar)), "application/json");
      }
      return publicHref(key);
    },

    async get(href) {
      const response = await fetchImpl(href);
      if (!response.ok) throw new Error(`The store answered ${response.status}.`);
      return new Uint8Array(await response.arrayBuffer());
    },

    async head(href) {
      const response = await fetchImpl(href, { method: "HEAD" });
      if (response.status === 404) return { exists: false, size: 0 };
      if (!response.ok) throw new Error(`The store answered ${response.status}.`);
      return { exists: true, size: Number(response.headers.get("content-length") ?? 0) };
    },
  };
}
