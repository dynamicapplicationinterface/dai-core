---
title: Writing apps
---

# Writing an app that runs in a container

This part of the documentation is about the code *inside* a `.dai` file — the
application itself, not the tooling that builds one and not the host that opens
it. If you are building a host, you want the [host bridge](/docs/host-bridge).

**Start with [Choose a shape](/docs/choose-a-shape).** Solo, passable, session
or broadcast: the answer decides which tables are shared and which constraints
apply, and it cannot be fixed afterward by editing a table.

**For an AI:** fetch [`/llms-full.txt`](/llms-full.txt) — see [For AI
models](/docs/the-recipe).

## Find what you came for

- **Learning** — [Your first app](/docs/first-app) (solo), [Your first
  two-player app](/docs/two-player-app) (session).
- **Doing one thing** — [Share a table](/docs/share-a-table), [Run a
  session](/docs/run-a-session), [Show a conflict](/docs/show-a-conflict),
  [Redraw when rows arrive](/docs/redraw-on-merge).
- **Looking something up** — [Constraints](/docs/constraints): every rule, by
  id, with its reason and what enforces it. [Runtime API](/docs/runtime-api),
  [Schema](/docs/schema-reference), [Refusals](/docs/refusals).
- **Understanding why** — [Why rows never change](/docs/why-rows-never-change),
  [Why nothing derived is stored](/docs/why-nothing-derived), [Seats and
  contested seats](/docs/seats-and-contested-seats).
- **Seeing it whole** — [Examples](/docs/examples), one complete application
  per shape.

## One document {#one-document}

<!--@include: ./parts/constraint/ONE-DOCUMENT.md-->

## Sharing {#sharing}

<!--@include: ./parts/constraint/SHARE-THROUGH-HOST.md-->
