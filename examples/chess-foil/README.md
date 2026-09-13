# The chess foil — how not to build a shared document

**This is a deliberately wrong application, kept as a teaching foil.** It is a
reconstruction, not the original: the first chess application a model wrote
from the recipe of the time stored the board, and that version was never
committed to this repository. This one was written on purpose to make the same
mistakes, so that it can sit beside the correct one and the difference can be
read.

The correct application is [`tests/fixture/chess`](../../tests/fixture/chess).
Read its `schema.sql` beside the one here.

Only the two files that carry the lesson are here — `schema.sql` and
`store.js`. They do not build into a working application, and they should not:
`dai check` refuses them, and `tests/rules.spec.ts` asserts that it refuses them
for exactly the reasons below and that the correct application passes.

## What is wrong, and which constraint it breaks

**It stores what it should derive.** `games` holds `fen` (the board), `turn`,
`result` and `updated_at`. Each is computable from the moves. After two copies
merge, each copy's stored board was computed from the moves *it* had, and
neither was computed from the union — so the board on screen disagrees with the
moves beneath it, differently on each copy.
Constraint: **SHARED-NO-DERIVED-STATE**. The correct one stores no board, no
turn, no result and no timestamp, and replays `moves` through the engine.

**It changes shared rows in place.** Every move runs `UPDATE games SET fen = …`.
A replicated table is append-only: the UPDATE is refused with
`REPLICATED_TABLE_IMMUTABLE`, and a raw `INSERT INTO moves` fails for want of
the replication columns. Constraint: **SHARED-WRITE-SURFACE**. The correct one
writes every shared row through `window.dai.replicated.insert`.

**It shares what belongs to one copy.** `selected_square` and `theme` sit in
the shared `games` table, so one player's tap selects a square on the other
player's screen. Constraint: **SHARED-LOCAL-STAYS-LOCAL**. The correct one keeps
them in local `settings` and `ui_state` tables.

**It forbids the conflict it should show.** `UNIQUE (game_id, ply)` on `moves`
means two moves at the same turn — the case a merge exists to surface — is a
constraint violation instead of something a person sees and settles.
Constraint: **SHARED-NO-UNIQUE-CHECK** and **SHARED-SURFACE-CONFLICTS**. The
correct one allows both rows and, in `store.js` `state()`, detects two legal
moves at one ply and asks the players which stands.

**It reads the table, not the view, and never redraws.** `SELECT … FROM moves`
returns superseded and deleted rows beside current ones, and nothing listens for
`dai:merged`, so the other player's move never appears until a reload.
Constraints: **SHARED-READ-CURRENT**, **SHARED-REDRAW-ON-MERGE**.

**It never decided its shape.** It marks tables shared and has no session
profile, so a copy forwarded to a third person could play. Two people and a
closed game is a session. Constraint: **SHAPE-FIRST**, **SESSION-PROFILE**.
