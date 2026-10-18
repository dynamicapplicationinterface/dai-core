Here is a simple inventory. It is a solo document: one person, one copy, so nothing is shared and it needs no JavaScript of its own. You add things with a name, a count and where they are kept, nudge the count up or down with one tap, and anything at or below its low-stock mark is flagged and floated to the top.

```text
dai bundle v1
name: Inventory

--- file: schema.sql
-- Inventory · shape: solo
--
-- The decision: one person keeps track of what they have, on their own phone
-- or laptop. Nobody else adds to it and no second copy's changes need keeping,
-- so nothing is shared: ordinary tables, written with the kit, keys and all.

CREATE TABLE IF NOT EXISTS items (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  place  TEXT NOT NULL DEFAULT '',
  qty    INTEGER NOT NULL DEFAULT 0,
  low_at INTEGER NOT NULL DEFAULT 1   -- flagged when qty is at or below this
);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="What you have, how many, and where it is" />
  <meta name="dai:does" content="Keep a list of what you have, with a count and where it lives" />
  <meta name="dai:does" content="Add or remove one with a single tap as things come and go" />
  <meta name="dai:does" content="Flag anything running low so it is never a surprise" />
  <meta name="theme-color" content="#f4f1ea" />
  <title>Inventory</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Example rows, so the first open is not empty. A second open adds nothing.
    INSERT OR IGNORE INTO items (id, name, place, qty, low_at) VALUES
      (1, 'AA batteries', 'Hall drawer', 6, 2),
      (2, 'Light bulbs', 'Garage shelf', 1, 2),
      (3, 'Paper towels', 'Pantry', 4, 1),
      (4, 'Printer paper', 'Study cabinet', 0, 1);
  </script>

  <main>
    <header>
      <h1>Inventory</h1>
      <p class="summary">
        <dai-value query="SELECT count(*) FROM items"></dai-value> items ·
        <dai-value query="SELECT count(*) FROM items WHERE qty <= low_at"></dai-value> running low
      </p>
    </header>

    <dai-rows
      class="list"
      query="SELECT id, name, place, qty, qty <= low_at AS low FROM items ORDER BY low DESC, name COLLATE NOCASE"
      empty="Nothing here yet. Add the first thing you want to keep track of.">
      <template>
        <div class="item">
          <div class="what">
            <strong data-text="name"></strong>
            <span class="place" data-text="place"></span>
          </div>
          <span class="flag" data-when="low">Low</span>
          <div class="count">
            <button type="button" class="step" aria-label="One fewer"
              data-run="UPDATE items SET qty = max(qty - 1, 0) WHERE id = :id">&minus;</button>
            <span class="qty" data-text="qty"></span>
            <button type="button" class="step" aria-label="One more"
              data-run="UPDATE items SET qty = qty + 1 WHERE id = :id">+</button>
          </div>
          <button type="button" class="remove" aria-label="Remove this item"
            data-run="DELETE FROM items WHERE id = :id">Remove</button>
        </div>
      </template>
    </dai-rows>

    <dai-form class="add" run="INSERT INTO items (name, place, qty, low_at) VALUES (:name, :place, :qty, :low_at)">
      <h2>Add something</h2>
      <label>Name <input name="name" required maxlength="80" placeholder="e.g. Trash bags" autocomplete="off" /></label>
      <label>Where <input name="place" maxlength="60" placeholder="e.g. Under the sink" autocomplete="off" /></label>
      <div class="pair">
        <label>How many <input name="qty" type="number" min="0" step="1" value="1" required inputmode="numeric" /></label>
        <label>Low at <input name="low_at" type="number" min="0" step="1" value="1" required inputmode="numeric" /></label>
      </div>
      <button>Add</button>
    </dai-form>

    <footer>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./dai-kit.js"></script>
</body>
</html>

--- file: app.css
:root {
  color-scheme: light dark;
  --bg: #f4f1ea;
  --card: #ffffff;
  --ink: #232a26;
  --muted: #69726c;
  --line: #e1dccf;
  --accent: #2f6f4f;
  --warn: #9a5b00;
  --warn-bg: #fbeed6;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161a17; --card: #1f2520; --ink: #e8ece8; --muted: #9aa39c;
    --line: #2e3630; --accent: #7cc39c; --warn: #f0b35a; --warn-bg: #3a2c12;
  }
}

* { box-sizing: border-box; }

/* A display rule below would otherwise show what the page hid. */
[hidden] { display: none !important; }

html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { line-height: 1.45; -webkit-font-smoothing: antialiased; }

/* Color runs to every edge; content stays clear of the strips a phone covers. */
main {
  max-width: 600px;
  margin: 0 auto;
  padding: calc(24px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px))
    calc(32px + var(--dai-safe-bottom, 0px)) calc(16px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* The top right corner belongs to the host's menu button. */
header { padding-right: 56px; }
h1 { margin: 0; font-size: 30px; letter-spacing: -0.02em; line-height: 1.1; }
h2 { margin: 0; font-size: 16px; }
.summary { margin: 6px 0 0; color: var(--muted); font-variant-numeric: tabular-nums; }

.list { display: block; }
.list .item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 12px;
  align-items: center;
  padding: 12px 14px;
  margin-bottom: 10px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
}
.what { display: grid; gap: 2px; min-width: 0; }
.what strong { overflow-wrap: anywhere; }
.place { color: var(--muted); font-size: 14px; }
.place:empty { display: none; }

.flag {
  grid-column: 1; justify-self: start;
  font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--warn); background: var(--warn-bg);
  padding: 2px 8px; border-radius: 999px;
}

.count { display: flex; align-items: center; gap: 6px; grid-column: 2; grid-row: 1; }
.qty { min-width: 2.2em; text-align: center; font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }

button {
  font: inherit; min-height: 44px; padding: 0 16px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: var(--bg);
}
button.step { min-width: 44px; padding: 0; font-size: 22px; line-height: 1; background: transparent; color: var(--accent); }
button.remove {
  grid-column: 1 / -1; justify-self: start; min-height: 36px; padding: 0 4px;
  border: 0; background: none; color: var(--muted); font-size: 14px;
  text-decoration: underline; text-underline-offset: 3px;
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.add {
  display: grid; gap: 12px; padding: 16px;
  background: var(--card); border: 1px solid var(--line); border-radius: 14px;
}
.add label { display: grid; gap: 6px; color: var(--muted); font-size: 14px; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
input {
  font: inherit; color: var(--ink); background: var(--bg);
  border: 1px solid var(--line); border-radius: 10px;
  min-height: 44px; padding: 8px 12px; width: 100%;
}
::placeholder { color: var(--muted); opacity: 0.6; font-style: italic; }

dai-rows[empty], .list:empty { color: var(--muted); }

footer { display: flex; justify-content: flex-end; }
dai-save {
  display: inline-block; padding: 12px 22px; border-radius: 10px;
  background: var(--accent); color: var(--bg); cursor: pointer; font-weight: 600;
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#2f6f4f"/><path d="M20 38 50 22l30 16v32L50 86 20 70z" fill="#f4f1ea"/><path d="M20 38 50 54l30-16M50 54v32" fill="none" stroke="#2f6f4f" stroke-width="5" stroke-linejoin="round"/></svg>
```

Notes on how it behaves:

- **Low stock:** each item has a "Low at" number. When the count is at or below it, the item gets a Low tag and sits at the top of the list. The header counts how many are running low.
- **Saving:** every tap is written to the database as it happens, so there is no Save button to press. The small Save control only appears if you open the file straight in a browser with no host.
- **Sharing:** this is a single-person document. If you later want two people, or two of your own devices, to add to the same inventory and keep both sets of changes, tell me now. That is a different design (the list becomes a shared table) and it is better to decide before the first release than to convert later.
