-- Plant care
--
-- Two ordinary tables. A plant says how often it wants water; every
-- watering, feeding, misting or note is a row in care. Nothing is totalled
-- and stored: how long ago a plant was watered, and whether it is thirsty, are
-- worked out from the rows by the queries that show them.

CREATE TABLE IF NOT EXISTS plants (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  place      TEXT NOT NULL DEFAULT '',
  every_days INTEGER NOT NULL DEFAULT 7 CHECK (every_days >= 1),
  created    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS care (
  id       INTEGER PRIMARY KEY,
  plant_id INTEGER NOT NULL REFERENCES plants (id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('Watered', 'Fed', 'Misted', 'Note')),
  note     TEXT,
  at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS care_by_plant ON care (plant_id, at);
