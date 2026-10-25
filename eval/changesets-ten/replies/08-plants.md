```text
dai bundle v1
name: Plant care

--- file: schema.sql
-- Plant care
--
-- Two ordinary tables. A plant says how often it wants water; every
-- watering, feeding, misting or note is a row in care. Nothing is totalled
-- and stored: how long ago a plant was watered, and whether it is thirsty, are
-- worked out from the rows by the queries that show them.

CREATE TABLE IF NOT EXISTS plants (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  place      TEXT NOT NULL DEFAULT '',
  every_days INTEGER NOT NULL DEFAULT 7 CHECK (every_days >= 1),
  created    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS care (
  id       INTEGER PRIMARY KEY,
  plant_id INTEGER NOT NULL REFERENCES plants (id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('Watered', 'Fed', 'Misted', 'Note')),
  note     TEXT,
  at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS care_by_plant ON care (plant_id, at);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="Know which plants are thirsty and what each one got" />
  <meta name="dai:does" content="Log every watering, feeding and misting with one tap" />
  <meta name="dai:does" content="Show which plants are thirsty and which can wait" />
  <meta name="dai:does" content="Keep a note on each plant, like a new leaf or a pest" />
  <meta name="theme-color" content="#f4f7f1" />
  <title>Plant care</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <!--
    A plant-care log, written with the kit and no JavaScript of its own.
    Tables are declared in schema.sql; the rows below are the starting data,
    run once when the document is created. Plant ids are chosen by the runtime,
    so the care rows find their plant by name.
  -->
  <script type="application/sql">
    INSERT INTO plants (name, place, every_days) VALUES
      ('Monstera', 'Living room window', 7),
      ('Snake plant', 'Bedroom', 14),
      ('Pothos', 'Kitchen shelf', 7),
      ('Basil', 'Kitchen windowsill', 3);

    INSERT INTO care (plant_id, kind, note, at)
      SELECT id, 'Watered', NULL, datetime('now', '-3 days') FROM plants WHERE name = 'Monstera';
    INSERT INTO care (plant_id, kind, note, at)
      SELECT id, 'Fed', 'Half-strength fertilizer', datetime('now', '-20 days') FROM plants WHERE name = 'Monstera';
    INSERT INTO care (plant_id, kind, note, at)
      SELECT id, 'Note', 'A new leaf is unfurling', datetime('now', '-2 days') FROM plants WHERE name = 'Monstera';
    INSERT INTO care (plant_id, kind, note, at)
      SELECT id, 'Watered', NULL, datetime('now', '-15 days') FROM plants WHERE name = 'Snake plant';
    INSERT INTO care (plant_id, kind, note, at)
      SELECT id, 'Watered', NULL, datetime('now', '-7 days') FROM plants WHERE name = 'Pothos';
    INSERT INTO care (plant_id, kind, note, at)
      SELECT id, 'Misted', NULL, datetime('now', '-4 days') FROM plants WHERE name = 'Pothos';
    INSERT INTO care (plant_id, kind, note, at)
      SELECT id, 'Watered', NULL, datetime('now', '-1 days') FROM plants WHERE name = 'Basil';
    INSERT INTO care (plant_id, kind, note, at)
      SELECT id, 'Note', 'Pinched the top to keep it bushy', datetime('now', '-1 days') FROM plants WHERE name = 'Basil';
  </script>

  <main>
    <header>
      <p class="eyebrow">Today</p>
      <h1>Plant care</h1>
      <p class="pill">
        <dai-value query="SELECT CASE
            WHEN (SELECT count(*) FROM plants) = 0 THEN 'No plants yet'
            WHEN n = 0 THEN 'Everyone is watered'
            WHEN n = 1 THEN '1 plant needs water'
            ELSE n || ' plants need water' END
          FROM (SELECT count(*) AS n FROM (
            SELECT p.every_days AS e,
                   CAST(julianday(date('now')) - julianday(date(max(c.at))) AS INTEGER) AS d
            FROM plants p
            LEFT JOIN care c ON c.plant_id = p.id AND c.kind = 'Watered'
            GROUP BY p.id)
          WHERE d IS NULL OR d >= e)"></dai-value>
      </p>
    </header>

    <section aria-labelledby="plants-h">
      <h2 id="plants-h">Your plants</h2>
      <dai-rows class="plants" empty="No plants yet. Add your first one below." query="SELECT id, name, place, every_days,
          CASE WHEN d IS NULL THEN 'Not watered yet'
               WHEN d = 0 THEN 'Watered today'
               WHEN d = 1 THEN 'Watered yesterday'
               ELSE 'Watered ' || d || ' days ago' END AS last_text,
          CASE WHEN d IS NULL THEN 'Give it a first drink'
               WHEN d > every_days THEN 'Overdue by ' || (d - every_days) || CASE WHEN d - every_days = 1 THEN ' day' ELSE ' days' END
               WHEN d = every_days THEN 'Water today'
               WHEN every_days - d = 1 THEN 'Water tomorrow'
               ELSE 'Water in ' || (every_days - d) || ' days' END AS next_text,
          CASE WHEN d IS NOT NULL AND d > every_days THEN 1 ELSE 0 END AS late,
          CASE WHEN d IS NULL OR d = every_days THEN 1 ELSE 0 END AS due
        FROM (
          SELECT p.id AS id, p.name AS name, p.place AS place, p.every_days AS every_days,
                 CAST(julianday(date('now')) - julianday(date(max(c.at))) AS INTEGER) AS d
          FROM plants p
          LEFT JOIN care c ON c.plant_id = p.id AND c.kind = 'Watered'
          GROUP BY p.id)
        ORDER BY CASE WHEN d IS NULL THEN -1000 ELSE every_days - d END, name">
        <template>
          <article class="plant">
            <div class="top">
              <div class="who">
                <strong class="name" data-text="name"></strong>
                <span class="place" data-text="place" data-when="place"></span>
              </div>
              <div class="badges">
                <span class="badge late" data-when="late">Thirsty</span>
                <span class="badge due" data-when="due">Due</span>
              </div>
            </div>

            <p class="status">
              <span data-text="last_text"></span>
              <span aria-hidden="true">&middot;</span>
              <span class="next" data-text="next_text"></span>
            </p>

            <div class="actions">
              <button type="button" class="act primary" data-kind="Watered"
                data-run="INSERT INTO care (plant_id, kind) VALUES (:id, :kind)">Water</button>
              <button type="button" class="act" data-kind="Fed"
                data-run="INSERT INTO care (plant_id, kind) VALUES (:id, :kind)">Feed</button>
              <button type="button" class="act" data-kind="Misted"
                data-run="INSERT INTO care (plant_id, kind) VALUES (:id, :kind)">Mist</button>
            </div>

            <div class="extras">
              <label class="interval">
                <span>Water every</span>
                <input type="number" min="1" max="365" inputmode="numeric"
                  aria-label="Days between waterings"
                  data-text="every_days"
                  data-run="UPDATE plants SET every_days = max(1, CAST(:typed AS INTEGER)) WHERE id = :id" />
                <span>days</span>
              </label>
              <input class="note-in" type="text" maxlength="200"
                placeholder="Add a note, then press Enter"
                aria-label="Add a note about this plant"
                data-run="INSERT INTO care (plant_id, kind, note) SELECT :id, 'Note', trim(:typed) WHERE trim(:typed) <> ''" />
            </div>

            <details class="more">
              <summary>More</summary>
              <button type="button" class="act danger"
                data-run="DELETE FROM plants WHERE id = :id">Remove this plant and its history</button>
            </details>
          </article>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="add-h">
      <h2 id="add-h">Add a plant</h2>
      <dai-form class="add" run="INSERT INTO plants (name, place, every_days) VALUES (:name, :place, :every_days)">
        <input name="name" placeholder="Name, like Fern" required maxlength="60" aria-label="Plant name" />
        <input name="place" placeholder="Where it lives" maxlength="60" aria-label="Where it lives" />
        <label class="every">
          <span>Water every</span>
          <input name="every_days" type="number" min="1" max="365" value="7" required inputmode="numeric" />
          <span>days</span>
        </label>
        <button>Add plant</button>
      </dai-form>
    </section>

    <section aria-labelledby="log-h">
      <h2 id="log-h">Recent care</h2>
      <dai-rows class="log" empty="Nothing logged yet. Tap Water on a plant to start." query="SELECT id, name, kind, note, icon,
          CASE WHEN d <= 0 THEN 'Today'
               WHEN d = 1 THEN 'Yesterday'
               WHEN d BETWEEN 2 AND 13 THEN d || ' days ago'
               WHEN d BETWEEN 14 AND 59 THEN (d / 7) || ' weeks ago'
               ELSE (d / 30) || ' months ago' END AS when_text
        FROM (
          SELECT c.id AS id, c.at AS at, p.name AS name, c.kind AS kind, c.note AS note,
                 CASE c.kind WHEN 'Watered' THEN '💧' WHEN 'Fed' THEN '🌱' WHEN 'Misted' THEN '☁️' ELSE '📝' END AS icon,
                 CAST(julianday(date('now')) - julianday(date(c.at)) AS INTEGER) AS d
          FROM care c
          JOIN plants p ON p.id = c.plant_id)
        ORDER BY at DESC
        LIMIT 25">
        <template>
          <div class="entry">
            <span class="icon" aria-hidden="true" data-text="icon"></span>
            <div class="what">
              <p class="line"><strong data-text="name"></strong> <span data-text="kind"></span></p>
              <p class="memo" data-when="note" data-text="note"></p>
              <p class="when" data-text="when_text"></p>
            </div>
            <button type="button" class="undo" aria-label="Remove this entry" title="Remove this entry"
              data-run="DELETE FROM care WHERE id = :id">&times;</button>
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
/* Leaf green on paper, with a dark mode that follows the device. */
:root {
  --paper: #f4f7f1;
  --card: #ffffff;
  --ink: #1d2a20;
  --muted: #66766a;
  --line: #dbe5d6;
  --accent: #2f7d46;
  --accent-ink: #ffffff;
  --thirst: #a93a28;
  --thirst-bg: #fbe6e1;
  --soon: #7d5a0c;
  --soon-bg: #fbefcf;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #121a14;
    --card: #1b261e;
    --ink: #e6efe4;
    --muted: #94a697;
    --line: #2b3a2f;
    --accent: #6cc283;
    --accent-ink: #0e1a11;
    --thirst: #ff9d8b;
    --thirst-bg: #40201b;
    --soon: #f0cd73;
    --soon-bg: #3a2f12;
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

/* Color runs to every edge; content is pushed clear of the strips a phone covers. */
main {
  max-width: 640px;
  margin: 0 auto;
  padding: calc(32px + var(--dai-safe-top, 0px)) calc(18px + var(--dai-safe-right, 0px))
    calc(48px + var(--dai-safe-bottom, 0px)) calc(18px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 26px;
}

header { display: flex; flex-direction: column; gap: 4px; padding-right: 48px; }

.eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent);
}

h1 {
  margin: 0;
  font-size: 34px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.05;
}

.pill {
  margin: 8px 0 0;
  align-self: flex-start;
  padding: 5px 13px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 13px;
  font-weight: 600;
}

h2 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

p { margin: 0; }

dai-rows { display: block; }

dai-rows.plants { display: grid; gap: 12px; }

/* A plant */
.plant {
  display: grid;
  gap: 12px;
  padding: 16px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
}

.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; }

.who { display: flex; flex-direction: column; min-width: 0; }

.name { font-size: 19px; letter-spacing: -0.01em; overflow-wrap: anywhere; }

.place { font-size: 14px; color: var(--muted); overflow-wrap: anywhere; }

.badges { display: flex; gap: 6px; }

.badge {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.badge.late { background: var(--thirst-bg); color: var(--thirst); }
.badge.due { background: var(--soon-bg); color: var(--soon); }

.status { font-size: 14px; color: var(--muted); }
.status .next { color: var(--ink); font-weight: 600; }

.actions { display: flex; gap: 8px; flex-wrap: wrap; }

.act {
  flex: 1 1 5.5rem;
  min-height: 44px;
  padding: 10px 14px;
  font: inherit;
  font-weight: 600;
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 12px;
  cursor: pointer;
}

.act:hover { border-color: var(--accent); }

.act.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}

.act.danger { color: var(--thirst); flex: 0 1 auto; margin-top: 8px; }

.extras { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }

.interval, .every {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--muted);
}

.interval input, .every input {
  width: 4.5em;
  min-height: 44px;
  text-align: center;
}

.note-in { flex: 1 1 12rem; min-width: 0; }

input, select {
  min-height: 44px;
  padding: 8px 12px;
  font: inherit;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 10px;
}

input::placeholder { color: var(--muted); }

.more summary {
  min-height: 44px;
  display: flex;
  align-items: center;
  font-size: 14px;
  color: var(--muted);
  cursor: pointer;
}

/* The add form */
dai-form.add {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 16px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
}

dai-form.add > input[name="name"],
dai-form.add > input[name="place"] { flex: 1 1 12rem; min-width: 0; }

dai-form.add button {
  flex: 1 1 8rem;
  min-height: 44px;
  padding: 10px 18px;
  font: inherit;
  font-weight: 600;
  color: var(--accent-ink);
  background: var(--accent);
  border: 0;
  border-radius: 12px;
  cursor: pointer;
}

/* The log */
dai-rows.log {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  overflow: hidden;
}

.entry {
  display: grid;
  grid-template-columns: 2rem 1fr auto;
  align-items: start;
  gap: 10px;
  padding: 12px 8px 12px 14px;
  border-top: 1px solid var(--line);
}

.entry:first-child { border-top: 0; }

.icon { font-size: 20px; line-height: 1.3; }

.line { overflow-wrap: anywhere; }
.memo { font-size: 14px; overflow-wrap: anywhere; }
.when { font-size: 13px; color: var(--muted); }

.undo {
  width: 44px;
  height: 44px;
  font: inherit;
  font-size: 22px;
  line-height: 1;
  color: var(--muted);
  background: none;
  border: 0;
  border-radius: 10px;
  cursor: pointer;
}

.undo:hover { color: var(--thirst); }

button:focus-visible, input:focus-visible, summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

footer { display: flex; justify-content: flex-end; }

dai-save {
  display: inline-block;
  padding: 12px 22px;
  font-weight: 600;
  color: var(--accent-ink);
  background: var(--accent);
  border-radius: 10px;
  cursor: pointer;
}

/* On a wide screen the page becomes a card on a quieter ground. */
@media (min-width: 720px) {
  html, body { background: #e6ede2; }
  main {
    margin: 40px auto;
    padding: 36px 36px 44px;
    background: var(--paper);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 24px 60px -20px rgb(0 0 0 / 0.18);
  }
}

@media (min-width: 720px) and (prefers-color-scheme: dark) {
  html, body { background: #0b110d; }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#2f7d46"/>
  <path d="M50 82V46" fill="none" stroke="#f4f7f1" stroke-width="6" stroke-linecap="round"/>
  <path d="M50 52C28 52 20 36 20 22c18 0 30 8 30 30z" fill="#f4f7f1"/>
  <path d="M50 62c20 0 30-12 30-26-18 0-30 8-30 26z" fill="#f4f7f1" opacity="0.8"/>
  <path d="M34 82h32l-4 10H38z" fill="#f5d9a8"/>
</svg>
```
