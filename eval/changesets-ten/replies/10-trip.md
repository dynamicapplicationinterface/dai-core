```text
dai bundle v1
name: Trip planner

--- file: schema.sql
-- Trip planner
--
-- Every trip is a row. The page shows one at a time; which one is a setting
-- in the settings table. Totals are never stored: the budget, the counts and
-- the "days to go" are all read from the rows by the views below.

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT '',
  starts TEXT NOT NULL,
  ends TEXT NOT NULL,
  budget REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '',
  what TEXT NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  what TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  amount REAL NOT NULL,
  added TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  what TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS plans_by_trip ON plans (trip_id, day, time);
CREATE INDEX IF NOT EXISTS expenses_by_trip ON expenses (trip_id);
CREATE INDEX IF NOT EXISTS tasks_by_trip ON tasks (trip_id);

-- The trip on screen: the one chosen in settings, or else the earliest trip.
CREATE VIEW IF NOT EXISTS current_trip AS
SELECT coalesce(
  (SELECT t.id FROM trips t
    WHERE t.id = CAST((SELECT s.value FROM settings s WHERE s.name = 'trip') AS INTEGER)),
  (SELECT t.id FROM trips t ORDER BY t.starts, t.name LIMIT 1)
) AS id;

-- One line per trip, with its dates in words and its spending added up.
CREATE VIEW IF NOT EXISTS trip_cards AS
SELECT
  t.id AS id,
  t.name AS name,
  t.destination AS destination,
  t.starts AS starts,
  t.ends AS ends,
  t.budget AS budget,
  substr('SunMonTueWedThuFriSat', CAST(strftime('%w', t.starts) AS INTEGER) * 3 + 1, 3)
    || ' ' || CAST(strftime('%d', t.starts) AS INTEGER)
    || ' ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', (CAST(strftime('%m', t.starts) AS INTEGER) - 1) * 3 + 1, 3)
    AS starts_label,
  substr('SunMonTueWedThuFriSat', CAST(strftime('%w', t.ends) AS INTEGER) * 3 + 1, 3)
    || ' ' || CAST(strftime('%d', t.ends) AS INTEGER)
    || ' ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', (CAST(strftime('%m', t.ends) AS INTEGER) - 1) * 3 + 1, 3)
    AS ends_label,
  CASE CAST(julianday(t.ends) - julianday(t.starts) AS INTEGER)
    WHEN 0 THEN '1 day'
    ELSE (CAST(julianday(t.ends) - julianday(t.starts) AS INTEGER) + 1) || ' days'
  END AS days_text,
  CASE
    WHEN date('now') > t.ends THEN 'Finished'
    WHEN date('now') >= t.starts THEN 'Under way'
    WHEN julianday(t.starts) - julianday(date('now')) < 2 THEN 'Tomorrow'
    ELSE 'In ' || CAST(julianday(t.starts) - julianday(date('now')) AS INTEGER) || ' days'
  END AS when_text,
  printf('%.2f', t.spent) AS spent_text,
  CASE
    WHEN t.budget <= 0 THEN 'No budget set'
    WHEN t.spent <= t.budget THEN printf('%.2f', t.budget - t.spent) || ' left'
    ELSE printf('%.2f', t.spent - t.budget) || ' over'
  END AS budget_note,
  (t.budget > 0 AND t.spent > t.budget) AS over,
  (t.id = (SELECT id FROM current_trip)) AS current
FROM (
  SELECT trips.*,
    (SELECT coalesce(sum(e.amount), 0) FROM expenses e WHERE e.trip_id = trips.id) AS spent
  FROM trips
) AS t;

-- Itinerary lines, each knowing which day of the trip it falls on and
-- whether it is the first of its day (the day heading shows only there).
CREATE VIEW IF NOT EXISTS plan_items AS
SELECT
  p.id AS id,
  p.trip_id AS trip_id,
  p.day AS day,
  p.time AS time,
  p.what AS what,
  p.place AS place,
  p.done AS done,
  CASE WHEN p.time = '' THEN 'All day' ELSE p.time END AS time_text,
  CASE WHEN p.day >= t.starts
    THEN 'Day ' || (CAST(julianday(p.day) - julianday(t.starts) AS INTEGER) + 1) || ': '
    ELSE ''
  END
    || substr('SunMonTueWedThuFriSat', CAST(strftime('%w', p.day) AS INTEGER) * 3 + 1, 3)
    || ' ' || CAST(strftime('%d', p.day) AS INTEGER)
    || ' ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', (CAST(strftime('%m', p.day) AS INTEGER) - 1) * 3 + 1, 3)
    AS day_label,
  NOT EXISTS (
    SELECT 1 FROM plans q
    WHERE q.trip_id = p.trip_id AND q.day = p.day
      AND (q.time < p.time OR (q.time = p.time AND q.id < p.id))
  ) AS first_of_day
FROM plans p
JOIN trips t ON t.id = p.trip_id;

CREATE VIEW IF NOT EXISTS expense_items AS
SELECT
  e.id AS id,
  e.trip_id AS trip_id,
  e.what AS what,
  e.category AS category,
  e.added AS added,
  printf('%.2f', e.amount) AS amount_text,
  CASE CAST(julianday(date('now')) - julianday(date(e.added)) AS INTEGER)
    WHEN 0 THEN 'today'
    WHEN 1 THEN 'yesterday'
    ELSE CAST(julianday(date('now')) - julianday(date(e.added)) AS INTEGER) || ' days ago'
  END AS added_text
FROM expenses e;

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="Days, spending and to-dos for every trip you plan" />
  <meta name="dai:does" content="Lay out each day of a trip with times and places" />
  <meta name="dai:does" content="Track what you spend against a budget for the trip" />
  <meta name="dai:does" content="Tick off what to do before you leave" />
  <meta name="theme-color" content="#f7f3ec" />
  <title>Trip planner</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <!--
    A trip planner. Every trip is a row; the chips choose which one is on
    screen. No JavaScript here except the Share button (app.js); the kit does
    the rest, and everything on the page is a query over the tables.
  -->
  <script type="application/sql">
    -- Which trip is showing. Empty means "the earliest one".
    INSERT INTO settings (name, value) VALUES ('trip', '');

    INSERT INTO trips (name, destination, starts, ends, budget) VALUES
      ('Lisbon', 'Lisbon, Portugal', '2027-02-12', '2027-02-15', 900),
      ('Lake cabin', 'Lake Tahoe, California', '2027-03-19', '2027-03-21', 350);

    INSERT INTO plans (trip_id, day, time, what, place, done) VALUES
      ((SELECT id FROM trips WHERE name = 'Lisbon'), '2027-02-12', '09:40', 'Land and take the metro in', 'Airport', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), '2027-02-12', '12:00', 'Check in and drop the bags', 'Alfama apartment', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), '2027-02-12', '19:30', 'Dinner by the river', 'Cais do Sodre', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), '2027-02-13', '10:00', 'Tram 28 up to the viewpoint', 'Graca', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), '2027-02-13', '13:00', 'Pasteis de nata and a long lunch', 'Belem', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), '2027-02-13', '16:00', 'The tower and the monastery', 'Belem', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), '2027-02-14', '09:00', 'Day trip to Sintra by train', 'Sintra', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), '2027-02-14', '18:00', 'Back in time for sunset', 'Senhora do Monte', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), '2027-02-15', '11:00', 'Last coffee and souvenirs', 'Baixa', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), '2027-02-15', '14:30', 'Flight home', 'Airport', 0),
      ((SELECT id FROM trips WHERE name = 'Lake cabin'), '2027-03-19', '17:00', 'Drive up and light the stove', 'Cabin', 0),
      ((SELECT id FROM trips WHERE name = 'Lake cabin'), '2027-03-20', '10:00', 'Walk the lake loop', 'North shore trail', 0),
      ((SELECT id FROM trips WHERE name = 'Lake cabin'), '2027-03-21', '11:00', 'Check out and head home', 'Cabin', 0);

    INSERT INTO expenses (trip_id, what, category, amount) VALUES
      ((SELECT id FROM trips WHERE name = 'Lisbon'), 'Flights', 'Transport', 310),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), 'Apartment, 3 nights', 'Stay', 285.5),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), 'Sintra train tickets', 'Transport', 18.4),
      ((SELECT id FROM trips WHERE name = 'Lake cabin'), 'Cabin, two nights', 'Stay', 240);

    INSERT INTO tasks (trip_id, what, done) VALUES
      ((SELECT id FROM trips WHERE name = 'Lisbon'), 'Book the apartment', 1),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), 'Check that the passports are valid', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), 'Buy the Sintra train tickets', 1),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), 'Tell the bank we are traveling', 0),
      ((SELECT id FROM trips WHERE name = 'Lisbon'), 'Print the boarding passes', 0),
      ((SELECT id FROM trips WHERE name = 'Lake cabin'), 'Book the cabin', 1),
      ((SELECT id FROM trips WHERE name = 'Lake cabin'), 'Bring firewood and board games', 0);
  </script>

  <main>
    <header class="hero">
      <dai-rows
        query="SELECT id, name, destination, starts_label, ends_label, days_text, when_text FROM trip_cards WHERE current"
        empty="No trips yet. Open New trip below and add your first one.">
        <template>
          <div class="row-hero">
            <p class="when" data-text="when_text"></p>
            <h1 data-text="name"></h1>
            <p class="meta">
              <span data-text="destination"></span>
              <span class="dates"><span data-text="starts_label"></span> to <span data-text="ends_label"></span>,
              <span data-text="days_text"></span></span>
            </p>
          </div>
        </template>
      </dai-rows>
    </header>

    <section aria-labelledby="trips-h">
      <h2 id="trips-h">Your trips</h2>
      <dai-rows class="chips" query="SELECT id, name, current FROM trip_cards ORDER BY starts, name" empty="Nothing planned yet.">
        <template>
          <button type="button" class="chip" data-run="UPDATE settings SET value = :id WHERE name = 'trip'">
            <span class="cur" data-when="current">&#10003;<span class="sr"> selected</span></span>
            <span data-text="name"></span>
          </button>
        </template>
      </dai-rows>

      <details class="more">
        <summary>New trip</summary>
        <dai-form run="INSERT INTO trips (name, destination, starts, ends, budget) VALUES (:name, :destination, :starts, :ends, coalesce(nullif(:budget, ''), 0))">
          <label class="fld wide"><span>Trip name</span>
            <input name="name" required maxlength="60" placeholder="Lisbon" />
          </label>
          <label class="fld wide"><span>Where</span>
            <input name="destination" maxlength="80" placeholder="City or region" />
          </label>
          <label class="fld"><span>From</span>
            <input name="starts" type="date" required />
          </label>
          <label class="fld"><span>To</span>
            <input name="ends" type="date" required />
          </label>
          <label class="fld wide"><span>Budget (optional)</span>
            <input name="budget" type="number" inputmode="decimal" min="0" step="any" placeholder="0" />
          </label>
          <button>Add trip</button>
        </dai-form>
      </details>
    </section>

    <section aria-labelledby="plan-h">
      <h2 id="plan-h">Itinerary</h2>
      <dai-rows class="list"
        query="SELECT id, day_label, first_of_day, time_text, what, place, done FROM plan_items WHERE trip_id = (SELECT id FROM current_trip) ORDER BY day, time, id"
        empty="Nothing planned for these days yet. Add the first stop below.">
        <template>
          <div class="row plan">
            <h3 class="day" data-when="first_of_day" data-text="day_label"></h3>
            <div class="entry">
              <label class="tick">
                <input type="checkbox" data-run="UPDATE plans SET done = 1 - done WHERE id = :id" />
                <span class="box" aria-hidden="true"></span>
                <span class="body">
                  <span class="line">
                    <span class="time" data-text="time_text"></span>
                    <span class="what" data-text="what"></span>
                    <span class="state" data-when="done">done</span>
                  </span>
                  <span class="place" data-text="place"></span>
                </span>
              </label>
              <button type="button" class="x" aria-label="Remove this stop" data-run="DELETE FROM plans WHERE id = :id">&times;</button>
            </div>
          </div>
        </template>
      </dai-rows>

      <dai-form run="INSERT INTO plans (trip_id, day, time, what, place) VALUES ((SELECT id FROM current_trip), :day, coalesce(:time, ''), :what, coalesce(:place, ''))">
        <label class="fld"><span>Day</span>
          <input name="day" type="date" required />
        </label>
        <label class="fld"><span>Time (optional)</span>
          <input name="time" type="time" />
        </label>
        <label class="fld wide"><span>What</span>
          <input name="what" required maxlength="100" placeholder="Boat to the island" />
        </label>
        <label class="fld wide"><span>Where (optional)</span>
          <input name="place" maxlength="100" placeholder="Pier 4" />
        </label>
        <button>Add to itinerary</button>
      </dai-form>
    </section>

    <section aria-labelledby="budget-h">
      <h2 id="budget-h">Budget</h2>
      <dai-rows class="boxed"
        query="SELECT id, budget, spent_text, budget_note, over FROM trip_cards WHERE current"
        empty="Add a trip to set a budget.">
        <template>
          <div class="budget">
            <label class="fld"><span>Budget for this trip</span>
              <input type="number" inputmode="decimal" min="0" step="any" data-text="budget"
                data-run="UPDATE trips SET budget = :typed WHERE id = :id" />
            </label>
            <p class="figures">
              Spent <b data-text="spent_text"></b>
              <span class="dot" aria-hidden="true">&middot;</span>
              <span data-text="budget_note"></span>
              <span class="flag" data-when="over">Over budget</span>
            </p>
          </div>
        </template>
      </dai-rows>

      <dai-rows class="pills"
        query="SELECT category, printf('%.2f', sum(amount)) AS total FROM expenses WHERE trip_id = (SELECT id FROM current_trip) GROUP BY category ORDER BY sum(amount) DESC"
        empty="">
        <template>
          <span class="pill"><span data-text="category"></span> <b data-text="total"></b></span>
        </template>
      </dai-rows>

      <dai-rows class="list"
        query="SELECT id, what, category, amount_text, added_text FROM expense_items WHERE trip_id = (SELECT id FROM current_trip) ORDER BY added DESC, id DESC"
        empty="No spending yet. Add what you have paid for below.">
        <template>
          <div class="row expense">
            <span class="body">
              <span class="what" data-text="what"></span>
              <span class="place"><span data-text="category"></span>, <span data-text="added_text"></span></span>
            </span>
            <b class="amount" data-text="amount_text"></b>
            <button type="button" class="x" aria-label="Remove this expense" data-run="DELETE FROM expenses WHERE id = :id">&times;</button>
          </div>
        </template>
      </dai-rows>

      <dai-form run="INSERT INTO expenses (trip_id, what, category, amount) VALUES ((SELECT id FROM current_trip), :what, :category, :amount)">
        <label class="fld wide"><span>Paid for</span>
          <input name="what" required maxlength="80" placeholder="Museum tickets" />
        </label>
        <label class="fld"><span>Amount</span>
          <input name="amount" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="0.00" />
        </label>
        <label class="fld"><span>Kind</span>
          <select name="category">
            <option>Stay</option>
            <option>Food</option>
            <option>Transport</option>
            <option>Activities</option>
            <option selected>Other</option>
          </select>
        </label>
        <button>Add expense</button>
      </dai-form>
    </section>

    <section aria-labelledby="todo-h">
      <h2 id="todo-h">Before you go</h2>
      <p class="sub">
        <dai-value query="SELECT count(*) FROM tasks WHERE done = 1 AND trip_id = (SELECT id FROM current_trip)"></dai-value>
        of
        <dai-value query="SELECT count(*) FROM tasks WHERE trip_id = (SELECT id FROM current_trip)"></dai-value>
        done
      </p>
      <dai-rows class="list"
        query="SELECT id, what, done FROM tasks WHERE trip_id = (SELECT id FROM current_trip) ORDER BY done, what"
        empty="Nothing to do before you leave. Add a reminder below.">
        <template>
          <div class="row">
            <div class="entry">
              <label class="tick">
                <input type="checkbox" data-run="UPDATE tasks SET done = 1 - done WHERE id = :id" />
                <span class="box" aria-hidden="true"></span>
                <span class="body">
                  <span class="line">
                    <span class="what" data-text="what"></span>
                    <span class="state" data-when="done">done</span>
                  </span>
                </span>
              </label>
              <button type="button" class="x" aria-label="Remove this reminder" data-run="DELETE FROM tasks WHERE id = :id">&times;</button>
            </div>
          </div>
        </template>
      </dai-rows>

      <dai-form run="INSERT INTO tasks (trip_id, what) VALUES ((SELECT id FROM current_trip), :what)">
        <label class="fld wide"><span>Reminder</span>
          <input name="what" required maxlength="100" placeholder="Pack the charger" />
        </label>
        <button>Add reminder</button>
      </dai-form>
    </section>

    <footer>
      <button type="button" id="share" class="secondary" hidden>Share this trip</button>
      <dai-rows query="SELECT id FROM trip_cards WHERE current">
        <template>
          <button type="button" class="quiet" data-run="DELETE FROM trips WHERE id = :id">Delete this trip</button>
        </template>
      </dai-rows>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./app.js"></script>
  <script type="module" src="./dai-kit.js"></script>
</body>
</html>

--- file: app.js
// The only script of our own: the Share button. Sharing is the host's, so the
// button just asks the host to open its share sheet. Hidden unless there is a
// host to ask.
const share = document.getElementById("share");

if (share && window.dai && typeof window.dai.requestShare === "function") {
  share.hidden = false;
  share.addEventListener("click", () => {
    window.dai.requestShare();
  });
}

--- file: app.css
/* Warm paper, one terracotta accent. */
:root {
  --paper: #f7f3ec;
  --card: #fffdf9;
  --ink: #1f2933;
  --muted: #66707a;
  --line: #e5ddd0;
  --accent: #c2501f;
  --on-accent: #ffffff;
  --soft: #f6e1d5;
  --soft-ink: #7a2f0f;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #171a1f;
    --card: #20252c;
    --ink: #eef0f2;
    --muted: #9aa4af;
    --line: #333b45;
    --accent: #ff8a5c;
    --on-accent: #1a0e08;
    --soft: #3a2a22;
    --soft-ink: #ffc9b0;
  }
}

* { box-sizing: border-box; }

[hidden] { display: none !important; }

html, body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
}

body {
  min-height: 100vh;
  font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/*
 * Color runs to every edge; content stays clear of the strips a phone
 * covers, using the sizes the host reports (zero when nothing is in the way).
 */
main {
  max-width: 640px;
  margin: 0 auto;
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(20px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(20px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 28px;
}

section { display: flex; flex-direction: column; gap: 12px; }

/* The host floats a round button in the top right corner: keep the title clear. */
.hero { padding-right: 52px; }

.row-hero { display: block; }

.when {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
}

h1 {
  margin: 4px 0 6px;
  font-size: clamp(28px, 8vw, 38px);
  line-height: 1.08;
  letter-spacing: -0.03em;
  overflow-wrap: anywhere;
}

.meta { margin: 0; color: var(--muted); }
.meta .dates { white-space: normal; }

h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.sub { margin: -6px 0 0; color: var(--muted); font-size: 14px; }

dai-rows, dai-form { display: block; }

/* Trip chips */
dai-rows.chips { display: flex; flex-wrap: wrap; gap: 8px; }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 16px;
  font: inherit;
  font-weight: 600;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
}

.chip:has(.cur:not([hidden])) {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

button:focus-visible,
summary:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

/* Lists */
dai-rows.list,
dai-rows.boxed {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}

dai-rows.list:not(:has(.row)),
dai-rows.boxed:not(:has(.budget)) {
  padding: 16px;
  color: var(--muted);
}

.row { border-top: 1px solid var(--line); }
.row:first-child { border-top: 0; }

.plan .day {
  margin: 0;
  padding: 10px 14px 6px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--soft);
}

.plan { border-top: 0; }
.plan:not(:first-child) { border-top: 1px solid var(--line); }

.entry {
  display: grid;
  grid-template-columns: 1fr 44px;
  align-items: center;
}

.tick {
  position: relative;
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 12px;
  align-items: start;
  min-height: 48px;
  padding: 11px 4px 11px 14px;
  cursor: pointer;
}

.tick input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}

.box {
  width: 22px;
  height: 22px;
  margin-top: 1px;
  border: 2px solid var(--line);
  border-radius: 999px;
  background: var(--card);
}

.tick:has(input:focus-visible) .box {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

.tick:has(.state:not([hidden])) .box {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: inset 0 0 0 3px var(--card);
}

.tick:has(.state:not([hidden])) .what {
  color: var(--muted);
  text-decoration: line-through;
}

.body { display: block; min-width: 0; }
.line { display: block; overflow-wrap: anywhere; }

.time {
  display: inline-block;
  margin-right: 6px;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

.place {
  display: block;
  font-size: 14px;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.place:empty { display: none; }

.state {
  display: none;
  margin-left: 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent);
}

.tick:has(.state:not([hidden])) .state { display: inline; }

.x {
  width: 44px;
  height: 44px;
  padding: 0;
  font: inherit;
  font-size: 24px;
  line-height: 1;
  color: var(--muted);
  background: none;
  border: 0;
  border-radius: 10px;
  cursor: pointer;
}

.x:hover { color: var(--accent); }

.expense {
  display: grid;
  grid-template-columns: 1fr auto 44px;
  gap: 8px;
  align-items: center;
  padding: 10px 0 10px 14px;
}

.amount { font-variant-numeric: tabular-nums; }

/* Budget */
.budget { padding: 14px; display: flex; flex-direction: column; gap: 10px; }

.figures { margin: 0; color: var(--muted); }
.figures b { color: var(--ink); font-variant-numeric: tabular-nums; }
.figures .dot { margin: 0 4px; }

.flag {
  display: inline-block;
  margin-left: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--soft-ink);
  font-size: 12px;
  font-weight: 700;
}

dai-rows.pills { display: flex; flex-wrap: wrap; gap: 8px; }

.pill {
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--soft-ink);
  font-size: 13px;
}

.pill b { font-variant-numeric: tabular-nums; }

/* Forms */
dai-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
  gap: 10px;
}

.fld { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.fld > span { font-size: 13px; font-weight: 600; color: var(--muted); }
.wide, dai-form > button { grid-column: 1 / -1; }

input, select {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  font: inherit;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
}

dai-form > button,
dai-save {
  min-height: 44px;
  padding: 10px 18px;
  font: inherit;
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  border: 0;
  border-radius: 10px;
  cursor: pointer;
}

details.more { margin-top: 4px; }

details.more summary {
  display: flex;
  align-items: center;
  min-height: 44px;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
}

details.more dai-form { margin-top: 8px; }

/* Footer */
footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

footer dai-rows { display: contents; }

.secondary,
.quiet {
  min-height: 44px;
  padding: 10px 18px;
  font: inherit;
  font-weight: 600;
  border-radius: 10px;
  cursor: pointer;
}

.secondary {
  color: var(--accent);
  background: none;
  border: 1px solid var(--accent);
}

.quiet {
  color: var(--muted);
  background: none;
  border: 1px solid var(--line);
}

.quiet:hover { color: var(--accent); border-color: var(--accent); }

dai-save { display: inline-block; margin-left: auto; }

/* On a wide screen, a card on a quieter ground. */
@media (min-width: 720px) {
  html, body { background: color-mix(in srgb, var(--paper) 88%, #000); }
  main {
    margin: 40px auto;
    padding: calc(36px + var(--dai-safe-top, 0px)) calc(36px + var(--dai-safe-right, 0px))
      calc(40px + var(--dai-safe-bottom, 0px)) calc(36px + var(--dai-safe-left, 0px));
    background: var(--paper);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.05), 0 24px 60px -20px rgb(0 0 0 / 0.22);
  }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- A map pin over a dashed route, on terracotta. -->
  <rect width="100" height="100" rx="22" fill="#c2501f"/>
  <path d="M50 14c-13 0-23 10-23 23 0 18 23 40 23 40s23-22 23-40c0-13-10-23-23-23z" fill="#fff7ef"/>
  <circle cx="50" cy="37" r="9" fill="#c2501f"/>
  <path d="M16 88Q50 68 84 88" fill="none" stroke="#fff7ef" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 10"/>
</svg>
```
