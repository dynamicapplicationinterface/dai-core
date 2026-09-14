# Tic-tac-toe by message

Two people play one game, each on their own phone, sending the document back
and forth. Every game is its own session: the creator plays X, whoever opens the
invite takes the open seat and plays O, and the moves cross by the mailbox. The
reasoning for each table is in `schema.sql`; the application is `app.js`.

## Copies built before 15 September 2026

Every tic-tac-toe built before 15 September 2026 has a weaker guard on its
`marks` table than the format promises, and a rebuilt copy is the only way to get
the stronger one.

A shared table is append-only: a change is a new row, never an edit in place,
and a trigger in the database refuses an in-place edit. The trigger has to name
every column. The build worked out the column list by parsing `schema.sql`, and
the parser lost any column preceded by a comment written after the previous
column's comma — which is this example's own style:

```sql
game_id TEXT NOT NULL,     -- the games row's entity, as hex
turn    INTEGER NOT NULL,  -- 1-based; X plays odd turns, O even
```

So in those copies the trigger named `game_id` and not `turn` or `cell`, and
those two columns of a supposedly append-only table could be edited in place.

What that meant in practice: this app never edits them — it writes marks through
`window.dai.replicated`, which only ever adds rows. The gap was open to code that
wrote the table with plain SQL: a change to the app, or somebody with the
browser's console on their own copy. An edited row keeps its id, so the other
player's copy keeps the original, and the two copies disagree without either
noticing.

What changed: the parser now ignores comments, and the build checks every shared
table's trigger against the columns SQLite reports — a column the trigger misses
is now a refused build, not a quiet hole.

**If you have a copy from before that date, build the example again.** The
trigger comes from the build, so a copy already on a phone keeps the one it was
built with. A rebuilt document is a new document: games in an old copy stay in
that copy. **If you copied this example's style** — a comment after a column's
comma in a shared table — rebuild your app too; the same two lines of a build
from before that date would have hidden your columns the same way.
