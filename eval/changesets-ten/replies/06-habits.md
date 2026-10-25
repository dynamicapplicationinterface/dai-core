```text
dai bundle v1
name: Habit tracker

--- file: schema.sql
-- Habit tracker
--
-- Two ordinary tables and two views. A check-in is one row: a habit and the
-- calendar day it was done. Nothing is counted in a column; the streaks, the
-- week and the totals are all read from the rows by the views below, so every
-- copy of the document works them out the same way.
--
-- "day" is a calendar day the person means (their own today), kept as
-- YYYY-MM-DD text, not a moment in time. The moments (created) are UTC.

CREATE TABLE IF NOT EXISTS habits (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  emoji    TEXT NOT NULL DEFAULT '⭐',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checkins (
  id       INTEGER PRIMARY KEY,
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  created  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS checkins_by_habit_day ON checkins (habit_id, day);

-- Each active habit, whether it is done today, and the day its streak is
-- counted back from: today if it is done, otherwise yesterday, so a streak is
-- not lost before the day is over.
CREATE VIEW IF NOT EXISTS habit_today AS
SELECT
  h.id AS id,
  h.name AS name,
  h.emoji AS emoji,
  h.position AS position,
  EXISTS (
    SELECT 1 FROM checkins c
    WHERE c.habit_id = h.id AND c.day = date('now', 'localtime')
  ) AS done,
  CASE WHEN EXISTS (
    SELECT 1 FROM checkins c
    WHERE c.habit_id = h.id AND c.day = date('now', 'localtime')
  ) THEN date('now', 'localtime')
  ELSE date('now', 'localtime', '-1 day') END AS anchor
FROM habits h
WHERE h.archived = 0;

-- Streak: the run of consecutive days that ends on the anchor day. Its first
-- day is the latest checked day, on or before the anchor, whose previous day
-- was not checked.
CREATE VIEW IF NOT EXISTS habit_status AS
SELECT
  t.id AS id,
  t.name AS name,
  t.emoji AS emoji,
  t.position AS position,
  t.done AS done,
  1 - t.done AS notdone,
  CASE WHEN EXISTS (
    SELECT 1 FROM checkins c WHERE c.habit_id = t.id AND c.day = t.anchor
  ) THEN CAST(julianday(t.anchor) - julianday((
      SELECT max(c.day) FROM checkins c
      WHERE c.habit_id = t.id
        AND c.day <= t.anchor
        AND NOT EXISTS (
          SELECT 1 FROM checkins p
          WHERE p.habit_id = t.id AND p.day = date(c.day, '-1 day')
        )
    )) AS INTEGER) + 1
  ELSE 0 END AS streak,
  (
    SELECT count(DISTINCT c.day) FROM checkins c
    WHERE c.habit_id = t.id
      AND c.day >= date('now', 'localtime', '-6 days')
      AND c.day <= date('now', 'localtime')
  ) AS week,
  (
    SELECT group_concat(
      CASE WHEN EXISTS (
        SELECT 1 FROM checkins c
        WHERE c.habit_id = t.id
          AND c.day = date('now', 'localtime', '-' || d.column1 || ' days')
      ) THEN '●' ELSE '○' END, '')
    FROM (VALUES (6), (5), (4), (3), (2), (1), (0)) AS d
  ) AS strip
FROM habit_today t;

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="Tick off daily habits and keep your streaks going" />
  <meta name="dai:does" content="Tick off each habit once a day and watch the streak grow" />
  <meta name="dai:does" content="Show the last seven days of every habit at a glance" />
  <meta name="dai:does" content="Add, rename and retire habits whenever your routine changes" />
  <meta name="theme-color" content="#f3f7f1" />
  <title>Habit tracker</title>
  <link rel="icon" href="./icon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <!--
    A habit tracker. No JavaScript for the data: the kit draws the rows and
    redraws them after every tick. The tables and views are in schema.sql, and
    the starting habits are the SQL block below, which runs once when the
    document is created.

    Ticking a habit adds a check-in row for today; unticking removes it. Each
    habit has two tick controls, and only the one that fits is shown.
  -->
  <script type="application/sql">
    -- seed rows; the tables are declared in schema.sql
    INSERT INTO habits (name, emoji, position) VALUES
      ('Drink water', '💧', 1),
      ('Read for 20 minutes', '📖', 2),
      ('Walk outside', '🏃', 3),
      ('Stretch', '🧘', 4);

    -- a little history so the streaks and the week strip have something to show
    INSERT INTO checkins (habit_id, day)
    SELECT h.id, date('now', 'localtime', '-' || d.column1 || ' days')
    FROM habits h CROSS JOIN (VALUES (1), (2), (3), (4), (5)) AS d
    WHERE h.name = 'Drink water';

    INSERT INTO checkins (habit_id, day)
    SELECT h.id, date('now', 'localtime', '-' || d.column1 || ' days')
    FROM habits h CROSS JOIN (VALUES (1), (3), (4)) AS d
    WHERE h.name = 'Read for 20 minutes';

    INSERT INTO checkins (habit_id, day)
    SELECT h.id, date('now', 'localtime', '-' || d.column1 || ' days')
    FROM habits h CROSS JOIN (VALUES (0), (1), (2)) AS d
    WHERE h.name = 'Walk outside';

    INSERT INTO checkins (habit_id, day)
    SELECT h.id, date('now', 'localtime', '-' || d.column1 || ' days')
    FROM habits h CROSS JOIN (VALUES (2), (5)) AS d
    WHERE h.name = 'Stretch';
  </script>

  <main>
    <header>
      <p class="eyebrow">
        <dai-value query="SELECT CASE strftime('%w', 'now', 'localtime') WHEN '0' THEN 'Sunday' WHEN '1' THEN 'Monday' WHEN '2' THEN 'Tuesday' WHEN '3' THEN 'Wednesday' WHEN '4' THEN 'Thursday' WHEN '5' THEN 'Friday' ELSE 'Saturday' END"></dai-value>
      </p>
      <h1>Today</h1>
      <p class="progress">
        <dai-value query="SELECT CASE WHEN count(*) = 0 THEN 'Add your first habit' WHEN sum(done) = count(*) THEN 'All done today' ELSE sum(done) || ' of ' || count(*) || ' done today' END FROM habit_status"></dai-value>
      </p>
    </header>

    <section aria-label="Your habits">
      <dai-rows
        query="SELECT id, emoji, name, done, notdone, strip,
                 CASE WHEN streak = 0 THEN 'No streak yet'
                      WHEN streak = 1 THEN '1 day in a row'
                      ELSE streak || ' days in a row' END
                 || ' · ' || week || ' of 7 this week' AS note
               FROM habit_status
               ORDER BY position, name"
        empty="No habits yet. Add one below. Something small is a good place to start.">
        <template>
          <div class="habit">
            <label class="tick" data-when="notdone">
              <input type="checkbox" aria-label="Mark done today"
                data-run="INSERT INTO checkins (habit_id, day) VALUES (:id, date('now', 'localtime'))" />
              <span class="box" aria-hidden="true"></span>
            </label>
            <label class="tick is-done" data-when="done">
              <input type="checkbox" aria-label="Done today. Undo"
                data-run="DELETE FROM checkins WHERE habit_id = :id AND day = date('now', 'localtime')" />
              <span class="box" aria-hidden="true"></span>
            </label>
            <div class="body">
              <div class="title">
                <span class="emoji" data-text="emoji" aria-hidden="true"></span>
                <input class="name" aria-label="Habit name" maxlength="60"
                  data-text="name"
                  data-run="UPDATE habits SET name = coalesce(nullif(trim(:typed), ''), name) WHERE id = :id" />
              </div>
              <p class="note" data-text="note"></p>
              <p class="strip" aria-hidden="true" data-text="strip"></p>
            </div>
            <button type="button" class="quiet"
              data-run="UPDATE habits SET archived = 1 WHERE id = :id">Retire</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-label="Add a habit">
      <h2>New habit</h2>
      <dai-form run="INSERT INTO habits (name, emoji, position) VALUES (:name, :emoji, (SELECT coalesce(max(position), 0) + 1 FROM habits))">
        <select name="emoji" aria-label="Icon">
          <option>⭐</option>
          <option>💧</option>
          <option>📖</option>
          <option>🏃</option>
          <option>🧘</option>
          <option>✍️</option>
          <option>🥗</option>
          <option>😴</option>
          <option>🎵</option>
          <option>🌱</option>
        </select>
        <input name="name" placeholder="What do you want to do daily?" required maxlength="60" aria-label="Habit name" />
        <button type="button" class="primary">Add</button>
      </dai-form>
    </section>

    <details>
      <summary>Retired habits</summary>
      <dai-rows
        query="SELECT id, emoji, name FROM habits WHERE archived = 1 ORDER BY position, name"
        empty="Nothing retired. A retired habit keeps its history.">
        <template>
          <div class="retired">
            <span class="emoji" data-text="emoji" aria-hidden="true"></span>
            <span class="what" data-text="name"></span>
            <button type="button" class="quiet"
              data-run="UPDATE habits SET archived = 0 WHERE id = :id">Bring back</button>
            <button type="button" class="quiet danger"
              data-run="DELETE FROM habits WHERE id = :id">Delete</button>
          </div>
        </template>
      </dai-rows>
    </details>

    <footer>
      <p class="total">
        <dai-value query="SELECT count(*) FROM checkins"></dai-value>
        check-ins so far
      </p>
      <button type="button" id="share" class="quiet">Share</button>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./dai-kit.js"></script>
  <script type="module" src="./app.js"></script>
</body>
</html>

--- file: app.js
// The only script of the application's own: the Share button. Everything
// else is the kit and SQL. Sharing is the host's: this opens its share sheet
// and shares nothing itself.
const share = document.getElementById("share");

if (share) {
  if (!window.dai || typeof window.dai.requestShare !== "function") {
    share.hidden = true;
  } else {
    share.addEventListener("click", () => {
      try {
        window.dai.requestShare();
      } catch (err) {
        console.error("Could not open the share sheet", err);
      }
    });
  }
}

--- file: app.css
/* A calm green page that gets out of the way of the ticks. */
:root {
  --paper: #f3f7f1;
  --card: #ffffff;
  --ink: #17251c;
  --muted: #667a6c;
  --line: #dbe6d9;
  --accent: #1f9d6b;
  --accent-ink: #ffffff;
  --accent-soft: #dff2e8;
  --danger: #b3382c;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #101a14;
    --card: #17251c;
    --ink: #e8f2ea;
    --muted: #93a99a;
    --line: #26382c;
    --accent: #3fc08b;
    --accent-ink: #07130d;
    --accent-soft: #1e3a2b;
    --danger: #f0897d;
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

/* The color runs to every edge; the content is pushed clear of the strips a
   phone covers. */
main {
  max-width: 600px;
  min-height: 100vh;
  margin: 0 auto;
  padding:
    calc(28px + var(--dai-safe-top, 0px))
    calc(20px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px))
    calc(20px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 22px;
}

header { display: flex; flex-direction: column; gap: 4px; }

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
  font-size: 34px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.05;
}

h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.progress {
  margin: 8px 0 0;
  align-self: flex-start;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
}

/* The lists are cards. Rows draw their own dividers. */
dai-rows {
  display: block;
  padding: 10px 16px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  color: var(--muted);
  line-height: 1.5;
}

.habit {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
  color: var(--ink);
}

.habit:first-child { border-top: 0; }

/* Both tick controls share the first column; only one is shown. */
.tick {
  grid-column: 1;
  grid-row: 1;
  position: relative;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  cursor: pointer;
}

.tick input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}

.box {
  position: relative;
  width: 30px;
  height: 30px;
  border: 2px solid var(--line);
  border-radius: 999px;
  background: var(--card);
  transition: border-color 0.15s, background 0.15s, transform 0.15s;
}

.tick:hover .box { border-color: var(--accent); }
.tick:active .box { transform: scale(0.92); }

.tick.is-done .box {
  border-color: var(--accent);
  background: var(--accent);
}

.tick.is-done .box::after {
  content: "";
  position: absolute;
  left: 9px;
  top: 4px;
  width: 7px;
  height: 14px;
  border: solid var(--accent-ink);
  border-width: 0 3px 3px 0;
  transform: rotate(45deg);
}

.tick:has(input:focus-visible) .box {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

.body {
  grid-column: 2;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title { display: flex; align-items: center; gap: 6px; min-width: 0; }

.emoji { font-size: 20px; line-height: 1; }

/* The name is a control that reads as the line it replaced until touched. */
input.name {
  flex: 1;
  min-width: 0;
  min-height: 32px;
  padding: 2px 4px;
  margin: 0 -4px;
  border: 0;
  border-bottom: 1px dashed transparent;
  border-radius: 4px;
  background: none;
  font: inherit;
  font-size: 17px;
  font-weight: 600;
  color: var(--ink);
}

input.name:hover { border-bottom-color: var(--muted); }
input.name:focus { outline: none; border-bottom-color: var(--accent); background: var(--accent-soft); }

.note {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}

.strip {
  margin: 2px 0 0;
  font-size: 13px;
  letter-spacing: 0.25em;
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
}

button {
  font: inherit;
  cursor: pointer;
}

button.quiet {
  grid-column: 3;
  min-height: 44px;
  min-width: 44px;
  padding: 0 10px;
  border: 0;
  border-radius: 10px;
  background: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}

button.quiet:hover { background: var(--accent-soft); color: var(--accent); }
button.quiet.danger:hover { background: none; color: var(--danger); }

button:focus-visible,
input:focus-visible,
select:focus-visible,
summary:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

/* Adding a habit. */
dai-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

dai-form select,
dai-form input {
  min-height: 44px;
  padding: 8px 12px;
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
  color: var(--ink);
}

dai-form select { flex: 0 0 auto; }
dai-form input { flex: 1 1 12rem; min-width: 0; }

button.primary {
  min-height: 44px;
  padding: 0 22px;
  border: 0;
  border-radius: 12px;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 700;
}

button.primary:hover { filter: brightness(1.06); }

/* Retired habits. */
details {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
}

summary {
  min-height: 44px;
  padding: 10px 16px;
  cursor: pointer;
  font-weight: 600;
  color: var(--muted);
  display: flex;
  align-items: center;
}

details dai-rows {
  border: 0;
  border-top: 1px solid var(--line);
  border-radius: 0 0 16px 16px;
}

.retired {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  color: var(--ink);
}

.retired .what {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.retired button.quiet { grid-column: auto; }

footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: auto;
}

.total {
  margin: 0;
  flex: 1 1 auto;
  font-size: 13px;
  color: var(--muted);
}

dai-save {
  display: inline-block;
  padding: 12px 22px;
  border-radius: 12px;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 700;
  cursor: pointer;
}

/* On a wide window: a card on a quieter ground. */
@media (min-width: 720px) {
  main {
    margin: 40px auto;
    min-height: 0;
    padding: 36px 36px 32px;
    background: var(--paper);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.05), 0 24px 60px -24px rgb(0 0 0 / 0.25);
  }
  html, body { background: color-mix(in srgb, var(--paper) 88%, #000); }
}

@media (prefers-reduced-motion: reduce) {
  .box { transition: none; }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- A bold check mark in a ring, on green. -->
  <rect width="100" height="100" rx="22" fill="#1f9d6b"/>
  <circle cx="50" cy="50" r="30" fill="none" stroke="#dff2e8" stroke-width="7"/>
  <path d="M35 51l11 11 20-23" fill="none" stroke="#ffffff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```
