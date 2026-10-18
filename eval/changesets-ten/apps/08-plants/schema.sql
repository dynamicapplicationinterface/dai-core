-- Plant care · shape: solo
--
-- The decision: one person's plants, logged from one phone. Nobody else
-- adds to it and no second copy's changes need keeping, so nothing is shared:
-- ordinary tables, written with the kit, keys and all.
--
-- Nothing derived is stored. "Last watered", "needs water" and the day counts
-- are computed from the care log every time they are drawn.

CREATE TABLE IF NOT EXISTS plants (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  place       TEXT NOT NULL DEFAULT '',
  water_every INTEGER NOT NULL DEFAULT 7 CHECK (water_every BETWEEN 1 AND 365)
);

CREATE TABLE IF NOT EXISTS care_log (
  id       INTEGER PRIMARY KEY,
  plant_id INTEGER NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('water', 'feed', 'repot')),
  done_at  TEXT NOT NULL DEFAULT (datetime('now'))   -- UTC
);

CREATE INDEX IF NOT EXISTS care_log_by_plant ON care_log (plant_id, kind, done_at);

-- Removing a plant removes its history with it.
CREATE TRIGGER IF NOT EXISTS plants_remove_log
AFTER DELETE ON plants
BEGIN
  DELETE FROM care_log WHERE plant_id = OLD.id;
END;
