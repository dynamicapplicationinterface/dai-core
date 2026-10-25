```text
dai bundle v1
name: Packing list

--- file: schema.sql
-- Packing list
--
-- Ordinary tables with their own keys. One trip per document: its name and
-- dates live in a single row, and every thing to pack is a row of its own.
-- Totals ("3 of 14 packed") are queries in the page, never stored columns.

CREATE TABLE IF NOT EXISTS trip (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  dates TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  what TEXT NOT NULL,
  packed INTEGER NOT NULL DEFAULT 0,
  added TEXT NOT NULL DEFAULT (datetime('now'))
);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="A packing list you tick off as the bag fills" />
  <meta name="dai:does" content="Add what you need to take, sorted into groups" />
  <meta name="dai:does" content="Tick things off as they go into the bag" />
  <meta name="dai:does" content="Show at a glance how much is still left to pack" />
  <meta name="theme-color" content="#f4f7f5" />
  <title>Packing list</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <!-- Starting rows. Run once, when the document is created; ids are left out. -->
  <script type="application/sql">
    INSERT INTO trip (name, dates) VALUES ('Weekend away', 'Fri to Sun');

    INSERT INTO items (kind, what, packed) VALUES
      ('Documents', 'Passport or ID', 1),
      ('Documents', 'Tickets and bookings', 0),
      ('Documents', 'Wallet', 1),
      ('Clothes', 'Underwear and socks', 0),
      ('Clothes', 'Jacket', 0),
      ('Clothes', 'Something to sleep in', 0),
      ('Toiletries', 'Toothbrush', 0),
      ('Toiletries', 'Medication', 1),
      ('Toiletries', 'Sunscreen', 0),
      ('Tech', 'Phone charger', 1),
      ('Tech', 'Headphones', 0),
      ('Other', 'House keys', 0),
      ('Other', 'Water bottle', 0);
  </script>

  <main>
    <header>
      <!-- The trip's name and dates, typed over in place. -->
      <dai-rows query="SELECT id, name, dates FROM trip ORDER BY id LIMIT 1">
        <template>
          <div class="trip">
            <h1>
              <input
                class="title"
                aria-label="Name of the trip"
                placeholder="Where are you going?"
                maxlength="60"
                data-text="name"
                data-run="UPDATE trip SET name = :typed WHERE id = :id"
              />
            </h1>
            <input
              class="dates"
              aria-label="When the trip is"
              placeholder="When?"
              maxlength="40"
              data-text="dates"
              data-run="UPDATE trip SET dates = :typed WHERE id = :id"
            />
          </div>
        </template>
      </dai-rows>

      <p class="progress">
        <dai-value query="SELECT count(*) FROM items WHERE packed = 1"></dai-value>
        of
        <dai-value query="SELECT count(*) FROM items"></dai-value>
        packed
      </p>

      <dai-rows
        class="note"
        query="SELECT 1 AS ok WHERE (SELECT count(*) FROM items) > 0 AND (SELECT count(*) FROM items WHERE packed = 0) = 0"
      >
        <template>
          <p class="done">Everything is in the bag. Have a good trip.</p>
        </template>
      </dai-rows>
    </header>

    <section aria-labelledby="g-documents">
      <h2 id="g-documents">Documents</h2>
      <dai-rows class="list" empty="Nothing to pack here yet" query="SELECT id, what, packed FROM items WHERE kind = 'Documents' ORDER BY packed, added, what">
        <template>
          <div class="row">
            <label class="item">
              <input type="checkbox" data-run="UPDATE items SET packed = 1 - packed WHERE id = :id" />
              <span class="box" aria-hidden="true"></span>
              <span class="what" data-text="what"></span>
              <span class="in" data-when="packed">packed</span>
            </label>
            <button type="button" class="remove" aria-label="Remove this item" data-run="DELETE FROM items WHERE id = :id">&times;</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="g-clothes">
      <h2 id="g-clothes">Clothes</h2>
      <dai-rows class="list" empty="Nothing to pack here yet" query="SELECT id, what, packed FROM items WHERE kind = 'Clothes' ORDER BY packed, added, what">
        <template>
          <div class="row">
            <label class="item">
              <input type="checkbox" data-run="UPDATE items SET packed = 1 - packed WHERE id = :id" />
              <span class="box" aria-hidden="true"></span>
              <span class="what" data-text="what"></span>
              <span class="in" data-when="packed">packed</span>
            </label>
            <button type="button" class="remove" aria-label="Remove this item" data-run="DELETE FROM items WHERE id = :id">&times;</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="g-toiletries">
      <h2 id="g-toiletries">Toiletries</h2>
      <dai-rows class="list" empty="Nothing to pack here yet" query="SELECT id, what, packed FROM items WHERE kind = 'Toiletries' ORDER BY packed, added, what">
        <template>
          <div class="row">
            <label class="item">
              <input type="checkbox" data-run="UPDATE items SET packed = 1 - packed WHERE id = :id" />
              <span class="box" aria-hidden="true"></span>
              <span class="what" data-text="what"></span>
              <span class="in" data-when="packed">packed</span>
            </label>
            <button type="button" class="remove" aria-label="Remove this item" data-run="DELETE FROM items WHERE id = :id">&times;</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="g-tech">
      <h2 id="g-tech">Tech</h2>
      <dai-rows class="list" empty="Nothing to pack here yet" query="SELECT id, what, packed FROM items WHERE kind = 'Tech' ORDER BY packed, added, what">
        <template>
          <div class="row">
            <label class="item">
              <input type="checkbox" data-run="UPDATE items SET packed = 1 - packed WHERE id = :id" />
              <span class="box" aria-hidden="true"></span>
              <span class="what" data-text="what"></span>
              <span class="in" data-when="packed">packed</span>
            </label>
            <button type="button" class="remove" aria-label="Remove this item" data-run="DELETE FROM items WHERE id = :id">&times;</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="g-other">
      <h2 id="g-other">Other</h2>
      <dai-rows class="list" empty="Nothing to pack here yet" query="SELECT id, what, packed FROM items WHERE kind = 'Other' ORDER BY packed, added, what">
        <template>
          <div class="row">
            <label class="item">
              <input type="checkbox" data-run="UPDATE items SET packed = 1 - packed WHERE id = :id" />
              <span class="box" aria-hidden="true"></span>
              <span class="what" data-text="what"></span>
              <span class="in" data-when="packed">packed</span>
            </label>
            <button type="button" class="remove" aria-label="Remove this item" data-run="DELETE FROM items WHERE id = :id">&times;</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <dai-form class="add" run="INSERT INTO items (kind, what) VALUES (:kind, :what)">
      <select name="kind" aria-label="Group">
        <option>Documents</option>
        <option>Clothes</option>
        <option>Toiletries</option>
        <option>Tech</option>
        <option>Other</option>
      </select>
      <input name="what" placeholder="Don't forget&hellip;" aria-label="What to pack" required maxlength="80" />
      <button type="button">Add</button>
    </dai-form>

    <footer>
      <dai-form class="reset" run="UPDATE items SET packed = 0 WHERE packed = 1">
        <button type="button">Unpack everything</button>
      </dai-form>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./dai-kit.js"></script>
</body>
</html>

--- file: app.css
/* Calm greens on paper; the same list on a phone or a wide window. */
:root {
  --paper: #f4f7f5;
  --card: #ffffff;
  --ink: #16251d;
  --muted: #62756a;
  --line: #d9e3dc;
  --accent: #1f7a56;
  --accent-ink: #ffffff;
  --pill: #dcefe4;
  --pill-ink: #14503a;
  --ground: #e6ede8;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #121a16;
    --card: #1a251f;
    --ink: #e8f0ea;
    --muted: #8fa397;
    --line: #2b3a31;
    --accent: #4fc08d;
    --accent-ink: #0c1a13;
    --pill: #22362b;
    --pill-ink: #bfe8d1;
    --ground: #0d1310;
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

/*
 * The colour runs to every edge; the content stays clear of the strips a phone
 * covers, using the host's safe-area properties (zero where nothing is in the way).
 */
main {
  max-width: 560px;
  margin: 0 auto;
  padding:
    calc(28px + var(--dai-safe-top, 0px))
    calc(20px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px))
    calc(20px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 20px;
}

header { display: flex; flex-direction: column; gap: 6px; }

/* The trip's name and dates read as text until touched. */
.trip { display: flex; flex-direction: column; gap: 2px; }

h1 { margin: 0; }

.trip input {
  width: 100%;
  max-width: 100%;
  min-height: 44px;
  padding: 2px 0;
  border: 0;
  border-bottom: 1px dashed transparent;
  border-radius: 0;
  background: none;
  color: inherit;
  font: inherit;
}

.trip input.title {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
}

.trip input.dates {
  min-height: 36px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
}

.trip input::placeholder { color: var(--muted); font-weight: 400; }
.trip input:hover,
.trip input:focus { outline: none; border-bottom-color: var(--accent); }

.progress {
  margin: 4px 0 0;
  align-self: flex-start;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--pill);
  color: var(--pill-ink);
  font-size: 14px;
  font-weight: 600;
}

dai-value { display: inline; }

.note { display: block; }
.done { margin: 4px 0 0; color: var(--accent); font-weight: 600; }

h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.list {
  display: block;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
  color: var(--muted);
}

/* An empty group says so, quietly. */
.list:not(:has(.row)) { padding: 14px; font-size: 14px; }

.row {
  display: flex;
  align-items: stretch;
  color: var(--ink);
}

.row + .row { border-top: 1px solid var(--line); }

.item {
  flex: 1;
  min-width: 0;
  min-height: 48px;
  display: grid;
  grid-template-columns: 24px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 8px 6px 8px 14px;
  cursor: pointer;
}

/* The checkbox stays real and focusable; the circle is its picture. */
.item input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}

.box {
  width: 24px;
  height: 24px;
  border: 2px solid var(--muted);
  border-radius: 999px;
}

.what { overflow-wrap: anywhere; }

.in {
  display: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent);
}

.item:has(.in:not([hidden])) .box {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: inset 0 0 0 3px var(--card);
}

.item:has(.in:not([hidden])) .what { color: var(--muted); text-decoration: line-through; }
.item:has(.in:not([hidden])) .in { display: inline; }
.item:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }

.remove {
  flex: 0 0 auto;
  width: 44px;
  min-height: 44px;
  border: 0;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}

.remove:hover { color: var(--ink); }
.remove:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

/* Adding a thing: group, words, button. Wraps on a narrow screen. */
.add { display: flex; flex-wrap: wrap; gap: 8px; }

.add input,
.add select {
  min-height: 44px;
  padding: 10px 12px;
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  color: var(--ink);
}

.add input { flex: 1 1 12rem; min-width: 0; }
.add select { flex: 0 0 auto; }

.add input:focus,
.add select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }

dai-form button,
dai-save {
  min-height: 44px;
  padding: 10px 18px;
  font: inherit;
  font-weight: 600;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: var(--accent-ink);
  cursor: pointer;
}

dai-form button:focus-visible,
dai-save:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
  align-items: center;
}

.reset { display: block; }

.reset button {
  background: none;
  color: var(--muted);
  border: 1px solid var(--line);
  font-weight: 500;
}

dai-save { display: inline-block; }

/* On a wide window the page becomes a card on a quieter ground. */
@media (min-width: 720px) {
  html, body { background: var(--ground); }
  main {
    margin: 40px auto;
    padding: 32px 32px 36px;
    background: var(--paper);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 24px 60px -20px rgb(0 0 0 / 0.2);
  }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- A bag with a tick on it. -->
  <rect width="100" height="100" fill="#1f7a56"/>
  <path d="M36 34V26a6 6 0 0 1 6-6h16a6 6 0 0 1 6 6v8" fill="none" stroke="#f4f7f5" stroke-width="6" stroke-linecap="round"/>
  <rect x="18" y="34" width="64" height="46" rx="10" fill="#f4f7f5"/>
  <path d="M36 57l10 10 19-20" fill="none" stroke="#1f7a56" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```
