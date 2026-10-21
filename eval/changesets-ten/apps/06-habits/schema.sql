-- Habit tracker · shape: solo
--
-- The decision: one person's habits, kept on one device. Nobody else adds to
-- it and no second copy's changes need keeping, so nothing is shared: ordinary
-- tables, keys and all, written with plain SQL.
--
-- Notes:
--   * checks holds one row per habit per calendar day the person means ("I did
--     this on Tuesday"). That day is a fact they entered, in their own local
--     calendar, so it is a plain YYYY-MM-DD and not a write time. When a row
--     was created is stored in UTC (habits.created) and never shown.
--   * No streak, no count, no "done today" flag is stored. They are derived
--     from checks each time the page is drawn.
--   * Archiving a habit keeps its history; nothing is dropped.

CREATE TABLE IF NOT EXISTS habits (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checks (
  habit_id INTEGER NOT NULL,
  day      TEXT NOT NULL,          -- YYYY-MM-DD, the day the person did it
  PRIMARY KEY (habit_id, day)
);

-- Remembers that the example rows were offered once, so deleting them sticks.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
