/// <reference path="../apps/relay/src/cloudflare.d.ts" />
import { expect, test } from "@playwright/test";
import { VersionDO, announcementBytes } from "../apps/relay/src/version-do.js";
import { memoryState } from "./relay-memory.js";

/**
 * The relay's half of the version ping (`docs/version-ping.md`), run as the
 * deployed code runs: the real Durable Object class, handed in-memory storage
 * in place of Cloudflare's.
 *
 * What it holds:
 * - a copy says which build it has and is told whether there is a successor;
 * - an announcement is stored only if it is signed by the key it carries, so
 *   the relay cannot invent a successor and nobody without the key can publish
 *   one under this document;
 * - check-ins are counted per version and per document, and they are check-ins
 *   — nothing here can distinguish one copy from another, which is the point.
 */

const DOC = "9f1c2f4e-0d7a-4f39-9b2b-1b0f3a6e5c11";
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** An author, with the key they sign their builds and their announcements with. */
async function author(): Promise<{
  publicKey: string;
  sign: (bytes: Uint8Array) => Promise<string>;
}> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    publicKey: toBase64(spki),
    sign: async (bytes) =>
      toBase64(
        new Uint8Array(
          await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, bytes as unknown as ArrayBuffer),
        ),
      ),
  };
}

function relay(): { post: (path: string, body: unknown) => Promise<Response>; keys: () => string[]; read: <T>(key: string) => Promise<T | undefined> } {
  const memory = memoryState();
  const object = new VersionDO(memory.state, {});
  return {
    post: (path, body) =>
      object.fetch(
        new Request(`https://relay.invalid${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    keys: () => memory.keys(),
    read: <T,>(key: string) => memory.state.storage.get<T>(key),
  };
}

/** What an author publishes: the fields, signed as one. */
async function announcement(
  who: { publicKey: string; sign: (bytes: Uint8Array) => Promise<string> },
  fields: { document?: string; version: string; label: string; note: string; successor: string },
): Promise<Record<string, unknown>> {
  const document = fields.document ?? DOC;
  return {
    document,
    version: fields.version,
    label: fields.label,
    note: fields.note,
    successor: fields.successor,
    publicKey: who.publicKey,
    signature: await who.sign(announcementBytes({ ...fields, document })),
  };
}

test.describe("the version relay", () => {
  test("a copy holding the newest build is told there is nothing", async () => {
    const door = relay();
    const alice = await author();
    const published = await announcement(alice, {
      version: "build-2",
      label: "Version two",
      note: "the exercise list has 40 more movements",
      successor: "https://store.invalid/abc#k=key",
    });
    expect((await door.post(`/v/${DOC}/announce`, published)).status).toBe(200);

    const answer = await (await door.post(`/v/${DOC}`, { version: "build-2" })).json();
    expect(answer, "nothing to offer somebody who already has it").toEqual({
      current: "build-2",
      successor: null,
    });
  });

  test("a copy holding an older build is told what the author published", async () => {
    const door = relay();
    const alice = await author();
    await door.post(
      `/v/${DOC}/announce`,
      await announcement(alice, {
        version: "build-2",
        label: "Version two",
        note: "the exercise list has 40 more movements",
        successor: "https://store.invalid/abc#k=key",
      }),
    );

    const answer = (await (await door.post(`/v/${DOC}`, { version: "build-1" })).json()) as Record<string, unknown>;
    expect(answer.current).toBe("build-2");
    expect(answer.successor).toBe("https://store.invalid/abc#k=key");
    // The author's own words, carried and not interpreted.
    expect(answer.label).toBe("Version two");
    expect(answer.note).toBe("the exercise list has 40 more movements");
    // And the key it was signed by, for the copy to weigh against its own pin.
    expect(answer.publicKey).toBe(alice.publicKey);
  });

  test("a copy that has never been told of anything is told nothing, not an error", async () => {
    const door = relay();
    const answer = await (await door.post(`/v/${DOC}`, { version: "build-1" })).json();
    expect(answer).toEqual({ current: null, successor: null });
  });

  test("an announcement that is not signed by the key it carries is refused", async () => {
    const door = relay();
    const alice = await author();
    const mallory = await author();

    // Mallory's key, Alice's signature: the pair does not verify.
    const forged = {
      ...(await announcement(alice, {
        version: "build-2",
        label: "Version two",
        note: "trust me",
        successor: "https://store.invalid/evil#k=key",
      })),
      publicKey: mallory.publicKey,
    };
    const refused = await door.post(`/v/${DOC}/announce`, forged);
    expect(refused.status).toBe(403);
    expect(await door.read("current"), "and nothing was stored").toBeUndefined();

    // Nor can a field be edited after signing: the signature covers them all.
    const edited = {
      ...(await announcement(alice, {
        version: "build-2",
        label: "Version two",
        note: "the exercise list has 40 more movements",
        successor: "https://store.invalid/abc#k=key",
      })),
      successor: "https://store.invalid/evil#k=key",
    };
    expect((await door.post(`/v/${DOC}/announce`, edited)).status).toBe(403);
    expect(await door.read("current")).toBeUndefined();
  });

  test("a second author cannot replace the first author's notice", async () => {
    const door = relay();
    const alice = await author();
    const mallory = await author();
    await door.post(
      `/v/${DOC}/announce`,
      await announcement(alice, { version: "build-2", label: "Two", note: "n", successor: "https://a.invalid/#k=k" }),
    );
    const theirs = await door.post(
      `/v/${DOC}/announce`,
      await announcement(mallory, { version: "build-9", label: "Nine", note: "n", successor: "https://m.invalid/#k=k" }),
    );
    expect(theirs.status).toBe(409);
    const held = (await door.read("current")) as { successor: string };
    expect(held.successor, "the notice on the board is still the author's").toBe("https://a.invalid/#k=k");
  });

  test("an author replaces their own notice, and the newest one stands", async () => {
    const door = relay();
    const alice = await author();
    await door.post(
      `/v/${DOC}/announce`,
      await announcement(alice, { version: "build-2", label: "Two", note: "n", successor: "https://a.invalid/2#k=k" }),
    );
    await door.post(
      `/v/${DOC}/announce`,
      await announcement(alice, { version: "build-3", label: "Three", note: "n", successor: "https://a.invalid/3#k=k" }),
    );
    const answer = (await (await door.post(`/v/${DOC}`, { version: "build-1" })).json()) as Record<string, unknown>;
    expect(answer.current).toBe("build-3");
    expect(answer.successor).toBe("https://a.invalid/3#k=k");
  });

  test("check-ins are counted per version and per document, and nothing else is kept", async () => {
    const door = relay();
    for (const version of ["build-1", "build-1", "build-2"]) {
      await door.post(`/v/${DOC}`, { version });
    }
    const day = new Date().toISOString().slice(0, 10);
    expect(await door.read<number>(`count:build-1:${day}`)).toBe(2);
    expect(await door.read<number>(`count:build-2:${day}`)).toBe(1);
    expect(await door.read<number>(`count:${day}`), "three check-ins for the document").toBe(3);

    /*
     * And that is everything the relay holds. Read as a list rather than
     * asserted one key at a time, because what matters is the absence of
     * anything else: no address, no identifier, no record of who asked.
     */
    expect(door.keys().sort()).toEqual([`count:${day}`, `count:build-1:${day}`, `count:build-2:${day}`]);
  });

  test("a ping without a version is refused rather than counted", async () => {
    const door = relay();
    expect((await door.post(`/v/${DOC}`, {})).status).toBe(400);
    expect(door.keys(), "nothing counted").toEqual([]);
  });
});
