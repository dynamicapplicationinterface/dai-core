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
import type { Mailbox } from "./mailbox.js";

export interface FsMailboxOptions {
  /** Where the mailboxes go, one directory per document. Created if absent. */
  root: string;
}

/** A batch file name: a zero-padded ordinal, so a sorted listing is arrival order. */
const NAME = /^(\d{12})\.batch$/;

export function fsMailbox(options: FsMailboxOptions): Mailbox {
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true });

  // A document id names a directory; anything that is not a plausible id is
  // refused rather than allowed to escape the root.
  const dirFor = (documentId: string): string => {
    if (!/^[0-9a-zA-Z._-]{1,128}$/.test(documentId)) throw new Error(`Not a document id: ${documentId}`);
    return join(root, documentId);
  };

  const ordinals = (dir: string): number[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .map((name) => NAME.exec(name))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => Number(match[1]))
          .sort((a, b) => a - b)
      : [];

  return {
    async append(documentId, sealed) {
      const dir = dirFor(documentId);
      mkdirSync(dir, { recursive: true });
      const next = (ordinals(dir).at(-1) ?? 0) + 1;
      writeFileSync(join(dir, `${String(next).padStart(12, "0")}.batch`), sealed);
    },

    async head(documentId) {
      return String(ordinals(dirFor(documentId)).at(-1) ?? 0);
    },

    async since(documentId, cursor) {
      const dir = dirFor(documentId);
      const from = Number.parseInt(cursor, 10);
      const after = Number.isFinite(from) ? from : 0;
      const present = ordinals(dir);
      const wanted = present.filter((ordinal) => ordinal > after);
      const batches = wanted.map(
        (ordinal) => new Uint8Array(readFileSync(join(dir, `${String(ordinal).padStart(12, "0")}.batch`))),
      );
      return { cursor: String(present.at(-1) ?? after), batches };
    },
  };
}
