/**
 * A document carried in the address bar.
 *
 * On a phone the only pre-installed executor is the browser, and a browser
 * executes URLs, not files. A tapped attachment is a static preview at best.
 * So the file stays canonical and the link is how a document is met on first
 * contact — and the smallest link is one that carries the whole document, so
 * there is no host to be down, no store to trust, and nothing to expire.
 *
 * Everything lives in the fragment, after the `#`. A fragment is never sent to
 * a server: not to the opener's origin, not to a proxy, not into an access
 * log. The document is therefore in the link and nowhere else, which is the
 * property that makes this worth building rather than a small store.
 *
 * This file is the grammar — where the value sits, how long it may be, how it
 * is found in an address. What the value contains is `inline.ts`: the compact
 * carrier that sends what is the document's and rebuilds what is the host's.
 */
import { parseContainer, type Supplier } from "./container.js";
import { packInline, unpackInline, type Host, type PastHost } from "./inline.js";

export type { Host } from "./inline.js";

/**
 * Where the sender stops.
 *
 * There is no single URL limit to point at. Browsers take far more than this;
 * what truncates a long link is everything in between — Slack at 40,000
 * characters, WhatsApp at 65,536, Safari near 80,000, mail that wraps, a QR
 * code. A link silently cut in transit arrives as a document that will not
 * open and nothing to say why, which is worse than a sender who was told
 * plainly that this one is too big to put in a link.
 *
 * Measured against the encoded fragment, not the whole URL: the opener's own
 * address is short and known.
 */
export const INLINE_CAP = 32 * 1024;

/**
 * The cap for an address nothing linkifies: a home-screen icon's launch
 * address, read by the operating system out of a manifest and never pasted
 * into a chat. What limits it is the browser's own URL handling, which on
 * every current engine is measured in megabytes. A phone test settled that
 * the fragment survives Add to Home Screen; this is the size at which an
 * icon still carries its document rather than asking for the file.
 */
export const LAUNCH_CAP = 1024 * 1024;

/** The fragment key. `#a=` for the application itself, carried in the link. */
export const INLINE_KEY = "a";

/**
 * The fragment value for a document.
 *
 * The host is the sender's: what it can rebuild is what it may leave out, and
 * a link is never built that the same software could not open.
 */
export async function encodeInline(html: string, host: Host): Promise<string> {
  return packInline(parseContainer(html), host);
}

/**
 * The document a fragment value carries, as a complete container.
 *
 * Verify what comes back exactly as a file: this rebuilds bytes and proves the
 * rebuilt ones match the sealed digests, and decides nothing else.
 */
export async function decodeInline(
  value: string,
  host: Host,
  supply?: Supplier,
  pastHosts?: () => Promise<PastHost[]>,
): Promise<string> {
  return unpackInline(value, host, { supply, pastHosts });
}

/**
 * The whole link, or nothing.
 *
 * Returns `undefined` rather than a link that is too long, so a caller has to
 * decide what to do instead and cannot accidentally hand somebody a truncated
 * document. What to do instead is a reference link, which is item 2.3.
 */
export async function inlineLink(
  html: string,
  opener: string,
  host: Host,
  cap: number = INLINE_CAP,
  /** The path the link points at: the opener's root, or `/p/<id>` when a card was stored for it. */
  path = "/",
): Promise<string | undefined> {
  const value = await encodeInline(html, host);
  if (value.length > cap) return undefined;
  return `${opener.replace(/[#?].*$/, "").replace(/\/$/, "")}${path}#${INLINE_KEY}=${value}`;
}

/**
 * The fragment value in an address, if it carries a document.
 *
 * Read from a string rather than from `location` so this is testable and so a
 * native host, which has an address but no `location`, uses the same reader.
 */
export function inlineFrom(hash: string): string | undefined {
  // Read as fields rather than as the whole fragment, because a link may now
  // carry a `u=` hint beside the document (R7). The value itself is still held
  // to its alphabet: a fragment that is not exactly this is not a document,
  // and guessing at a damaged one is how a reader opens something it should
  // have refused.
  const value = fragmentFields(hash).get("a");
  return value && /^[A-Za-z0-9\-_]+$/.test(value) ? value : undefined;
}

/** The fragment's `key=value` fields. Never decoded as a document; see `inlineFrom`. */
function fragmentFields(hash: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of hash.replace(/^#/, "").split("&")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    fields.set(part.slice(0, at), part.slice(at + 1));
  }
  return fields;
}

/** The fragment key for the hint: which document this address is probably for. */
export const HINT_KEY = "u";

/**
 * The document a launch address is probably for (R7).
 *
 * A hint and nothing else. It says which library entry to try, so that "do I
 * already have this?" can be answered without decompressing a payload or
 * asking a store — which for a home-screen icon meant a network round trip to
 * open a document sitting in local storage. What is actually opened decides
 * its own identity: the mounted document's manifest UUID is authoritative, and
 * a fragment naming a different one is a first sighting, not a reason to reuse
 * anybody's data.
 *
 * It lives in the fragment because a fragment is never sent to a server. The
 * predecessor, `?doc=<uuid>`, was a query parameter, which means every launch
 * from every home-screen icon put that document's UUID in the opener's request
 * log — the one address in this design that reached a server at all. It is
 * still read here, for icons already on people's phones, and callers move the
 * address to this form on arrival so it is gone from the tab and the history.
 */
export function hintedUuid(hash: string, search = ""): string | undefined {
  const shaped = (value: string | undefined | null): string | undefined =>
    value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value.toLowerCase()
      : undefined;
  return shaped(fragmentFields(hash).get(HINT_KEY)) ?? shaped(new URLSearchParams(search).get("doc"));
}

/** Whether an address carries the retired query form, and so should be rewritten. */
export function hasLegacyHint(search: string): boolean {
  return new URLSearchParams(search).has("doc");
}
