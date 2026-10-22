-- Recipe box
--
-- Ordinary tables with their own keys. Totals (how many recipes, how many
-- times a dish was cooked) are always queries, never stored columns, and a
-- repeated action (cooking a dish) is a row per time, not a counter.

CREATE TABLE IF NOT EXISTS recipes (
  id        INTEGER PRIMARY KEY,
  title     TEXT NOT NULL,
  serves    INTEGER,
  minutes   INTEGER,
  notes     TEXT NOT NULL DEFAULT '',
  favorite  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingredients (
  id        INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,
  line      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ingredients_by_recipe ON ingredients (recipe_id, position);

CREATE TABLE IF NOT EXISTS steps (
  id        INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,
  body      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS steps_by_recipe ON steps (recipe_id, position);

CREATE TABLE IF NOT EXISTS cooked (
  id        INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS cooked_by_recipe ON cooked (recipe_id);

-- What is showing: one row. recipe_id is the open recipe (NULL shows the box).
CREATE TABLE IF NOT EXISTS settings (
  id             INTEGER PRIMARY KEY,
  recipe_id      INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
  favorites_only INTEGER NOT NULL DEFAULT 0
);
