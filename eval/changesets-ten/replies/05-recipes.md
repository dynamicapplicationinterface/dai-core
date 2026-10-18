Here is your recipe box. I built it as a solo document: it is one person's collection, kept in one file. It has no shared tables, because nobody else changes it and no second copy's edits need merging. If you send it to someone, they get their own copy to add to. It uses only the built-in kit, so the only JavaScript is the Share button.

What it does:
- Keeps recipes with a title, category, servings, ingredients and steps. Three examples are in it so it doesn't open empty.
- Filter the list by All, Favorites, or any category you've used. Category buttons appear on their own as you add recipes.
- Tap a recipe to read it. Every field on the open recipe can be edited in place, and each change is saved as you make it.
- Star favorites. Delete asks once before it removes anything.

```text
dai bundle v1
name: Recipe box

--- file: schema.sql
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

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Your recipes, kept in one file you can pass on" />
  <meta name="dai:does" content="Keep your recipes with ingredients and steps in one place" />
  <meta name="dai:does" content="Find dinner fast by category or from your favorites" />
  <meta name="dai:does" content="Fix a quantity or a step right on the recipe, saved as you type" />
  <meta name="theme-color" content="#fbf6ee" />
  <title>Recipe box</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Seed rows: local tables only, and a second open adds nothing.
    INSERT OR IGNORE INTO settings (id, selected) VALUES (1, 1);

    INSERT OR IGNORE INTO recipes (id, title, category, servings, ingredients, steps, favorite) VALUES
      (1, 'Tomato soup with grilled cheese', 'Dinner', '4',
'2 tbsp olive oil
1 onion, chopped
2 cloves garlic
2 cans (28 oz) whole tomatoes
2 cups vegetable stock
1/2 cup cream
8 slices bread, cheddar, butter',
'Soften the onion and garlic in the oil for 8 minutes.
Add the tomatoes and stock and simmer for 20 minutes.
Blend until smooth and stir in the cream. Salt to taste.
Butter the bread, fill with cheddar, and fry until golden on both sides.', 1),
      (2, 'Blueberry pancakes', 'Breakfast', '4',
'1 1/2 cups flour
2 tbsp sugar
1 tbsp baking powder
1 egg
1 1/4 cups milk
2 tbsp melted butter
1 cup blueberries',
'Whisk the dry ingredients together.
Mix the egg, milk and butter, then stir into the dry ingredients. A few lumps are fine.
Fold in the blueberries.
Cook 1/4 cup at a time on a medium pan until bubbles form, then flip.', 0),
      (3, 'Lemon bars', 'Dessert', '16 bars',
'1 cup butter, softened
2 cups flour
1/2 cup powdered sugar
4 eggs
1 1/2 cups sugar
Juice of 3 lemons
Zest of 1 lemon',
'Mix the butter, 2 cups flour and powdered sugar. Press into a 9x13 pan and bake at 350F for 20 minutes.
Whisk the eggs, sugar, lemon juice and zest and pour over the warm crust.
Bake 20 minutes more, until just set. Cool before cutting.', 0);
  </script>

  <main>
    <header>
      <h1>Recipe box</h1>
      <button id="share" type="button" class="quiet">Share</button>
    </header>

    <!-- Filters. The list below follows whichever is picked. -->
    <dai-rows class="filters" aria-label="Show"
      query="SELECT label, val, (val = (SELECT filter FROM settings WHERE id = 1)) AS picked, ord
               FROM (SELECT 'All' AS label, '' AS val, 0 AS ord
                     UNION ALL SELECT 'Favorites', '*fav', 1
                     UNION ALL SELECT category, category, 2 FROM (SELECT DISTINCT category FROM recipes))
              ORDER BY ord, label COLLATE NOCASE">
      <template>
        <button type="button" class="chip" data-run="UPDATE settings SET filter = :val WHERE id = 1">
          <span data-when="picked" aria-hidden="true">&#10003; </span><span data-text="label"></span>
        </button>
      </template>
    </dai-rows>

    <dai-rows class="list"
      empty="Nothing here yet. Add a recipe below, or pick a different filter."
      query="SELECT r.id, r.title, r.category, r.favorite, (r.id = s.selected) AS shown
               FROM recipes r JOIN settings s ON s.id = 1
              WHERE s.filter = '' OR (s.filter = '*fav' AND r.favorite = 1) OR r.category = s.filter
              ORDER BY r.title COLLATE NOCASE">
      <template>
        <button type="button" class="pick" data-run="UPDATE settings SET selected = :id, confirm = 0 WHERE id = 1">
          <span class="pick-title" data-text="title"></span>
          <span class="pick-meta"><span data-when="favorite" aria-label="Favorite">&#9733; </span><span data-text="category"></span></span>
          <span class="pick-open" data-when="shown">Open</span>
        </button>
      </template>
    </dai-rows>

    <!-- The open recipe. Every field is editable in place and saved as it is changed. -->
    <dai-rows class="recipe"
      empty="Pick a recipe from the list to read it, or add your first one below."
      query="SELECT r.id, r.title, r.category, r.servings, r.ingredients, r.steps, r.favorite,
                    (1 - r.favorite) AS notfav, (s.confirm = r.id) AS confirming, (s.confirm != r.id) AS idle
               FROM recipes r JOIN settings s ON s.id = 1
              WHERE r.id = s.selected">
      <template>
        <article class="card">
          <input class="name" aria-label="Recipe name" maxlength="80"
                 data-text="title" data-run="UPDATE recipes SET title = :typed WHERE id = :id AND length(trim(:typed)) &gt; 0" />
          <div class="facts">
            <label>Category
              <input aria-label="Category" maxlength="30" data-text="category"
                     data-run="UPDATE recipes SET category = :typed WHERE id = :id AND length(trim(:typed)) &gt; 0" />
            </label>
            <label>Serves
              <input aria-label="Serves" maxlength="30" data-text="servings"
                     data-run="UPDATE recipes SET servings = :typed WHERE id = :id" />
            </label>
          </div>
          <label class="block">Ingredients
            <textarea rows="8" aria-label="Ingredients" data-text="ingredients"
                      data-run="UPDATE recipes SET ingredients = :typed WHERE id = :id"></textarea>
          </label>
          <label class="block">Steps
            <textarea rows="8" aria-label="Steps" data-text="steps"
                      data-run="UPDATE recipes SET steps = :typed WHERE id = :id"></textarea>
          </label>
          <div class="actions">
            <button type="button" class="quiet" data-run="UPDATE recipes SET favorite = 1 - favorite WHERE id = :id">
              <span data-when="favorite">&#9733; Favorite</span><span data-when="notfav">&#9734; Mark as favorite</span>
            </button>
            <button type="button" class="quiet danger" data-when="idle"
                    data-run="UPDATE settings SET confirm = :id WHERE id = 1">Delete</button>
          </div>
          <div class="actions sure" data-when="confirming">
            <span>Delete this recipe for good?</span>
            <button type="button" class="danger-solid" data-run="DELETE FROM recipes WHERE id = :id">Delete it</button>
            <button type="button" class="quiet" data-run="UPDATE settings SET confirm = 0 WHERE id = 1">Keep it</button>
          </div>
        </article>
      </template>
    </dai-rows>

    <dai-form class="add" run="INSERT INTO recipes (title, category, servings, ingredients, steps)
                                VALUES (trim(:title), trim(:category), trim(:servings), :ingredients, :steps)">
      <h2>Add a recipe</h2>
      <label>Name <input name="title" required maxlength="80" placeholder="Grandma's noodle soup" /></label>
      <div class="facts">
        <label>Category
          <input name="category" required maxlength="30" list="categories" placeholder="Dinner" />
        </label>
        <label>Serves <input name="servings" maxlength="30" placeholder="4" /></label>
      </div>
      <datalist id="categories">
        <option value="Breakfast"></option>
        <option value="Lunch"></option>
        <option value="Dinner"></option>
        <option value="Dessert"></option>
        <option value="Snack"></option>
        <option value="Drink"></option>
      </datalist>
      <label class="block">Ingredients, one per line
        <textarea name="ingredients" rows="5" placeholder="2 cups flour&#10;1 egg"></textarea>
      </label>
      <label class="block">Steps
        <textarea name="steps" rows="5" placeholder="Mix. Bake. Eat."></textarea>
      </label>
      <button type="button" class="primary">Add to the box</button>
    </dai-form>

    <footer>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./dai-kit.js"></script>
  <script type="module" src="./app.js"></script>
</body>
</html>

--- file: app.js
// The only thing here the kit cannot express: asking the host to share.
// Everything else is the kit and SQL in the document.
document.getElementById("share").addEventListener("click", () => {
  window.dai.requestShare();
});

--- file: app.css
:root {
  color-scheme: light dark;
  --bg: #fbf6ee;
  --card: #ffffff;
  --ink: #2b2118;
  --muted: #7a6b5c;
  --line: #eadfce;
  --accent: #b5502b;
  --accent-ink: #ffffff;
  --danger: #a3261f;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1d1712; --card: #2a221b; --ink: #f3e9dc; --muted: #b3a28f; --line: #3e342a;
    --accent: #e88a63; --accent-ink: #1d1712; --danger: #ff8a80;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { font-size: 16px; line-height: 1.5; -webkit-font-smoothing: antialiased; }

/* Color runs to every edge; content stays clear of the strips a phone covers. */
main {
  max-width: 640px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: calc(20px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(16px + var(--dai-safe-left, 0px));
}

/* The top right corner belongs to the host's menu button. */
header { display: flex; align-items: center; gap: 12px; padding-right: 56px; }
h1 { margin: 0; flex: 1; font-size: 30px; letter-spacing: -0.02em; line-height: 1.1; }
h2 { margin: 0 0 4px; font-size: 18px; }

button, input, textarea {
  font: inherit; color: inherit;
}
button {
  min-height: 44px; padding: 0 16px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--line); background: var(--card);
}
button:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
button.quiet { background: transparent; color: var(--accent); border-color: var(--accent); }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
button.danger { color: var(--danger); border-color: var(--danger); }
button.danger-solid { background: var(--danger); color: var(--bg); border-color: var(--danger); font-weight: 600; }

input, textarea {
  width: 100%; min-height: 44px; padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--card);
}
textarea { resize: vertical; line-height: 1.5; }
::placeholder { color: var(--muted); opacity: 0.6; font-style: italic; }

label { display: grid; gap: 4px; font-size: 14px; color: var(--muted); }

/* Filters */
.filters { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border-radius: 999px; min-height: 44px; padding: 0 16px; }

/* The list */
.list { display: grid; gap: 8px; }
.pick {
  display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 12px;
  width: 100%; text-align: left; padding: 10px 14px; border-radius: 12px;
}
.pick-title { font-weight: 600; }
.pick-meta { grid-column: 1; font-size: 14px; color: var(--muted); }
.pick-open { grid-column: 2; grid-row: 1 / span 2; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); }

/* A considered empty state */
dai-rows:not(:has(*)), dai-rows > :only-child:not(button):not(article) { color: var(--muted); }
.list > :not(button), .recipe > :not(article) {
  margin: 0; padding: 18px; text-align: center; color: var(--muted);
  border: 1px dashed var(--line); border-radius: 12px;
}

/* The open recipe */
.card {
  display: grid; gap: 14px; padding: 16px; border-radius: 16px;
  background: var(--card); border: 1px solid var(--line);
}
.name {
  font-size: 24px; font-weight: 700; letter-spacing: -0.01em; min-height: 52px;
  border-color: transparent; background: transparent; padding-left: 0;
}
.name:hover, .name:focus { border-color: var(--line); padding-left: 12px; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.block textarea { background: var(--bg); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sure { padding: 12px; border-radius: 12px; border: 1px solid var(--danger); }
.sure span { flex: 1 1 100%; color: var(--ink); }

/* Add form */
.add {
  display: grid; gap: 12px; padding: 16px; border-radius: 16px;
  background: var(--card); border: 1px solid var(--line);
}

footer { display: flex; justify-content: flex-end; }
dai-save { display: inline-block; padding: 12px 22px; border-radius: 10px; background: var(--accent); color: var(--accent-ink); font-weight: 600; cursor: pointer; }

/* On a wide window, the same single column, a little roomier. */
@media (min-width: 720px) {
  main { padding-top: calc(40px + var(--dai-safe-top, 0px)); }
  h1 { font-size: 36px; }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#b5502b"/><path d="M18 44h64v8c0 18-12 30-32 30S18 70 18 52z" fill="#fbf6ee"/><rect x="14" y="36" width="72" height="10" rx="5" fill="#fbf6ee"/><path d="M40 28c-6-6 6-10 0-18M60 28c-6-6 6-10 0-18" fill="none" stroke="#fbf6ee" stroke-width="5" stroke-linecap="round"/></svg>
```

Notes:
- Everything is stored inside the document, so the recipes travel with the file. Saving is automatic when it's opened in the DAI app. If you open the file straight in a browser, a Save button appears at the bottom.
- Share sends a copy of the whole box. It isn't a live link, so changes made on one copy won't show up on the other.
- The category buttons come from the categories your recipes use. Renaming a category on a recipe moves it to the new button, and a category with no recipes left disappears.
- I haven't run this in the DAI container.
