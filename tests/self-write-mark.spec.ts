import { expect, test } from "@playwright/test";

/**
 * The mark that tells a tab's own address write from a link arriving.
 *
 * `loadAt` sets it immediately before it writes, and the `hashchange` listener
 * asks `ownWrite()` first, so the tab does not hear itself as a link and load
 * twice. The mark is for the moment between the write and the load it asks
 * for: a load that never comes — one iOS drops, one a throw stops — used to
 * leave it set for ever, and a tab restored from the back/forward cache came
 * back with it still set, ignoring every real link from then on (cold review
 * of 8b9273c, Q1.1).
 *
 * Driven against the module itself, with the few globals it touches standing
 * in, because the states that matter are ones a driven engine will not produce
 * on demand: a navigation that throws, and a restore from the back/forward
 * cache (measured: this WebKit build serves a fresh load for a back instead).
 */
const listeners = new Map<string, (() => void)[]>();
const calls: string[] = [];
let refuse = false;

const refused = (): never => {
  throw new TypeError("navigation refused");
};
const stand = {
  addEventListener(kind: string, listener: () => void) {
    listeners.set(kind, [...(listeners.get(kind) ?? []), listener]);
  },
  location: {
    href: "https://opendai.app/?doc=1#a=1",
    replace: (to: string) => (refuse ? refused() : calls.push(`replace ${to}`)),
    assign: (to: string) => (refuse ? refused() : calls.push(`assign ${to}`)),
    reload: () => (refuse ? refused() : calls.push("reload")),
  },
};
const scope = globalThis as unknown as Record<string, unknown>;
scope.window = stand;
scope.location = stand.location;

const { loadAt, ownWrite } = await import("../apps/runner/src/navigate.js");

const fire = (kind: string): void => (listeners.get(kind) ?? []).forEach((listener) => listener());

test.describe("the mark on a tab's own address write", () => {
  test.beforeEach(() => {
    refuse = false;
    calls.length = 0;
    // Whatever the case before left, this one starts unmarked.
    fire("pageshow");
  });

  test("is set for the write, and dropped when the tab is put away", () => {
    expect(ownWrite(), "nothing written yet").toBe(false);

    loadAt("https://opendai.app/?doc=1#a=1&opener-doc=u", "replace");
    expect(calls, "the fragment moved, so a real load is asked for").toEqual([
      "replace https://opendai.app/?doc=1#a=1&opener-doc=u",
      "reload",
    ]);
    expect(ownWrite(), "between the write and the load it asks for").toBe(true);

    // The load never comes, and the tab is put away instead.
    fire("pagehide");
    expect(ownWrite(), "put away: the mark does not outlive it").toBe(false);
  });

  test("is dropped when the tab is shown again, which is what a restore is", () => {
    loadAt("https://opendai.app/elsewhere#opener-doc=u", "assign");
    expect(calls, "another address: one load, no reload after it").toEqual([
      "assign https://opendai.app/elsewhere#opener-doc=u",
    ]);
    expect(ownWrite()).toBe(true);

    fire("pageshow");
    expect(ownWrite(), "shown again: a link arriving now is a link").toBe(false);
  });

  test("is dropped when the navigation itself throws", () => {
    refuse = true;
    expect(() => loadAt("https://opendai.app/?doc=1#a=1&opener-doc=u", "replace")).toThrow("navigation refused");
    expect(ownWrite(), "nothing is loading, so nothing is this tab's own write").toBe(false);
  });
});
