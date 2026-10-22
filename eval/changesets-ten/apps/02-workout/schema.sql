-- Workout log
--
-- One row per set. A workout is not stored: it is the sets logged on the same
-- day, grouped by the queries that show them. Totals are never kept in a
-- column; every count, best and total on the page is a query over these rows.

CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY,
  exercise TEXT NOT NULL,
  reps INTEGER NOT NULL CHECK (reps > 0),
  weight REAL NOT NULL DEFAULT 0 CHECK (weight >= 0),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS sets_by_time ON sets (at);
