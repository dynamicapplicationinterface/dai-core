---
title: Why nothing derived is stored
---

# Why nothing derived is stored

The first chess application written for DAI stored the board. It was a
reasonable thing to do in an ordinary application and exactly the wrong thing
in a shared one, and the difference between it and the correct version teaches
four constraints at once.

That first version was never kept. The one below is a **deliberate
reconstruction**, labeled as such in
[`examples/chess-foil`](https://github.com/dynamicapplicationinterface/dai-core/tree/main/examples/chess-foil),
written to make the same mistakes. The lint refuses it for exactly those
reasons, and a test holds it to that.

## The two schemas

The foil:

<<< @/../examples/chess-foil/schema.sql

The application that works —
[`tests/fixture/chess`](https://github.com/dynamicapplicationinterface/dai-core/tree/main/tests/fixture/chess):

<<< @/../tests/fixture/chess/schema.sql

## What the difference teaches

**Derive, don't store.** The foil's `games` row holds the board (`fen`), whose
turn it is, the result and when it was last updated. Each copy computed those
from the moves *it* had. After two copies merge, neither was computed from the
union, so the board on screen disagrees with the moves underneath it — and
differently on each copy. The correct version stores only what a person did —
a game, its moves, its resignations and draw offers — and replays the moves
every time it draws.

<!--@include: ./parts/constraint/SHARED-NO-DERIVED-STATE.md-->

**Append, don't change.** The foil runs `UPDATE games SET fen = …` on every
move. A shared table is append-only, so the runtime refuses it.

<!--@include: ./parts/constraint/SHARED-WRITE-SURFACE.md-->

**Local stays local.** The foil keeps the selected square and the theme in the
shared `games` table, so one player's tap selects a square on the other
player's screen. The correct version has `settings`, `ui_state` and `drafts`,
which never travel.

<!--@include: ./parts/constraint/SHARED-LOCAL-STAYS-LOCAL.md-->

**Let the conflict exist.** The foil puts `UNIQUE (game_id, ply)` on moves, so
two moves at the same turn — the very thing a merge exists to show — is an
error instead of something the players see. The correct version allows both
rows and asks which one stands.

<!--@include: ./parts/constraint/SHARED-NO-UNIQUE-CHECK.md-->

The foil also reads the `moves` table itself instead of `moves_current`, never
listens for `dai:merged`, and declares no session although it is a closed game
of two. All of it traces back to the question it was never asked:
[Choose a shape](/docs/choose-a-shape).
