/**
 * A mailbox that is a directory.
 *
 * For tests, and for a machine that is its own relay. One directory per
 * document; one file per appended batch, named by a zero-padded ordinal so a
 * plain sorted listing is the order they arrived. The cursor is that ordinal as
 * a string — how many batches the mailbox held when it was read.
 *
 * The ordinal is allocated by counting what is there and taking the next, which
 * is atomic enough for one process and for the two-party sessions slice one
 * serves. A real relay over a shared object store closes the gap with a
 * conditional write; that belongs to the relay adapter, not to the interface.
 *
 * Node only. Never imported by the opener.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256Hex } from "./core.js";
import type { Mailbox } from "./mailbox.js";

export interface FsMailboxOptions {
  /** Where the mailboxes go, one directory per document. Created if absent. */
  root: string;
}

/**
 * A batch file: a zero-padded ordinal for order, and the blob's own digest for
 * identity. The ordinal is a cursor `since` can compare; the digest is how a
 * re-append of the same bytes is recognised as the batch already here.
 */
const NAME = /^(\d{12})\.([0-9a-f]{64})\.batch$/;

// The digest that names a batch is the store's hash (one-engine): the same
// sha256Hex the container and the store name their bytes by.
const digestOf = (bytes: Uint8Array): Promise<string> => sha256Hex(bytes);

export function fsMailbox(options: FsMailboxOptions): Mailbox {
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true });

  // A document id names a directory; anything that is not a plausible id is
  // refused rather than allowed to escape the root.
  const dirFor = (documentId: string): string => {
    if (!/^[0-9a-zA-Z._-]{1,128}$/.test(documentId)) throw new Error(`Not a document id: ${documentId}`);
    return join(root, documentId);
  };

  const entries = (dir: string): { ordinal: number; digest: string; file: string }[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .map((file) => ({ file, match: NAME.exec(file) }))
          .filter((e): e is { file: string; match: RegExpExecArray } => e.match !== null)
          .map((e) => ({ ordinal: Number(e.match[1]), digest: e.match[2]!, file: e.file }))
          .sort((a, b) => a.ordinal - b.ordinal)
      : [];

  return {
    async append(documentId, sealed) {
      const dir = dirFor(documentId);
      mkdirSync(dir, { recursive: true });
      const digest = await digestOf(sealed);
      const present = entries(dir);
      // Idempotent by digest: a retry sends the identical sealed bytes, and a
      // batch already here is a no-op that returns its *original* cursor — never
      // a new one, or `head` would move for a row the mailbox did not gain and a
      // reader's cursor could skip. This is what lets a caller advance its
      // watermark only after `append` returns and re-send on failure without
      // fear of a duplicate — the same rule the write flush keeps.
      const already = present.find((e) => e.digest === digest);
      if (already) return String(already.ordinal);
      const next = (present.at(-1)?.ordinal ?? 0) + 1;
      writeFileSync(join(dir, `${String(next).padStart(12, "0")}.${digest}.batch`), sealed);
      return String(next);
    },

    async head(documentId) {
      return String(entries(dirFor(documentId)).at(-1)?.ordinal ?? 0);
    },

    async since(documentId, cursor) {
      const dir = dirFor(documentId);
      const from = Number.parseInt(cursor, 10);
      const after = Number.isFinite(from) ? from : 0;
      const present = entries(dir);
      const wanted = present.filter((e) => e.ordinal > after);
      const batches = wanted.map((e) => new Uint8Array(readFileSync(join(dir, e.file))));
      return { cursor: String(present.at(-1)?.ordinal ?? after), batches };
    },
  };
}
