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
