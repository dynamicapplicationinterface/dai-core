/**
 * The invite carrier: a document filtered to one session (T1-D28, Step 2).
 *
 * The row logic is `filterToSession` in `replicated-rows.ts`. This is the seam
 * between it and the container, and the one function an invite is made by —
 * the opener's share sheet calls it (`apps/runner/src/invite.ts`), so an
 * invite is made by the same tested code on every host that makes one. It
 * keeps the property the whole scheme rests on: **an invite is the sender's
 * document with only its database changed.**
 *
 * The application's files travel byte for byte, and the manifest is resealed
 * around the same publisher signature — the database is outside the signed set
 * — so the recipient's sibling test recognises the invite as the same document
 * and merges the added game rather than treating it as a new document from a
 * stranger. Re-signing here would break that for every recipient.
 *
 * It works on the container as a host holds it once opened, which is the form
 * an invite leaves in: a link carries the document as a page. It was first
 * written against the sectioned binary, filtering the data section in place,
 * and nothing ever called it that way (backlog D9) — the opener filtered and
 * resealed on its own instead, so the invite a person sent was made by code
 * this module's tests did not reach.
 *
 * The database is opened, filtered and re-serialised by an injected engine, for
 * the same reason the write rules inject one: the opener has SQLite compiled to
 * wasm, the tests have `node:sqlite`, and neither belongs in an isomorphic
 * module.
 */
import { resealContainer, type ParsedContainer } from "./container.js";
import { filterToSession, type Rows } from "./replicated-rows.js";

/**
 * A scratch database an invite is filtered in. Loaded from the sender's
 * database, mutated by `filterToSession`, and dumped back to bytes — never the
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
 * Produces an invite: the sender's document, resealed around its database
 * filtered to one session, and nothing else moved.
 *
 * Throws `SESSION_EXPORT_INCOMPLETE` (from `filterToSession`) when the source is
 * malformed — a session whose rows are not closed under their parents — rather
 * than shipping an invite with a parent that never arrives. The result is not
 * re-verified here; a host re-verifies what it is about to hand on, as it does
 * any resealed document.
 */
export async function exportSession(
  container: ParsedContainer,
  database: Uint8Array,
  session: Uint8Array,
  engine: ScratchEngine,
): Promise<ParsedContainer> {
  try {
    const db = engine.open(database);
    // The table set is derived from the database, not passed in, so a caller
    // cannot hand a list that omits the roster tables (T1-D28/D29).
    filterToSession(db, session);
    return await resealContainer(container, engine.serialize());
  } finally {
    engine.close();
  }
}
