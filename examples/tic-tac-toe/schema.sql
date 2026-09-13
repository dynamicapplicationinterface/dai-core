-- Tic-tac-toe by message · shape: session
--
-- The decision: two people play one game, each on their own phone, sending
-- the document back and forth. Both copies' marks must be kept, so the tables
-- are shared. And it is a closed group of two — a copy forwarded to a third
-- person must not let them play — so it is a session, not merely passable.
--
-- What that costs, and why:
--   * Every game is its own session. The creator plays X; whoever opens the
--     invite takes the open seat and plays O. Who is X and who is O is read
--     from the seats, never stored.
--   * No board, no turn, no winner. All of it is derived by replaying marks in
--     turn order. Two marks at one turn (the same side moved on two copies) is
--     shown to the players to settle, never decided silently.
--   * No UNIQUE(game_id, turn): it would refuse exactly the rows that make a
--     collision visible.
--   * Which game is showing is about this copy, so it is local.

-- dai:profile session max_parties=2 close=any

-- dai:replicated
CREATE TABLE IF NOT EXISTS games (
  x_name TEXT NOT NULL,
  o_name TEXT NOT NULL
);

-- cell is 0..8, left to right, top to bottom. (No comment after the last
-- column: see SHARED-NO-TRAILING-COMMENT.)
-- dai:replicated
CREATE TABLE IF NOT EXISTS marks (
  game_id TEXT NOT NULL,     -- the games row's entity, as hex
  turn    INTEGER NOT NULL,  -- 1-based; X plays odd turns, O even
  cell    INTEGER NOT NULL
);

-- Local: never merged.
CREATE TABLE IF NOT EXISTS settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  active_game TEXT
);
