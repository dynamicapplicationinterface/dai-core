/**
 * What a host claims to apply, and how the claim is checked.
 *
 * A misconfigured host is silently insecure: nothing inside a container can
 * tell whether the frame it runs in was given the flags §4 requires. So a host
 * says what it applied on the handshake, as the list of §4 clauses it holds —
 * named by the isolation probe's own check ids, because the probe is the
 * judge. A host's word is never taken for it: the probe is mounted in the
 * host, and every clause the host claimed must come back "blocked". A claim
 * the probe finds open is a failing host, in CI and anywhere else the probe is
 * run.
 */

/** The checks the isolation probe makes, by id. One per §4 clause. */
export const ISOLATION_CLAUSES = [
  "origin", // the frame has no origin in common with the shell
  "shell", // the shell's document is out of reach
  "popup", // window.open is refused
  "network", // fetch is refused by policy, with a violation report
  "socket", // WebSocket is refused
  "evaluation", // a string cannot be evaluated as code
  "inline", // an injected inline script does not run
  "handler", // an inline event handler does not run
  "storage", // localStorage is an in-memory stand-in, never the host's
] as const;

export type IsolationClause = (typeof ISOLATION_CLAUSES)[number];

/** One line of the probe's report. */
export interface ProbeResult {
  id: string;
  status: "blocked" | "allowed";
}

export interface ClaimVerdict {
  ok: boolean;
  /** Claimed, and the probe found them open. A failing host. */
  broken: string[];
  /** Held according to the probe, but not claimed. Honest, if odd. */
  unclaimed: string[];
  /** Claimed, but the probe never checked them. Unverifiable, so not ok. */
  unchecked: string[];
}

/**
 * Holds a host's claim against what the probe actually found.
 *
 * Strict in one direction only: a host may hold more than it claims, but it
 * may not claim what it does not hold, and it may not claim something the
 * probe cannot see.
 */
export function verifyClaim(claimed: readonly string[], results: readonly ProbeResult[]): ClaimVerdict {
  const seen = new Map(results.map((result) => [result.id, result.status]));
  const broken = claimed.filter((id) => seen.get(id) === "allowed");
  const unchecked = claimed.filter((id) => !seen.has(id));
  const unclaimed = results
    .filter((result) => result.status === "blocked" && !claimed.includes(result.id))
    .map((result) => result.id);
  return { ok: broken.length === 0 && unchecked.length === 0, broken, unclaimed, unchecked };
}

/**
 * What a person is told on a launch card, and the clauses that make it true.
 *
 * A tick is not this host's opinion of itself. Each one names the §4 clauses
 * it rests on, and a host may show it only while it applies all of them — the
 * same list it declares to every container, which the probe checks. Take a
 * clause away and the sentence it backed disappears. A host may say less than
 * it does, and never more.
 *
 * These are all statements about the host, not about the document: what no
 * document running here will be able to do. Nothing can be said about a
 * particular document's behaviour before it has run, so nothing is.
 */
export interface Claim {
  id: string;
  /** The sentence, as somebody reads it. */
  says: string;
  needs: readonly IsolationClause[];
}

export const CLAIMS: readonly Claim[] = [
  { id: "offline", says: "Can't go online", needs: ["network", "socket"] },
  {
    id: "contained",
    says: "Can't see your other tabs, files or apps",
    needs: ["origin", "shell", "storage"],
  },
  { id: "windows", says: "Can't open windows or take you somewhere else", needs: ["popup"] },
  {
    id: "sealed",
    says: "Runs only what was sealed inside it",
    needs: ["inline", "handler", "evaluation"],
  },
];

/** The claims a host holding these clauses may display, and no others. */
export function claimsFor(applied: readonly string[]): Claim[] {
  return CLAIMS.filter((claim) => claim.needs.every((need) => applied.includes(need)));
}
