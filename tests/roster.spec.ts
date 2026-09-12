import { expect, test } from "@playwright/test";
import { rosterOf, isMember, type Binding, type Seat } from "../src/replicated-roster.js";

/**
 * The stated roster, as a set function (T1-D29).
 *
 * Admission is creator-authored seats and joiner-authored bindings, and
 * membership is a pure function of them — which is what lets two copies agree
 * without a clock. These check the rule directly, including the property the
 * whole correction rests on: the answer does not depend on the order the rows
 * are considered in.
 */

const bytes = (b: number): Uint8Array => new Uint8Array(16).fill(b);
const CREATOR = bytes(0xc0);
const OPENER = bytes(0x0b);
const FORWARDED = bytes(0xff);
const SEAT1 = bytes(0x01);
const SEAT2 = bytes(0x02);
const hx = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");

const seat = (s: Uint8Array): Seat => ({ seat: s });
const bind = (s: Uint8Array, r: Uint8Array): Binding => ({ seat: s, replica: r });

test.describe("the stated roster (T1-D29)", () => {
  test("a bound seat makes its replica a member; an open seat makes no one one", () => {
    // Creator minted two seats and bound itself to one; the other is still open.
    const roster = rosterOf([seat(SEAT1), seat(SEAT2)], [bind(SEAT1, CREATOR)], 2);
    expect(isMember(roster, CREATOR)).toBe(true);
    expect(roster.members.size).toBe(1); // the open seat admits no one
    expect(roster.contested).toEqual([]);
    expect(roster.overCap).toBe(false);
  });

  test("both seats bound is a full roster of two", () => {
    const roster = rosterOf(
      [seat(SEAT1), seat(SEAT2)],
      [bind(SEAT1, CREATOR), bind(SEAT2, OPENER)],
      2,
    );
    expect(roster.members).toEqual(new Set([hx(CREATOR), hx(OPENER)]));
  });

  test("forwarded-copy-cannot-enter: a second binding contests the seat, admitting neither", () => {
    // The opener bound seat 2; a forwarded copy opened the same invite and bound
    // it too. The seat is contested — no clock picks a winner — so neither is a
    // member, and the forwarded copy cannot enter (nor does it erase the opener's
    // own rows, because membership is decided here, not by dropping after play).
    const roster = rosterOf(
      [seat(SEAT1), seat(SEAT2)],
      [bind(SEAT1, CREATOR), bind(SEAT2, OPENER), bind(SEAT2, FORWARDED)],
      2,
    );
    expect(isMember(roster, CREATOR)).toBe(true);
    expect(isMember(roster, OPENER)).toBe(false);
    expect(isMember(roster, FORWARDED)).toBe(false);
    expect(roster.contested).toEqual([hx(SEAT2)]);
  });

  test("a binding to a seat the session never minted is not membership", () => {
    // The forgery the two-row model refuses: a replica cannot admit itself by
    // binding a seat the creator never stated.
    const roster = rosterOf([seat(SEAT1)], [bind(SEAT1, CREATOR), bind(bytes(0x99), FORWARDED)], 2);
    expect(isMember(roster, FORWARDED)).toBe(false);
    expect(roster.members).toEqual(new Set([hx(CREATOR)]));
  });

  test("roster-closes-at-max-parties: more seats than the signed cap is over-cap", () => {
    const roster = rosterOf([seat(SEAT1), seat(SEAT2), seat(bytes(0x03))], [], 2);
    expect(roster.overCap).toBe(true);
  });

  test("the answer does not depend on the order the rows are considered in", () => {
    // Convergence, stated as a property: any permutation of the same rows yields
    // the identical roster. A clock or a tiebreak would fail this.
    const seats = [seat(SEAT1), seat(SEAT2)];
    const bindings = [bind(SEAT1, CREATOR), bind(SEAT2, OPENER), bind(SEAT2, FORWARDED)];
    const canonical = (r: ReturnType<typeof rosterOf>): string =>
      JSON.stringify([[...r.members].sort(), [...r.contested].sort(), r.overCap]);

    const base = canonical(rosterOf(seats, bindings, 2));
    for (const perm of [
      [...bindings].reverse(),
      [bindings[2]!, bindings[0]!, bindings[1]!],
      [bindings[1]!, bindings[2]!, bindings[0]!],
    ]) {
      expect(canonical(rosterOf([...seats].reverse(), perm, 2))).toBe(base);
    }
  });
});
