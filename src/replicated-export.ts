/**
 * The invite carrier: a container filtered to one session (T1-D28, Step 2).
 *
 * This is the host's half. The row logic is `filterToSession` in
 * `replicated-rows.ts`; the container surgery is `replaceData` in `format.ts`.
 * This module is the seam between them, and it keeps the one property the whole
 * scheme rests on: **the invite differs from the sender's copy in exactly one
 * section and the footer.**
 *
 * `replaceData` copies the manifest and payload sections through byte-identical
 * and rewrites only the DATA section and the footer (its generation counter and
 * data digest). The manifest — and therefore the publisher's signature over it —
 * is untouched, so the invite is not re-signed: it carries the same signature
 * over the same application as the sender's copy, which is what makes the
 * recipient's sibling test recognise it and merge the added game rather than
 * treat it as a new document from a stranger. Re-signing here would break that
 * for every recipient.
 *
 * The database bytes are opened, filtered and re-serialised by an injected
 * engine, for the same reason the write rules inject one: the runtime has SQLite
 * compiled to wasm, the tests have `node:sqlite`, and neither belongs in an
 * isomorphic module.
 */
import { readContainerFile, replaceData, sectionBytes, SECTION, FormatError } from "./format.js";
import { filterToSession, type Rows } from "./replicated-rows.js";

/**
 * A scratch database an invite is filtered in. Loaded from the sender's DATA
 * section, mutated by `filterToSession`, and dumped back to bytes — never the
 * sender's live copy, which is append-only and holds their other games.
 */
export interface ScratchEngine {
  /** Load a database from bytes into a mutable scratch and expose it as `Rows`. */
  open(data: Uint8Array): Rows;
  /** The current scratch, serialised back to SQLite file bytes. */
  serialize(): Uint8Array;
  /** Release the scratch. Always called, even when the export refuses. */
  close(): void;
}

/**
 * Produces an invite: the sender's container with its database filtered to one
 * session, and nothing else moved.
 *
 * Throws `SESSION_EXPORT_INCOMPLETE` (from `filterToSession`) when the source is
 * malformed — a session whose rows are not closed under their parents — rather
 * than shipping an invite with a parent that never arrives.
 */
export async function exportSession(
  containerBytes: Uint8Array,
  tables: readonly string[],
  session: Uint8Array,
  engine: ScratchEngine,
): Promise<Uint8Array> {
  const file = readContainerFile(containerBytes);
  const data = sectionBytes(containerBytes, file, SECTION.DATA);
  if (!data) {
    throw new FormatError("The container has no database section, so there is nothing to filter.");
  }

  try {
    const db = engine.open(data);
    filterToSession(db, tables, session);
    const filtered = engine.serialize();
    // replaceData rewrites the DATA section and the footer, and copies the
    // manifest and payload through untouched — the one-section-plus-footer
    // property this scheme depends on.
    return await replaceData(containerBytes, filtered);
  } finally {
    engine.close();
  }
}
