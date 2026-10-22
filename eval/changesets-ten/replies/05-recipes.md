```text
dai bundle v1
name: Recipe box

--- file: schema.sql
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

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="Your recipes, ingredients and steps in one place" />
  <meta name="dai:does" content="Keep every recipe with its ingredients and numbered steps" />
  <meta name="dai:does" content="Mark favorites and narrow the box down to the ones you love" />
  <meta name="dai:does" content="Log each time you cook a dish and see when you last made it" />
  <meta name="theme-color" content="#fbf6ef" />
  <title>Recipe box</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <!--
    A recipe box. Written with the kit: the tables are declared in schema.sql,
    the starting recipes are the seed block below (run once, when the document
    is created), and the only script is the Share button.

    Two views share one page. Which recipe is open is a row in settings; when
    one is open, the stylesheet hides the box and shows the recipe, and the
    other way round when none is.
  -->
  <script type="application/sql">
    -- seed rows; the tables are declared in schema.sql
    INSERT INTO recipes (title, serves, minutes, notes, favorite) VALUES
      ('Buttermilk pancakes', 4, 20, 'Rest the batter while the pan heats.', 1),
      ('Tomato soup', 4, 35, 'Good with a grilled cheese sandwich.', 0),
      ('Lemon olive oil cake', 8, 55, 'Better the next day.', 1);

    INSERT INTO ingredients (recipe_id, position, line) VALUES
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 1, '1 1/2 cups flour'),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 2, '2 tbsp sugar'),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 3, '1 tsp baking powder'),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 4, '1/2 tsp baking soda'),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 5, '1/4 tsp salt'),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 6, '1 1/4 cups buttermilk'),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 7, '1 egg'),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 8, '3 tbsp melted butter'),
      ((SELECT id FROM recipes WHERE title = 'Tomato soup'), 1, '2 tbsp olive oil'),
      ((SELECT id FROM recipes WHERE title = 'Tomato soup'), 2, '1 onion, chopped'),
      ((SELECT id FROM recipes WHERE title = 'Tomato soup'), 3, '3 cloves garlic, sliced'),
      ((SELECT id FROM recipes WHERE title = 'Tomato soup'), 4, '1 can (28 oz) whole tomatoes'),
      ((SELECT id FROM recipes WHERE title = 'Tomato soup'), 5, '2 cups vegetable stock'),
      ((SELECT id FROM recipes WHERE title = 'Tomato soup'), 6, 'Salt and pepper'),
      ((SELECT id FROM recipes WHERE title = 'Lemon olive oil cake'), 1, '1 1/2 cups flour'),
      ((SELECT id FROM recipes WHERE title = 'Lemon olive oil cake'), 2, '1 cup sugar'),
      ((SELECT id FROM recipes WHERE title = 'Lemon olive oil cake'), 3, '3 eggs'),
      ((SELECT id FROM recipes WHERE title = 'Lemon olive oil cake'), 4, '2/3 cup olive oil'),
      ((SELECT id FROM recipes WHERE title = 'Lemon olive oil cake'), 5, 'Zest and juice of 2 lemons');

    INSERT INTO steps (recipe_id, position, body) VALUES
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 1, 'Whisk the flour, sugar, baking powder, baking soda and salt in a large bowl.'),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 2, 'Whisk the buttermilk, egg and melted butter, then fold into the dry mix until just combined.'),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 3, 'Heat a buttered pan over medium heat and pour in 1/4 cup of batter per pancake.'),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), 4, 'Flip when bubbles form and the edges look set, about 2 minutes. Cook 1 minute more.'),
      ((SELECT id FROM recipes WHERE title = 'Tomato soup'), 1, 'Soften the onion in the olive oil over medium heat, about 8 minutes.'),
      ((SELECT id FROM recipes WHERE title = 'Tomato soup'), 2, 'Add the garlic for 1 minute, then the tomatoes and stock.'),
      ((SELECT id FROM recipes WHERE title = 'Tomato soup'), 3, 'Simmer for 20 minutes, blend until smooth, and season to taste.'),
      ((SELECT id FROM recipes WHERE title = 'Lemon olive oil cake'), 1, 'Heat the oven to 350 F and line a round pan with parchment.'),
      ((SELECT id FROM recipes WHERE title = 'Lemon olive oil cake'), 2, 'Beat the eggs and sugar until pale, then stream in the oil, zest and juice.'),
      ((SELECT id FROM recipes WHERE title = 'Lemon olive oil cake'), 3, 'Fold in the flour and bake for 40 minutes, until a skewer comes out clean.');

    INSERT INTO cooked (recipe_id, at) VALUES
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), datetime('now', '-10 days')),
      ((SELECT id FROM recipes WHERE title = 'Buttermilk pancakes'), datetime('now', '-3 days')),
      ((SELECT id FROM recipes WHERE title = 'Tomato soup'), datetime('now', '-1 days'));

    INSERT INTO settings (recipe_id, favorites_only) VALUES (NULL, 0);
  </script>

  <main>
    <header>
      <p class="eyebrow">
        <dai-value query="SELECT count(*) || CASE WHEN count(*) = 1 THEN ' recipe' ELSE ' recipes' END FROM recipes"></dai-value>
      </p>
      <h1>Recipe box</h1>
    </header>

    <!-- The box: shown when no recipe is open. -->
    <section class="browse" aria-label="All recipes">
      <dai-rows query="SELECT favorites_only FROM settings LIMIT 1">
        <template>
          <label class="toggle">
            <input type="checkbox" data-run="UPDATE settings SET favorites_only = 1 - favorites_only" />
            <span class="switch" aria-hidden="true"></span>
            <span>Favorites only</span>
            <span class="mark" data-when="favorites_only">on</span>
          </label>
        </template>
      </dai-rows>

      <dai-rows
        class="list"
        query="SELECT r.id, r.title, r.favorite,
                 TRIM(
                   CASE WHEN r.minutes IS NULL THEN '' ELSE r.minutes || ' min' END
                   || CASE WHEN r.minutes IS NOT NULL AND r.serves IS NOT NULL THEN ' · ' ELSE '' END
                   || CASE WHEN r.serves IS NULL THEN '' ELSE 'serves ' || r.serves END
                 ) AS meta
               FROM recipes r
               WHERE coalesce((SELECT favorites_only FROM settings LIMIT 1), 0) = 0 OR r.favorite = 1
               ORDER BY lower(r.title)"
      >
        <template>
          <button type="button" class="recipe" data-run="UPDATE settings SET recipe_id = :id">
            <span class="rtitle" data-text="title"></span>
            <span class="rmeta" data-when="meta" data-text="meta"></span>
            <span class="star mark" data-when="favorite">★<span class="sr"> Favorite</span></span>
          </button>
        </template>
      </dai-rows>

      <dai-rows query="SELECT 1 AS x WHERE NOT EXISTS (SELECT 1 FROM recipes)">
        <template>
          <p class="empty">Your box is empty. Add your first recipe below and it will be kept right here in this file.</p>
        </template>
      </dai-rows>

      <dai-rows
        query="SELECT 1 AS x
               WHERE coalesce((SELECT favorites_only FROM settings LIMIT 1), 0) = 1
                 AND EXISTS (SELECT 1 FROM recipes)
                 AND NOT EXISTS (SELECT 1 FROM recipes WHERE favorite = 1)"
      >
        <template>
          <p class="empty">No favorites yet. Open a recipe and mark it a favorite, or turn the filter off.</p>
        </template>
      </dai-rows>

      <h2>Add a recipe</h2>
      <dai-form
        class="add"
        run="INSERT INTO recipes (title, serves, minutes) VALUES (:title, nullif(trim(:serves), ''), nullif(trim(:minutes), ''))"
      >
        <input name="title" placeholder="Recipe name" aria-label="Recipe name" required maxlength="80" />
        <input name="serves" type="number" min="1" inputmode="numeric" placeholder="Serves" aria-label="Serves" />
        <input name="minutes" type="number" min="1" inputmode="numeric" placeholder="Minutes" aria-label="Minutes" />
        <button type="button">Add</button>
      </dai-form>
    </section>

    <!-- The open recipe: shown when one is open. -->
    <dai-rows
      class="open"
      query="SELECT x.id, x.title, x.serves, x.minutes, x.notes, x.favorite,
               CASE WHEN x.n = 0 THEN 'Not cooked yet'
                 ELSE 'Cooked ' || x.n || CASE WHEN x.n = 1 THEN ' time' ELSE ' times' END || ', last '
                   || CASE
                        WHEN x.d <= 0 THEN 'today'
                        WHEN x.d = 1 THEN 'yesterday'
                        WHEN x.d < 14 THEN x.d || ' days ago'
                        WHEN x.d < 60 THEN (x.d / 7) || ' weeks ago'
                        ELSE (x.d / 30) || ' months ago'
                      END
               END AS cooked_text
             FROM (
               SELECT r.id, r.title, r.serves, r.minutes, r.notes, r.favorite,
                 (SELECT count(*) FROM cooked c WHERE c.recipe_id = r.id) AS n,
                 (SELECT CAST(julianday(date('now')) - julianday(date(max(c.at))) AS INTEGER)
                    FROM cooked c WHERE c.recipe_id = r.id) AS d
               FROM recipes r
               WHERE r.id = (SELECT recipe_id FROM settings LIMIT 1)
             ) x"
    >
      <template>
        <article class="detail">
          <button type="button" class="back" data-run="UPDATE settings SET recipe_id = NULL">← All recipes</button>

          <input
            class="name"
            aria-label="Recipe name"
            data-text="title"
            data-run="UPDATE recipes SET title = CASE WHEN trim(:typed) = '' THEN title ELSE trim(:typed) END WHERE id = :id"
          />

          <div class="facts">
            <label>
              <span>Serves</span>
              <input
                type="number" min="1" inputmode="numeric"
                data-text="serves"
                data-run="UPDATE recipes SET serves = CAST(nullif(trim(:typed), '') AS INTEGER) WHERE id = :id"
              />
            </label>
            <label>
              <span>Minutes</span>
              <input
                type="number" min="1" inputmode="numeric"
                data-text="minutes"
                data-run="UPDATE recipes SET minutes = CAST(nullif(trim(:typed), '') AS INTEGER) WHERE id = :id"
              />
            </label>
          </div>

          <label class="toggle fav">
            <input type="checkbox" data-run="UPDATE recipes SET favorite = 1 - favorite WHERE id = :id" />
            <span class="star" aria-hidden="true">★</span>
            <span>Favorite</span>
            <span class="mark" data-when="favorite">yes</span>
          </label>

          <input
            class="notes"
            aria-label="Notes"
            placeholder="A note for next time"
            maxlength="200"
            data-text="notes"
            data-run="UPDATE recipes SET notes = :typed WHERE id = :id"
          />

          <p class="cooked" data-text="cooked_text"></p>
          <button type="button" class="primary" data-run="INSERT INTO cooked (recipe_id) VALUES (:id)">I cooked this</button>
        </article>
      </template>
    </dai-rows>

    <section class="editor" aria-label="Ingredients">
      <h2>Ingredients</h2>
      <dai-rows
        class="lines"
        query="SELECT id, line FROM ingredients
               WHERE recipe_id = (SELECT recipe_id FROM settings LIMIT 1)
               ORDER BY position, id"
        empty="No ingredients yet. Add the first one below."
      >
        <template>
          <div class="line">
            <span class="text" data-text="line"></span>
            <button type="button" class="x" aria-label="Remove ingredient" data-run="DELETE FROM ingredients WHERE id = :id">×</button>
          </div>
        </template>
      </dai-rows>
      <dai-form
        class="add"
        run="INSERT INTO ingredients (recipe_id, position, line)
             VALUES (
               (SELECT recipe_id FROM settings LIMIT 1),
               (SELECT coalesce(max(position), 0) + 1 FROM ingredients WHERE recipe_id = (SELECT recipe_id FROM settings LIMIT 1)),
               :line
             )"
      >
        <input name="line" placeholder="2 cups flour" aria-label="New ingredient" required maxlength="120" />
        <button type="button">Add</button>
      </dai-form>
    </section>

    <section class="editor" aria-label="Steps">
      <h2>Steps</h2>
      <dai-rows
        class="lines steps"
        query="SELECT id, body FROM steps
               WHERE recipe_id = (SELECT recipe_id FROM settings LIMIT 1)
               ORDER BY position, id"
        empty="No steps yet. Add the first one below."
      >
        <template>
          <div class="line step">
            <span class="text" data-text="body"></span>
            <button type="button" class="x" aria-label="Remove step" data-run="DELETE FROM steps WHERE id = :id">×</button>
          </div>
        </template>
      </dai-rows>
      <dai-form
        class="add"
        run="INSERT INTO steps (recipe_id, position, body)
             VALUES (
               (SELECT recipe_id FROM settings LIMIT 1),
               (SELECT coalesce(max(position), 0) + 1 FROM steps WHERE recipe_id = (SELECT recipe_id FROM settings LIMIT 1)),
               :body
             )"
      >
        <input name="body" placeholder="Preheat the oven to 350 F" aria-label="New step" required maxlength="300" />
        <button type="button">Add</button>
      </dai-form>
    </section>

    <dai-rows
      class="editor"
      query="SELECT id FROM recipes WHERE id = (SELECT recipe_id FROM settings LIMIT 1)"
    >
      <template>
        <details class="remove">
          <summary>Remove this recipe</summary>
          <p>This deletes the recipe with its ingredients, steps and cooking history.</p>
          <button type="button" class="danger" data-run="DELETE FROM recipes WHERE id = :id">Delete recipe</button>
        </details>
      </template>
    </dai-rows>

    <footer>
      <button type="button" id="share" class="quiet">Share this box</button>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./app.js"></script>
  <script type="module" src="./dai-kit.js"></script>
</body>
</html>

--- file: app.js
// The only thing the kit cannot say: ask the host to share. The host builds
// the link, shows the card, and asks about the person's data; nothing here
// shares anything itself.
const share = document.getElementById("share");

share.addEventListener("click", () => {
  try {
    window.dai.requestShare();
  } catch (err) {
    // No host (the file was opened straight in a browser): nothing to share with.
    share.hidden = true;
  }
});

--- file: app.css
/* Recipe box: warm paper, tomato red. */
:root {
  --paper: #fbf6ef;
  --card: #fffdf9;
  --ink: #2b2118;
  --muted: #7a6a5a;
  --line: #eadfce;
  --accent: #b4452a;
  --accent-ink: #ffffff;
  --soft: #f4e3d6;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #1b1612;
    --card: #251e18;
    --ink: #f1e7da;
    --muted: #a89886;
    --line: #3a3027;
    --accent: #e8795c;
    --accent-ink: #1b1612;
    --soft: #38271f;
  }
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  min-height: 100%;
  background: var(--paper);
  color: var(--ink);
}

body {
  font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

button, input { font: inherit; color: inherit; }

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/*
 * The screen's edges: the color runs out to every edge, and the content is
 * pushed clear of the strips a phone covers.
 */
main {
  max-width: 640px;
  margin: 0 auto;
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(20px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(20px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* Two views, one page: which one shows follows what the open-recipe query drew. */
main:has(article.detail) .browse { display: none; }
main:not(:has(article.detail)) .editor { display: none; }

/* The host floats a round button in the top right corner. */
header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-right: 56px;
}

.eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
}

h1 {
  margin: 0;
  font: 700 36px/1.05 "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  letter-spacing: -0.02em;
}

h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.browse, .editor { display: flex; flex-direction: column; gap: 12px; }
.browse h2 { margin: 10px 0 -2px; }
.editor h2 { margin: 0; }

dai-rows { display: block; }

/* The box */
.list { display: grid; gap: 10px; }

.recipe {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: "title star" "meta star";
  column-gap: 12px;
  align-items: center;
  width: 100%;
  min-height: 56px;
  padding: 12px 16px;
  text-align: left;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  cursor: pointer;
}

.recipe:hover { border-color: var(--accent); }
.rtitle { grid-area: title; font-weight: 600; font-size: 17px; }
.rmeta { grid-area: meta; font-size: 13px; color: var(--muted); }
.recipe .star { grid-area: star; }

.mark { display: none; }
.star { color: var(--accent); font-size: 18px; }
.recipe:has(.mark:not([hidden])) .star { display: inline; }

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.empty {
  margin: 0;
  padding: 24px 18px;
  text-align: center;
  color: var(--muted);
  background: var(--card);
  border: 1px dashed var(--line);
  border-radius: 14px;
}

/* Switches */
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  cursor: pointer;
  align-self: flex-start;
}

.toggle input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}

.toggle:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 8px;
}

.switch {
  position: relative;
  width: 40px;
  height: 24px;
  border-radius: 999px;
  background: var(--line);
}

.switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--card);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
  transition: transform 0.15s;
}

.toggle:has(.mark:not([hidden])) .switch { background: var(--accent); }
.toggle:has(.mark:not([hidden])) .switch::after { transform: translateX(16px); }

/* Visible text for the state is redundant next to the switch; keep it for screen readers. */
.toggle .mark:not([hidden]) {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  display: inline;
}

.fav .star { color: var(--muted); font-size: 22px; }
.fav:has(.mark:not([hidden])) .star { color: var(--accent); }

/* The open recipe */
.detail { display: flex; flex-direction: column; gap: 12px; }

.back {
  align-self: flex-start;
  min-height: 44px;
  padding: 0 14px 0 0;
  border: 0;
  background: none;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
}

input.name {
  width: 100%;
  min-height: 44px;
  padding: 2px 0;
  border: 0;
  border-bottom: 1px dashed transparent;
  background: none;
  font: 700 30px/1.15 "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  letter-spacing: -0.01em;
}

input.name:hover, input.name:focus { border-bottom-color: var(--accent); outline: none; }

.facts { display: flex; flex-wrap: wrap; gap: 12px; }

.facts label {
  flex: 1 1 8rem;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--muted);
}

.facts input, .notes, dai-form input {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--ink);
}

.cooked { margin: 4px 0 0; color: var(--muted); }

.primary, dai-form button, dai-save {
  min-height: 44px;
  padding: 10px 18px;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
  cursor: pointer;
}

.primary { align-self: flex-start; }

/* Ingredients and steps */
.lines {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 16px;
  border-top: 1px solid var(--line);
}

.line:first-child { border-top: 0; }
.line .text { flex: 1; padding: 8px 0; }

.x {
  flex: none;
  min-width: 44px;
  min-height: 44px;
  border: 0;
  background: none;
  font-size: 22px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
}

.x:hover { color: var(--accent); }

.steps { counter-reset: step; }

.step::before {
  counter-increment: step;
  content: counter(step);
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--soft);
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
}

.lines > :not(template):only-child:not(.line) {
  display: block;
  padding: 18px 16px;
  color: var(--muted);
}

/* Forms */
dai-form { display: flex; flex-wrap: wrap; gap: 8px; }
dai-form input { flex: 1 1 8rem; width: auto; min-width: 0; }
dai-form input[name="title"], dai-form input[name="line"], dai-form input[name="body"] { flex: 3 1 12rem; }

/* Removing */
.remove {
  padding: 0 16px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
}

.remove summary {
  min-height: 44px;
  display: flex;
  align-items: center;
  color: var(--muted);
  cursor: pointer;
}

.remove p { margin: 0 0 10px; color: var(--muted); font-size: 14px; }

.danger {
  margin-bottom: 14px;
  min-height: 44px;
  padding: 10px 18px;
  border: 1px solid var(--accent);
  border-radius: 10px;
  background: none;
  color: var(--accent);
  font-weight: 600;
  cursor: pointer;
}

/* Footer */
footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.quiet {
  min-height: 44px;
  padding: 10px 18px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  font-weight: 600;
  cursor: pointer;
}

dai-save { display: inline-block; }

@media (min-width: 720px) {
  main { padding-top: calc(48px + var(--dai-safe-top, 0px)); }
  h1 { font-size: 44px; }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- A recipe card on tomato red. -->
  <rect width="100" height="100" rx="22" fill="#b4452a"/>
  <rect x="22" y="20" width="56" height="62" rx="8" fill="#fbf6ef"/>
  <rect x="22" y="20" width="56" height="16" rx="8" fill="#f4e3d6"/>
  <rect x="22" y="30" width="56" height="6" fill="#f4e3d6"/>
  <circle cx="34" cy="28" r="4" fill="#b4452a"/>
  <rect x="32" y="46" width="36" height="5" rx="2.5" fill="#b4452a"/>
  <rect x="32" y="58" width="28" height="5" rx="2.5" fill="#d9a898"/>
  <rect x="32" y="70" width="32" height="5" rx="2.5" fill="#d9a898"/>
</svg>
```
