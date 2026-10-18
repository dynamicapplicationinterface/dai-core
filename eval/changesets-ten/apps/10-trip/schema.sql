-- Trip planner · shape: solo
--
-- The decision: one person's trip, kept on their own device. Nobody else adds
-- to it and no second copy's changes need keeping, so nothing is shared:
-- ordinary tables with keys, written in JavaScript over the kit's database.
--
-- Nothing derived is stored. A day's number comes from its place in the list,
-- and the counts of stops are computed each time they are drawn. The only
-- times kept are the ones the person typed (a date, a time of day).

CREATE TABLE IF NOT EXISTS trip (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  title TEXT NOT NULL DEFAULT 'My trip'
);

CREATE TABLE IF NOT EXISTS days (
  id      INTEGER PRIMARY KEY,
  label   TEXT NOT NULL,            -- e.g. "Arrive in Lisbon"
  on_date TEXT NOT NULL DEFAULT ''  -- YYYY-MM-DD as entered, or empty
);

CREATE TABLE IF NOT EXISTS stops (
  id      INTEGER PRIMARY KEY,
  day_id  INTEGER NOT NULL,         -- the days row this stop belongs to
  at_time TEXT NOT NULL DEFAULT '', -- HH:MM as entered, or empty
  name    TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  done    INTEGER NOT NULL DEFAULT 0
);
