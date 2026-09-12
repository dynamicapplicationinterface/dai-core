/**
 * A mailbox: append-only bytes per document, held by a relay that cannot read
 * them (Track 5, slice one).
 *
 * A file carries the whole database from one copy to another. A mailbox carries
 * the same thing in pieces — an append per write — so a game plays itself
 * between two devices with no file passed by hand. The relay sees a document
 * id and a growing list of opaque blobs; it never holds the key, so a request
 * is a log line and never content, the same promise `no-beacon` and the
 * reference store already keep.
 *
 * Three calls, and no more (the scope is fixed in docs/replicated-tables.md
 * §"Track 5 moves up"). `append` adds a batch; `head` names where the mailbox
 * is now; `since` returns everything after a cursor. What a batch *is* — a set
 * of replicated rows — is the frame's business, not the relay's: the frame
 * serializes what it wrote and applies what it pulls, through the same
 * `applyRow` a file merge uses, so T1-D13 governs a bad row here exactly as it
 * does in a file. Everything at this layer is opaque bytes.
 *
 * Retention, entitlement (who may append or subscribe), and multi-party
 * fan-out are deliberately absent. They are dials on a working mechanism, and
 * the mechanism ships first.
 */

/** The relay, as three calls over opaque bytes. */
export interface Mailbox {
  /**
   * Add a sealed batch to the document's mailbox, and answer with the cursor it
   * landed at — the position a reader who has this batch has read up to.
   * Ordering is the mailbox's to assign; the caller does not choose where a
   * batch lands.
   *
   * **Idempotent by the digest of `sealed`.** A second append of the identical
   * bytes is a no-op. This is what makes the durability rule safe: a publisher
   * advances its watermark — its only record of what it has sent — *only after
   * this resolves*, and on a failure re-sends the identical sealed bytes. If it
   * advanced on send and the batch never arrived, those rows would never be
   * sent again and no reader could recover them: the silent-loss shape the
   * write flush already guards against. Seal once and retry the same bytes; the
   * IV is inside the seal, so re-sealing would defeat the dedup.
   *
   * **A deduplicated retry returns the *original* cursor, and never allocates a
   * new one.** The retry is the same batch, so it must occupy the same position
   * — `head` does not move, and a reader's cursor cannot skip. The digest is a
   * store fact, not a happens-before: a mailbox over a shared counter has to
   * check the digest→cursor index *before* it increments, or a retried batch
   * that secretly landed becomes a second entry and the mailbox counts a row it
   * did not gain. The directory adapter gets this for free because the cursor
   * is written into the batch's own name; a counter-backed relay must earn it.
   */
  append(documentId: string, sealed: Uint8Array): Promise<string>;

  /**
   * Where the mailbox is now, as an opaque cursor. Two `head` calls with no
   * `append` between them return equal cursors; a caller holding the last
   * cursor it saw can tell whether there is anything new without reading it.
   */
  head(documentId: string): Promise<string>;

  /**
   * Everything appended after `cursor`, and the cursor that now names the end.
   * Passing the returned cursor to the next `since` reads only what arrived in
   * between; passing an empty string reads the whole mailbox.
   */
  since(documentId: string, cursor: string): Promise<{ cursor: string; batches: Uint8Array[] }>;
}

const IV_BYTES = 12;

/**
 * Seals a batch under the document's key.
 *
 * The same AES-GCM the reference store uses (`src/store.ts`): a fresh 12-byte
 * IV prepended to the ciphertext, under the 32-byte key that already travels in
 * a document's link fragment and never reaches a server. The relay stores the
 * result and can read none of it; a batch that was tampered with fails the GCM
 * tag on open and is dropped before a row of it is ever applied.
 */
export async function sealBatch(plaintext: Uint8Array, rawKey: Uint8Array): Promise<Uint8Array> {
  if (rawKey.byteLength !== 32) throw new Error("MAILBOX_KEY_INVALID");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await crypto.subtle.importKey("raw", rawKey as unknown as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext as unknown as ArrayBuffer),
  );
  const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, iv.byteLength);
  return out;
}

/**
 * Opens a sealed batch, or throws.
 *
 * Throws rather than returns null: a batch that will not open is not an empty
 * batch, and a caller that treated it as one would advance its cursor past a
 * row it never saw. The caller drops the one batch and keeps its cursor where
 * it was, so the batch is re-offered rather than silently lost.
 */
export async function openBatch(sealed: Uint8Array, rawKey: Uint8Array): Promise<Uint8Array> {
  if (rawKey.byteLength !== 32) throw new Error("MAILBOX_KEY_INVALID");
  if (sealed.byteLength <= IV_BYTES) throw new Error("MAILBOX_BATCH_TRUNCATED");
  const key = await crypto.subtle.importKey("raw", rawKey as unknown as ArrayBuffer, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const iv = sealed.subarray(0, IV_BYTES);
  const body = sealed.subarray(IV_BYTES);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body as unknown as ArrayBuffer),
  );
}

/* ----------------------------------------------------- a mailbox per session */

const KEY_LABEL = "dai:mailbox:key:";
const ID_LABEL = "dai:mailbox:id:";

/** HKDF-SHA-256 from a root key under one info string, `bytes` bytes out. */
async function hkdf(root: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const hk = await crypto.subtle.importKey("raw", root as unknown as ArrayBuffer, "HKDF", false, [
    "deriveBits",
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: info as unknown as ArrayBuffer },
    hk,
    bytes * 8,
  );
  return new Uint8Array(derived);
}

const withLabel = (label: string, sessionId: Uint8Array): Uint8Array => {
  const prefix = new TextEncoder().encode(label);
  const info = new Uint8Array(prefix.length + sessionId.length);
  info.set(prefix);
  info.set(sessionId, prefix.length);
  return info;
};

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A session's mailbox key and id, both derived from the document root key and
 * the session id (T1-D30).
 *
 * Two HKDF outputs under two labels, and the split is the whole point:
 *
 * - The **key** is `HKDF(root, "…key:" ‖ sessionId)`. A party holding the root
 *   but not the session id cannot derive it, so the document key alone opens no
 *   session's mailbox — the session id, which travels in the invite, is the
 *   capability.
 * - The **id** is `HKDF(root, "…id:" ‖ sessionId)`, returned as hex for a relay
 *   path segment. Because it needs the root, it is not derivable from the session
 *   id alone: a relay serving many documents sees an opaque, unlinkable name per
 *   session and cannot tell that two documents share one, or that one document
 *   holds many. If the id were the session id, the relay would hold the social
 *   graph the format exists not to leak.
 *
 * Both parties derive the same pair from the same inputs with no round trip —
 * HKDF is a function — which is the convergence the session mailbox rests on.
 * The relay is unchanged: this is a different opaque id under the same three
 * calls, never a new capability the relay must understand.
 */
export async function deriveSessionMailbox(
  rootKey: Uint8Array,
  sessionId: Uint8Array,
): Promise<{ key: Uint8Array; id: string }> {
  if (rootKey.byteLength !== 32) throw new Error("MAILBOX_KEY_INVALID");
  const key = await hkdf(rootKey, withLabel(KEY_LABEL, sessionId), 32);
  const id = await hkdf(rootKey, withLabel(ID_LABEL, sessionId), 32);
  return { key, id: toHex(id) };
}
