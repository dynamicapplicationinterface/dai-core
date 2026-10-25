-- Habit tracker
--
-- Two ordinary tables and two views. A check-in is one row: a habit and the
-- calendar day it was done. Nothing is counted in a column; the streaks, the
-- week and the totals are all read from the rows by the views below, so every
-- copy of the document works them out the same way.
--
-- "day" is a calendar day the person means (their own today), kept as
-- YYYY-MM-DD text, not a moment in time. The moments (created) are UTC.

CREATE TABLE IF NOT EXISTS habits (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  emoji    TEXT NOT NULL DEFAULT '⭐',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checkins (
  id       INTEGER PRIMARY KEY,
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  created  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS checkins_by_habit_day ON checkins (habit_id, day);

-- Each active habit, whether it is done today, and the day its streak is
-- counted back from: today if it is done, otherwise yesterday, so a streak is
-- not lost before the day is over.
CREATE VIEW IF NOT EXISTS habit_today AS
SELECT
  h.id AS id,
  h.name AS name,
  h.emoji AS emoji,
  h.position AS position,
  EXISTS (
    SELECT 1 FROM checkins c
    WHERE c.habit_id = h.id AND c.day = date('now', 'localtime')
  ) AS done,
  CASE WHEN EXISTS (
    SELECT 1 FROM checkins c
    WHERE c.habit_id = h.id AND c.day = date('now', 'localtime')
  ) THEN date('now', 'localtime')
  ELSE date('now', 'localtime', '-1 day') END AS anchor
FROM habits h
WHERE h.archived = 0;

-- Streak: the run of consecutive days that ends on the anchor day. Its first
-- day is the latest checked day, on or before the anchor, whose previous day
-- was not checked.
CREATE VIEW IF NOT EXISTS habit_status AS
SELECT
  t.id AS id,
  t.name AS name,
  t.emoji AS emoji,
  t.position AS position,
  t.done AS done,
  1 - t.done AS notdone,
  CASE WHEN EXISTS (
    SELECT 1 FROM checkins c WHERE c.habit_id = t.id AND c.day = t.anchor
  ) THEN CAST(julianday(t.anchor) - julianday((
      SELECT max(c.day) FROM checkins c
      WHERE c.habit_id = t.id
        AND c.day <= t.anchor
        AND NOT EXISTS (
          SELECT 1 FROM checkins p
          WHERE p.habit_id = t.id AND p.day = date(c.day, '-1 day')
        )
    )) AS INTEGER) + 1
  ELSE 0 END AS streak,
  (
    SELECT count(DISTINCT c.day) FROM checkins c
    WHERE c.habit_id = t.id
      AND c.day >= date('now', 'localtime', '-6 days')
      AND c.day <= date('now', 'localtime')
  ) AS week,
  (
    SELECT group_concat(
      CASE WHEN EXISTS (
        SELECT 1 FROM checkins c
        WHERE c.habit_id = t.id
          AND c.day = date('now', 'localtime', '-' || d.column1 || ' days')
      ) THEN '●' ELSE '○' END, '')
    FROM (VALUES (6), (5), (4), (3), (2), (1), (0)) AS d
  ) AS strip
FROM habit_today t;
