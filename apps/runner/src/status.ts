/**
 * The words for where a document's data stands, from the host's evidence only
 * (R-Z sentences 2 and 4; V1.0 ruling 6 as amended; R-H).
 *
 * Two states remain. "Saved in this browser" is the host's acknowledgment of a
 * local save. "Kept" is the owner's store's acknowledgment of the exact
 * revision on screen, and nothing else is: not a save, not a connection that
 * came back, not a store that was asked. When the store acknowledged an
 * earlier revision and not this one, both facts are said in one line.
 *
 * Build 2b-1 has no store, so `kept` is always null and "Kept" is never shown;
 * the store's acknowledgment arrives in 2b-2 (docs/store.md, "Operations").
 */

/** What the store acknowledged, when it has: the revision on screen or an earlier one, and when, as shown. */
export interface KeptReading {
  revision: "current" | "earlier";
  /** The acknowledgment's time, already in the person's local form ("10:42"). */
  at: string;
}

export interface StorageStatus {
  /** The runtime's account of the local save, as the host acknowledged it. */
  state: "saving" | "saved" | "failed";
  /** The store's acknowledgment, or null when there is none. */
  kept: KeptReading | null;
}

export function storageWords(status: StorageStatus): string {
  if (status.state === "failed") return "Not saved";
  if (status.state === "saving") return "Saving…";
  if (status.kept?.revision === "current") return "Kept";
  if (status.kept) return `Saved in this browser. Last kept at ${status.kept.at}.`;
  return "Saved in this browser";
}
