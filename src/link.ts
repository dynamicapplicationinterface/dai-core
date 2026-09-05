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
import { packInline, unpackInline, type Host } from "./inline.js";

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
export async function decodeInline(value: string, host: Host, supply?: Supplier): Promise<string> {
  return unpackInline(value, host, { supply });
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
): Promise<string | undefined> {
  const value = await encodeInline(html, host);
  if (value.length > INLINE_CAP) return undefined;
  return `${opener.replace(/[#?].*$/, "").replace(/\/$/, "")}/#${INLINE_KEY}=${value}`;
}

/**
 * The fragment value in an address, if it carries a document.
 *
 * Read from a string rather than from `location` so this is testable and so a
 * native host, which has an address but no `location`, uses the same reader.
 */
export function inlineFrom(hash: string): string | undefined {
  const value = /^#?a=([A-Za-z0-9\-_]+)$/.exec(hash)?.[1];
  return value && value.length > 0 ? value : undefined;
}
