-- Workout log · shape: solo
--
-- The decision: one person's training log, kept on their own phone. Nobody
-- else adds to it and no second copy's changes need keeping, so nothing is
-- shared: an ordinary table, written with the kit, key and all. (If it is
-- sent to someone, they get a copy of their own to write in.)
--
-- Times are stored in UTC and shown as words by the queries in index.html.
-- Weight is stored in pounds; 0 means bodyweight.

CREATE TABLE IF NOT EXISTS lifts (
  id        INTEGER PRIMARY KEY,
  exercise  TEXT NOT NULL,
  sets      INTEGER NOT NULL DEFAULT 1,
  reps      INTEGER NOT NULL DEFAULT 1,
  weight    REAL NOT NULL DEFAULT 0,
  logged    TEXT NOT NULL DEFAULT (datetime('now'))
);
