-- Budget · shape: solo
--
-- The decision: one person's monthly budget, kept on their own device. Nobody
-- else adds to it and no second copy's changes need keeping, so nothing is
-- shared: ordinary tables, with keys and constraints.
--
-- Nothing derived is stored. What a category has spent, what is left and
-- whether it is over are worked out from the expenses every time they are drawn.
-- An expense's date is the day the person says they spent it, not when the row
-- was written.

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  limit_cents INTEGER NOT NULL DEFAULT 0     -- monthly limit; 0 means no limit
);

CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL,
  what        TEXT NOT NULL,
  cents       INTEGER NOT NULL,
  spent_on    TEXT NOT NULL                  -- YYYY-MM-DD, as entered
);

CREATE TABLE IF NOT EXISTS settings (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  seeded INTEGER NOT NULL DEFAULT 0
);
