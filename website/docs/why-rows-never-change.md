---
title: Why rows never change
---

# Why shared rows never change

A shared table is append-only. An edit is a new row, a delete is a new row,
and the table the application wrote is never updated in place. This page is
why, and what the rules on the [Constraints](/docs/constraints) page follow
from it.

## Two copies, no server

Two people each hold a copy of the document and change it while apart. When the
copies meet — a file opened, a link tapped, a batch pulled from the mailbox —
they have to end up the same, with nobody's change lost and no server to decide
between them.

If a row could be changed in place, meeting would mean choosing between two
versions of it, and the choice would depend on which copy you started from.
Append-only rows remove the choice: meeting is the **union** of the rows both
copies have. Union does not care about order, repetition or which side goes
first, so every copy that has seen the same rows holds the same table.

## What each row carries

The compiler adds the columns that make that work: who wrote the row
(`_r_replica`), its place in that writer's sequence (`_r_seq`), a logical clock
(`_r_lc`), which thing it is a version of (`_r_entity`), the versions it
replaces (`_r_parents`), whether it is a delete (`_r_deleted`), and — in a
session document — which session it belongs to (`_r_session`). A row is
**superseded** once a later row names it as a parent; the rows nothing
supersedes are the **heads**.

One head per entity is the ordinary case, and that is the row `t_current`
shows. Two heads means two copies edited the same thing without seeing each
other's edit: a conflict, shown with `_r_conflicted`, and settled by writing a
row that names both as parents. [Show a conflict](/docs/show-a-conflict)
covers what the application does with it.

## Why the rules follow

- **No UPDATE or DELETE** — they would change a row in place, and the triggers
  refuse them. Write through `window.dai.replicated`.
- **No PRIMARY KEY** — the key is `(_r_replica, _r_seq)`, and a counter two
  copies both advance allocates the same id for different rows.
- **No UNIQUE** — it refuses exactly the second row that makes a conflict
  visible.
- **No CHECK** — a check that differs between two versions of the application
  rejects the other copy's honest rows, invisibly.
- **Read `_current`** — the table itself holds every version of everything.
- **Store no derived state** — see [Why nothing derived is
  stored](/docs/why-nothing-derived).

## Where this was decided

The design record is the profiles and confidentiality draft,
[`docs/profiles-and-confidentiality-2.1.1.md`](https://github.com/dynamicapplicationinterface/dai-core/blob/main/docs/profiles-and-confidentiality-2.1.1.md),
and what changed while building it is the numbered decisions in
[`docs/replicated-tables.md`](https://github.com/dynamicapplicationinterface/dai-core/blob/main/docs/replicated-tables.md).
Where the two disagree, the numbered decision is what shipped.
