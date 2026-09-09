/**
 * Is the document that just arrived another copy of the one already here?
 * (docs/replicated-tables.md §7)
 *
 * The host's half of the question. It decides whether to *offer* a merge; the
 * frame decides whether one can actually happen, because only the frame has
 * the two databases open and only it can compare their schemas. Splitting it
 * that way keeps the host out of the business of parsing somebody else's
 * SQLite, which is the whole reason the merge lives in the frame.
 *
 * Everything here is a judgement about identity, made from manifests. Nothing
 * here reads a data section.
 */

/**
 * Whether a copy carries replicated tables, decided by the host alone.
 *
 * The host must not ask the frame this. The frame is the sandbox and the host
 * is what decides whether a merge is offered; a flag sent up from the frame
 * would be a fact supplied by the party the decision exists to contain. If the
 * two ever disagree about what is replicated, that is a refusal and not a
 * negotiation — the host declines, and the frame is never consulted.
 *
 * It reads the signed manifest, which is the authority. `replication.tables`
 * is covered by the signature, so what a document says about itself here
 * cannot be edited without the key that signed it, and an unsigned document's
 * answer is exactly as trustworthy as the rest of it.
 *
 * This replaced a heuristic that searched the database bytes for the rewrite's
 * own column names, because until the compiler emitted this field there was
 * nothing else that survived into a container: the `-- dai:replicated` marker
 * is consumed at build and `runtime/schema.json` carries a digest, not schema
 * text. The heuristic had a false positive — a table holding both column names
 * as content — and the field has none.
 */
export function declaresReplication(manifest: {
  replication?: { tables?: unknown } | null;
}): boolean {
  const tables = manifest.replication?.tables;
  return Array.isArray(tables) && tables.length > 0;
}

/** What a host knows about a copy without opening its database. */
export interface CopyIdentity {
  documentUuid?: string;
  /** The publisher's SPKI fingerprint, or absent for an unsigned document. */
  publicKeyFingerprint?: string;
  /** Whether this copy is known to carry replicated tables. */
  replicated?: boolean;
}

export type SiblingVerdict =
  | { sibling: true }
  | { sibling: false; because: "unrelated" | "different-publisher" | "not-replicated" | "same-copy" };

/**
 * The test, in the order §7 gives, stopping at the first answer.
 *
 * Order matters and is not arbitrary: a stranger reusing a UUID must be caught
 * by the publisher check rather than reaching the schema comparison, and a
 * document that is not replicated at all must be recognised as ordinary
 * succession rather than as a failed merge.
 */
export function siblingTest(
  incoming: CopyIdentity,
  local: CopyIdentity,
  options: { sameReplica?: boolean } = {},
): SiblingVerdict {
  if (!incoming.documentUuid || !local.documentUuid) return { sibling: false, because: "unrelated" };
  if (incoming.documentUuid !== local.documentUuid) return { sibling: false, because: "unrelated" };

  /*
   * The publisher has to agree, and "agree" is not "both absent" (T1-D4).
   *
   * Draft 1 assumes a signed document and compares SPKIs. Unsigned documents
   * are ordinary here, and treating two absences as a match would let any
   * unsigned file claiming this UUID present itself as a sibling — which at
   * Level 1, where a replica id is a claim anyway, is a merge with a stranger.
   * Both signed by the same key, or both unsigned; one of each is a refusal.
   */
  const signedHere = Boolean(local.publicKeyFingerprint);
  const signedThere = Boolean(incoming.publicKeyFingerprint);
  if (signedHere !== signedThere) return { sibling: false, because: "different-publisher" };
  if (signedHere && incoming.publicKeyFingerprint !== local.publicKeyFingerprint) {
    return { sibling: false, because: "different-publisher" };
  }

  // A document with no replicated tables is replaced whole, by succession. It
  // is not a failed merge and must not be offered as one.
  if (local.replicated === false || incoming.replicated === false) {
    return { sibling: false, because: "not-replicated" };
  }

  /*
   * My own copy coming back.
   *
   * Same replica id means this is the file this device wrote, returning — a
   * newer generation of its own document, which succession handles. Merging it
   * would be merging a copy with itself, and the offer would be nonsense on
   * screen: *merge into my copy* pointing at the copy it already is.
   */
  if (options.sameReplica) return { sibling: false, because: "same-copy" };

  return { sibling: true };
}

/** What the card says when the answer is no. Never a bare failure. */
export function whyNotSibling(because: Exclude<SiblingVerdict, { sibling: true }>["because"]): string {
  switch (because) {
    case "unrelated":
      return "This is a different document, so there is nothing to merge it into. It opens on its own.";
    case "different-publisher":
      return "This copy was published by somebody else. It has the same id, which it should not, so it is opened separately and nothing here is touched.";
    case "not-replicated":
      return "This document is replaced as a whole rather than merged. The newer copy wins.";
    case "same-copy":
      return "This is this device's own copy coming back. There is nothing to merge — it is the newer version of what is already here.";
  }
}
