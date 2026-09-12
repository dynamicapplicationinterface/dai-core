/**
 * The stated roster: who is a member of a session (T1-D29).
 *
 * Admission is two replicated rows with different authors — a creator-authored
 * **seat** (random bytes, no replica id) and a joiner-authored **binding**
 * (`{ seat, replica }`, under the joiner's own fresh id). Membership is a **pure
 * function of those rows**, computed here, so any two copies holding the same
 * rows agree without a clock, an order, or a tiebreak — which is the whole
 * correction over the inferred roster that decided admission by a forgeable
 * Lamport integer.
 *
 * This module knows nothing about SQLite. A caller reads the seat and binding
 * rows for a session out of the database and passes them here; the enforcement
 * (dropping a non-member's rows at merge) reads the answer. Kept pure so the
 * rule can be tested as a set function, which is exactly what convergence needs
 * it to be.
 */

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A seat the creator minted for one invite. `seat` is random bytes. */
export interface Seat {
  seat: Uint8Array;
}

/** A joiner binding its own replica id to a seat it was invited to. */
export interface Binding {
  seat: Uint8Array;
  replica: Uint8Array;
}

export interface Roster {
  /** The replica ids that are members, as lowercase hex. */
  members: Set<string>;
  /** Seats bound by two or more distinct replicas: contested, `SEAT_ALREADY_BOUND`. */
  contested: string[];
  /** True when there are more seats than the signed cap: `SEATS_EXCEED_CAP`. */
  overCap: boolean;
}

/**
 * Computes the roster from a session's seats and bindings.
 *
 * A replica is a member iff it binds a seat that the session actually minted and
 * that is not contested. A seat bound by two distinct replicas admits neither —
 * order-free, because either a clock or a tiebreak would be the forgeable
 * ordering T1-D29 removed. More seats than `maxParties` is over the signed cap.
 *
 * `maxParties` is the signed bound; a caller that cannot supply it (a document
 * with no session block) has no roster to compute.
 */
export function rosterOf(seats: readonly Seat[], bindings: readonly Binding[], maxParties: number): Roster {
  const minted = new Set(seats.map((s) => hex(s.seat)));

  // Which distinct replicas bind each minted seat.
  const bySeat = new Map<string, Set<string>>();
  for (const binding of bindings) {
    const seat = hex(binding.seat);
    if (!minted.has(seat)) continue; // a binding to an unminted seat is not a member
    let replicas = bySeat.get(seat);
    if (!replicas) {
      replicas = new Set<string>();
      bySeat.set(seat, replicas);
    }
    replicas.add(hex(binding.replica));
  }

  const members = new Set<string>();
  const contested: string[] = [];
  for (const [seat, replicas] of bySeat) {
    if (replicas.size === 1) {
      members.add([...replicas][0]!);
    } else {
      // Two or more parties opened one invite: the seat admits neither.
      contested.push(seat);
    }
  }

  return { members, contested, overCap: seats.length > maxParties };
}

/** Whether a replica is admitted by the roster. */
export function isMember(roster: Roster, replica: Uint8Array): boolean {
  return roster.members.has(hex(replica));
}
