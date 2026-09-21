import { expect, test } from "@playwright/test";
import { CHECK_EVERY_MS, askForSuccessor, checkIsDue } from "../apps/runner/src/version-check.js";

/**
 * What a copy asks, and what it does with the answer (`docs/version-ping.md`).
 *
 * The end-to-end path is `version-update-e2e`. These are the decisions the copy
 * makes on its own, each of which ends in silence — no card, no sentence — and
 * so cannot be read from a screen.
 */

const DOC = "9f1c2f4e-0d7a-4f39-9b2b-1b0f3a6e5c11";
const KEY = "the-author-key";
const now = Date.parse("2026-09-22T12:00:00.000Z");

/** A relay that answers whatever a test hands it, and records what it was asked. */
function answering(body: unknown, status = 200): { fetcher: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test.describe("when a copy asks again", () => {
  test("the first time, and then once a day", () => {
    expect(checkIsDue(undefined, now), "never asked").toBe(true);
    expect(checkIsDue(new Date(now - 60_000).toISOString(), now), "asked a minute ago").toBe(false);
    expect(checkIsDue(new Date(now - CHECK_EVERY_MS + 1_000).toISOString(), now), "not quite a day").toBe(false);
    expect(checkIsDue(new Date(now - CHECK_EVERY_MS).toISOString(), now), "a day").toBe(true);
    // A record written by something that got it wrong is asked again rather
    // than never asked: unreadable is not "recently".
    expect(checkIsDue("not a time", now)).toBe(true);
  });
});

test.describe("what a copy sends and takes back", () => {
  test("sends the three facts and nothing else", async () => {
    const relay = answering({ current: "build-2", successor: "https://store.invalid/2#k=k", publicKey: KEY, label: "Two", note: "n" });
    await askForSuccessor({
      relayBase: "https://relay.invalid",
      documentUuid: DOC,
      version: "build-1",
      trustedKey: KEY,
      fetcher: relay.fetcher,
    });
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0]!.url, "the document is the route").toBe(`https://relay.invalid/v/${DOC}`);
    expect(relay.calls[0]!.body, "the build it holds, and the key it trusts").toEqual({
      version: "build-1",
      publisher: KEY,
    });
  });

  test("takes the author's words as the author's", async () => {
    const relay = answering({
      current: "build-2",
      successor: "https://store.invalid/2#k=k",
      publicKey: KEY,
      label: "Version two",
      note: "the exercise list has 40 more movements",
    });
    const successor = await askForSuccessor({
      relayBase: "https://relay.invalid",
      documentUuid: DOC,
      version: "build-1",
      trustedKey: KEY,
      fetcher: relay.fetcher,
    });
    expect(successor).toEqual({
      version: "build-2",
      label: "Version two",
      note: "the exercise list has 40 more movements",
      address: "https://store.invalid/2#k=k",
    });
  });

  test("refuses a successor announced under a key this copy did not pin", async () => {
    /*
     * The relay is a noticeboard: it cannot forge an announcement, and it can
     * serve one from anybody holding some key. Which key matters is the copy's
     * own question, and it is answered here rather than by fetching first and
     * asking later — a fetch on a stranger's say-so is the thing being avoided.
     */
    const relay = answering({
      current: "build-2",
      successor: "https://store.invalid/evil#k=k",
      publicKey: "somebody-else",
      label: "Two",
      note: "n",
    });
    const successor = await askForSuccessor({
      relayBase: "https://relay.invalid",
      documentUuid: DOC,
      version: "build-1",
      trustedKey: KEY,
      fetcher: relay.fetcher,
    });
    expect(successor, "nothing offered, and nothing fetched").toBeNull();
  });

  test("an unsigned copy, which pinned no key, is offered nothing", async () => {
    const relay = answering({ current: "build-2", successor: "https://store.invalid/2#k=k", publicKey: KEY, label: "Two", note: "n" });
    expect(
      await askForSuccessor({
        relayBase: "https://relay.invalid",
        documentUuid: DOC,
        version: "build-1",
        trustedKey: undefined,
        fetcher: relay.fetcher,
      }),
    ).toBeNull();
  });

  test("silence, whatever goes wrong: a check that finds nothing is not news", async () => {
    const cases: { what: string; relay: { fetcher: typeof fetch } }[] = [
      { what: "the same build this copy holds", relay: answering({ current: "build-1", successor: null }) },
      { what: "nothing announced at all", relay: answering({ current: null, successor: null }) },
      { what: "a relay that refuses", relay: answering({ error: "no" }, 500) },
      {
        what: "a relay that is not there",
        relay: {
          fetcher: (async () => {
            throw new TypeError("Failed to fetch");
          }) as unknown as typeof fetch,
        },
      },
    ];
    for (const { what, relay } of cases) {
      expect(
        await askForSuccessor({
          relayBase: "https://relay.invalid",
          documentUuid: DOC,
          version: "build-1",
          trustedKey: KEY,
          fetcher: relay.fetcher,
        }),
        what,
      ).toBeNull();
    }
  });

  test("a build with no relay address asks nobody", async () => {
    const relay = answering({ current: "build-2", successor: "https://store.invalid/2#k=k", publicKey: KEY });
    expect(
      await askForSuccessor({ relayBase: "", documentUuid: DOC, version: "build-1", trustedKey: KEY, fetcher: relay.fetcher }),
    ).toBeNull();
    expect(relay.calls, "and asks nothing of anybody").toEqual([]);
  });
});
