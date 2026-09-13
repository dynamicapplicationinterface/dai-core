---
title: Your first two-player app
---

# Your first two-player app

Tic-tac-toe by message: two people, each on their own phone, sending one
document back and forth. It is
[`examples/tic-tac-toe`](https://github.com/dynamicapplicationinterface/dai-core/tree/main/examples/tic-tac-toe),
and it is exercised end to end — two devices, real files — by
`tests/examples-shared.spec.ts`.

## 1. Decide the shape

Both copies' marks must be kept, so the tables are shared. And it is a closed
group of two: a copy forwarded to a third person must not let them play. That
is a **session**, not merely [passable](/docs/choose-a-shape).

## 2. Declare the tables, and the profile

<<< @/../examples/tic-tac-toe/schema.sql

Two shared tables, `games` and `marks`, and one local one. There is no board
column, no turn and no winner: all three are computed from the marks every time
they are drawn.

<!--@include: ./parts/constraint/SESSION-PROFILE.md-->

<!--@include: ./parts/constraint/SHARED-NO-DERIVED-STATE.md-->

## 3. A new game is a new session

Starting a game creates a session — which seats this copy and leaves one seat
open — and then inserts the `games` row into it. In `app.js` that is the
`new-game` submit handler.

<!--@include: ./parts/constraint/SESSION-CREATE.md-->

<!--@include: ./parts/constraint/SESSION-ROW-CARRIES-SESSION.md-->

## 4. Invite, and take the seat

The Invite button asks the host to share: the host makes the link that carries
the document and the key. When the other person opens it, the application
binds the open seat — once at start-up, and again only when a file or link is
opened, never on a background merge. That is `joinIfInvited` in `app.js`.

<!--@include: ./parts/constraint/SESSION-INVITE.md-->

<!--@include: ./parts/constraint/SESSION-JOIN-ON-OPEN.md-->

## 5. Read, derive, redraw

Every read is from a `_current` view; `state()` replays the marks in turn
order to get the board. When the other player's marks arrive, `dai:merged`
fires and the application draws again.

<!--@include: ./parts/constraint/SHARED-READ-CURRENT.md-->

<!--@include: ./parts/constraint/SHARED-REDRAW-ON-MERGE.md-->

## 6. Say who is outside, and why

A copy can hold the game without being in it: it was forwarded rather than
invited, or its seat was taken on another device, or the match is closed. The
application says which, instead of showing a board that silently ignores taps.
If two people open the same invite, the seat is contested and the creator is
offered a fresh invite.

<!--@include: ./parts/constraint/SESSION-MEMBERSHIP.md-->

<!--@include: ./parts/constraint/SESSION-CONTESTED-SEAT.md-->

## 7. Finish, then close

Winning is a mark like any other. Closing the match is a separate act, offered
only when the game is over.

<!--@include: ./parts/constraint/SESSION-CLOSE.md-->

## The whole application

::: details app.js
<<< @/../examples/tic-tac-toe/app.js
:::

::: details index.html
<<< @/../examples/tic-tac-toe/index.html
:::

## Try it

```bash
npx dai build ./examples/tic-tac-toe -n "Tic-tac-toe"
```

Open the file in the [DAI opener](https://opendai.app), start a game, make the
first move and press Invite. Open the link on a second device: it takes the
open seat and it is O's move. Shared tables are written only under a host, so
the opener — not a file double-clicked into a browser — is where this works;
see [SHARED-NEEDS-HOST](/docs/constraints#SHARED-NEEDS-HOST).
