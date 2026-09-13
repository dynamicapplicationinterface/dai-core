---
title: Examples
---

# Examples

One complete application per shape, each with the decision that led to it
stated first — in its own `schema.sql`, where the next person to change it will
read it. These are the same applications the [model file](/docs/the-recipe)
hands an assistant, copied from these directories by the build and held to
them by a test.

## Solo {#solo}

**Beach trip** — a packing list for one family, on one phone.
[`examples/packing-list`](https://github.com/dynamicapplicationinterface/dai-core/tree/main/examples/packing-list)

<<< @/../examples/packing-list/schema.sql

Written with the kit and no JavaScript; [Your first app](/docs/first-app) walks
through it.

## Passable {#passable}

**Receipts** — two people in one household add the receipts they paid for and
hand the document back and forth.
[`examples/receipts`](https://github.com/dynamicapplicationinterface/dai-core/tree/main/examples/receipts)

<<< @/../examples/receipts/schema.sql

::: details app.js
<<< @/../examples/receipts/app.js
:::

::: details index.html
<<< @/../examples/receipts/index.html
:::

What to look for: every shared write goes through `window.dai.replicated`;
every read is from `receipts_current`; who owes whom is computed in SQL on every
draw; `dai:merged` redraws; and a receipt edited on both copies is shown with a
choice ([Show a conflict](/docs/show-a-conflict)).

## Session {#session}

**Tic-tac-toe** — two people play by sending the document back and forth.
[`examples/tic-tac-toe`](https://github.com/dynamicapplicationinterface/dai-core/tree/main/examples/tic-tac-toe)

<<< @/../examples/tic-tac-toe/schema.sql

[Your first two-player app](/docs/two-player-app) walks through it, with the
whole source.

The larger session application in the repository is chess,
[`tests/fixture/chess`](https://github.com/dynamicapplicationinterface/dai-core/tree/main/tests/fixture/chess):
three shared tables, a board derived by replaying the moves through an engine,
and draw offers, claims and resignations as rows.

## Broadcast {#broadcast}

No example yet. A broadcast application is built exactly as a solo one today
([SHAPE-BROADCAST-CONVENTION](/docs/constraints#SHAPE-BROADCAST-CONVENTION)),
and an example will be added when there is a real one rather than an invented
one.

## The mistake, beside the fix {#foil}

[Why nothing derived is stored](/docs/why-nothing-derived) puts a deliberately
wrong chess application beside the correct one. The difference between them is
four constraints at once.

## Both shared examples are tested

`tests/examples-shared.spec.ts` compiles the receipts and tic-tac-toe
applications, opens each on separate devices in the real host, and drives them
by clicking, with the rows travelling by file — including the conflict, the
invite, a forwarded copy that was never invited, and a seat two people took.
