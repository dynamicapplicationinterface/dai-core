-- Family chores · shape: passable
--
-- The decision: several people in one family add chores and tick them off,
-- each on their own phone, and the document is handed around so that every
-- copy's changes are kept. A family is more than two people and has no
-- fixed roster, so this is passable, not a session.
--
-- What that costs, and why:
--   * members, chores and completions are shared. They are written through
--     window.dai.replicated and read through the _current views.
--   * No PRIMARY KEY, UNIQUE or CHECK on them. A chore's identity is its
--     entity. Two people ticking the same chore on the same day is two
--     completions; the page counts the chore as done once.
--   * Nothing derived is stored: whether a chore is done, and each person's
--     progress this week, are computed from the completions every time.
--   * A completion is a fact somebody entered (the day it was done), not a
--     record of when the row was written.
--   * Which person the screen is filtered to is about this copy, so it is
--     local.

-- dai:replicated
CREATE TABLE IF NOT EXISTS members (
  name TEXT NOT NULL
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS chores (
  title     TEXT NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',   -- the members row's entity, as hex; '' for anyone
  cadence   TEXT NOT NULL                 -- 'daily' or 'weekly'
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS completions (
  chore_id TEXT NOT NULL,                 -- the chores row's entity, as hex
  done_on  TEXT NOT NULL                  -- the day it was done, YYYY-MM-DD
);

-- Local: never merged. May use keys and checks freely.
CREATE TABLE IF NOT EXISTS settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  view TEXT NOT NULL DEFAULT 'all'        -- 'all', or a member's entity as hex
);
