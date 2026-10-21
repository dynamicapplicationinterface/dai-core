I built this as a solo document: one person keeps their own plants, so nothing is shared and nothing merges. It uses the kit with no JavaScript of its own. Each plant shows when it was last watered and fed, flags the ones that are due, and has one-tap buttons to log care. A recent-activity list sits below, with an Undo for a mistaken tap.

```text
dai bundle v1
name: Plant care

--- file: schema.sql
-- Plant care · shape: solo
--
-- The decision: one person's plants, logged from one phone. Nobody else
-- adds to it and no second copy's changes need keeping, so nothing is shared:
-- ordinary tables, written with the kit, keys and all.
--
-- Nothing derived is stored. "Last watered", "needs water" and the day counts
-- are computed from the care log every time they are drawn.

CREATE TABLE IF NOT EXISTS plants (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  place       TEXT NOT NULL DEFAULT '',
  water_every INTEGER NOT NULL DEFAULT 7 CHECK (water_every BETWEEN 1 AND 365)
);

CREATE TABLE IF NOT EXISTS care_log (
  id       INTEGER PRIMARY KEY,
  plant_id INTEGER NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('water', 'feed', 'repot')),
  done_at  TEXT NOT NULL DEFAULT (datetime('now'))   -- UTC
);

CREATE INDEX IF NOT EXISTS care_log_by_plant ON care_log (plant_id, kind, done_at);

-- Removing a plant removes its history with it.
CREATE TRIGGER IF NOT EXISTS plants_remove_log
AFTER DELETE ON plants
BEGIN
  DELETE FROM care_log WHERE plant_id = OLD.id;
END;

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Which plants need water, and when you last cared for them" />
  <meta name="dai:does" content="Keep a list of your plants and where each one lives" />
  <meta name="dai:does" content="Log a watering or feeding with one tap and see how long ago it was" />
  <meta name="dai:does" content="Show at a glance which plants are thirsty today" />
  <meta name="theme-color" content="#f1f5ee" />
  <title>Plant care</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Seed rows; the tables are declared in schema.sql. A second open adds nothing.
    INSERT OR IGNORE INTO plants (id, name, place, water_every) VALUES
      (1, 'Monstera', 'Living room window', 7),
      (2, 'Snake plant', 'Bedroom', 14),
      (3, 'Basil', 'Kitchen sill', 3);

    INSERT OR IGNORE INTO care_log (id, plant_id, kind, done_at) VALUES
      (1, 1, 'water', datetime('now', '-8 days')),
      (2, 1, 'feed',  datetime('now', '-20 days')),
      (3, 2, 'water', datetime('now', '-5 days')),
      (4, 3, 'water', datetime('now', '-1 days'));
  </script>

  <main>
    <header>
      <h1>Plant care</h1>
      <p class="thirsty-count">
        <dai-value query="SELECT count(*) FROM plants p WHERE coalesce((SELECT cast(julianday(date('now')) - julianday(date(max(c.done_at))) AS integer) FROM care_log c WHERE c.plant_id = p.id AND c.kind = 'water'), p.water_every) &gt;= p.water_every"></dai-value>
        thirsty today
      </p>
    </header>

    <section>
      <h2>Your plants</h2>
      <dai-rows empty="No plants yet. Add the first one below." query="
        WITH w AS (
          SELECT p.id, p.name, p.place, p.water_every,
                 (SELECT cast(julianday(date('now')) - julianday(date(max(c.done_at))) AS integer)
                    FROM care_log c WHERE c.plant_id = p.id AND c.kind = 'water') AS since_water,
                 (SELECT cast(julianday(date('now')) - julianday(date(max(c.done_at))) AS integer)
                    FROM care_log c WHERE c.plant_id = p.id AND c.kind = 'feed') AS since_feed
            FROM plants p
        )
        SELECT id, name, place,
               'Water every ' || water_every || CASE WHEN water_every = 1 THEN ' day' ELSE ' days' END AS rhythm,
               CASE WHEN since_water IS NULL THEN 'Not watered yet'
                    WHEN since_water = 0 THEN 'Watered today'
                    WHEN since_water = 1 THEN 'Watered yesterday'
                    ELSE 'Watered ' || since_water || ' days ago' END AS watered,
               CASE WHEN since_feed IS NULL THEN 'Never fed'
                    WHEN since_feed = 0 THEN 'Fed today'
                    WHEN since_feed = 1 THEN 'Fed yesterday'
                    ELSE 'Fed ' || since_feed || ' days ago' END AS fed,
               CASE WHEN place = '' THEN 0 ELSE 1 END AS has_place,
               CASE WHEN since_water IS NULL OR since_water &gt;= water_every THEN 1 ELSE 0 END AS thirsty,
               CASE WHEN since_water IS NULL OR since_water &gt;= water_every THEN 0 ELSE 1 END AS fine
          FROM w
         ORDER BY thirsty DESC, water_every - coalesce(since_water, water_every), name">
        <template>
          <article class="plant">
            <div class="top">
              <div class="who">
                <strong class="name" data-text="name"></strong>
                <span class="place" data-text="place" data-when="has_place"></span>
              </div>
              <span class="badge thirsty" data-when="thirsty">Needs water</span>
              <span class="badge fine" data-when="fine">All good</span>
            </div>
            <p class="facts">
              <span data-text="watered"></span>
              <span class="dot" aria-hidden="true">·</span>
              <span data-text="fed"></span>
              <span class="dot" aria-hidden="true">·</span>
              <span data-text="rhythm"></span>
            </p>
            <div class="care">
              <button class="primary" data-run="INSERT INTO care_log (plant_id, kind) VALUES (:id, 'water')">Watered</button>
              <button data-run="INSERT INTO care_log (plant_id, kind) VALUES (:id, 'feed')">Fed</button>
              <button data-run="INSERT INTO care_log (plant_id, kind) VALUES (:id, 'repot')">Repotted</button>
              <button class="link" aria-label="Remove this plant and its history" data-run="DELETE FROM plants WHERE id = :id">Remove</button>
            </div>
          </article>
        </template>
      </dai-rows>
    </section>

    <dai-form class="add" run="INSERT INTO plants (name, place, water_every) VALUES (:name, :place, :every)">
      <h2>Add a plant</h2>
      <div class="fields">
        <label>Name <input name="name" required maxlength="60" placeholder="e.g. Fiddle leaf fig" /></label>
        <label>Where <input name="place" maxlength="60" placeholder="e.g. Hallway" /></label>
        <label>Water every (days) <input name="every" type="number" inputmode="numeric" min="1" max="365" value="7" required /></label>
      </div>
      <button>Add plant</button>
    </dai-form>

    <section>
      <h2>Recent care</h2>
      <dai-rows empty="Nothing logged yet. Tap Watered on a plant when you water it." query="
        WITH l AS (
          SELECT c.id, p.name,
                 CASE c.kind WHEN 'water' THEN 'Watered' WHEN 'feed' THEN 'Fed' ELSE 'Repotted' END AS what,
                 cast(julianday(date('now')) - julianday(date(c.done_at)) AS integer) AS days,
                 c.done_at
            FROM care_log c JOIN plants p ON p.id = c.plant_id
        )
        SELECT id, name, what,
               CASE WHEN days = 0 THEN 'today'
                    WHEN days = 1 THEN 'yesterday'
                    ELSE days || ' days ago' END AS when_words
          FROM l ORDER BY done_at DESC, id DESC LIMIT 20">
        <template>
          <div class="entry">
            <span class="line"><strong data-text="what"></strong> <span data-text="name"></span></span>
            <span class="when" data-text="when_words"></span>
            <button class="link" aria-label="Undo this entry" data-run="DELETE FROM care_log WHERE id = :id">Undo</button>
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
:root {
  color-scheme: light dark;
  --bg: #f1f5ee;
  --card: #ffffff;
  --ink: #1d2b21;
  --muted: #647268;
  --line: #dde6d8;
  --accent: #2f7a4b;
  --on-accent: #ffffff;
  --thirsty: #a85a00;
  --thirsty-bg: #fdf0dc;
  --fine: #2f7a4b;
  --fine-bg: #e3f1e6;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121a14; --card: #1b261e; --ink: #e6eee7; --muted: #9aaa9e; --line: #2b3a2f;
    --accent: #7cc796; --on-accent: #0f1a12;
    --thirsty: #f0b35a; --thirsty-bg: #3a2b12; --fine: #8fd3a5; --fine-bg: #1f3526;
  }
}
* { box-sizing: border-box; }
/* A display rule below would otherwise show what the page hid. */
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { font-size: 16px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
main {
  max-width: 600px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 28px;
  padding: calc(24px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px))
    calc(36px + var(--dai-safe-bottom, 0px)) calc(16px + var(--dai-safe-left, 0px));
}
/* The top right corner belongs to the host's menu button. */
header { display: flex; flex-direction: column; gap: 6px; padding-right: 56px; }
h1 { margin: 0; font-size: 30px; letter-spacing: -0.02em; line-height: 1.1; }
h2 {
  margin: 0 0 10px; font-size: 13px; font-weight: 700; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted);
}
.thirsty-count { margin: 0; color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

dai-rows { display: grid; gap: 10px; }
dai-rows:not(:has(*)) { color: var(--muted); }

.plant, .entry, dai-form.add {
  background: var(--card); border: 1px solid var(--line); border-radius: 14px;
}
.plant { padding: 14px 16px; display: grid; gap: 8px; }
.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.who { display: grid; gap: 2px; min-width: 0; }
.name { font-size: 18px; overflow-wrap: anywhere; }
.place { color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
.badge {
  flex: none; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.badge.thirsty { background: var(--thirsty-bg); color: var(--thirsty); }
.badge.fine { background: var(--fine-bg); color: var(--fine); }
.facts { margin: 0; color: var(--muted); font-size: 14px; }
.dot { margin: 0 4px; }
.care { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }

button {
  font: inherit; min-height: 44px; padding: 0 16px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--accent); background: transparent; color: var(--accent); font-weight: 600;
}
button.primary, dai-form button, dai-save { background: var(--accent); color: var(--on-accent); }
button.link {
  border: 0; background: none; color: var(--muted); font-weight: 400; text-decoration: underline;
  text-underline-offset: 3px; padding: 0 8px;
}
.care button.link { margin-left: auto; }

dai-form.add { display: block; padding: 16px; }
.fields { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 14px; }
.fields label { display: grid; gap: 6px; font-size: 14px; color: var(--muted); }
input {
  font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line);
  border-radius: 10px; min-height: 44px; padding: 8px 12px; width: 100%;
}
::placeholder { color: var(--muted); opacity: 0.6; font-style: italic; }

.entry { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 6px 8px 6px 16px; }
.entry .line { flex: 1 1 12em; min-width: 0; overflow-wrap: anywhere; }
.entry .when { color: var(--muted); font-size: 14px; }

footer { display: flex; justify-content: flex-end; }
dai-save { display: inline-block; padding: 12px 22px; border-radius: 10px; font-weight: 600; cursor: pointer; }

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#2f7a4b"/><path d="M50 82V44" fill="none" stroke="#f1f5ee" stroke-width="6" stroke-linecap="round"/><path d="M50 52C32 52 22 40 22 24c18 0 28 10 28 28z" fill="#f1f5ee"/><path d="M50 62c16 0 26-10 26-26-16 0-26 10-26 26z" fill="#cfe8d5"/><path d="M36 82h28l-4-14H40z" fill="#f1f5ee"/></svg>
```

Notes:
- Shape: solo. If you later want to share it with someone, that is a different design and would need to be decided before the first release, so tell me now if you want it.
- Tapping Watered, Fed or Repotted writes a log entry immediately. A plant is "thirsty" when its days since the last watering reach its watering rhythm (or it was never watered). Nothing like that is stored; it is worked out each time.
- Remove deletes a plant and its history, with no confirmation. Undo on a Recent care row removes that one entry.
- Times are stored in UTC and shown as "today", "yesterday" and "N days ago". Days are counted in UTC, so near midnight a day can roll over a little early or late for you.
