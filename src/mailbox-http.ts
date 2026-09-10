/**
 * A mailbox over HTTP — the client half of the relay (Track 5, slice one).
 *
 * The `Mailbox` interface, spoken to a Durable-Object-backed relay. It runs in
 * the host, never the frame: the frame has `connect-src 'none'` and cannot
 * reach a relay, so the host — which holds the document key and does the
 * sealing — is the one that carries the three calls over the wire.
 *
 * The relay contract, one document at a time, under a base URL:
 *   - `append`: `POST <base>/<doc>` with the sealed bytes as the body; the
 *     response body is the cursor the batch landed at, and a deduplicated
 *     retry returns the *original* cursor (the relay's job, not the client's).
 *   - `head`:   `GET <base>/<doc>/head` → the cursor as text.
 *   - `since`:  `GET <base>/<doc>?since=<cursor>` → a JSON `{ cursor, batches }`
 *     with each batch base64, in order.
 *
 * `fetch` is injected so a test drives it without a network and the opener
 * passes the real one. Nothing here holds a key or reads a batch; the bytes are
 * opaque, exactly as they are to the relay.
 */
import type { Mailbox } from "./mailbox.js";

export interface HttpMailboxOptions {
  /** The relay's base URL, e.g. `https://relay.opendai.app/m`. No trailing slash needed. */
  base: string;
  /** The fetch to use. Injected for tests; the opener passes `window.fetch`. */
  fetch: typeof fetch;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

/** A document id, restricted to what can sit in a path segment without escaping it. */
const segment = (documentId: string): string => {
  if (!/^[0-9a-zA-Z._-]{1,128}$/.test(documentId)) throw new Error(`Not a document id: ${documentId}`);
  return documentId;
};

export function httpMailbox(options: HttpMailboxOptions): Mailbox {
  const base = options.base.replace(/\/$/, "");
  const doFetch = options.fetch;

  return {
    async append(documentId, sealed) {
      const response = await doFetch(`${base}/${segment(documentId)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: sealed as never,
      });
      if (!response.ok) throw new Error(`MAILBOX_APPEND_${response.status}`);
      return (await response.text()).trim();
    },

    async head(documentId) {
      const response = await doFetch(`${base}/${segment(documentId)}/head`);
      if (!response.ok) throw new Error(`MAILBOX_HEAD_${response.status}`);
      return (await response.text()).trim();
    },

    async since(documentId, cursor) {
      const url = `${base}/${segment(documentId)}?since=${encodeURIComponent(cursor)}`;
      const response = await doFetch(url);
      if (!response.ok) throw new Error(`MAILBOX_SINCE_${response.status}`);
      const body = (await response.json()) as { cursor?: unknown; batches?: unknown };
      const batches = Array.isArray(body.batches)
        ? body.batches.filter((b): b is string => typeof b === "string").map(fromBase64)
        : [];
      return { cursor: typeof body.cursor === "string" ? body.cursor : cursor, batches };
    },
  };
}

/** Exposed so the relay and its tests encode batches the same way the client decodes them. */
export const base64 = { encode: toBase64, decode: fromBase64 };
