-- Inventory · shape: solo
--
-- The decision: one person keeps track of what they have, on their own phone
-- or laptop. Nobody else adds to it and no second copy's changes need keeping,
-- so nothing is shared: ordinary tables, written with the kit, keys and all.

CREATE TABLE IF NOT EXISTS items (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  place  TEXT NOT NULL DEFAULT '',
  qty    INTEGER NOT NULL DEFAULT 0,
  low_at INTEGER NOT NULL DEFAULT 1   -- flagged when qty is at or below this
);
