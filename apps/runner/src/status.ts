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
 * The store's acknowledgment is the receipt `keeping.ts` holds to what it
 * sent (docs/store.md, "Operations"); nothing else feeds `kept`.
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

/**
 * The words the pill shows. When the store kept an earlier revision and not
 * this one, both facts are said in the pill's own box (D300): "Saved here ·
 * kept 10:42 AM", measured on three engines at 0.94 of the offer's width,
 * where R-Z's whole sentence is 1.48 of it. The sentence itself is the pill's
 * label (`storageSentence`).
 */
export function storageWords(status: StorageStatus): string {
  if (status.state === "failed") return "Not saved";
  if (status.state === "saving") return "Saving…";
  if (status.kept?.revision === "current") return "Kept";
  if (status.kept) return `Saved here · kept ${status.kept.at}`;
  return "Saved in this browser";
}

/** The status as one sentence, R-Z sentence 4's words: the pill's accessible name and its title. */
export function storageSentence(status: StorageStatus): string {
  if (status.state === "saved" && status.kept && status.kept.revision !== "current") {
    return `Saved in this browser. Last kept at ${status.kept.at}.`;
  }
  return storageWords(status);
}
