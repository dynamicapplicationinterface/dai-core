-- Velvet Chess · schema version 2 (replicated)
--
-- Three replicated tables hold everything both players must agree on.
-- They are append-only: the compiler adds the _r_* columns, the composite
-- primary key, the immutability triggers and the *_heads / *_current /
-- *_conflicts views. The application never writes an _r_* column and never
-- runs UPDATE or DELETE against these tables.
--
-- Rules the author followed, and why:
--   * No PRIMARY KEY, UNIQUE or CHECK on replicated tables. The key is the
--     replica's; a UNIQUE(game_id, ply) would refuse the very rows that
--     union merge exists to surface as a conflict; a CHECK that differs
--     between two copies shows up as rejected rows, not a refused merge.
--   * No board, no turn, no result, no timestamp. All of it is derived by
--     replaying `moves` through the engine in `ply` order.
--   * A game's identity is the entity of its `games` row. `game_id` in the
--     other two tables is that entity, as hex.
--
-- Profile (Track 3): each game is a session of two, and either player may end
--   one (close=any — a resignation, and later a retire). The creator seats
--   itself and leaves an open seat; the invitee binds it. A forwarded copy that
--   opens an already-bound invite contests the seat rather than entering, and
--   the app says so. Every row of a game carries its session.
-- dai:profile session max_parties=2 close=any

-- dai:replicated
CREATE TABLE IF NOT EXISTS games (
  white_name    TEXT NOT NULL,
  black_name    TEXT NOT NULL,
  creator_color TEXT NOT NULL,   -- 'w' | 'b'
  initial_fen   TEXT NOT NULL
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS moves (
  game_id    TEXT NOT NULL,      -- hex entity of the games row
  ply        INTEGER NOT NULL,   -- 1-based; the move's own ordinal, the only ordering key
  color      TEXT NOT NULL,      -- 'w' | 'b' — the side that claims to have moved
  from_sq    TEXT NOT NULL,
  to_sq      TEXT NOT NULL,
  promotion  TEXT,               -- 'q' | 'r' | 'b' | 'n' | NULL
  san        TEXT NOT NULL,      -- for display only; the engine recomputes it
  draw_offer INTEGER NOT NULL DEFAULT 0
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS game_events (
  game_id   TEXT NOT NULL,
  after_ply INTEGER NOT NULL,    -- the ply count the event was made at; only valid at that count
  color     TEXT NOT NULL,       -- the side acting
  kind      TEXT NOT NULL,       -- 'resign' | 'draw-accept' | 'draw-decline' | 'claim'
  detail    TEXT NOT NULL DEFAULT ''
);

-- Local tables. Never merged; they describe this copy, not the game.

CREATE TABLE IF NOT EXISTS settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  theme          TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  animations     INTEGER NOT NULL DEFAULT 1 CHECK (animations IN (0,1)),
  active_game_id TEXT,
  seed_completed INTEGER NOT NULL DEFAULT 0,
  setup_you      TEXT NOT NULL DEFAULT '',
  setup_them     TEXT NOT NULL DEFAULT '',
  setup_color    TEXT NOT NULL DEFAULT 'random' CHECK (setup_color IN ('random','w','b'))
);

CREATE TABLE IF NOT EXISTS ui_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  current_view    TEXT NOT NULL DEFAULT 'board',
  orientation     TEXT NOT NULL DEFAULT 'w',
  selected_square TEXT,
  promotion_from  TEXT,
  promotion_to    TEXT
);

-- A tentative move lives here until the player commits it. It is this copy's
-- private state: it never travels, so nothing about it is a shared fact.
CREATE TABLE IF NOT EXISTS drafts (
  game_id    TEXT PRIMARY KEY,
  from_sq    TEXT NOT NULL,
  to_sq      TEXT NOT NULL,
  promotion  TEXT,
  draw_offer INTEGER NOT NULL DEFAULT 0
);

-- Per-copy facts about a game: which game is the bundled practice board,
-- which games this copy has hidden, and the photos this person attached.
CREATE TABLE IF NOT EXISTS local_games (
  game_id  TEXT PRIMARY KEY,
  is_demo  INTEGER NOT NULL DEFAULT 0,
  hidden   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS photos (
  game_id TEXT NOT NULL,
  color   TEXT NOT NULL CHECK (color IN ('w','b')),
  bytes   BLOB NOT NULL,
  PRIMARY KEY (game_id, color)
);
