import { expect, test } from "@playwright/test";
import type { VerifiedContainer } from "../src/container.js";
import { pinTrust, TrustStorageUnavailable, trustVerdict, type PinnedKey, type TrustStore } from "../src/trust.js";

/**
 * Trust on first use, when the storage behind it does not answer.
 *
 * A first open on a slow device used to be refused: the database that holds
 * pins is created by that very open, and when it took longer than its bound the
 * trust step threw and the person was told the file could not be opened. The
 * fix opens such a document as unfamiliar and unremembered — and it must do
 * that without opening a hole in the one guard `pinTrust` exists for.
 *
 * That guard: two opens of one document carrying two different keys both find
 * no pin, both pin, and the store keeps the first. The second reads its pin
 * back, finds somebody else's key, and is refused. If "the store could not be
 * reached" were allowed to look like "no pin", that loser could be waved
 * through. So the unreachable case is its own outcome, and these hold the line
 * between them.
 */

const UUID = "11111111-2222-4333-8444-555555555555";
const OURS = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-ours";
const THEIRS = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-theirs";

/** Only what trust reads: the document, its name, and the key it presents. */
function signedWith(publicKey: string, fingerprint: string): VerifiedContainer {
  return {
    manifest: { documentUuid: UUID, appName: "Notes" },
    publicKey,
    publicKeyFingerprint: fingerprint,
    signature: "valid",
  } as unknown as VerifiedContainer;
}

const pinFor = (publicKey: string, fingerprint: string): PinnedKey => ({
  publicKey,
  fingerprint,
  appName: "Notes",
  firstSeen: 1_700_000_000,
});

/** A store that keeps its first pin and ignores a second, as both hosts do. */
function memoryStore(initial: Record<string, PinnedKey> = {}) {
  const pins: Record<string, PinnedKey> = { ...initial };
  const store: TrustStore = {
    async get(uuid) {
      return pins[uuid] ?? null;
    },
    async pin(uuid, key) {
      if (!pins[uuid]) pins[uuid] = key;
    },
    async forget(uuid) {
      delete pins[uuid];
    },
  };
  return { store, pins };
}

const unreachable: TrustStore = {
  async get() {
    throw new TrustStorageUnavailable();
  },
  async pin() {
    throw new TrustStorageUnavailable();
  },
  async forget() {
    throw new TrustStorageUnavailable();
  },
};

test.describe("trust when storage does not answer", () => {
  test("storage that cannot be reached: shown as unfamiliar, then opened unpinned", async () => {
    const ours = signedWith(OURS, "ours0000");
    const look = await trustVerdict(unreachable, ours);
    expect(look).toMatchObject({ status: "unknown", unavailable: true });
    expect(await pinTrust(unreachable, ours)).toMatchObject({ status: "unpinned" });
  });

  test("a different key that loses the race is refused, not waved through", async () => {
    /*
     * The case that stops this fix becoming a hole. Both opens looked and found
     * no pin; the other open pinned first; this one pins (the store keeps the
     * first), reads back, finds the other key, and must be refused.
     */
    const { store, pins } = memoryStore();
    const ours = signedWith(OURS, "ours0000");
    expect(await trustVerdict(store, ours)).toMatchObject({ status: "unknown" });

    pins[UUID] = pinFor(THEIRS, "theirs00"); // the rival's pin lands first

    const result = await pinTrust(store, ours);
    expect(result.status).toBe("mismatch");
    expect(pins[UUID]!.publicKey).toBe(THEIRS);
  });

  test("the pin write cannot reach storage, the read-back can, and finds another key: refused", async () => {
    const { store, pins } = memoryStore({ [UUID]: pinFor(THEIRS, "theirs00") });
    const flaky: TrustStore = {
      ...store,
      async pin() {
        throw new TrustStorageUnavailable();
      },
    };
    expect((await pinTrust(flaky, signedWith(OURS, "ours0000"))).status).toBe("mismatch");
    expect(pins[UUID]!.publicKey).toBe(THEIRS);
  });

  test("storage answers but the pin did not take: still refused, as before", async () => {
    const { store } = memoryStore();
    const forgetful: TrustStore = { ...store, async pin() {} };
    const result = await pinTrust(forgetful, signedWith(OURS, "ours0000"));
    expect(result).toMatchObject({ status: "mismatch", message: expect.stringMatching(/could not remember/) });
  });

  test("a failure that is not unreachable storage stays a failure", async () => {
    const broken: TrustStore = {
      async get() {
        throw new Error("disk corrupt");
      },
      async pin() {},
      async forget() {},
    };
    await expect(trustVerdict(broken, signedWith(OURS, "ours0000"))).rejects.toThrow("disk corrupt");
    await expect(pinTrust(broken, signedWith(OURS, "ours0000"))).rejects.toThrow("disk corrupt");
  });

  test("a pin already held with a different key is refused before anything is asked", async () => {
    const { store } = memoryStore({ [UUID]: pinFor(THEIRS, "theirs00") });
    expect((await trustVerdict(store, signedWith(OURS, "ours0000"))).status).toBe("mismatch");
  });
});
