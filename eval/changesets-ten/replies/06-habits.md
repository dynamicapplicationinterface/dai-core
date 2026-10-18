Here is a habit tracker. It is a solo document: one person, one phone, nothing merged, so it uses ordinary tables and no shared rows. Each habit gets one tap a day, the last seven days sit under it so you can fix a missed day, and the streak is worked out from the check-ins every time rather than stored.

```text
dai bundle v1
name: Habit tracker

--- file: schema.sql
-- Habit tracker · shape: solo
--
-- The decision: one person's habits, kept on one device. Nobody else adds to
-- it and no second copy's changes need keeping, so nothing is shared: ordinary
-- tables, keys and all, written with plain SQL.
--
-- Notes:
--   * checks holds one row per habit per calendar day the person means ("I did
--     this on Tuesday"). That day is a fact they entered, in their own local
--     calendar, so it is a plain YYYY-MM-DD and not a write time. When a row
--     was created is stored in UTC (habits.created) and never shown.
--   * No streak, no count, no "done today" flag is stored. They are derived
--     from checks each time the page is drawn.
--   * Archiving a habit keeps its history; nothing is dropped.

CREATE TABLE IF NOT EXISTS habits (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checks (
  habit_id INTEGER NOT NULL,
  day      TEXT NOT NULL,          -- YYYY-MM-DD, the day the person did it
  PRIMARY KEY (habit_id, day)
);

-- Remembers that the example rows were offered once, so deleting them sticks.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Daily habits, a week at a glance, and streaks that count" />
  <meta name="dai:does" content="Track the habits you want to keep, one tap a day" />
  <meta name="dai:does" content="Fix a missed day with a tap if you forgot to mark it" />
  <meta name="dai:does" content="Show your current streak and how many days you kept each habit this week" />
  <meta name="theme-color" content="#f4f1ea" />
  <title>Habit tracker</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Local seed only, offered once. A second open adds nothing.
    INSERT INTO habits (id, name)
      SELECT id, name FROM (
        SELECT 1 AS id, 'Drink water' AS name
        UNION ALL SELECT 2, 'Walk for 20 minutes'
        UNION ALL SELECT 3, 'Read a few pages'
      )
      WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'seeded');

    INSERT INTO checks (habit_id, day)
      SELECT h, date('now', o) FROM (
        SELECT 1 AS h, '-1 day' AS o
        UNION ALL SELECT 1, '-2 day'
        UNION ALL SELECT 1, '-3 day'
        UNION ALL SELECT 2, '-1 day'
        UNION ALL SELECT 3, '-2 day'
      )
      WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'seeded');

    INSERT OR IGNORE INTO meta (key, value) VALUES ('seeded', '1');
  </script>

  <!-- Nothing to type into or press until app.js has started. -->
  <p id="opening" class="opening" role="status">Opening…</p>

  <main id="app" hidden inert>
    <header>
      <h1>Habits</h1>
      <p id="today" class="today" aria-live="polite"></p>
    </header>

    <p id="notice" class="notice" role="status" hidden></p>

    <ul id="list" class="list"></ul>

    <div id="empty" class="empty" hidden>
      <p><strong>No habits yet.</strong></p>
      <p>Add one below, something small you can do every day. A tap each day builds the streak.</p>
    </div>

    <form id="add" class="add" autocomplete="off">
      <label for="name">New habit</label>
      <div class="row">
        <input id="name" required maxlength="60" placeholder="e.g. Stretch for five minutes" />
        <button type="submit">Add</button>
      </div>
    </form>

    <details id="archived-box" class="archived" hidden>
      <summary>Archived habits</summary>
      <ul id="archived" class="list"></ul>
    </details>

    <footer>
      <!-- Shown only when the file is open in a plain browser with no host. -->
      <button id="save" type="button" class="quiet" hidden>Save to this file</button>
    </footer>
  </main>

  <script type="module" src="./app.js"></script>
</body>
</html>

--- file: app.js
// Habit tracker: a solo document. Every tap is written to the database as it
// happens; the page is drawn from the database and redrawn after each write.
// Streaks and counts are derived from the check-ins every time, never stored.

const $ = (id) => document.getElementById(id);
let db; // opened by the start-up at the end of this file

const rows = (sql, bind) => (bind === undefined ? db.selectObjects(sql) : db.selectObjects(sql, bind));

// ---- days -----------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
/** A calendar day in the person's own time zone, as YYYY-MM-DD. */
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const daysAgo = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // noon, so a daylight-saving shift never lands on the wrong day
  d.setDate(d.getDate() - n);
  return d;
};

function say(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}

/** Runs a write and says what went wrong, rather than failing silently. */
function write(fn) {
  try {
    fn();
    say("");
    return true;
  } catch (error) {
    say(`That did not save: ${String(error?.message ?? error)}`);
    return false;
  }
}

// ---- reading --------------------------------------------------------------

function loadChecks() {
  const byHabit = new Map();
  for (const { habit_id, day } of rows("SELECT habit_id, day FROM checks")) {
    if (!byHabit.has(habit_id)) byHabit.set(habit_id, new Set());
    byHabit.get(habit_id).add(day);
  }
  return byHabit;
}

/** Consecutive days kept, ending today, or yesterday if today is not marked yet. */
function streakOf(days) {
  let back = days.has(ymd(daysAgo(0))) ? 0 : 1;
  let count = 0;
  while (days.has(ymd(daysAgo(back)))) {
    count += 1;
    back += 1;
  }
  return count;
}

// ---- drawing --------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toggle(habitId, day, isDone) {
  const ok = write(() =>
    isDone
      ? db.exec({ sql: "DELETE FROM checks WHERE habit_id = ? AND day = ?", bind: [habitId, day] })
      : db.exec({ sql: "INSERT OR IGNORE INTO checks (habit_id, day) VALUES (?, ?)", bind: [habitId, day] }),
  );
  if (ok) draw();
}

function drawHabit(habit, days) {
  const today = ymd(daysAgo(0));
  const doneToday = days.has(today);
  const streak = streakOf(days);
  const week = [6, 5, 4, 3, 2, 1, 0].map((n) => daysAgo(n));
  const keptThisWeek = week.filter((d) => days.has(ymd(d))).length;

  const item = el("li", "habit" + (doneToday ? " done" : ""));

  const top = el("div", "top");
  const title = el("div", "title");
  title.append(el("strong", "name", habit.name));
  const meta =
    streak > 1
      ? `${streak}-day streak · ${keptThisWeek} of 7 this week`
      : `${keptThisWeek} of 7 this week`;
  title.append(el("span", "meta", meta));

  const big = el("button", "today-btn", doneToday ? "Done today ✓" : "Mark done today");
  big.type = "button";
  big.setAttribute("aria-pressed", String(doneToday));
  big.addEventListener("click", () => toggle(habit.id, today, doneToday));
  top.append(title, big);

  const strip = el("div", "strip");
  for (const date of week) {
    const day = ymd(date);
    const done = days.has(day);
    const cell = el("button", "day" + (done ? " on" : "") + (day === today ? " now" : ""));
    cell.type = "button";
    cell.setAttribute("aria-pressed", String(done));
    cell.setAttribute(
      "aria-label",
      `${date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}: ${done ? "done" : "not done"}`,
    );
    cell.append(
      el("span", "dow", date.toLocaleDateString("en-US", { weekday: "narrow" })),
      el("span", "dot", done ? "✓" : ""),
    );
    cell.addEventListener("click", () => toggle(habit.id, day, done));
    strip.append(cell);
  }

  const foot = el("div", "foot");
  const archive = el("button", "link", "Archive");
  archive.type = "button";
  archive.setAttribute("aria-label", `Archive ${habit.name}`);
  archive.addEventListener("click", () => {
    if (write(() => db.exec({ sql: "UPDATE habits SET archived = 1 WHERE id = ?", bind: [habit.id] }))) draw();
  });
  foot.append(archive);

  item.append(top, strip, foot);
  return item;
}

function draw() {
  const checks = loadChecks();
  const today = ymd(daysAgo(0));
  const habits = rows("SELECT id, name FROM habits WHERE archived = 0 ORDER BY id");

  const list = $("list");
  list.replaceChildren(...habits.map((h) => drawHabit(h, checks.get(h.id) ?? new Set())));
  $("empty").hidden = habits.length > 0;

  const done = habits.filter((h) => checks.get(h.id)?.has(today)).length;
  $("today").textContent =
    habits.length === 0
      ? ""
      : done === habits.length
        ? `All ${habits.length} done today`
        : `${done} of ${habits.length} done today`;
  $("today").classList.toggle("all", habits.length > 0 && done === habits.length);

  const archived = rows("SELECT id, name FROM habits WHERE archived = 1 ORDER BY id");
  $("archived-box").hidden = archived.length === 0;
  $("archived").replaceChildren(
    ...archived.map((h) => {
      const item = el("li", "habit quietrow");
      item.append(el("span", "name", h.name));
      const back = el("button", "quiet", "Bring back");
      back.type = "button";
      back.setAttribute("aria-label", `Bring back ${h.name}`);
      back.addEventListener("click", () => {
        if (write(() => db.exec({ sql: "UPDATE habits SET archived = 0 WHERE id = ?", bind: [h.id] }))) draw();
      });
      item.append(back);
      return item;
    }),
  );
}

// ---- acting ---------------------------------------------------------------

$("add").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("name").value.trim();
  if (!name) return;
  if (write(() => db.exec({ sql: "INSERT INTO habits (name) VALUES (?)", bind: [name] }))) {
    $("name").value = "";
    draw();
    $("name").focus();
  }
});

// Only a file opened straight in a browser, with no host, needs this.
$("save").addEventListener("click", async () => {
  try {
    await window.dai.saveDatabase(db);
    say("");
  } catch (error) {
    say(`That did not save: ${String(error?.message ?? error)}`);
  }
});

// The date rolls over while the page is open: redraw when it comes back to the front.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && db) draw();
});

// Start-up: nothing can be typed into until this has finished, and if it fails
// the person is told, not left at "Opening…".
try {
  db = await window.dai.openDatabase();
  draw();
  $("save").hidden = window.dai.autosaves;
  $("opening").hidden = true;
  $("app").hidden = false;
  $("app").inert = false;
} catch (error) {
  $("opening").classList.add("failed");
  $("opening").textContent =
    `The habit tracker could not be opened: ${error?.message ?? error}. ` +
    "Try opening the document again, or ask whoever sent it for a new copy.";
}

--- file: app.css
:root {
  color-scheme: light dark;
  --bg: #f4f1ea;
  --card: #ffffff;
  --ink: #1f2a24;
  --muted: #667069;
  --line: #e1dccf;
  --accent: #2f7d54;
  --accent-ink: #ffffff;
  --glow: #dcefe3;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151a17; --card: #1e2520; --ink: #e8ece8; --muted: #9aa39c;
    --line: #2d362f; --accent: #6fc493; --accent-ink: #10231a; --glow: #20352a;
  }
}
* { box-sizing: border-box; }
/* A display rule below would otherwise show what the page hid. */
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { line-height: 1.45; -webkit-font-smoothing: antialiased; }

main {
  max-width: 560px;
  margin: 0 auto;
  padding: calc(24px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(16px + var(--dai-safe-left, 0px));
}
/* The top right corner belongs to the host's menu button. */
header { padding-right: 56px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 32px; letter-spacing: -0.02em; line-height: 1.1; }
.today { margin: 6px 0 0; color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
.today.all { color: var(--accent); }

.opening {
  margin: 0; color: var(--muted); text-align: center;
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px)) 0
    calc(16px + var(--dai-safe-left, 0px));
}
.opening.failed { color: var(--ink); text-align: left; max-width: 36em; margin: 0 auto; }
.notice { background: var(--card); border-left: 4px solid var(--accent); padding: 10px 12px; border-radius: 8px; }

.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.habit {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  padding: 14px; display: grid; gap: 12px;
}
.habit.done { border-color: var(--accent); }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.title { display: grid; gap: 2px; flex: 1 1 11em; min-width: 0; }
.name { font-size: 18px; overflow-wrap: anywhere; }
.meta { color: var(--muted); font-size: 14px; }

button {
  font: inherit; min-height: 44px; padding: 0 16px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink);
}
button.quiet { background: transparent; color: var(--accent); }
.today-btn { flex: 0 0 auto; font-weight: 600; }
.habit.done .today-btn { background: var(--glow); color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Seven days, oldest first, today on the right. */
.strip { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.day {
  display: grid; justify-items: center; align-content: center; gap: 2px;
  min-height: 52px; padding: 4px 0; background: transparent; color: var(--muted);
  border: 1px solid var(--line);
}
.day .dow { font-size: 12px; font-weight: 600; }
.day .dot { font-size: 16px; line-height: 1; min-height: 16px; }
.day.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.day.now:not(.on) { border-color: var(--accent); color: var(--ink); }

.foot { display: flex; justify-content: flex-end; }
button.link {
  min-height: 44px; padding: 0 4px; border: 0; background: none; color: var(--muted);
  font-size: 14px; text-decoration: underline; text-underline-offset: 3px;
}

.empty {
  background: var(--card); border: 1px dashed var(--line); border-radius: 16px;
  padding: 20px 18px; color: var(--muted); text-align: center;
}
.empty p { margin: 4px 0; }
.empty strong { color: var(--ink); }

.add { margin-top: 24px; display: grid; gap: 6px; }
.add label { color: var(--muted); font-size: 14px; }
.row { display: flex; gap: 8px; }
input {
  font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line);
  border-radius: 10px; min-height: 44px; padding: 8px 12px; width: 100%; min-width: 0;
}
::placeholder { color: var(--muted); opacity: 0.6; }

.archived { margin-top: 24px; color: var(--muted); }
.archived summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
.archived .list { margin-top: 4px; }
.quietrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 6px 6px 14px; }
.quietrow .name { font-size: 16px; color: var(--ink); }

footer { margin-top: 28px; display: flex; justify-content: flex-end; }

@media (min-width: 720px) {
  main { padding-top: calc(40px + var(--dai-safe-top, 0px)); }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#2f7d54"/><g fill="#dcefe3"><circle cx="24" cy="68" r="7"/><circle cx="42" cy="68" r="7"/><circle cx="60" cy="68" r="7"/><circle cx="78" cy="68" r="7" opacity="0.4"/></g><path d="M26 38l16 16 32-30" fill="none" stroke="#ffffff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>
```

How it works:

- **Shape:** solo. It's one person's habits on one device, so nothing is shared or merged. A copy you send someone is an ordinary document they can write to.
- **Each habit** has a "Mark done today" button and a row of the last seven days. Tap any day to mark it or unmark it, which is how you fix a day you forgot.
- **Streaks and counts** are worked out from the check-ins each time the screen is drawn. Nothing like that is stored.
- **A streak** counts back from today, or from yesterday if today isn't marked yet. A streak doesn't break until a whole day has passed unmarked.
- **Every tap** is saved to the document as you make it. There's no Save button under the DAI opener. A small "Save to this file" button appears only if the file is opened directly in a browser with no host.
- **Archive** hides a habit but keeps its history, and "Bring back" restores it.
- **Three example habits** with a few check-ins are added on first open, once. If you delete them they stay deleted.
