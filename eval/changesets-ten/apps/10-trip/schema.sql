-- Trip planner
--
-- Every trip is a row. The page shows one at a time; which one is a setting
-- in the settings table. Totals are never stored: the budget, the counts and
-- the "days to go" are all read from the rows by the views below.

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT '',
  starts TEXT NOT NULL,
  ends TEXT NOT NULL,
  budget REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '',
  what TEXT NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  what TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  amount REAL NOT NULL,
  added TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  what TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS plans_by_trip ON plans (trip_id, day, time);
CREATE INDEX IF NOT EXISTS expenses_by_trip ON expenses (trip_id);
CREATE INDEX IF NOT EXISTS tasks_by_trip ON tasks (trip_id);

-- The trip on screen: the one chosen in settings, or else the earliest trip.
CREATE VIEW IF NOT EXISTS current_trip AS
SELECT coalesce(
  (SELECT t.id FROM trips t
    WHERE t.id = CAST((SELECT s.value FROM settings s WHERE s.name = 'trip') AS INTEGER)),
  (SELECT t.id FROM trips t ORDER BY t.starts, t.name LIMIT 1)
) AS id;

-- One line per trip, with its dates in words and its spending added up.
CREATE VIEW IF NOT EXISTS trip_cards AS
SELECT
  t.id AS id,
  t.name AS name,
  t.destination AS destination,
  t.starts AS starts,
  t.ends AS ends,
  t.budget AS budget,
  substr('SunMonTueWedThuFriSat', CAST(strftime('%w', t.starts) AS INTEGER) * 3 + 1, 3)
    || ' ' || CAST(strftime('%d', t.starts) AS INTEGER)
    || ' ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', (CAST(strftime('%m', t.starts) AS INTEGER) - 1) * 3 + 1, 3)
    AS starts_label,
  substr('SunMonTueWedThuFriSat', CAST(strftime('%w', t.ends) AS INTEGER) * 3 + 1, 3)
    || ' ' || CAST(strftime('%d', t.ends) AS INTEGER)
    || ' ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', (CAST(strftime('%m', t.ends) AS INTEGER) - 1) * 3 + 1, 3)
    AS ends_label,
  CASE CAST(julianday(t.ends) - julianday(t.starts) AS INTEGER)
    WHEN 0 THEN '1 day'
    ELSE (CAST(julianday(t.ends) - julianday(t.starts) AS INTEGER) + 1) || ' days'
  END AS days_text,
  CASE
    WHEN date('now') > t.ends THEN 'Finished'
    WHEN date('now') >= t.starts THEN 'Under way'
    WHEN julianday(t.starts) - julianday(date('now')) < 2 THEN 'Tomorrow'
    ELSE 'In ' || CAST(julianday(t.starts) - julianday(date('now')) AS INTEGER) || ' days'
  END AS when_text,
  printf('%.2f', t.spent) AS spent_text,
  CASE
    WHEN t.budget <= 0 THEN 'No budget set'
    WHEN t.spent <= t.budget THEN printf('%.2f', t.budget - t.spent) || ' left'
    ELSE printf('%.2f', t.spent - t.budget) || ' over'
  END AS budget_note,
  (t.budget > 0 AND t.spent > t.budget) AS over,
  (t.id = (SELECT id FROM current_trip)) AS current
FROM (
  SELECT trips.*,
    (SELECT coalesce(sum(e.amount), 0) FROM expenses e WHERE e.trip_id = trips.id) AS spent
  FROM trips
) AS t;

-- Itinerary lines, each knowing which day of the trip it falls on and
-- whether it is the first of its day (the day heading shows only there).
CREATE VIEW IF NOT EXISTS plan_items AS
SELECT
  p.id AS id,
  p.trip_id AS trip_id,
  p.day AS day,
  p.time AS time,
  p.what AS what,
  p.place AS place,
  p.done AS done,
  CASE WHEN p.time = '' THEN 'All day' ELSE p.time END AS time_text,
  CASE WHEN p.day >= t.starts
    THEN 'Day ' || (CAST(julianday(p.day) - julianday(t.starts) AS INTEGER) + 1) || ': '
    ELSE ''
  END
    || substr('SunMonTueWedThuFriSat', CAST(strftime('%w', p.day) AS INTEGER) * 3 + 1, 3)
    || ' ' || CAST(strftime('%d', p.day) AS INTEGER)
    || ' ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', (CAST(strftime('%m', p.day) AS INTEGER) - 1) * 3 + 1, 3)
    AS day_label,
  NOT EXISTS (
    SELECT 1 FROM plans q
    WHERE q.trip_id = p.trip_id AND q.day = p.day
      AND (q.time < p.time OR (q.time = p.time AND q.id < p.id))
  ) AS first_of_day
FROM plans p
JOIN trips t ON t.id = p.trip_id;

CREATE VIEW IF NOT EXISTS expense_items AS
SELECT
  e.id AS id,
  e.trip_id AS trip_id,
  e.what AS what,
  e.category AS category,
  e.added AS added,
  printf('%.2f', e.amount) AS amount_text,
  CASE CAST(julianday(date('now')) - julianday(date(e.added)) AS INTEGER)
    WHEN 0 THEN 'today'
    WHEN 1 THEN 'yesterday'
    ELSE CAST(julianday(date('now')) - julianday(date(e.added)) AS INTEGER) || ' days ago'
  END AS added_text
FROM expenses e;
