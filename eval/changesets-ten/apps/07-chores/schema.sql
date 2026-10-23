-- Chore chart
--
-- People, the chores they own, and one row each time a chore is done.
-- Nothing is stored as a total: "done today" and "3 of 5" are read from
-- the completions by the view below and by the queries in index.html.

CREATE TABLE IF NOT EXISTS people (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🙂'
);

CREATE TABLE IF NOT EXISTS chores (
  id        INTEGER PRIMARY KEY,
  title     TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  every     TEXT NOT NULL DEFAULT 'day' CHECK (every IN ('day', 'week'))
);

CREATE TABLE IF NOT EXISTS completions (
  id       INTEGER PRIMARY KEY,
  chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  done_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS completions_by_chore ON completions (chore_id, done_at);

-- A daily chore is done if it was ticked today; a weekly chore if it was
-- ticked since Monday. Times are stored in UTC and compared in local time.
CREATE VIEW IF NOT EXISTS chore_status AS
SELECT
  c.id,
  c.title,
  c.every,
  c.person_id,
  p.name,
  p.emoji,
  CASE WHEN EXISTS (
    SELECT 1 FROM completions k
    WHERE k.chore_id = c.id
      AND date(k.done_at, 'localtime') >= CASE c.every
        WHEN 'day' THEN date('now', 'localtime')
        ELSE date('now', 'localtime', 'weekday 0', '-6 days')
      END
  ) THEN 1 ELSE 0 END AS done
FROM chores c
JOIN people p ON p.id = c.person_id;
