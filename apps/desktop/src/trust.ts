/**
 * The desktop host's pin storage.
 *
 * The decision lives in `src/trust.ts` and is shared with the opener. What is
 * here is the part that is genuinely this host's: pins are kept by the Rust
 * side, in a file next to the application's own data, reached through the same
 * command bridge as everything else.
 *
 * It began the other way round — the whole decision was here, shaped around
 * these commands — and moved when the opener needed the same protection. Two
 * implementations of "is this the publisher you trusted" would eventually
 * disagree, and the day they do is the day one of them lets an impersonation
 * through.
 */
import { checkTrust as decide, forgetTrust as drop } from "../../../src/trust.js";
import type { PinnedKey, TrustStore, TrustVerdict } from "../../../src/trust.js";
import type { VerifiedContainer } from "../../../src/container.js";

export type { TrustVerdict };

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** What the Rust side stores, which is snake_case and not ours to rename. */
interface StoredKey {
  public_key: string | null;
  fingerprint: string | null;
  app_name: string | null;
  first_seen: number;
}

function storeFor(invoke: Invoke): TrustStore {
  return {
    async get(documentUuid) {
      const stored = await invoke<StoredKey | null>("get_pinned_key", { documentUuid });
      if (!stored) return null;
      return {
        publicKey: stored.public_key,
        fingerprint: stored.fingerprint,
        appName: stored.app_name,
        firstSeen: stored.first_seen,
      };
    },

    async pin(documentUuid, key: PinnedKey) {
      // The Rust side refuses to overwrite an existing pin, which is the point:
      // trust on first use means the first use, and a host that let a later
      // open replace the record would be remembering whatever it was last told.
      await invoke<void>("pin_key", {
        documentUuid,
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        appName: key.appName,
      });
    },

    async forget(documentUuid) {
      await invoke<void>("forget_pinned_key", { documentUuid });
    },
  };
}

export async function checkTrust(
  invoke: Invoke,
  container: VerifiedContainer,
): Promise<TrustVerdict> {
  return decide(storeFor(invoke), container);
}

export async function forgetTrust(invoke: Invoke, documentUuid: string): Promise<void> {
  await drop(storeFor(invoke), documentUuid);
}

import type { PublisherPin, PublisherStore, RootPublisher } from "../../../src/publisher.js";

/**
 * Publishers, kept by the Rust side (4.3). The decision is shared with the
 * opener in `src/publisher.ts`; this is only where this host keeps records.
 */
export function publisherStoreFor(invoke: Invoke): PublisherStore {
  return {
    async byKey(publicKey) {
      return (await invoke<PublisherPin | null>("get_publisher", { publicKey })) ?? null;
    },
    async bySkeleton(skeleton) {
      return invoke<PublisherPin[]>("find_publishers", { skeleton });
    },
    async save(pin) {
      await invoke<void>("save_publisher", { pin });
    },
    async roots() {
      const text = await invoke<string | null>("read_root_list");
      if (!text) return [];
      try {
        const list = JSON.parse(text) as { formatVersion?: number; publishers?: RootPublisher[] };
        if (list?.formatVersion !== 1 || !Array.isArray(list.publishers)) return [];
        return list.publishers.filter((p) => typeof p?.spki === "string" && typeof p?.name === "string");
      } catch {
        return [];
      }
    },
  };
}
