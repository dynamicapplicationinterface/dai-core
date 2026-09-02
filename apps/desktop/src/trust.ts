/**
 * Trust on first use for cartridge publishers.
 *
 * Core verification proves a container is internally consistent: nothing has
 * changed since it was signed by the key it carries. It cannot prove *who* that
 * key belongs to, because an attacker who tampers with a cartridge can also
 * replace the key and re-sign — every check still passes, against their key.
 *
 * The registry closes that for documents this host has seen before. The first
 * time a document is opened its key is recorded; every later open must present
 * the same key. Substituting one is then visible, because the host remembers
 * what the document used to be signed with and the document cannot rewrite that
 * memory.
 *
 * The limit, stated plainly: this protects revisions of a document already
 * known to the host. A malicious *new* document with a new UUID is a first use
 * and has nothing to compare against. Closing that needs a publisher identity
 * separate from the key, which the manifest does not have. See
 * docs/backlog.md §2.
 */
import type { VerifiedContainer } from "../../../src/container.js";

interface PinnedKey {
  public_key: string | null;
  fingerprint: string | null;
  app_name: string | null;
  first_seen: number;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type TrustVerdict =
  | { status: "pinned"; fingerprint?: string }
  | { status: "trusted"; fingerprint?: string; firstSeen: number }
  | { status: "mismatch"; message: string; expected?: string; received?: string };

/**
 * Decides whether a verified container may be mounted, and records the key on a
 * first sighting.
 *
 * Runs *after* core verification, never instead of it. A cartridge whose
 * signature does not check out is already refused; this answers the different
 * question of whether the key that checked out is the one this host expects.
 */
export async function checkTrust(
  invoke: Invoke,
  container: VerifiedContainer,
): Promise<TrustVerdict> {
  const uuid = container.manifest.documentUuid;
  // The full key, not the fingerprint: a 64-bit truncation is a weaker thing to
  // compare than the key itself, for no saving.
  const presented = container.signature === "valid" ? (container.publicKey ?? null) : null;

  const pinned = await invoke<PinnedKey | null>("get_pinned_key", { documentUuid: uuid });

  if (!pinned) {
    await invoke<void>("pin_key", {
      documentUuid: uuid,
      publicKey: presented,
      fingerprint: container.publicKeyFingerprint ?? null,
      appName: container.manifest.appName ?? null,
    });
    return { status: "pinned", fingerprint: container.publicKeyFingerprint };
  }

  if (pinned.public_key === presented) {
    return {
      status: "trusted",
      fingerprint: container.publicKeyFingerprint,
      firstSeen: pinned.first_seen,
    };
  }

  // Any change of trust state for a document is a mismatch. The application
  // inside a container is immutable, so the only thing a legitimate revision
  // changes is its database — never who signed it.
  if (pinned.public_key && !presented) {
    return {
      status: "mismatch",
      message:
        `This document was previously signed by ${pinned.fingerprint ?? "a publisher"}, ` +
        `and this copy is not signed at all. A signature has been stripped from it.`,
      expected: pinned.fingerprint ?? undefined,
    };
  }

  if (!pinned.public_key && presented) {
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

/** Drops a pin so the next open trusts afresh. For deliberate key rotation. */
export async function forgetTrust(invoke: Invoke, documentUuid: string): Promise<void> {
  await invoke<void>("forget_pinned_key", { documentUuid });
}
