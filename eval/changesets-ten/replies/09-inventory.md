```text
dai bundle v1
name: Inventory

--- file: schema.sql
-- Inventory
--
-- Two ordinary tables. Stock is never stored: every change is a row in
-- movements (a delivery is positive, a use is negative), and the count on
-- screen is the sum of an item's rows. Two copies that each add a movement
-- merge cleanly; a stored total would not.

CREATE TABLE IF NOT EXISTS items (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  place    TEXT NOT NULL DEFAULT '',
  low_at   INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS movements (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delta   INTEGER NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS movements_by_item ON movements (item_id);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Inventory</title>
  <meta name="description" content="Count what you have and see what is running low" />
  <meta name="dai:does" content="Track how many of each thing you have, and where it lives" />
  <meta name="dai:does" content="Record what comes in and what gets used, one tap at a time" />
  <meta name="dai:does" content="Flag anything running low before it runs out" />
  <meta name="theme-color" content="#f6f4ef" />
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Example items. The tables are declared in schema.sql.
    INSERT INTO items (name, place, low_at) VALUES
      ('Printer paper', 'Supply closet', 2),
      ('Coffee beans', 'Kitchen shelf', 2),
      ('AA batteries', 'Desk drawer', 4),
      ('Hand soap', 'Bathroom cabinet', 2),
      ('Light bulbs', 'Garage', 3),
      ('Stamps', 'Desk drawer', 5);

    INSERT INTO movements (item_id, delta, note, at)
      SELECT id, 10, 'Opening count', datetime('now', '-9 days') FROM items WHERE name = 'Printer paper';
    INSERT INTO movements (item_id, delta, note, at)
      SELECT id, -3, 'Used', datetime('now', '-2 days') FROM items WHERE name = 'Printer paper';

    INSERT INTO movements (item_id, delta, note, at)
      SELECT id, 6, 'Opening count', datetime('now', '-9 days') FROM items WHERE name = 'Coffee beans';
    INSERT INTO movements (item_id, delta, note, at)
      SELECT id, -1, 'Used', datetime('now', '-1 days') FROM items WHERE name = 'Coffee beans';

    INSERT INTO movements (item_id, delta, note, at)
      SELECT id, 8, 'Opening count', datetime('now', '-9 days') FROM items WHERE name = 'AA batteries';
    INSERT INTO movements (item_id, delta, note, at)
      SELECT id, -5, 'Used', datetime('now', '-3 hours') FROM items WHERE name = 'AA batteries';

    INSERT INTO movements (item_id, delta, note, at)
      SELECT id, 4, 'Opening count', datetime('now', '-9 days') FROM items WHERE name = 'Hand soap';

    INSERT INTO movements (item_id, delta, note, at)
      SELECT id, 12, 'Opening count', datetime('now', '-9 days') FROM items WHERE name = 'Light bulbs';
    INSERT INTO movements (item_id, delta, note, at)
      SELECT id, -2, 'Used', datetime('now', '-5 days') FROM items WHERE name = 'Light bulbs';

    INSERT INTO movements (item_id, delta, note, at)
      SELECT id, 20, 'Opening count', datetime('now', '-9 days') FROM items WHERE name = 'Stamps';
  </script>

  <main>
    <header>
      <p class="eyebrow">What is on the shelf</p>
      <h1>Inventory</h1>

      <div class="summary">
        <p>
          <strong><dai-value query="SELECT count(*) FROM items WHERE archived = 0"></dai-value></strong>
          <span>things</span>
        </p>
        <p>
          <strong><dai-value query="SELECT COALESCE(SUM(m.delta), 0) FROM movements m JOIN items i ON i.id = m.item_id WHERE i.archived = 0"></dai-value></strong>
          <span>in all</span>
        </p>
        <p class="warn">
          <strong><dai-value query="SELECT count(*) FROM (SELECT i.id FROM items i LEFT JOIN movements m ON m.item_id = i.id WHERE i.archived = 0 GROUP BY i.id HAVING COALESCE(SUM(m.delta), 0) &lt;= i.low_at)"></dai-value></strong>
          <span>low or out</span>
        </p>
      </div>
    </header>

    <section aria-labelledby="stock-h">
      <h2 id="stock-h">Stock</h2>
      <dai-rows
        class="list"
        empty="Nothing here yet. Add the first thing below."
        query="SELECT i.id AS id, i.name AS name, i.place AS place, COALESCE(SUM(m.delta), 0) AS stock, CASE WHEN COALESCE(SUM(m.delta), 0) &lt;= i.low_at THEN 1 ELSE 0 END AS low FROM items i LEFT JOIN movements m ON m.item_id = i.id WHERE i.archived = 0 GROUP BY i.id ORDER BY low DESC, i.name">
        <template>
          <div class="item">
            <div class="top">
              <div class="who">
                <span class="name" data-text="name"></span>
                <span class="place" data-text="place"></span>
              </div>
              <span class="tag" data-when="low">Low</span>
              <span class="stock" data-text="stock"></span>
            </div>
            <div class="actions">
              <button type="button" class="btn"
                data-run="INSERT INTO movements (item_id, delta, note) SELECT :id, -1, 'Used one' WHERE (SELECT COALESCE(SUM(delta), 0) FROM movements WHERE item_id = :id) &gt;= 1">Use 1</button>
              <button type="button" class="btn"
                data-run="INSERT INTO movements (item_id, delta, note) VALUES (:id, 1, 'Added one')">Add 1</button>
              <button type="button" class="btn"
                data-run="INSERT INTO movements (item_id, delta, note) VALUES (:id, 10, 'Added ten')">Add 10</button>
              <button type="button" class="btn ghost"
                data-run="UPDATE items SET archived = 1 WHERE id = :id">Archive</button>
            </div>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="add-h">
      <h2 id="add-h">Add a thing</h2>
      <dai-form class="add" run="INSERT INTO items (name, place, low_at) VALUES (:name, :place, CAST(:low_at AS INTEGER))">
        <label>
          <span>Name</span>
          <input name="name" required maxlength="80" placeholder="Printer paper" autocomplete="off" />
        </label>
        <label>
          <span>Where it lives</span>
          <input name="place" maxlength="80" placeholder="Supply closet" autocomplete="off" />
        </label>
        <label>
          <span>Flag it at or below</span>
          <input name="low_at" type="number" inputmode="numeric" min="0" step="1" placeholder="2" />
        </label>
        <button type="button" class="btn primary">Add</button>
      </dai-form>
      <p class="hint">A new thing starts at 0. Use Add 1 or Add 10 to count what you have.</p>
    </section>

    <section aria-labelledby="recent-h">
      <h2 id="recent-h">Recently</h2>
      <dai-rows
        class="list"
        empty="No changes yet."
        query="SELECT id, name, shown, note, CASE WHEN 60 &gt; secs THEN 'just now' WHEN 3600 &gt; secs THEN (secs / 60) || ' min ago' WHEN 86400 &gt; secs THEN (secs / 3600) || ' h ago' WHEN 172800 &gt; secs THEN 'yesterday' ELSE (secs / 86400) || ' days ago' END AS ago FROM (SELECT m.id AS id, i.name AS name, CASE WHEN m.delta &gt; 0 THEN '+' || m.delta ELSE CAST(m.delta AS TEXT) END AS shown, m.note AS note, CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', m.at) AS INTEGER) AS secs FROM movements m JOIN items i ON i.id = m.item_id ORDER BY m.at DESC, m.id DESC LIMIT 8) ORDER BY secs, id DESC">
        <template>
          <div class="log">
            <span class="delta" data-text="shown"></span>
            <span class="what"><span data-text="name"></span> <span class="note" data-text="note"></span></span>
            <span class="ago" data-text="ago"></span>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="archive-h">
      <h2 id="archive-h">Archived</h2>
      <dai-rows
        class="list"
        empty="Nothing archived."
        query="SELECT id, name, place FROM items WHERE archived = 1 ORDER BY name">
        <template>
          <div class="log">
            <span class="what"><span data-text="name"></span> <span class="note" data-text="place"></span></span>
            <button type="button" class="btn ghost"
              data-run="UPDATE items SET archived = 0 WHERE id = :id">Restore</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <footer>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./dai-kit.js"></script>
</body>
</html>

--- file: app.css
/* Paper and ink, with one warm accent. */
:root {
  --paper: #f6f4ef;
  --card: #ffffff;
  --ink: #1f2a2e;
  --muted: #68757a;
  --line: #e1ddd2;
  --accent: #1f6f5c;
  --accent-ink: #ffffff;
  --warn: #b4540a;
  --warn-bg: #fbe9d6;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #14191b;
    --card: #1d2427;
    --ink: #e9eeee;
    --muted: #93a2a7;
    --line: #2d383c;
    --accent: #4fb89c;
    --accent-ink: #0d1a16;
    --warn: #f0a96a;
    --warn-bg: #3a2a1a;
  }
}

* { box-sizing: border-box; }

[hidden] { display: none !important; }

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

/* Colour runs to every edge; content stays clear of what a phone covers. */
main {
  max-width: 40rem;
  margin: 0 auto;
  padding:
    calc(32px + var(--dai-safe-top, 0px))
    calc(20px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px))
    calc(20px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 28px;
}

header { display: flex; flex-direction: column; gap: 6px; }

.eyebrow {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
}

h1 {
  margin: 0;
  font-size: 2.1rem;
  line-height: 1.05;
  letter-spacing: -0.03em;
}

h2 {
  margin: 0 0 10px;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.summary p {
  margin: 0;
  padding: 8px 14px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 0.9rem;
  color: var(--muted);
}

.summary strong { font-size: 1.1rem; color: var(--ink); }
.summary .warn strong { color: var(--warn); }

.list {
  display: block;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  overflow: hidden;
}

.item {
  padding: 14px 16px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.item:first-child, .log:first-child { border-top: 0; }

.top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.who {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.name { font-weight: 650; overflow-wrap: anywhere; }
.place { font-size: 0.85rem; color: var(--muted); overflow-wrap: anywhere; }

.stock {
  font-size: 1.6rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.tag {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--warn-bg);
  color: var(--warn);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.actions { display: flex; flex-wrap: wrap; gap: 8px; }

.btn,
dai-save {
  min-height: 44px;
  min-width: 44px;
  padding: 0 16px;
  font: inherit;
  font-weight: 600;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 12px;
  cursor: pointer;
}

.btn:hover { border-color: var(--accent); }

.btn.primary,
dai-save {
  background: var(--accent);
  color: var(--accent-ink);
  border-color: var(--accent);
}

.btn.ghost {
  background: none;
  color: var(--muted);
  margin-left: auto;
}

button:focus-visible,
input:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

.add {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 16px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
}

.add label {
  flex: 1 1 12rem;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
}

.add input {
  min-height: 44px;
  min-width: 0;
  padding: 0 12px;
  font: inherit;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.add .btn { flex: 1 1 100%; }

.hint { margin: 8px 2px 0; font-size: 0.85rem; color: var(--muted); }

.log {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  min-height: 44px;
  border-top: 1px solid var(--line);
}

.delta {
  min-width: 3ch;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

.what { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.note { color: var(--muted); font-size: 0.85rem; }
.ago { font-size: 0.8rem; color: var(--muted); white-space: nowrap; }

footer { display: flex; justify-content: flex-end; }
dai-save { display: inline-flex; align-items: center; }

@media (min-width: 720px) {
  main { padding-top: calc(48px + var(--dai-safe-top, 0px)); }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- A stack of boxes on a green ground. -->
  <rect width="100" height="100" fill="#1f6f5c"/>
  <rect x="16" y="52" width="32" height="30" rx="3" fill="#f6f4ef"/>
  <rect x="52" y="52" width="32" height="30" rx="3" fill="#f6f4ef"/>
  <rect x="34" y="18" width="32" height="30" rx="3" fill="#f0c987"/>
  <rect x="28" y="64" width="8" height="5" rx="2" fill="#1f6f5c"/>
  <rect x="64" y="64" width="8" height="5" rx="2" fill="#1f6f5c"/>
  <rect x="46" y="30" width="8" height="5" rx="2" fill="#1f6f5c"/>
</svg>
```
