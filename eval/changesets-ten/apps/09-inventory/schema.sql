-- Inventory
--
-- Two ordinary tables. Stock is never stored: every change is a row in
-- movements (a delivery is positive, a use is negative), and the count on
-- screen is the sum of an item's rows. Two copies that each add a movement
-- merge cleanly; a stored total would not.

CREATE TABLE IF NOT EXISTS items (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  place    TEXT NOT NULL DEFAULT '',
  low_at   INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS movements (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delta   INTEGER NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS movements_by_item ON movements (item_id);
