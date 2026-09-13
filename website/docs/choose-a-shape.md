---
title: Choose a shape
---

# Choose a shape

Start here. Every DAI application is one of four shapes, and the shape is
decided before a single table is written. It decides which tables are shared,
whether there is a session, and which of the [constraints](/docs/constraints)
apply to you.

It comes first because it cannot be fixed afterward by editing a table. The
first chess application written for DAI was never asked this question: it
marked its tables shared and then stored the board in one of them, which is
wrong the moment two copies merge. [Why nothing derived is
stored](/docs/why-nothing-derived) shows that application beside the correct
one.

<!--@include: ./parts/shapes.md-->

## What the runtime actually knows

The runtime tells apart three configurations, not four: no replicated tables,
replicated tables, and replicated tables with a session profile. Solo and
broadcast are the same thing to it today. The difference between a publisher
and the people reading their document is a promise the application makes, and
nothing enforces it until the confidentiality levels exist — so a broadcast
application is built exactly as a solo one, and says nothing it cannot back.

## Then

- **Solo** — [Your first app](/docs/first-app) walks through one.
- **Passable** — [Share a table](/docs/share-a-table), and the receipts
  application in [Examples](/docs/examples#passable).
- **Session** — [Your first two-player app](/docs/two-player-app), then
  [Run a session](/docs/run-a-session).
- **Broadcast** — build it as solo, and read
  [SHAPE-BROADCAST-CONVENTION](/docs/constraints#SHAPE-BROADCAST-CONVENTION).
