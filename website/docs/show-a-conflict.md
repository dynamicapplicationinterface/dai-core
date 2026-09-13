---
title: Show a conflict
---

# Show a conflict

Two copies can act before they meet, and when they do the application shows it
and lets the person decide. Nothing picks a winner silently.

<!--@include: ./parts/constraint/SHARED-SURFACE-CONFLICTS.md-->

## The same row, edited on both copies

In the receipts application, a receipt edited on both phones comes back from
`receipts_current` with `_r_conflicted = 1`. The row gets a "Changed twice —
choose" button; `openConflict` lists the competing versions from
`receipts_heads` (a deleted version shows as "Deleted on one copy"); choosing
one writes it with `change`, or `remove` for the deleted one, and that write
settles the conflict because it names every current version as its parent.
`tests/examples-shared.spec.ts` does exactly this across two devices.

::: details examples/receipts/app.js
<<< @/../examples/receipts/app.js
:::

## Two new rows that claim one slot

Replication cannot see this kind: the two rows are different entities. In
tic-tac-toe, two marks at the same turn are found by `state()` while it replays
the marks, and shown as a choice of which mark stands; the other is removed.
The same shape applies to two moves at one ply in chess, or two people taking
one shift.

## Why a merge does not just pick one

A merge that kept one version and hid the other would read to a person as lost
data, and which one "won" would depend on the order the files happened to
arrive in. The runtime does pick one deterministically for `_current`, so every
copy shows the same thing — and marks it, so the person can see there is
something to decide.
