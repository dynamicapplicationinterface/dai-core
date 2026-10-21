-- Packing list · shape: solo
--
-- The decision: one person's list for their own trip, kept in one document.
-- Nobody else changes it and no second copy's edits need keeping, so nothing
-- is shared: ordinary tables, written with the kit, keys and all.

CREATE TABLE IF NOT EXISTS items (
  id     INTEGER PRIMARY KEY,
  kind   TEXT NOT NULL,
  what   TEXT NOT NULL,
  packed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trip (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  dates TEXT NOT NULL
);
