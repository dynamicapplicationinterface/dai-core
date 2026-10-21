I built this as a solo document: one person's trip, kept in one file, with days and the stops inside each day. If you later want a travel partner to add stops too, tell me and I'll rebuild it as a shared plan. That choice has to be made before the first release, so I'm saying it now.

```text
dai bundle v1
name: Trip planner

--- file: schema.sql
-- Trip planner · shape: solo
--
-- The decision: one person's trip, kept on their own device. Nobody else adds
-- to it and no second copy's changes need keeping, so nothing is shared:
-- ordinary tables with keys, written in JavaScript over the kit's database.
--
-- Nothing derived is stored. A day's number comes from its place in the list,
-- and the counts of stops are computed each time they are drawn. The only
-- times kept are the ones the person typed (a date, a time of day).

CREATE TABLE IF NOT EXISTS trip (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  title TEXT NOT NULL DEFAULT 'My trip'
);

CREATE TABLE IF NOT EXISTS days (
  id      INTEGER PRIMARY KEY,
  label   TEXT NOT NULL,            -- e.g. "Arrive in Lisbon"
  on_date TEXT NOT NULL DEFAULT ''  -- YYYY-MM-DD as entered, or empty
);

CREATE TABLE IF NOT EXISTS stops (
  id      INTEGER PRIMARY KEY,
  day_id  INTEGER NOT NULL,         -- the days row this stop belongs to
  at_time TEXT NOT NULL DEFAULT '', -- HH:MM as entered, or empty
  name    TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  done    INTEGER NOT NULL DEFAULT 0
);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Plan a trip day by day, with the stops in each" />
  <meta name="dai:does" content="Lay out your trip as days, each with its own list of stops" />
  <meta name="dai:does" content="Add a time and a note to any stop, and tick it off when you have been" />
  <meta name="dai:does" content="Keep the whole plan in one file you can open anywhere, offline" />
  <meta name="theme-color" content="#f5f1e8" />
  <title>Trip planner</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Local seed only, written so a second open adds nothing.
    INSERT OR IGNORE INTO trip (id, title) VALUES (1, 'Lisbon long weekend');
    INSERT OR IGNORE INTO days (id, label, on_date) VALUES
      (1, 'Arrive and wander', ''),
      (2, 'Alfama and the river', '');
    INSERT OR IGNORE INTO stops (id, day_id, at_time, name, note, done) VALUES
      (1, 1, '15:00', 'Check in', 'Rua Augusta, ask about luggage storage', 0),
      (2, 1, '17:30', 'Miradouro de Santa Luzia', 'Sunset view over the rooftops', 0),
      (3, 1, '20:00', 'Dinner in Bairro Alto', '', 0),
      (4, 2, '09:00', 'Tram 28 from Martim Moniz', 'Go early, before the queue', 0),
      (5, 2, '11:00', 'Castelo de Sao Jorge', '', 0);
  </script>

  <!-- Nothing to type into until app.js has started. -->
  <p id="opening" class="opening" role="status">Opening…</p>

  <main id="app" hidden inert>
    <header>
      <input id="trip-title" class="trip-title" aria-label="Trip name" maxlength="60" autocomplete="off" />
      <p id="summary" class="summary" aria-live="polite"></p>
    </header>

    <p id="notice" class="notice" role="status" hidden></p>

    <section id="days" class="days" aria-label="Days"></section>

    <p id="empty" class="empty" hidden>No days yet. Add the first day below, then add stops to it.</p>

    <form id="add-day" class="panel" autocomplete="off">
      <h2>Add a day</h2>
      <div class="fields">
        <label>What is the day about
          <input id="day-label" required maxlength="80" placeholder="e.g. Museums and lunch" />
        </label>
        <label>Date <span class="optional">· optional</span>
          <input id="day-date" type="date" />
        </label>
      </div>
      <div class="actions"><button type="submit">Add day</button></div>
    </form>

    <form id="add-stop" class="panel" autocomplete="off" hidden>
      <h2>Add a stop</h2>
      <div class="fields">
        <label>Day
          <select id="stop-day" required></select>
        </label>
        <label>Time <span class="optional">· optional</span>
          <input id="stop-time" type="time" />
        </label>
        <label class="wide">Stop
          <input id="stop-name" required maxlength="80" placeholder="e.g. Pastéis de Belém" />
        </label>
        <label class="wide">Note <span class="optional">· optional</span>
          <input id="stop-note" maxlength="200" placeholder="e.g. Book ahead" />
        </label>
      </div>
      <div class="actions"><button type="submit">Add stop</button></div>
    </form>

    <footer>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./app.js"></script>
</body>
</html>

--- file: app.js
// Trip planner — a solo document. Days and stops are ordinary local tables,
// written the moment a person acts and drawn again from the database.

const $ = (id) => document.getElementById(id);
let db; // the kit's handle, taken by the start-up at the end of this file
const rows = (sql, bind) => (bind === undefined ? db.selectObjects(sql) : db.selectObjects(sql, bind));
const run = (sql, bind) => (bind === undefined ? db.exec(sql) : db.exec({ sql, bind }));

/** A day whose "remove" has been tapped once and is waiting for the second tap. */
let armedDay = null;

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
    say(`That did not save: ${error?.message ?? error}`);
    return false;
  }
}

// ---- words for dates and times ---------------------------------------------

function dateWords(ymd) {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function timeWords(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---- drawing ---------------------------------------------------------------

function button(label, className, onClick, ariaLabel) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  if (ariaLabel) b.setAttribute("aria-label", ariaLabel);
  b.addEventListener("click", onClick);
  return b;
}

function drawStop(stop) {
  const item = document.createElement("li");
  item.className = stop.done ? "stop done" : "stop";

  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "tick";
  tick.setAttribute("aria-pressed", stop.done ? "true" : "false");
  tick.setAttribute("aria-label", `${stop.done ? "Mark not visited" : "Mark visited"}: ${stop.name}`);
  tick.textContent = stop.done ? "✓" : "";
  tick.addEventListener("click", () => {
    if (write(() => run("UPDATE stops SET done = 1 - done WHERE id = ?", [stop.id]))) draw();
  });

  const body = document.createElement("div");
  body.className = "stop-body";
  const name = document.createElement("strong");
  name.textContent = stop.name;
  body.append(name);
  if (stop.at_time) {
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = timeWords(stop.at_time);
    body.prepend(time);
  }
  if (stop.note) {
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = stop.note;
    body.append(note);
  }

  const remove = button("Remove", "link", () => {
    if (write(() => run("DELETE FROM stops WHERE id = ?", [stop.id]))) draw();
  }, `Remove stop: ${stop.name}`);

  item.append(tick, body, remove);
  return item;
}

function drawDay(day, number) {
  const card = document.createElement("article");
  card.className = "day";

  const head = document.createElement("div");
  head.className = "day-head";
  const titles = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = day.on_date ? `Day ${number} · ${dateWords(day.on_date)}` : `Day ${number}`;
  const title = document.createElement("h2");
  title.textContent = day.label;
  titles.append(eyebrow, title);

  const armed = armedDay === day.id;
  const removeDay = button(
    armed ? "Tap again to remove" : "Remove day",
    armed ? "link danger" : "link",
    () => {
      if (day.stops > 0 && !armed) {
        armedDay = day.id;
        draw();
        return;
      }
      armedDay = null;
      const ok = write(() => {
        run("BEGIN");
        try {
          run("DELETE FROM stops WHERE day_id = ?", [day.id]);
          run("DELETE FROM days WHERE id = ?", [day.id]);
          run("COMMIT");
        } catch (error) {
          run("ROLLBACK");
          throw error;
        }
      });
      if (ok) draw();
    },
    `Remove day ${number}: ${day.label}`,
  );
  head.append(titles, removeDay);

  const stops = rows(
    `SELECT id, at_time, name, note, done FROM stops WHERE day_id = ?
      ORDER BY CASE WHEN at_time = '' THEN 1 ELSE 0 END, at_time, id`,
    [day.id],
  );
  const list = document.createElement("ul");
  list.className = "stops";
  for (const stop of stops) list.append(drawStop(stop));

  card.append(head, list);
  if (stops.length === 0) {
    const none = document.createElement("p");
    none.className = "none";
    none.textContent = "Nothing planned yet. Add a stop below.";
    card.append(none);
  }
  return card;
}

function draw() {
  const title = $("trip-title");
  if (document.activeElement !== title) {
    title.value = rows("SELECT title FROM trip WHERE id = 1")[0]?.title ?? "";
  }

  const days = rows(
    `SELECT d.id, d.label, d.on_date, (SELECT count(*) FROM stops s WHERE s.day_id = d.id) AS stops
       FROM days d ORDER BY d.on_date = '', d.on_date, d.id`,
  );
  const totals = rows("SELECT count(*) AS n, coalesce(sum(done), 0) AS done FROM stops")[0];
  $("summary").textContent = days.length
    ? `${plural(days.length, "day")} · ${plural(totals.n, "stop")} · ${totals.done} visited`
    : "";

  $("days").replaceChildren(...days.map((day, i) => drawDay(day, i + 1)));
  $("empty").hidden = days.length > 0;

  // The stop form is written once in the page; only its day choices are
  // refreshed, and the chosen day is kept.
  const select = $("stop-day");
  const chosen = select.value;
  select.replaceChildren(
    ...days.map((day, i) => {
      const option = document.createElement("option");
      option.value = String(day.id);
      option.textContent = `Day ${i + 1} · ${day.label}`;
      return option;
    }),
  );
  if (days.some((d) => String(d.id) === chosen)) select.value = chosen;
  $("add-stop").hidden = days.length === 0;
}

// ---- acting ----------------------------------------------------------------

$("trip-title").addEventListener("change", () => {
  const title = $("trip-title").value.trim() || "My trip";
  if (write(() => run("UPDATE trip SET title = ? WHERE id = 1", [title]))) {
    $("trip-title").value = title;
  }
});

$("add-day").addEventListener("submit", (event) => {
  event.preventDefault();
  const label = $("day-label").value.trim();
  if (!label) return;
  const ok = write(() => run("INSERT INTO days (label, on_date) VALUES (?, ?)", [label, $("day-date").value]));
  if (!ok) return;
  const newest = db.selectValue("SELECT last_insert_rowid()");
  $("add-day").reset();
  draw();
  // The next thing a person does is add stops to the day they just made.
  $("stop-day").value = String(newest);
  $("stop-name").focus();
});

$("add-stop").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("stop-name").value.trim();
  const dayId = Number($("stop-day").value);
  if (!name || !dayId) return;
  const ok = write(() =>
    run("INSERT INTO stops (day_id, at_time, name, note) VALUES (?, ?, ?, ?)", [
      dayId,
      $("stop-time").value,
      name,
      $("stop-note").value.trim(),
    ]),
  );
  if (!ok) return;
  $("stop-time").value = "";
  $("stop-name").value = "";
  $("stop-note").value = "";
  draw();
  $("stop-name").focus();
});

// Start-up: nothing can be typed into until this has finished, and if it
// fails the person is told, not left at "Opening…".
try {
  // The kit opens the database; taking its handle avoids a second copy.
  await import("./dai-kit.js");
  db = window.daiKit.db;
  draw();
  $("opening").hidden = true;
  $("app").hidden = false;
  $("app").inert = false;
} catch (error) {
  $("opening").classList.add("failed");
  $("opening").textContent =
    `This trip could not be opened: ${error?.message ?? error}. ` +
    "Try opening the document again, or ask whoever sent it for a new copy.";
}

--- file: app.css
:root {
  color-scheme: light dark;
  --bg: #f5f1e8;
  --card: #ffffff;
  --ink: #22201b;
  --muted: #6f6a5e;
  --line: #e2dccd;
  --accent: #b4532a;
  --accent-ink: #ffffff;
  --done: #3f7a55;
  --danger: #a03030;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1815; --card: #24211d; --ink: #efe9dc; --muted: #a39c8b; --line: #38342d;
    --accent: #e48a5e; --accent-ink: #1a1815; --done: #7cc39a; --danger: #f08a8a;
  }
}
* { box-sizing: border-box; }
/* A display rule below would otherwise show what the page hid. */
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { line-height: 1.45; -webkit-font-smoothing: antialiased; }
main {
  max-width: 600px;
  margin: 0 auto;
  display: grid;
  gap: 20px;
  padding: calc(24px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(16px + var(--dai-safe-left, 0px));
}
/* The top right corner belongs to the host's menu button. */
header { padding-right: 56px; }
.trip-title {
  width: 100%; margin: 0; padding: 2px 0; border: 0; border-bottom: 1px dashed transparent;
  background: none; color: var(--ink); font: inherit; font-size: 30px; font-weight: 700;
  letter-spacing: -0.02em; line-height: 1.15; min-height: 44px;
}
.trip-title:hover, .trip-title:focus { outline: none; border-bottom-color: var(--accent); }
.summary { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
.opening {
  margin: 0; color: var(--muted); text-align: center;
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px)) 0 calc(16px + var(--dai-safe-left, 0px));
}
.opening.failed { color: var(--ink); text-align: left; max-width: 36em; margin: 0 auto; }
.notice { margin: 0; background: var(--card); border-left: 4px solid var(--accent); padding: 10px 12px; border-radius: 8px; }

.days { display: grid; gap: 16px; }
.day { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px 10px; }
.day-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.eyebrow { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); }
h2 { margin: 2px 0 0; font-size: 19px; }
.stops { list-style: none; margin: 8px 0 0; padding: 0; }
.stop { display: grid; grid-template-columns: 44px 1fr auto; align-items: center; gap: 4px 8px; border-top: 1px solid var(--line); padding: 4px 0; }
.stop-body { display: grid; gap: 1px; padding: 6px 0; min-width: 0; overflow-wrap: anywhere; }
.time { font-size: 13px; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
.note { font-size: 14px; color: var(--muted); }
.stop.done strong { color: var(--muted); text-decoration: line-through; }
.none { margin: 8px 0 4px; color: var(--muted); font-style: italic; }
.empty { margin: 0; color: var(--muted); text-align: center; padding: 24px 0; }

.tick {
  width: 44px; height: 44px; padding: 0; background: none; border: 0; cursor: pointer;
  display: grid; place-items: center; color: var(--accent-ink); font-size: 16px; font-weight: 700;
}
.tick::before {
  content: ""; grid-area: 1 / 1; width: 24px; height: 24px; border-radius: 999px; border: 2px solid var(--line);
}
.tick[aria-pressed="true"]::before { background: var(--done); border-color: var(--done); }
.tick { position: relative; }
.tick[aria-pressed="true"] { color: #fff; }
.tick { z-index: 0; }

.panel { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
.panel h2 { margin: 0 0 12px; font-size: 16px; }
.fields { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.fields label { display: grid; gap: 6px; font-size: 14px; color: var(--muted); }
.fields .wide { grid-column: 1 / -1; }
.optional { font-size: 13px; opacity: 0.8; }
input, select {
  font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line);
  border-radius: 10px; min-height: 44px; padding: 8px 12px; width: 100%;
}
::placeholder { color: var(--muted); opacity: 0.55; font-style: italic; }
.actions { margin-top: 14px; display: flex; gap: 8px; }
button { font: inherit; min-height: 44px; padding: 0 18px; border-radius: 10px; cursor: pointer; }
.actions button, dai-save {
  border: 0; background: var(--accent); color: var(--accent-ink); font-weight: 600;
}
button.link {
  min-height: 44px; padding: 0 6px; border: 0; background: none; color: var(--muted);
  font-size: 14px; text-decoration: underline; text-underline-offset: 3px;
}
button.link.danger { color: var(--danger); font-weight: 600; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
footer { display: flex; justify-content: flex-end; }
dai-save { display: inline-block; padding: 12px 22px; border-radius: 10px; cursor: pointer; }

@media (min-width: 720px) {
  html, body { background: color-mix(in srgb, var(--bg) 88%, #000); }
  main { margin: 32px auto; padding: 32px; background: var(--bg); border-radius: 24px; box-shadow: 0 24px 60px -24px rgb(0 0 0 / 0.25); }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#b4532a"/><path d="M26 74C26 56 50 56 50 40" fill="none" stroke="#f5f1e8" stroke-width="7" stroke-linecap="round" stroke-dasharray="1 13"/><circle cx="26" cy="74" r="9" fill="#f5f1e8"/><path d="M50 18c-8.3 0-15 6.5-15 14.600 0 10.400 15 24.400 15 24.400s15-14 15-24.400C65 24.500 58.300 18 50 18z" fill="#f5f1e8"/><circle cx="50" cy="32.500" r="5.500" fill="#b4532a"/></svg>
```

What you get:

- **Days**: add a day with a name and an optional date. Days are numbered by their place in the list, and dated days sort ahead of undated ones.
- **Stops**: each stop belongs to a day and has a name, an optional time and an optional note. Stops sort by time within a day. Tap the circle to mark a stop visited.
- **Removing**: removing a day that has stops asks for a second tap first, then removes the day and its stops together.
- **Trip name and totals**: tap the title to rename the trip. The totals under it are counted from the rows each time, never stored.
- **Starting point**: it opens with a small Lisbon example so it isn't empty. Replace it with your own trip.

It saves as you go. There is no Save button under a host. The kit's small save control only appears if the file is opened straight in a browser. It needs no network.

Stops can't be edited or reordered yet, only added, ticked and removed. I can add editing and drag-to-reorder if you want them.
