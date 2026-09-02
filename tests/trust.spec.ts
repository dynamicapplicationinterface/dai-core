import { expect, test } from "@playwright/test";
import { checkTrust, forgetTrust } from "../apps/desktop/src/trust.js";
import type { VerifiedContainer } from "../src/container.js";

/**
 * The trust registry decides whether a validly signed cartridge is signed by
 * the *expected* publisher. Core verification has already passed by this point:
 * every case below is a container whose mathematics check out, which is exactly
 * why the question is worth asking.
 *
 * The storage lives in Rust and is not exercised here. What is exercised is the
 * decision, which is where the security actually is — a wrong verdict cannot be
 * saved into safety by a correct file write.
 */
interface Pin {
  public_key: string | null;
  fingerprint: string | null;
  app_name: string | null;
  first_seen: number;
}

/** Stands in for the Rust commands, with the same refusal to overwrite a pin. */
function fakeHost(initial: Record<string, Pin> = {}) {
  const registry: Record<string, Pin> = { ...initial };

  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const uuid = args?.documentUuid as string;

    if (command === "get_pinned_key") return (registry[uuid] ?? null) as T;

    if (command === "pin_key") {
      // Trust on first use means exactly once. A pin that could be replaced by
      // reopening a file would protect nothing.
      if (registry[uuid]) throw new Error(`${uuid} is already pinned.`);
      registry[uuid] = {
        public_key: (args?.publicKey as string | null) ?? null,
        fingerprint: (args?.fingerprint as string | null) ?? null,
        app_name: (args?.appName as string | null) ?? null,
        first_seen: 1_700_000_000,
      };
      return undefined as T;
    }

    if (command === "forget_pinned_key") {
      delete registry[uuid];
      return undefined as T;
    }

    throw new Error(`unexpected command ${command}`);
  };

  return { invoke, registry };
}

function container(overrides: Partial<VerifiedContainer> = {}): VerifiedContainer {
  return {
    html: "<html></html>",
    archive: {},
    manifest: {
      manifestVersion: 1,
      documentUuid: "11111111-2222-4333-8444-555555555555",
      appName: "Notes",
      createdAt: "2026-01-01T00:00:00.000Z",
      algorithm: "SHA-256",
      integrityPolicy: "required",
      hashes: {},
      publicKeyFingerprint: "aaaaaaaaaaaaaaaa",
    },
    integrityPolicy: "required",
    publicKey: "PUBLIC-KEY-A",
    publicKeyFingerprint: "aaaaaaaaaaaaaaaa",
    database: new Uint8Array(0),
    signature: "valid",
    ...overrides,
  } as VerifiedContainer;
}

test.describe("trust on first use", () => {
  test("pins the key the first time a document is opened", async () => {
    const host = fakeHost();
    const verdict = await checkTrust(host.invoke, container());

    expect(verdict.status).toBe("pinned");
    // The full key is recorded, not the fingerprint: a 64-bit truncation is a
    // weaker thing to compare, for no saving.
    expect(host.registry["11111111-2222-4333-8444-555555555555"]!.public_key).toBe("PUBLIC-KEY-A");
  });

  test("accepts the same document signed by the same key", async () => {
    const host = fakeHost();
    await checkTrust(host.invoke, container());

    // A later revision: same document, same publisher, new database.
    const verdict = await checkTrust(host.invoke, container());
    expect(verdict.status).toBe("trusted");
  });

  test("blocks a document re-signed by a different key", async () => {
    const host = fakeHost();
    await checkTrust(host.invoke, container());

    // The attack the whole registry exists for. The signature is valid — the
    // attacker signed it properly, with their own key — so only a memory of
    // what this document used to be signed with can catch it.
    const verdict = await checkTrust(
      host.invoke,
      container({ publicKey: "PUBLIC-KEY-B", publicKeyFingerprint: "bbbbbbbbbbbbbbbb" }),
    );

    expect(verdict.status).toBe("mismatch");
    if (verdict.status !== "mismatch") return;
    expect(verdict.expected).toBe("aaaaaaaaaaaaaaaa");
    expect(verdict.received).toBe("bbbbbbbbbbbbbbbb");
    // The wording must not imply the file is broken: it is properly signed.
    expect(verdict.message).toContain("by somebody else");
  });

  test("blocks a signature stripped from a document that had one", async () => {
    const host = fakeHost();
    await checkTrust(host.invoke, container());

    const verdict = await checkTrust(
      host.invoke,
      container({ signature: "unsigned", publicKey: undefined, publicKeyFingerprint: undefined }),
    );

    expect(verdict.status).toBe("mismatch");
    if (verdict.status !== "mismatch") return;
    expect(verdict.message).toContain("stripped");
  });

  test("blocks a signature added to a document that never had one", async () => {
    const host = fakeHost();
    const unsigned = container({
      signature: "unsigned",
      publicKey: undefined,
      publicKeyFingerprint: undefined,
    });
    await checkTrust(host.invoke, unsigned);

    // The application in a container is immutable, so the only legitimate
    // change to a document is its database — never who signed it.
    const verdict = await checkTrust(host.invoke, container());

    expect(verdict.status).toBe("mismatch");
    if (verdict.status !== "mismatch") return;
    expect(verdict.message).toContain("added");
  });

  test("treats an unsigned document consistently across opens", async () => {
    const host = fakeHost();
    const unsigned = container({
      signature: "unsigned",
      publicKey: undefined,
      publicKeyFingerprint: undefined,
    });

    expect((await checkTrust(host.invoke, unsigned)).status).toBe("pinned");
    expect((await checkTrust(host.invoke, unsigned)).status).toBe("trusted");
  });

  test("a different document is a separate first use", async () => {
    const host = fakeHost();
    await checkTrust(host.invoke, container());

    // Per spec §1 a changed application is a new document with a new UUID, so
    // an unrelated key here is not a mismatch — it is a first sighting. This is
    // the documented limit of TOFU, asserted so it stays visible.
    const verdict = await checkTrust(
      host.invoke,
      container({
        manifest: { ...container().manifest, documentUuid: "99999999-2222-4333-8444-555555555555" },
        publicKey: "PUBLIC-KEY-B",
        publicKeyFingerprint: "bbbbbbbbbbbbbbbb",
      }),
    );

    expect(verdict.status).toBe("pinned");
  });

  test("forgetting a pin allows a deliberate key rotation", async () => {
    const host = fakeHost();
    await checkTrust(host.invoke, container());

    const rotated = container({
      publicKey: "PUBLIC-KEY-B",
      publicKeyFingerprint: "bbbbbbbbbbbbbbbb",
    });
    expect((await checkTrust(host.invoke, rotated)).status).toBe("mismatch");

    // Without an escape hatch a re-signed document is permanently unopenable,
    // and a user facing that reaches for something worse than an explicit reset.
    await forgetTrust(host.invoke, "11111111-2222-4333-8444-555555555555");
    expect((await checkTrust(host.invoke, rotated)).status).toBe("pinned");
  });
});
