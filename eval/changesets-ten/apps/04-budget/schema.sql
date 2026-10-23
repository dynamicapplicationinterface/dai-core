-- Budget
--
-- Ordinary tables. A total is never stored: what is spent, what is left and
-- what a category has used are all worked out by the queries that show them.

-- One row: what comes in each month.
CREATE TABLE IF NOT EXISTS plan (
  id      INTEGER PRIMARY KEY,
  income  REAL NOT NULL DEFAULT 0
);

-- A place money goes, with the most it should take each month.
CREATE TABLE IF NOT EXISTS categories (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  monthly_limit  REAL NOT NULL DEFAULT 0,
  position       INTEGER NOT NULL DEFAULT 0
);

-- One row per thing spent. Times are UTC text; the page shows them as words.
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  amount       REAL NOT NULL CHECK (amount > 0),
  note         TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS transactions_by_category
  ON transactions (category_id, at);

-- Each category with what it has taken so far this month (UTC months).
CREATE VIEW IF NOT EXISTS category_month AS
SELECT
  c.id            AS id,
  c.name          AS name,
  c.position      AS position,
  c.monthly_limit AS monthly_limit,
  COALESCE((SELECT SUM(t.amount)
              FROM transactions t
             WHERE t.category_id = c.id
               AND strftime('%Y-%m', t.at) = strftime('%Y-%m', 'now')), 0) AS spent,
  (SELECT count(*) FROM transactions x WHERE x.category_id = c.id) AS entries_ever
FROM categories c;
