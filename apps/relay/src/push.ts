/**
 * Push, as the relay sends it (Track 5, slice two).
 *
 * A push here carries nothing. It is the Web Push protocol with an empty body:
 * the relay tells a push service "wake this subscription", and the service
 * worker it wakes asks the relay's own `head` what moved. So there is no
 * payload to encrypt, and nothing about a move — not its size, not which
 * mailbox it was in — reaches the push service beyond the fact that one of
 * this subscription's mailboxes moved.
 *
 * What the relay does need is to prove to the push service that it is the
 * sender the subscription was made for: VAPID (RFC 8292), an ES256 JWT signed
 * with a key whose public half the opener handed to `pushManager.subscribe`.
 * WebCrypto signs ECDSA as the raw `r || s` pair, which is exactly the JWS
 * encoding, so no DER conversion is needed.
 *
 * Plain WebCrypto and `fetch`, so the Worker and a Node test run the same code.
 */

export interface Vapid {
  /** The public key, raw uncompressed P-256 (65 bytes), base64url — the opener's `applicationServerKey`. */
  publicKey: string;
  /** The private key, as a JWK. A Worker secret in production. */
  privateKey: JsonWebKey;
  /** Who a push service contacts about this sender: a `mailto:` or `https:` URL. */
  subject: string;
}

const encoder = new TextEncoder();

export const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** How long a VAPID token is good for. RFC 8292 caps it at 24 hours. */
const TOKEN_SECONDS = 12 * 60 * 60;

/**
 * The `Topic` every push carries: the same constant for every mailbox.
 *
 * A topic collapses the pushes a push service is still holding for one
 * subscription, and collapsing is per subscription already, so a constant
 * collapses a burst of moves exactly as well as a per-mailbox value would.
 * A per-mailbox value would not be neutral: both players' subscriptions to one
 * game would carry the same topic, and the push service — Google's, Apple's,
 * Mozilla's — could see that two devices are in the same game. That is the
 * linkage one mailbox per session exists to deny, undone at the last hop.
 */
export const PUSH_TOPIC = "dai";

/** The `Authorization` header for one push to `endpoint`. */
export async function vapidAuthorization(endpoint: string, vapid: Vapid, now = Date.now()): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(
    encoder.encode(
      JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + TOKEN_SECONDS, sub: vapid.subject }),
    ),
  );
  const key = await crypto.subtle.importKey("jwk", vapid.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${base64url(new Uint8Array(signature))}, k=${vapid.publicKey}`;
}

/**
 * Wakes one subscription. `gone` means the push service no longer knows it —
 * the person revoked permission or the browser dropped it — and the relay
 * should forget it; anything else is kept and tried again on the next move.
 */
export async function sendPush(
  endpoint: string,
  vapid: Vapid,
  doFetch: typeof fetch = fetch,
): Promise<"sent" | "gone" | "failed"> {
  try {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidAuthorization(endpoint, vapid),
        // Kept a day if the device is off; a move older than that is picked up
        // on the next open anyway.
        ttl: "86400",
        urgency: "high",
        topic: PUSH_TOPIC,
      },
    });
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/** A subscription's name at the relay: the SHA-256 of its endpoint, hex. */
export async function endpointId(endpoint: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(endpoint));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The push services a browser actually hands out endpoints on.
 *
 * Chrome, and Edge on Android, use Firebase Cloud Messaging; Firefox, Mozilla's
 * autopush; Safari, Apple's web push service; Edge on Windows, the Windows
 * notification service. Exact hosts where the host is fixed, a suffix where a
 * service spreads over regional hosts.
 */
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com"]);
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com"];

/**
 * An endpoint the relay will send to: HTTPS on a real push service's host.
 *
 * Without this the relay would POST to any HTTPS URL anyone subscribed, which
 * is a spam amplifier: register many arbitrary URLs against a mailbox, append
 * once, and the relay sends to all of them. The allowlist bounds where it can
 * send; the per-mailbox cap in the Durable Object bounds how many.
 *
 * `allowLoopback` admits plain HTTP to localhost, for a test that stands a push
 * service up locally. It is off unless the relay's environment turns it on
 * (`PUSH_ALLOW_LOOPBACK`), which a deploy never does.
 */
export function acceptableEndpoint(endpoint: unknown, allowLoopback = false): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:" && !url.port) {
    const host = url.hostname.toLowerCase();
    return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  }
  return allowLoopback && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}
