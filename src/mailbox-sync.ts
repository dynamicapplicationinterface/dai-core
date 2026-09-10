/**
 * The two moves a host makes over a mailbox, in one place (Track 5, slice one).
 *
 * The frame authors rows and merges them; the host carries them, because the
 * frame cannot reach the network. What the host does is small and has two rules
 * it must not get wrong, so they live here rather than hand-rolled in the
 * runner: publish re-sends the *same* sealed bytes until the relay accepts them
 * (never re-sealing, which would change the IV and defeat the relay's dedup),
 * and catch-up advances its cursor over what it delivered and drops — rather
 * than stalls on — a batch that will not open.
 *
 * This module carries no key and no engine: sealing is the caller's (it holds
 * the document key), and staging-and-merging a delivered batch is the frame's.
 * It is the orchestration between them, and it is where the durability rule is
 * kept so a host cannot advance a watermark on a send that never landed.
 */
import type { Mailbox } from "./mailbox.js";

/**
 * Appends already-sealed bytes, retrying the identical bytes until the relay
 * accepts them, and answers with the cursor the batch landed at.
 *
 * Seal once, then call this: the bytes handed in are re-sent unchanged, so a
 * retry over a batch that secretly landed is the relay's no-op and a batch that
 * never landed is re-sent whole. The caller advances its watermark — its record
 * of what it has sent — only after this resolves; on exhaustion it throws and
 * the watermark stays put, so the rows are offered again on the next occasion
 * rather than lost. Retry cadence beyond the attempt count is the host's to
 * decide (a backoff, the next foreground); this only guarantees the bytes do
 * not change between attempts.
 */
export async function publishSealed(
  mailbox: Mailbox,
  documentId: string,
  sealed: Uint8Array,
  attempts = 4,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      return await mailbox.append(documentId, sealed);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("MAILBOX_APPEND_FAILED");
}

/**
 * Reads everything after `cursor`, opens each batch, hands the plaintext to
 * `deliver`, and answers with the cursor that now names the end.
 *
 * `open` decrypts (the caller holds the key); `deliver` stages and merges (the
 * frame does). A batch that will not open is dropped and the reader moves on:
 * a sealed batch fails to open only if it was tampered with or sent under the
 * wrong key, and neither is recoverable by re-reading it, so stalling the whole
 * mailbox behind one bad blob would be a poison pill. The good batches around
 * it are delivered and the cursor advances past all of them; delivering a batch
 * twice is a no-op at the merge, so an over-broad cursor costs nothing while a
 * stalled one costs the game.
 */
export async function catchUp(
  mailbox: Mailbox,
  documentId: string,
  cursor: string,
  open: (sealed: Uint8Array) => Promise<Uint8Array>,
  deliver: (plaintext: Uint8Array) => Promise<void>,
): Promise<string> {
  const { cursor: next, batches } = await mailbox.since(documentId, cursor);
  for (const sealed of batches) {
    let plaintext: Uint8Array;
    try {
      plaintext = await open(sealed);
    } catch {
      // Tampered or wrong-keyed: it will never open, so drop it and keep going
      // rather than stall every batch behind it.
      continue;
    }
    await deliver(plaintext);
  }
  return next;
}
