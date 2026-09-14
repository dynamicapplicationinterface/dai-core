/**
 * Trust on first use for container publishers.
 *
 * Verification proves a container is internally consistent: nothing has changed
 * since it was signed by the key it carries. It cannot prove *who* that key
 * belongs to, because somebody who alters a container can also replace the key
 * and re-sign it — every check still passes, against their key.
 *
 * This closes that for documents a host has seen before. The first time a
 * document is opened its key is recorded; every later open must present the
 * same key. Substituting one becomes visible, because the host remembers what
 * the document used to be signed with and the document cannot rewrite that
 * memory.
 *
 * The limit, stated plainly: this protects revisions of a document already
 * known to the host. A malicious *new* document with a new identity is a first
 * use and has nothing to compare against. Closing that needs a publisher
 * identity separate from the key, which the manifest does not have.
 *
 * ## Why it lives here
 *
 * It began in the desktop application, shaped around that host's storage. The
 * opener needed the same protection and would have got a second copy of the
 * decision — and the day two implementations of "is this the publisher you
 * trusted" disagree is a day one of them lets an impersonation through.
 *
 * So the decision is here and takes its storage as a parameter. A host supplies
 * somewhere to keep pins; nothing else about it is negotiable.
 */
import type { VerifiedContainer } from "./container.js";

/** What a host remembers about a document it has opened before. */
export interface PinnedKey {
  /** Base64 SPKI, or null for a document that was unsigned when first seen. */
  publicKey: string | null;
  fingerprint: string | null;
  appName: string | null;
  /** Unix milliseconds. Shown to a person deciding whether to believe a change. */
  firstSeen: number;
}

/**
 * Somewhere to keep pins.
 *
 * Deliberately three methods. A host that had to implement more would end up
 * with logic in it, and logic in a host is a second opinion about trust.
 */
export interface TrustStore {
  get(documentUuid: string): Promise<PinnedKey | null>;
  pin(documentUuid: string, key: PinnedKey): Promise<void>;
  forget(documentUuid: string): Promise<void>;
}

/**
 * Thrown by a store that could not reach its storage at all — a database
 * that never answered, not a record that is absent.
 *
 * The difference is the whole point. "No pin" and "could not look" must not be
 * the same answer: "no pin" after a pin was written means another open got its
 * pin in first, and that open's loser must be refused (see `pinTrust`); "could
 * not look" means nothing was written anywhere, so there is no pin to race
 * against. A store throws this only for the second.
 */
export class TrustStorageUnavailable extends Error {
  constructor(message = "This device's storage did not answer.") {
    super(message);
    this.name = "TrustStorageUnavailable";
  }
}

export type TrustVerdict =
  | { status: "pinned"; fingerprint?: string }
  | { status: "trusted"; fingerprint?: string; firstSeen: number }
  | { status: "mismatch"; message: string; expected?: string; received?: string }
  /**
   * Opened as a first sighting that could not be remembered: the store could
   * not be reached, so no key was recorded and none could have been raced.
   * The next open is a first use again.
   */
  | { status: "unpinned"; fingerprint?: string };

/**
 * What a host sees before it has decided anything: the verdicts above, or
 * `unknown` for a document this host has never met, which the host may pin
 * once the person has agreed to open it — and not before.
 */
export type TrustLook =
  | TrustVerdict
  // `unavailable` when the store could not be reached rather than found nothing.
  | { status: "unknown"; fingerprint?: string; unavailable?: true };

/** The key a container presents, for comparison with a pin. */
function presentedKey(container: VerifiedContainer): string | null {
  // The full key rather than the fingerprint: a truncation is a weaker thing to
  // compare than the key itself, for no saving.
  return container.signature === "valid" ? (container.publicKey ?? null) : null;
}

/**
 * Records the key a document was first seen with. Idempotent: a store keeps
 * its first pin and ignores a second.
 *
 * Called after consent, not before. A pin made when a link was merely followed
 * is a pin nobody agreed to, and a review found what that allows: a link
 * carrying a stranger's copy of a document, loaded and closed without a tap,
 * would leave the real document reading as an impersonation ever after — with
 * nothing in the library to delete, and so no way to undo it.
 */
export async function pinTrust(store: TrustStore, container: VerifiedContainer): Promise<TrustVerdict> {
  try {
    await store.pin(container.manifest.documentUuid, {
      publicKey: presentedKey(container),
      fingerprint: container.publicKeyFingerprint ?? null,
      appName: container.manifest.appName ?? null,
      firstSeen: Date.now(),
    });
  } catch (error) {
    // Unreachable storage is decided by the read-back below, which must also
    // find it unreachable. Anything else is a real failure and stays one.
    if (!(error instanceof TrustStorageUnavailable)) throw error;
  }
  /*
   * The pin that is there is the one that counts — and it may not be this
   * one. Two opens of one document with two keys, both finding no pin, both
   * pinning: the store keeps the first, and the second used to be told it
   * was pinned and ran. What was kept is read back and compared, so the
   * loser of that race is refused the way any later mismatch would be.
   */
  const look = await trustVerdict(store, container);
  if (look.status === "trusted") return { status: "pinned", fingerprint: look.fingerprint };
  /*
   * The one way through without a pin: the read-back could not reach storage
   * at all. Nothing was written, so no other open's pin exists to lose to,
   * and a slow database on a first open — the open that creates it — opens
   * the document as unfamiliar instead of refusing it. A read-back that
   * reached storage and found a different key is refused above as a
   * mismatch; one that reached it and found nothing is refused below.
   */
  if (look.status === "unknown" && look.unavailable) {
    return { status: "unpinned", fingerprint: container.publicKeyFingerprint };
  }
  if (look.status === "unknown") {
    return {
      status: "mismatch",
      message: "This device could not remember which key signed this document. Nothing has been changed; try opening it again.",
    };
  }
  return look;
}

/**
 * Compares a verified container with what this host remembers, and writes
 * nothing.
 *
 * Runs *after* verification, never instead of it. A container whose signature
 * does not check out has already been refused; this answers the different
 * question of whether the key that checked out is the one this host expects.
 */
export async function trustVerdict(
  store: TrustStore,
  container: VerifiedContainer,
): Promise<TrustLook> {
  const uuid = container.manifest.documentUuid;
  const presented = presentedKey(container);

  let pinned: PinnedKey | null;
  try {
    pinned = await store.get(uuid);
  } catch (error) {
    if (!(error instanceof TrustStorageUnavailable)) throw error;
    // Could not look: shown the card as unfamiliar, and said so, never trusted.
    return { status: "unknown", fingerprint: container.publicKeyFingerprint, unavailable: true };
  }

  if (!pinned) return { status: "unknown", fingerprint: container.publicKeyFingerprint };

  if (pinned.publicKey === presented) {
    return {
      status: "trusted",
      fingerprint: container.publicKeyFingerprint,
      firstSeen: pinned.firstSeen,
    };
  }

  // Any change of trust state for a document is a mismatch. The application
  // inside a container is immutable, so the only thing a legitimate revision
  // changes is its database — never who signed it.
  if (pinned.publicKey && !presented) {
    return {
      status: "mismatch",
      message:
        `This document was previously signed by ${pinned.fingerprint ?? "a publisher"}, ` +
        `and this copy is not signed at all. A signature has been stripped from it.`,
      expected: pinned.fingerprint ?? undefined,
    };
  }

  if (!pinned.publicKey && presented) {
    return {
      status: "mismatch",
      message:
        `This document was not signed when it was first opened, and this copy ` +
        `is signed by ${container.publicKeyFingerprint ?? "an unknown key"}. ` +
        `A signature has been added to a document that never had one.`,
      received: container.publicKeyFingerprint,
    };
  }

  return {
    status: "mismatch",
    message:
      `This document is signed by a different publisher than the one it was ` +
      `first opened with. It is mathematically valid, which means it was signed ` +
      `properly — by somebody else. Treat it as an impersonation of the original ` +
      `until you have confirmed the change with the publisher directly.`,
    expected: pinned.fingerprint ?? undefined,
    received: container.publicKeyFingerprint,
  };
}

/**
 * Looks, and pins a first sighting on the spot.
 *
 * For a host where the look and the consent are the same act — the desktop
 * app, which opens what it was handed; the opener's library, whose entries
 * were agreed to when they were kept. A host that shows a card first should
 * call `trustVerdict` and `pinTrust` separately, with the card in between.
 */
export async function checkTrust(
  store: TrustStore,
  container: VerifiedContainer,
): Promise<TrustVerdict> {
  const look = await trustVerdict(store, container);
  if (look.status !== "unknown") return look;
  return pinTrust(store, container);
}

/** Drops a pin so the next open trusts afresh. For a deliberate key rotation. */
export async function forgetTrust(store: TrustStore, documentUuid: string): Promise<void> {
  await store.forget(documentUuid);
}
