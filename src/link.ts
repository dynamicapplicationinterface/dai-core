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
 * Compressed with gzip because that is what a browser can undo without
 * shipping a decompressor — `DecompressionStream` speaks gzip and deflate and
 * not brotli, and a link that needed a library to open would need the library
 * to arrive first.
 */

import { fromBase64, toBase64 } from "./core.js";

/**
 * Where the sender stops.
 *
 * There is no single URL limit to point at. Browsers take far more than this;
 * what truncates a long link is everything in between — chat clients that
 * linkify up to a length, mail that wraps, a QR code, somebody pasting into a
 * message box. A link that is silently cut in transit arrives as a document
 * that will not open and nothing to say why, which is worse than a sender who
 * was told plainly that this one is too big to put in a link.
 *
 * Measured against the encoded fragment, not the whole URL: the opener's own
 * address is short and known, and the number is a rough safety line rather
 * than a boundary anything depends on.
 */
export const INLINE_CAP = 32 * 1024;

/** The fragment key. `#a=` for the application itself, carried in the link. */
export const INLINE_KEY = "a";

/*
 * base64url over the core's own base64, not `btoa`.
 *
 * The core implements base64 itself so it carries no environmental
 * assumptions — `btoa` is absent from some runtimes and throws on bytes above
 * 0xFF. A second implementation here would be a second place for that to be
 * wrong, so this is the URL alphabet applied to the one that exists.
 */
function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  // The core's decoder ignores padding and anything outside the alphabet, so
  // only the two substituted characters have to be put back.
  return fromBase64(value.replace(/-/g, "+").replace(/_/g, "/"));
}

/**
 * Runs bytes through a compression stream.
 *
 * Streams rather than a library because they are what a browser already has.
 * The whole document is in memory either way; this is not about streaming, it
 * is about not shipping a compressor to open a link.
 */
async function through(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  /*
   * Cast through a local shape because this package compiles without the DOM
   * library — deliberately, so the core makes no assumption about where it
   * runs. `Response` and the compression streams are present in every runtime
   * this ships to (browsers, Node 18 and up, Deno, workers); what is absent
   * is the type declaration, and pulling in all of `lib.dom` for three names
   * would change what the whole package believes about its environment.
   */
  const body = (new Response(bytes as never) as { body: unknown }).body as {
    pipeThrough: (stream: unknown) => unknown;
  };
  const out = body.pipeThrough(stream);
  return new Uint8Array(await new Response(out as never).arrayBuffer());
}

/**
 * The fragment value for a document.
 *
 * Takes the container as it stands. Thinning it first is the caller's
 * decision, because it is a decision: a thin document needs a host that holds
 * an engine, and whether the recipient will have one is something the sender
 * knows and this function does not.
 */
export async function encodeInline(html: string): Promise<string> {
  const bytes = new TextEncoder().encode(html);
  return toBase64Url(await through(bytes, new CompressionStream("gzip")));
}

/** The document a fragment value carries. */
export async function decodeInline(value: string): Promise<string> {
  const bytes = await through(fromBase64Url(value), new DecompressionStream("gzip"));
  return new TextDecoder().decode(bytes);
}

/**
 * The whole link, or nothing.
 *
 * Returns `undefined` rather than a link that is too long, so a caller has to
 * decide what to do instead and cannot accidentally hand somebody a truncated
 * document. What to do instead is a reference link, which is item 2.3.
 */
export async function inlineLink(html: string, opener: string): Promise<string | undefined> {
  const value = await encodeInline(html);
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
