This is a packing list for one person on one phone, so I built it as a solo document. Nothing is shared, there is no JavaScript of its own, and the kit does all the wiring. Every tick is saved the moment you make it.

It has a trip name and dates you can type over, items grouped by kind, a count of what is still missing, and a button to untick everything for the next trip.

```text
dai bundle v1
name: Packing list

--- file: schema.sql
-- Packing list · shape: solo
--
-- The decision: one person's list for their own trip, kept in one document.
-- Nobody else changes it and no second copy's edits need keeping, so nothing
-- is shared: ordinary tables, written with the kit, keys and all.

CREATE TABLE IF NOT EXISTS items (
  id     INTEGER PRIMARY KEY,
  kind   TEXT NOT NULL,
  what   TEXT NOT NULL,
  packed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trip (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  dates TEXT NOT NULL
);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="A packing list you tick off as the bag fills" />
  <meta name="dai:does" content="Keep everything for your trip in one list you can add to" />
  <meta name="dai:does" content="Tick each thing off as it goes in the bag" />
  <meta name="dai:does" content="Show what is still missing before you leave" />
  <meta name="theme-color" content="#f4f1ea" />
  <title>Packing list</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Seed rows: local, and safe to run on every open.
    INSERT OR IGNORE INTO trip (id, name, dates) VALUES (1, 'My trip', 'Add your dates');

    INSERT OR IGNORE INTO items (id, kind, what, packed) VALUES
      (1, 'Documents', 'Passport or ID', 0),
      (2, 'Documents', 'Tickets and bookings', 0),
      (3, 'Clothes', 'Underwear and socks', 0),
      (4, 'Clothes', 'Jacket', 0),
      (5, 'Toiletries', 'Toothbrush', 1),
      (6, 'Toiletries', 'Medication', 0),
      (7, 'Tech', 'Phone charger', 1),
      (8, 'Tech', 'Headphones', 0);
  </script>

  <main>
    <header>
      <!-- The trip's name and dates are typed over in place. -->
      <dai-rows query="SELECT id, name, dates FROM trip WHERE id = 1">
        <template>
          <div class="trip">
            <input class="dates" aria-label="When the trip is" data-text="dates"
                   data-run="UPDATE trip SET dates = :typed WHERE id = 1" maxlength="40" />
            <input class="name" aria-label="Name of the trip" data-text="name"
                   data-run="UPDATE trip SET name = :typed WHERE id = 1" maxlength="60" />
          </div>
        </template>
      </dai-rows>
      <p class="progress">
        <dai-value query="SELECT count(*) FROM items WHERE packed = 1"></dai-value>
        of
        <dai-value query="SELECT count(*) FROM items"></dai-value>
        packed
      </p>
    </header>

    <section aria-label="Still to pack">
      <h2>Still to pack</h2>
      <dai-rows query="SELECT id, kind, what FROM items WHERE packed = 0 ORDER BY kind, id"
                empty="Everything is in the bag. Have a good trip.">
        <template>
          <div class="row">
            <label class="item">
              <input type="checkbox" data-run="UPDATE items SET packed = 1 WHERE id = :id" />
              <span class="box" aria-hidden="true"></span>
              <span class="what" data-text="what"></span>
              <span class="kind" data-text="kind"></span>
            </label>
            <button type="button" class="remove" aria-label="Remove from the list"
                    data-run="DELETE FROM items WHERE id = :id">×</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-label="Packed">
      <h2>In the bag</h2>
      <dai-rows query="SELECT id, kind, what FROM items WHERE packed = 1 ORDER BY kind, id"
                empty="Nothing packed yet. Tick things off above as they go in.">
        <template>
          <div class="row done">
            <label class="item">
              <input type="checkbox" checked data-run="UPDATE items SET packed = 0 WHERE id = :id" />
              <span class="box" aria-hidden="true"></span>
              <span class="what" data-text="what"></span>
              <span class="kind" data-text="kind"></span>
            </label>
            <button type="button" class="remove" aria-label="Remove from the list"
                    data-run="DELETE FROM items WHERE id = :id">×</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <dai-form class="add" run="INSERT INTO items (kind, what) VALUES (:kind, :what)">
      <select name="kind" aria-label="Group">
        <option>Clothes</option>
        <option>Toiletries</option>
        <option>Documents</option>
        <option>Tech</option>
        <option>Other</option>
      </select>
      <input name="what" placeholder="Don't forget…" required maxlength="80" aria-label="Item" />
      <button>Add</button>
    </dai-form>

    <footer>
      <button type="button" class="quiet" data-run="UPDATE items SET packed = 0">Start over: untick everything</button>
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
  --ink: #1f2a2e;
  --muted: #6b7479;
  --line: #e1dbcd;
  --accent: #2d6a73;
  --on-accent: #ffffff;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141a1c;
    --card: #1d2528;
    --ink: #e7eced;
    --muted: #96a3a7;
    --line: #2d383c;
    --accent: #7cc3cc;
    --on-accent: #10181a;
  }
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }

html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { font-size: 16px; line-height: 1.45; -webkit-font-smoothing: antialiased; }

main {
  max-width: 560px;
  margin: 0 auto;
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(16px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* The top right corner belongs to the host's menu button. */
header { display: flex; flex-direction: column; gap: 6px; padding-right: 56px; }
.trip { display: flex; flex-direction: column; }

.trip input {
  width: 100%;
  min-height: 44px;
  padding: 2px 0;
  border: 0;
  border-bottom: 1px dashed transparent;
  background: none;
  color: inherit;
  font: inherit;
}
.trip input:hover,
.trip input:focus { outline: none; border-bottom-color: var(--accent); }
.trip .dates {
  min-height: 28px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
}
.trip .name {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.progress {
  margin: 4px 0 0;
  align-self: flex-start;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--card);
  border: 1px solid var(--line);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

dai-rows { display: block; }
section dai-rows {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}

/* The empty message the kit draws. */
section dai-rows:not(:has(.row)) {
  padding: 16px;
  color: var(--muted);
}

.row {
  display: flex;
  align-items: center;
  border-top: 1px solid var(--line);
}
.row:first-child { border-top: 0; }

.item {
  flex: 1;
  min-width: 0;
  min-height: 48px;
  display: grid;
  grid-template-columns: 24px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 8px 8px 8px 14px;
  cursor: pointer;
}
.item input { position: absolute; opacity: 0; width: 1px; height: 1px; }

.box {
  width: 24px;
  height: 24px;
  border: 2px solid var(--muted);
  border-radius: 999px;
}
.item:has(input:checked) .box {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: inset 0 0 0 4px var(--card);
}
.item:has(input:focus-visible) .box { outline: 2px solid var(--accent); outline-offset: 2px; }

.what { overflow-wrap: anywhere; }
.done .what { color: var(--muted); text-decoration: line-through; }

.kind {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

.remove {
  flex: none;
  width: 44px;
  min-height: 44px;
  border: 0;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 22px;
  cursor: pointer;
}
.remove:hover,
.remove:focus-visible { color: var(--ink); }

.add { display: flex; gap: 8px; }
.add input,
.add select {
  min-width: 0;
  min-height: 44px;
  padding: 8px 12px;
  font: inherit;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.add input { flex: 1; }
.add select { flex: none; }

button { font: inherit; }
.add button,
dai-save {
  min-height: 44px;
  padding: 0 18px;
  font-weight: 600;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: var(--on-accent);
  cursor: pointer;
}

footer { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
button.quiet {
  min-height: 44px;
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--muted);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
dai-save { display: inline-block; line-height: 44px; padding: 0 22px; }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* On a wide screen the page becomes a card on a quieter ground. */
@media (min-width: 720px) {
  main {
    margin: 40px auto;
    padding: 32px;
    background: var(--bg);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.05), 0 24px 60px -20px rgb(0 0 0 / 0.2);
  }
  html, body { background: color-mix(in srgb, var(--bg) 88%, #000); }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#2d6a73"/><rect x="22" y="34" width="56" height="46" rx="9" fill="#f4f1ea"/><path d="M38 34v-6a6 6 0 0 1 6-6h12a6 6 0 0 1 6 6v6" fill="none" stroke="#f4f1ea" stroke-width="6" stroke-linecap="round"/><path d="M36 58l9 9 19-19" fill="none" stroke="#2d6a73" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>
```

Notes:

- **Sharing:** It is a personal list, so there is no Share button. The host's own menu can still send someone a copy. Their copy is separate, and the two will not merge.
- **Items:** Removing an item deletes it for good. "Start over" unticks everything but keeps the items, so the list can be reused for the next trip.
- **Dates and name:** Both are typed over in place and saved as you go. The dates are the small line above the title.
- **Saving:** There is no save button. The kit shows a Save control only if the file is opened straight in a browser with no host.
