Here is your workout log. It is a solo document: one person, one phone, nothing shared, so there are no merged tables. You add a lift in a few taps (exercise, sets, reps, weight), see this week at a glance, and see your best weight for each exercise. It saves as you go, and it carries three example entries so it does not open empty. Delete those whenever you like.

```text
dai bundle v1
name: Workout log

--- file: schema.sql
-- Workout log · shape: solo
--
-- The decision: one person's training log, kept on their own phone. Nobody
-- else adds to it and no second copy's changes need keeping, so nothing is
-- shared: an ordinary table, written with the kit, key and all. (If it is
-- sent to someone, they get a copy of their own to write in.)
--
-- Times are stored in UTC and shown as words by the queries in index.html.
-- Weight is stored in pounds; 0 means bodyweight.

CREATE TABLE IF NOT EXISTS lifts (
  id        INTEGER PRIMARY KEY,
  exercise  TEXT NOT NULL,
  sets      INTEGER NOT NULL DEFAULT 1,
  reps      INTEGER NOT NULL DEFAULT 1,
  weight    REAL NOT NULL DEFAULT 0,
  logged    TEXT NOT NULL DEFAULT (datetime('now'))
);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Log your lifts and see your week at a glance" />
  <meta name="dai:does" content="Log each exercise with sets, reps and weight in a few taps" />
  <meta name="dai:does" content="Show how many days you trained this week and your total weight lifted" />
  <meta name="dai:does" content="Keep your best weight for every exercise so you can beat it" />
  <meta name="theme-color" content="#14181d" />
  <title>Workout log</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Example entries, so the first open is not an empty shell. Fixed ids, so
    -- a second open adds nothing. The tables are declared in schema.sql.
    INSERT OR IGNORE INTO lifts (id, exercise, sets, reps, weight, logged) VALUES
      (1, 'Back squat',  4, 5,  185, datetime('now', '-2 days')),
      (2, 'Bench press', 3, 8,  135, datetime('now', '-2 days')),
      (3, 'Pull-up',     3, 8,    0, datetime('now', '-1 days'));
  </script>

  <main>
    <header>
      <h1>Workout log</h1>
      <p class="sub">What you lifted, and how it adds up.</p>
    </header>

    <section class="stats" aria-label="Last 7 days">
      <div class="stat">
        <span class="num">
          <dai-value query="SELECT count(DISTINCT date(logged, 'localtime')) FROM lifts WHERE logged >= datetime('now', '-6 days')"></dai-value>
        </span>
        <span class="label">days trained, last 7</span>
      </div>
      <div class="stat">
        <span class="num">
          <dai-value query="SELECT CAST(coalesce(sum(sets * reps * weight), 0) AS INTEGER) FROM lifts WHERE logged >= datetime('now', '-6 days')"></dai-value>
        </span>
        <span class="label">lb lifted, last 7</span>
      </div>
    </section>

    <dai-form run="INSERT INTO lifts (exercise, sets, reps, weight) VALUES (:exercise, :sets, :reps, :weight)">
      <h2>Log a lift</h2>
      <label class="wide">Exercise
        <input name="exercise" list="common" required maxlength="60" placeholder="e.g. Deadlift" autocomplete="off" />
      </label>
      <datalist id="common">
        <option value="Back squat"></option>
        <option value="Front squat"></option>
        <option value="Bench press"></option>
        <option value="Overhead press"></option>
        <option value="Deadlift"></option>
        <option value="Barbell row"></option>
        <option value="Pull-up"></option>
        <option value="Dip"></option>
        <option value="Lunge"></option>
        <option value="Curl"></option>
      </datalist>
      <label>Sets
        <input name="sets" type="number" inputmode="numeric" min="1" max="50" step="1" value="3" required />
      </label>
      <label>Reps
        <input name="reps" type="number" inputmode="numeric" min="1" max="500" step="1" value="8" required />
      </label>
      <label>Weight (lb)
        <input name="weight" type="number" inputmode="decimal" min="0" max="2000" step="any" value="0" required />
      </label>
      <button>Add to log</button>
      <p class="hint">Weight 0 means bodyweight.</p>
    </dai-form>

    <section>
      <h2>Recent</h2>
      <dai-rows
        query="SELECT id, exercise,
                      CASE date(logged, 'localtime')
                        WHEN date('now', 'localtime') THEN 'Today'
                        WHEN date('now', 'localtime', '-1 day') THEN 'Yesterday'
                        ELSE strftime('%a %b %d', logged, 'localtime')
                      END AS day,
                      sets || ' x ' || reps ||
                        CASE WHEN weight = 0 THEN ' · bodyweight'
                             ELSE ' at ' || CAST(weight AS TEXT) || ' lb' END AS detail
                 FROM lifts ORDER BY logged DESC, id DESC LIMIT 30"
        empty="Nothing logged yet. Add your first lift above.">
        <template>
          <div class="entry">
            <div class="what">
              <strong data-text="exercise"></strong>
              <span class="detail" data-text="detail"></span>
            </div>
            <span class="day" data-text="day"></span>
            <button type="button" class="quiet" aria-label="Delete this entry" data-run="DELETE FROM lifts WHERE id = :id">Delete</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <section>
      <h2>Your best</h2>
      <dai-rows
        query="SELECT exercise,
                      CASE WHEN max(weight) = 0 THEN 'bodyweight'
                           ELSE CAST(max(weight) AS TEXT) || ' lb' END AS best,
                      count(*) || CASE WHEN count(*) = 1 THEN ' entry' ELSE ' entries' END AS times
                 FROM lifts GROUP BY exercise ORDER BY max(logged) DESC LIMIT 20"
        empty="Your best weight for each exercise shows up here.">
        <template>
          <div class="entry best">
            <div class="what">
              <strong data-text="exercise"></strong>
              <span class="detail" data-text="times"></span>
            </div>
            <span class="pr" data-text="best"></span>
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
  --bg: #f4f2ee;
  --card: #ffffff;
  --ink: #1b1f24;
  --muted: #667078;
  --line: #e1ddd5;
  --accent: #d2491f;
  --on-accent: #ffffff;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14181d;
    --card: #1e242b;
    --ink: #eceff2;
    --muted: #94a0aa;
    --line: #2d353e;
    --accent: #ff7a50;
    --on-accent: #14181d;
  }
}

* { box-sizing: border-box; }

html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { line-height: 1.45; -webkit-font-smoothing: antialiased; }

/* Color runs to every edge; content is pushed clear of the strips a phone covers. */
main {
  max-width: 560px;
  margin: 0 auto;
  padding: calc(24px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px))
    calc(32px + var(--dai-safe-bottom, 0px)) calc(16px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* The top right corner belongs to the host's menu button. */
header { padding-right: 56px; }
h1 { margin: 0; font-size: 30px; letter-spacing: -0.02em; line-height: 1.1; }
.sub { margin: 4px 0 0; color: var(--muted); }
h2 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.stat {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 14px 16px;
  display: grid;
  gap: 2px;
}
.num { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.label { color: var(--muted); font-size: 14px; }

dai-form {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 16px;
}
dai-form h2, dai-form .wide, dai-form button, dai-form .hint { grid-column: 1 / -1; }
dai-form label { display: grid; gap: 6px; font-size: 14px; color: var(--muted); min-width: 0; }
dai-form h2 { margin-bottom: 0; }
.hint { margin: 0; font-size: 13px; color: var(--muted); }

input {
  font: inherit;
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  min-height: 44px;
  padding: 8px 12px;
  width: 100%;
  min-width: 0;
}
::placeholder { color: var(--muted); opacity: 0.6; }

button {
  font: inherit;
  font-weight: 600;
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid var(--accent);
  border-radius: 10px;
  background: var(--accent);
  color: var(--on-accent);
  cursor: pointer;
}
button.quiet {
  background: transparent;
  color: var(--muted);
  border-color: transparent;
  font-weight: 500;
  padding: 0 10px;
}
button.quiet:hover { color: var(--accent); }

dai-rows {
  display: block;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}
.entry {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 4px 12px;
  padding: 10px 8px 10px 16px;
  border-top: 1px solid var(--line);
}
.entry:first-child { border-top: 0; }
.entry.best { grid-template-columns: 1fr auto; padding-right: 16px; }
.what { display: grid; gap: 1px; min-width: 0; }
.what strong { overflow-wrap: anywhere; }
.detail, .day { color: var(--muted); font-size: 14px; }
.day { white-space: nowrap; }
.pr { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--accent); white-space: nowrap; }

/* The empty line the kit shows when a list has no rows. */
dai-rows:not(:has(.entry)) { padding: 16px; color: var(--muted); }

footer { display: flex; justify-content: flex-end; }
dai-save {
  display: inline-block;
  padding: 12px 22px;
  border-radius: 10px;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
  cursor: pointer;
}

@media (max-width: 360px) {
  dai-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (min-width: 720px) {
  main { padding-top: 40px; }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#14181d"/><rect x="12" y="40" width="10" height="20" rx="3" fill="#ff7a50"/><rect x="22" y="32" width="10" height="36" rx="3" fill="#ff7a50"/><rect x="32" y="46" width="36" height="8" fill="#eceff2"/><rect x="68" y="32" width="10" height="36" rx="3" fill="#ff7a50"/><rect x="78" y="40" width="10" height="20" rx="3" fill="#ff7a50"/></svg>
```

A few notes on how it works:

- **Solo shape.** The log is yours alone, so the table is ordinary and there is no sharing machinery. To send it to someone, use the Share option in the host's menu. They get a copy of their own to write in.
- **Saving.** Every entry is written the moment you add it. There is no save button under the opener. A Save button appears only if the file is opened straight in a browser.
- **Derived numbers.** "Days trained" and "lb lifted" for the last 7 days, and your best weight per exercise, are worked out from your entries each time. None are stored, so deleting a mistaken entry fixes them.
- **Times.** Entries are stored in UTC and shown as "Today", "Yesterday", or a weekday and date.
- **Units.** Weight is in pounds, and 0 means bodyweight (pull-ups and the like).
- **Not included yet.** There is no editing of an entry (delete and re-add), and no per-workout grouping or rest timer. I can add any of these if you want them.
