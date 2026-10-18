-- Recipe box · shape: solo
--
-- The decision: one person's collection of recipes, kept in one file. Nobody
-- else changes it and no second copy's edits need to be kept alongside this
-- one's, so nothing is shared: ordinary local tables, written with the kit.
-- Sending the box to someone gives them a copy of their own.
--
-- Which recipe is open, which filter is on, and which delete is waiting for a
-- second tap are about this screen, not about a recipe, so they live in
-- settings rather than on the recipes.

CREATE TABLE IF NOT EXISTS recipes (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Other',
  servings    TEXT NOT NULL DEFAULT '',
  ingredients TEXT NOT NULL DEFAULT '',
  steps       TEXT NOT NULL DEFAULT '',
  favorite    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  selected INTEGER NOT NULL DEFAULT 0,   -- the recipe that is open, 0 for none
  filter   TEXT NOT NULL DEFAULT '',     -- '' for all, '*fav' for favorites, else a category
  confirm  INTEGER NOT NULL DEFAULT 0    -- the recipe whose delete is waiting for a second tap
);
