-- Connect Four by message · shape: session
--
-- The decision: two people play one game, each on their own phone, sending
-- the document back and forth. Both copies' moves must be kept, so the tables
-- are shared. And only the two people in a game may play it — a copy
-- forwarded to a third person must not let them drop a disc — so it is a
-- closed group of two: a session, not merely passable.
--
-- What that costs, and why:
--   * Every game is its own session. The creator plays Red and moves first;
--     whoever opens the invite takes the open seat and plays Yellow. Who is
--     Red and who is Yellow is read from the seats, never stored.
--   * No board, no turn, no winner. All of it is derived by replaying the
--     drops in turn order; a disc's row follows from gravity. Two drops at one
--     turn (the same player moved on two copies) is shown to the players to
--     settle, never decided silently.
--   * No UNIQUE(game_id, turn) and no CHECK on col: they would refuse exactly
--     the rows that make a collision visible, or another version's honest rows.
--   * Which game is showing is about this copy, so it is local.

-- dai:profile session max_parties=2 close=any

-- dai:replicated
CREATE TABLE IF NOT EXISTS games (
  red_name    TEXT NOT NULL,
  yellow_name TEXT NOT NULL
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS drops (
  game_id TEXT NOT NULL,     -- the games row's entity, as hex
  turn    INTEGER NOT NULL,  -- 1-based; Red plays odd turns, Yellow even
  col     INTEGER NOT NULL   -- 0..6, left to right
);

-- Local: never merged.
CREATE TABLE IF NOT EXISTS settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  active_game TEXT
);
