```text
dai bundle v1
name: Workout log

--- file: schema.sql
-- Workout log
--
-- One row per set. A workout is not stored: it is the sets logged on the same
-- day, grouped by the queries that show them. Totals are never kept in a
-- column; every count, best and total on the page is a query over these rows.

CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY,
  exercise TEXT NOT NULL,
  reps INTEGER NOT NULL CHECK (reps > 0),
  weight REAL NOT NULL DEFAULT 0 CHECK (weight >= 0),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS sets_by_time ON sets (at);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="Log every set and see how your lifting adds up" />
  <meta name="dai:does" content="Log each set with its exercise, reps and weight in a few taps" />
  <meta name="dai:does" content="Show what you did today, yesterday and across the week" />
  <meta name="dai:does" content="Track your best weight for every exercise you have logged" />
  <meta name="theme-color" content="#f5f6f1" />
  <title>Workout log</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <!--
    A workout log made only from the kit: no JavaScript of its own. Every set
    is a row, written the moment it is added; the day summaries, the weekly
    figures and the personal bests are all queries over those rows.
  -->
  <script type="application/sql">
    -- Seed rows. The table is declared in schema.sql; ids are left to the runtime.
    INSERT INTO sets (exercise, reps, weight, at) VALUES
      ('Squat', 8, 60, datetime('now', '-3 days', '-5 minutes')),
      ('Squat', 8, 60, datetime('now', '-3 days', '-10 minutes')),
      ('Squat', 6, 70, datetime('now', '-3 days', '-15 minutes')),
      ('Bench press', 10, 40, datetime('now', '-3 days', '-30 minutes')),
      ('Bench press', 8, 45, datetime('now', '-3 days', '-35 minutes')),
      ('Pull-up', 6, 0, datetime('now', '-1 days', '-5 minutes')),
      ('Pull-up', 5, 0, datetime('now', '-1 days', '-8 minutes')),
      ('Deadlift', 5, 90, datetime('now', '-1 days', '-20 minutes')),
      ('Deadlift', 5, 95, datetime('now', '-1 days', '-25 minutes')),
      ('Bench press', 8, 47.5, datetime('now', '-3 hours')),
      ('Bench press', 7, 50, datetime('now', '-2 hours', '-50 minutes'));
  </script>

  <main>
    <header>
      <p class="eyebrow">Strength training</p>
      <h1>Workout log</h1>
      <p class="lede">Add a set the moment you finish it.</p>
    </header>

    <section class="stats" aria-label="The last seven days">
      <div class="stat">
        <dai-value class="num" query="SELECT count(DISTINCT date(at, 'localtime')) FROM sets WHERE at >= datetime('now', '-7 days')"></dai-value>
        <span class="cap">workout days</span>
      </div>
      <div class="stat">
        <dai-value class="num" query="SELECT count(*) FROM sets WHERE at >= datetime('now', '-7 days')"></dai-value>
        <span class="cap">sets</span>
      </div>
      <div class="stat">
        <dai-value class="num" query="SELECT printf('%d', coalesce(round(sum(weight * reps)), 0)) FROM sets WHERE at >= datetime('now', '-7 days')"></dai-value>
        <span class="cap">lifted</span>
      </div>
    </section>

    <section>
      <h2>Log a set</h2>
      <dai-form class="add" run="INSERT INTO sets (exercise, reps, weight) VALUES (:exercise, :reps, :weight)">
        <label class="field wide">
          <span>Exercise</span>
          <input name="exercise" placeholder="Bench press" required maxlength="60" autocomplete="off" />
        </label>
        <label class="field">
          <span>Reps</span>
          <input name="reps" type="number" inputmode="numeric" min="1" max="999" step="1" placeholder="8" required />
        </label>
        <label class="field">
          <span>Weight</span>
          <input name="weight" type="number" inputmode="decimal" min="0" step="any" value="0" required />
        </label>
        <button type="button" class="primary">Add set</button>
      </dai-form>
      <p class="hint">Weight 0 is for bodyweight work.</p>
    </section>

    <section>
      <h2>Days</h2>
      <dai-rows
        empty="No workouts yet. Log your first set above."
        query="SELECT day,
                 CASE CAST(julianday(date('now', 'localtime')) - julianday(day) AS INTEGER)
                   WHEN 0 THEN 'Today'
                   WHEN 1 THEN 'Yesterday'
                   ELSE substr('SunMonTueWedThuFriSat', 1 + 3 * strftime('%w', day), 3) || ' '
                        || CAST(strftime('%d', day) AS INTEGER) || ' '
                        || substr('JanFebMarAprMayJunJulAugSepOctNovDec', 1 + 3 * (strftime('%m', day) - 1), 3)
                 END AS label,
                 count(*) AS n,
                 printf('%d', round(sum(weight * reps))) AS lifted,
                 replace(group_concat(DISTINCT exercise), ',', ', ') AS what
               FROM (SELECT date(at, 'localtime') AS day, exercise, reps, weight FROM sets)
               GROUP BY day
               ORDER BY day DESC
               LIMIT 14">
        <template>
          <div class="row day">
            <div class="grow">
              <span class="title" data-text="label"></span>
              <span class="meta" data-text="what"></span>
            </div>
            <div class="figures">
              <span class="big" data-text="n"></span>
              <span class="meta">sets</span>
            </div>
          </div>
        </template>
      </dai-rows>
    </section>

    <section>
      <h2>Best by exercise</h2>
      <dai-rows
        empty="Your best weights will show up here."
        query="SELECT exercise, count(*) AS n, printf('%g', max(weight)) AS best, max(weight) > 0 AS weighted
               FROM sets
               GROUP BY exercise
               ORDER BY max(at) DESC">
        <template>
          <div class="row">
            <div class="grow">
              <span class="title" data-text="exercise"></span>
              <span class="meta"><span data-text="n"></span> sets logged</span>
            </div>
            <div class="figures" data-when="weighted">
              <span class="big" data-text="best"></span>
              <span class="meta">best</span>
            </div>
          </div>
        </template>
      </dai-rows>
    </section>

    <section>
      <h2>Latest sets</h2>
      <dai-rows
        empty="Nothing logged yet."
        query="SELECT id, exercise,
                 CASE WHEN weight = 0 THEN reps || ' reps' ELSE reps || ' × ' || printf('%g', weight) END AS detail,
                 CASE
                   WHEN m < 1 THEN 'just now'
                   WHEN m < 60 THEN CAST(m AS INTEGER) || ' min ago'
                   WHEN m < 120 THEN '1 hour ago'
                   WHEN m < 1440 THEN CAST(m / 60 AS INTEGER) || ' hours ago'
                   WHEN dd = 1 THEN 'yesterday'
                   ELSE dd || ' days ago'
                 END AS ago
               FROM (SELECT id, exercise, reps, weight, at,
                       (julianday('now') - julianday(at)) * 1440.0 AS m,
                       CAST(julianday(date('now', 'localtime')) - julianday(date(at, 'localtime')) AS INTEGER) AS dd
                     FROM sets)
               ORDER BY at DESC, id DESC
               LIMIT 20">
        <template>
          <div class="row">
            <div class="grow">
              <span class="title" data-text="exercise"></span>
              <span class="meta"><span data-text="detail"></span> · <span data-text="ago"></span></span>
            </div>
            <button type="button" class="remove" aria-label="Delete this set" data-run="DELETE FROM sets WHERE id = :id">Delete</button>
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
/* Chalk and iron: a quiet, high-contrast ground with one strong accent. */
:root {
  --paper: #f5f6f1;
  --card: #ffffff;
  --ink: #1d2320;
  --muted: #67716b;
  --line: #dde2da;
  --accent: #1f6f4a;
  --accent-ink: #ffffff;
  --tint: #e3efe8;
  --danger: #a63a2b;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #131715;
    --card: #1c211e;
    --ink: #eef2ee;
    --muted: #97a39b;
    --line: #2e3631;
    --accent: #5fc791;
    --accent-ink: #0c1a12;
    --tint: #1f2f26;
    --danger: #ee8c7d;
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

/* The colour runs to every edge; content stays clear of what a phone covers. */
main {
  max-width: 600px;
  margin: 0 auto;
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(20px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(20px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 26px;
}

header { display: flex; flex-direction: column; gap: 4px; padding-right: 56px; }

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
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.05;
}

.lede { margin: 4px 0 0; color: var(--muted); }

h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

section { min-width: 0; }

/* The week at a glance. */
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  background: var(--tint);
  border-radius: 14px;
  min-width: 0;
}

.stat .num {
  display: block;
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.1;
  color: var(--accent);
}

.stat .cap { font-size: 12px; font-weight: 600; color: var(--muted); }

/* Lists. */
dai-rows {
  display: block;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 8px 14px;
  border-top: 1px solid var(--line);
}

.row:first-child { border-top: 0; }

.grow { flex: 1; min-width: 0; display: flex; flex-direction: column; }

.title { font-weight: 650; overflow-wrap: anywhere; }

.meta { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }

.figures { display: flex; flex-direction: column; align-items: flex-end; }

.big { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; }

/* The empty state the kit shows when a query returns nothing. */
dai-rows:empty,
dai-rows > :not(.row):not(template) {
  padding: 20px 14px;
  color: var(--muted);
  text-align: center;
}

/* Adding a set. */
dai-form.add {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 14px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
}

.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.field.wide { grid-column: 1 / -1; }
.field span { font-size: 12px; font-weight: 600; color: var(--muted); }

dai-form input {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 10px 12px;
  font: inherit;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 10px;
}

dai-form input::placeholder { color: var(--muted); opacity: 0.7; }

button {
  min-height: 44px;
  font: inherit;
  cursor: pointer;
}

.primary {
  grid-column: 1 / -1;
  padding: 10px 16px;
  font-weight: 700;
  color: var(--accent-ink);
  background: var(--accent);
  border: 0;
  border-radius: 10px;
}

.remove {
  min-width: 44px;
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--danger);
  background: none;
  border: 1px solid var(--line);
  border-radius: 10px;
}

.hint { margin: 8px 2px 0; font-size: 13px; color: var(--muted); }

/* Keyboard support: a clear ring wherever focus lands. */
:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

footer { display: flex; justify-content: flex-end; }

dai-save {
  display: inline-block;
  padding: 12px 22px;
  font-weight: 700;
  color: var(--accent-ink);
  background: var(--accent);
  border-radius: 10px;
  cursor: pointer;
}

/* A card on a quieter ground when the window is wide. */
@media (min-width: 720px) {
  html, body { background: color-mix(in srgb, var(--paper) 90%, var(--ink)); }
  main {
    margin: 40px auto;
    padding: 32px 32px 36px;
    background: var(--paper);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 24px 60px -20px rgb(0 0 0 / 0.18);
  }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- A barbell on a green ground. -->
  <rect width="100" height="100" rx="22" fill="#1f6f4a"/>
  <rect x="30" y="46" width="40" height="8" rx="4" fill="#f5f6f1"/>
  <rect x="18" y="30" width="12" height="40" rx="5" fill="#f5f6f1"/>
  <rect x="70" y="30" width="12" height="40" rx="5" fill="#f5f6f1"/>
  <rect x="8" y="39" width="8" height="22" rx="4" fill="#f5f6f1"/>
  <rect x="84" y="39" width="8" height="22" rx="4" fill="#f5f6f1"/>
</svg>
```
