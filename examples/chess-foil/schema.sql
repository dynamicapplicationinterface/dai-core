-- THE FOIL. Deliberately wrong; see README.md. The correct schema is
-- tests/fixture/chess/schema.sql.

-- dai:replicated
CREATE TABLE IF NOT EXISTS games (
  white_name      TEXT NOT NULL,
  black_name      TEXT NOT NULL,
  fen             TEXT NOT NULL,             -- WRONG: the board, derivable from moves
  turn            TEXT NOT NULL CHECK (turn IN ('w','b')),  -- WRONG: derivable, and a CHECK
  result          TEXT NOT NULL DEFAULT '*', -- WRONG: derivable
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')), -- WRONG: a second opinion about order
  selected_square TEXT,                      -- WRONG: this copy's UI state, shared
  -- WRONG: theme is this copy's setting, shared
  theme           TEXT NOT NULL DEFAULT 'system'
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS moves (
  game_id TEXT NOT NULL,
  ply     INTEGER NOT NULL,
  san     TEXT NOT NULL,
  -- WRONG: refuses the conflict a merge exists to show
  UNIQUE (game_id, ply)
);
