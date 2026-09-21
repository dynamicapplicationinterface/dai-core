import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * The home-screen badge count (backlog D34), from the one script the service
 * worker and the opener both load. Loaded here as it is there, not copied: a
 * second copy of the rule would be the thing to test instead of this one.
 */

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../apps/runner/public/badge.js"), "utf8");

interface Entry {
  uuid: string;
  waiting: string[];
  moved: string[];
  shown?: number;
}
interface Badge {
  count(entry: Entry | null): number;
  afterReport(entry: Entry | null, uuid: string, sessions: unknown[]): Entry;
  afterPush(entry: Entry | null, uuid: string, game: string): Entry;
  afterOpen(entry: Entry | null, uuid: string): Entry;
  show(n: number): Promise<unknown>;
}

/** Runs badge.js against a scope of our choosing, as a worker or a window would. */
function load(scope: Record<string, unknown>): Badge {
  new Function("self", source)(scope);
  return scope.daiBadge as Badge;
}

const A = "a".repeat(32);
const B = "b".repeat(32);
const DOC = "11111111-1111-4111-8111-111111111111";

test.describe("the badge count", () => {
  const badge = load({});

  test("a move arriving for a game not already waiting raises the count, and two games show 2", () => {
    const reported = badge.afterReport(null, DOC, []);
    const first = badge.afterPush(reported, DOC, A);
    expect(first.shown).toBe(1);
    const second = badge.afterPush(first, DOC, B);
    expect(second.shown).toBe(2);
  });

  test("a document that never reported is not counted at all", () => {
    /*
     * The number means "games waiting on you", and only the application knows
     * that. For a document that never says, a count would be the worker
     * guessing on its behalf, and nothing it does could correct the guess —
     * the correction *is* the report. So it stays silent (D34).
     */
    const never = badge.afterPush(null, DOC, A);
    expect(never.shown, "a push for a document that never reported shows nothing").toBe(0);
    const twice = badge.afterPush(never, DOC, B);
    expect(twice.shown, "and a second one still shows nothing").toBe(0);

    // The moment it reports, it counts — including what moved while it was shut.
    const reported = badge.afterReport(twice, DOC, [A, B]);
    expect(badge.count(reported)).toBe(2);
    const oneAnswered = badge.afterReport(reported, DOC, [B]);
    expect(badge.count(oneAnswered), "a game it no longer lists drops out").toBe(1);
    expect(badge.count(badge.afterReport(oneAnswered, DOC, [])), "and none is none").toBe(0);
  });

  test("guard: a push for a game already waiting on this player does not raise it", () => {
    // Reported waiting on A (their turn). A push for A (a rename, a resend, the
    // second batch of one move) is not a new turn.
    const reported = badge.afterReport(null, DOC, [A]);
    expect(badge.count(reported)).toBe(1);
    expect(badge.afterPush(reported, DOC, A).shown).toBe(1);
  });

  test("guard: a game that moves twice before the app is opened counts once", () => {
    const once = badge.afterPush(badge.afterReport(null, DOC, []), DOC, A);
    expect(badge.afterPush(once, DOC, A).shown).toBe(1);
  });

  test("the app's report is the truth: it replaces what moved, and a game it no longer lists drops out", () => {
    const moved = badge.afterPush(badge.afterPush(badge.afterReport(null, DOC, [A]), DOC, A), DOC, B);
    expect(badge.count(moved)).toBe(2);
    // Opened; the player moved in A and B is now their turn.
    const reported = badge.afterReport(moved, DOC, [B]);
    expect(reported).toEqual({ uuid: DOC, waiting: [B], moved: [], shown: 0, reports: true });
    expect(badge.count(reported)).toBe(1);
  });

  test("opening the document clears what moved and shows nothing, keeping the last report", () => {
    const moved = badge.afterPush(badge.afterReport(null, DOC, [A]), DOC, B);
    expect(badge.afterOpen(moved, DOC)).toEqual({ uuid: DOC, waiting: [A], moved: [], shown: 0, reports: true });
  });

  test("only session ids are kept from a report, once each", () => {
    expect(badge.afterReport(null, DOC, [A, A, "not-a-session", 7, B.toUpperCase()]).waiting).toEqual([A]);
  });

  test("an entry is one document's: a push for one leaves another's count alone", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const theirs = badge.afterReport(null, other, [A]);
    // Both documents have reported, so the only thing separating them is which
    // entry the push lands in.
    const ours = badge.afterPush(badge.afterReport(null, DOC, []), DOC, B);
    expect(ours.uuid).toBe(DOC);
    expect(badge.count(theirs)).toBe(1);
    expect(ours.shown).toBe(1);
  });
});

test.describe("showing it on the icon", () => {
  test("sets the number, and clears at zero", async () => {
    const calls: string[] = [];
    const badge = load({
      navigator: {
        setAppBadge: async (n: number) => void calls.push(`set ${n}`),
        clearAppBadge: async () => void calls.push("clear"),
      },
    });
    expect(await badge.show(2)).toBe(2);
    expect(await badge.show(0)).toBe(0);
    expect(calls).toEqual(["set 2", "clear"]);
  });

  test("where the API is absent, or throws, nothing throws", async () => {
    expect(await load({ navigator: {} }).show(3)).toBe("unsupported");
    expect(await load({}).show(0)).toBe("unsupported");
    const throwing = load({
      navigator: {
        setAppBadge: () => {
          throw new Error("not allowed");
        },
      },
    });
    expect(await throwing.show(1)).toBe("unsupported");
    const rejecting = load({ navigator: { setAppBadge: () => Promise.reject(new Error("denied")) } });
    expect(await rejecting.show(1)).toBe(1);
  });
});
