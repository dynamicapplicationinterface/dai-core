import { sha256Hex } from "./core.js";

/**
 * Which copy of a non-replicated document opens, when a copy of one this device
 * already holds arrives (backlog D36).
 *
 * A document without replicated tables cannot merge, so when a copy of it comes
 * back, one whole database mounts and the other does not. That used to be
 * decided by `savedAt` alone: later wins. But `savedAt` is a wall clock standing
 * in for causality, and every save moves it, including a save that changed
 * nothing a person did. A copy that had seen nothing could therefore outrank a
 * real move made elsewhere, and the move was dropped without a word.
 *
 * Two facts that had been one field are kept apart:
 *
 *   - `savedAt`: when this copy last wrote.
 *   - `matchedAt` / `matchedDigest`: the last point this copy is known to have
 *     matched another. That is the copy it last took in, or the copy it last
 *     sent out with its data, whichever was later, by that copy's stamp and the
 *     digest of its database.
 *
 * And a third: `history`, the digests of the databases this copy has held here,
 * so that a link it sent earlier can be recognized when it comes back.
 *
 * The decision reads what each copy has seen, not whose clock ran last:
 *
 *   - The arriving database is this copy's own, now or in the past: keep.
 *   - The arriving copy is stamped at or before the last match: keep. It is
 *     behind what was matched.
 *   - Nothing written here since the last match: take. The arriving copy is
 *     simply further along.
 *   - Written here since the last match, and the arriving copy is neither this
 *     copy's past nor behind the match: the two copies diverged. Neither has
 *     seen the other. There is no correct order to find, so nothing is picked,
 *     and the person is told.
 *
 * What this cannot see, stated. The arriving copy carries only a stamp and a
 * database, not where it came from, so "further along" means "later than the
 * last match", not "descended from it". A copy sent out and then answered by
 * someone who never opened it, starting instead from an older copy, still
 * reads as further along and is taken. That is the old behavior, not a new loss.
 * Making it exact needs the arriving copy to carry its own lineage, which is a
 * format change. A cleverer clock would only move where the silent pick happens.
 *
 * Documents with replicated tables never come here: they merge.
 */

/** What this device knows about the copy it holds. */
export interface HeldCopy {
  /** When this copy last wrote. */
  savedAt?: string;
  /** The stamp of the last copy this one matched: taken in, or sent out. */
  matchedAt?: string;
  /** That copy's database digest. */
  matchedDigest?: string;
  /** Digests of every database this copy has held here, oldest first. */
  history?: readonly string[];
}

export interface Arriving {
  /** The arriving copy's `savedAt`. */
  savedAt?: string;
  /** Its database digest. */
  digest: string;
}

export type CopyChoice =
  /** The arriving copy is further along than this one: it opens. */
  | { kind: "take" }
  /** The arriving copy is this one, or behind it: this device's copy opens. `older` when it is behind, which is said. */
  | { kind: "keep"; older: boolean }
  /** Both changed since they last matched: neither opens over the other. */
  | { kind: "diverged" };

/** How many past databases a copy remembers. Past this, an old own link reads as diverged: refused, never lost. */
export const HISTORY_LIMIT = 64;

/** The match recorded for a copy that arrived with no database at all: a document as built, before it first opened. */
export const BLANK_DIGEST = "blank";

/**
 * What a save does to a copy's record. It always joins the history. And a save
 * the runtime reports as setup only (the document's own schema and seed rows,
 * nothing else written since it opened) is part of the match, not a change since
 * it, as long as nothing else has been written since the match either. Every
 * copy of the document runs that same SQL on first open, so it is not something
 * one copy did that another has not seen.
 *
 * Without this, opening a document is itself a change: D36 exactly.
 */
export function afterSave(held: HeldCopy, digest: string, setup: boolean): Pick<HeldCopy, "matchedDigest" | "history"> {
  const history = remember(held.history, digest);
  const lastSaved = held.history?.[held.history.length - 1];
  // A blank match counts only while nothing has been saved at all: once a save
  // has landed on top of it, that save is what the copy holds.
  const nothingSinceMatch =
    held.matchedDigest !== undefined &&
    (held.matchedDigest === BLANK_DIGEST ? lastSaved === undefined : lastSaved === held.matchedDigest);
  return { matchedDigest: setup && nothingSinceMatch ? digest : held.matchedDigest, history };
}

/** Appends a digest, without repeating the last entry, keeping the newest HISTORY_LIMIT. */
export function remember(history: readonly string[] | undefined, digest: string): string[] {
  const next = [...(history ?? [])];
  if (next[next.length - 1] !== digest) next.push(digest);
  return next.slice(-HISTORY_LIMIT);
}

/**
 * Decides which copy opens. `localDigest` is the database this device holds
 * now, read from storage.
 */
export function chooseCopy(held: HeldCopy, localDigest: string, arriving: Arriving): CopyChoice {
  if (arriving.digest === localDigest) return { kind: "keep", older: false };

  // A record from before this existed has no match to reason from. The old
  // rule decides it, as it decided every copy held today; the first open under
  // this code records a match, and every decision after that is this one.
  if (held.matchedDigest === undefined) {
    const known = arriving.savedAt !== undefined && held.savedAt !== undefined;
    if (known && arriving.savedAt! > held.savedAt!) return { kind: "take" };
    return { kind: "keep", older: known && arriving.savedAt! < held.savedAt! };
  }

  if (arriving.digest === held.matchedDigest || (held.history ?? []).includes(arriving.digest)) {
    return { kind: "keep", older: true };
  }

  if (arriving.savedAt !== undefined && held.matchedAt !== undefined && arriving.savedAt <= held.matchedAt) {
    return { kind: "keep", older: true };
  }

  if (localDigest === held.matchedDigest) return { kind: "take" };

  return { kind: "diverged" };
}

/** A database's digest, as hex, by the one engine every hash in this repository goes through. */
export function databaseDigest(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

/**
 * Which build of an application a container is: its signature.
 *
 * Not part of choosing between copies — nothing below reads it — but the fact
 * that decides whether a copy is a copy of *this* document at all, which is a
 * question the data cannot answer (D85). The signature covers the author's
 * files and not the database (§9.2), so it is identical for every copy of one
 * build, however that copy travelled and whatever has been written into it,
 * and different for every rebuild.
 *
 * **Undefined for an unsigned container, and that is an answer.** An unsigned
 * document cannot say which build it is — anyone can produce one that looks
 * like any other — so a build read off it would be a guess, and the caller
 * refuses nothing on a guess.
 *
 * Two earlier attempts are recorded because both looked right and neither was:
 * a digest over the archive drifted on every save, since the manifest inside
 * it carries `savedAt`; a digest over the manifest's entry digests drifted
 * between carriers, since an inline link rebuilds them. Each was caught by a
 * test of an ordinary thing — reopening a document you have been writing to,
 * and taking in a copy that arrived as a link.
 */
export function buildOf(manifest: { signature?: string }): string | undefined {
  return manifest.signature;
}
