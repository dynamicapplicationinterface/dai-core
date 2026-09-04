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

export type TrustVerdict =
  | { status: "pinned"; fingerprint?: string }
  | { status: "trusted"; fingerprint?: string; firstSeen: number }
  | { status: "mismatch"; message: string; expected?: string; received?: string };

/**
 * Decides whether a verified container may be mounted, recording the key on a
 * first sighting.
 *
 * Runs *after* verification, never instead of it. A container whose signature
 * does not check out has already been refused; this answers the different
 * question of whether the key that checked out is the one this host expects.
 */
export async function checkTrust(
  store: TrustStore,
  container: VerifiedContainer,
): Promise<TrustVerdict> {
  const uuid = container.manifest.documentUuid;
  // The full key rather than the fingerprint: a truncation is a weaker thing to
  // compare than the key itself, for no saving.
  const presented = container.signature === "valid" ? (container.publicKey ?? null) : null;

  const pinned = await store.get(uuid);

  if (!pinned) {
    await store.pin(uuid, {
      publicKey: presented,
      fingerprint: container.publicKeyFingerprint ?? null,
      appName: container.manifest.appName ?? null,
      firstSeen: Date.now(),
    });
    return { status: "pinned", fingerprint: container.publicKeyFingerprint };
  }

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

/** Drops a pin so the next open trusts afresh. For a deliberate key rotation. */
export async function forgetTrust(store: TrustStore, documentUuid: string): Promise<void> {
  await store.forget(documentUuid);
}
