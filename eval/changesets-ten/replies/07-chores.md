```text
dai bundle v1
name: Chore chart

--- file: schema.sql
-- Chore chart
--
-- People, the chores they own, and one row each time a chore is done.
-- Nothing is stored as a total: "done today" and "3 of 5" are read from
-- the completions by the view below and by the queries in index.html.

CREATE TABLE IF NOT EXISTS people (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🙂'
);

CREATE TABLE IF NOT EXISTS chores (
  id        INTEGER PRIMARY KEY,
  title     TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  every     TEXT NOT NULL DEFAULT 'day' CHECK (every IN ('day', 'week'))
);

CREATE TABLE IF NOT EXISTS completions (
  id       INTEGER PRIMARY KEY,
  chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  done_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS completions_by_chore ON completions (chore_id, done_at);

-- A daily chore is done if it was ticked today; a weekly chore if it was
-- ticked since Monday. Times are stored in UTC and compared in local time.
CREATE VIEW IF NOT EXISTS chore_status AS
SELECT
  c.id,
  c.title,
  c.every,
  c.person_id,
  p.name,
  p.emoji,
  CASE WHEN EXISTS (
    SELECT 1 FROM completions k
    WHERE k.chore_id = c.id
      AND date(k.done_at, 'localtime') >= CASE c.every
        WHEN 'day' THEN date('now', 'localtime')
        ELSE date('now', 'localtime', 'weekday 0', '-6 days')
      END
  ) THEN 1 ELSE 0 END AS done
FROM chores c
JOIN people p ON p.id = c.person_id;

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="Who does which chore, ticked off day by day" />
  <meta name="dai:does" content="Give each person their own daily and weekly chores" />
  <meta name="dai:does" content="Tick a chore off and see who is all done for the day" />
  <meta name="dai:does" content="Add people and chores as the household changes" />
  <meta name="theme-color" content="#fbf7ef" />
  <title>Chore chart</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <!--
    Seed rows. This block runs once, when the document is created. The tables
    are declared in schema.sql; ids are left out so the runtime chooses them,
    and chores find their person by name.
  -->
  <script type="application/sql">
    INSERT INTO people (name, emoji) VALUES
      ('Alex', '🦊'),
      ('Sam', '🐼'),
      ('Riley', '🐙');

    INSERT INTO chores (title, person_id, every) VALUES
      ('Make the bed',            (SELECT id FROM people WHERE name = 'Alex'),  'day'),
      ('Feed the cat',            (SELECT id FROM people WHERE name = 'Alex'),  'day'),
      ('Take out the recycling',  (SELECT id FROM people WHERE name = 'Alex'),  'week'),
      ('Set the table',           (SELECT id FROM people WHERE name = 'Sam'),   'day'),
      ('Water the plants',        (SELECT id FROM people WHERE name = 'Sam'),   'week'),
      ('Wipe the bathroom sink',  (SELECT id FROM people WHERE name = 'Sam'),   'week'),
      ('Dishes after dinner',     (SELECT id FROM people WHERE name = 'Riley'), 'day'),
      ('Walk the dog',            (SELECT id FROM people WHERE name = 'Riley'), 'day'),
      ('Vacuum the living room',  (SELECT id FROM people WHERE name = 'Riley'), 'week');

    INSERT INTO completions (chore_id)
      SELECT id FROM chores
      WHERE title IN ('Make the bed', 'Set the table', 'Water the plants');
  </script>

  <p id="opening" class="opening" role="status">Opening…</p>

  <main id="app" hidden inert>
    <header>
      <p class="eyebrow">Household</p>
      <h1>Chore chart</h1>
      <p class="progress">
        <dai-value query="SELECT count(*) FROM chore_status WHERE done = 1"></dai-value>
        of
        <dai-value query="SELECT count(*) FROM chore_status"></dai-value>
        chores done
      </p>
      <p class="hint">Daily chores reset each morning. Weekly chores reset on Monday.</p>
    </header>

    <section aria-labelledby="h-people">
      <h2 id="h-people">Who is doing what</h2>
      <dai-rows id="people-list" empty="Nobody yet. Add the first person below."
        query="SELECT id, emoji, name, done_n, total_n,
                      CASE WHEN total_n > 0 AND done_n = total_n THEN 1 ELSE 0 END AS all_done
               FROM (
                 SELECT p.id, p.emoji, p.name,
                        (SELECT count(*) FROM chore_status s WHERE s.person_id = p.id AND s.done = 1) AS done_n,
                        (SELECT count(*) FROM chore_status s WHERE s.person_id = p.id) AS total_n
                 FROM people p
               )
               ORDER BY name">
        <template>
          <div class="person">
            <span class="avatar" data-text="emoji" aria-hidden="true"></span>
            <input class="pname" aria-label="Name"
              data-text="name"
              data-run="UPDATE people SET name = COALESCE(NULLIF(trim(:typed), ''), name) WHERE id = :id" />
            <span class="tally">
              <span class="star" data-when="all_done">All done 🎉</span>
              <span class="count"><span data-text="done_n"></span> of <span data-text="total_n"></span></span>
            </span>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="h-daily">
      <h2 id="h-daily">Every day</h2>
      <dai-rows empty="No daily chores yet. Add one below."
        query="SELECT id, title, name, emoji, done, 1 - done AS pending
               FROM chore_status
               WHERE every = 'day'
               ORDER BY done, name, title">
        <template>
          <div class="chore">
            <label class="tick" data-when="pending">
              <input type="checkbox"
                data-run="INSERT INTO completions (chore_id) VALUES (:id)" />
              <span class="box" aria-hidden="true"></span>
              <span class="what">
                <span class="t" data-text="title"></span>
                <span class="by"><span data-text="emoji"></span> <span data-text="name"></span></span>
              </span>
            </label>
            <label class="tick is-done" data-when="done">
              <input type="checkbox" checked
                data-run="DELETE FROM completions WHERE chore_id = :id AND date(done_at, 'localtime') >= date('now', 'localtime')" />
              <span class="box" aria-hidden="true"></span>
              <span class="what">
                <span class="t" data-text="title"></span>
                <span class="by"><span data-text="emoji"></span> <span data-text="name"></span> · done</span>
              </span>
            </label>
            <button type="button" class="remove" aria-label="Remove this chore"
              data-run="DELETE FROM chores WHERE id = :id">×</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="h-weekly">
      <h2 id="h-weekly">Once a week</h2>
      <dai-rows empty="No weekly chores yet. Add one below."
        query="SELECT id, title, name, emoji, done, 1 - done AS pending
               FROM chore_status
               WHERE every = 'week'
               ORDER BY done, name, title">
        <template>
          <div class="chore">
            <label class="tick" data-when="pending">
              <input type="checkbox"
                data-run="INSERT INTO completions (chore_id) VALUES (:id)" />
              <span class="box" aria-hidden="true"></span>
              <span class="what">
                <span class="t" data-text="title"></span>
                <span class="by"><span data-text="emoji"></span> <span data-text="name"></span></span>
              </span>
            </label>
            <label class="tick is-done" data-when="done">
              <input type="checkbox" checked
                data-run="DELETE FROM completions WHERE chore_id = :id AND date(done_at, 'localtime') >= date('now', 'localtime', 'weekday 0', '-6 days')" />
              <span class="box" aria-hidden="true"></span>
              <span class="what">
                <span class="t" data-text="title"></span>
                <span class="by"><span data-text="emoji"></span> <span data-text="name"></span> · done this week</span>
              </span>
            </label>
            <button type="button" class="remove" aria-label="Remove this chore"
              data-run="DELETE FROM chores WHERE id = :id">×</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="h-add-chore">
      <h2 id="h-add-chore">Add a chore</h2>
      <dai-form run="INSERT INTO chores (title, person_id, every) VALUES (trim(:title), :person, :every)">
        <input class="wide" name="title" aria-label="Chore" placeholder="Take out the trash…" required maxlength="80" />
        <select id="who" name="person" aria-label="Who does it"></select>
        <select name="every" aria-label="How often">
          <option value="day">Every day</option>
          <option value="week">Once a week</option>
        </select>
        <button type="button">Add</button>
      </dai-form>
    </section>

    <section aria-labelledby="h-add-person">
      <h2 id="h-add-person">Add a person</h2>
      <dai-form run="INSERT INTO people (name, emoji) VALUES (trim(:name), COALESCE(NULLIF(trim(:emoji), ''), '🙂'))">
        <input class="emoji" name="emoji" aria-label="Emoji" placeholder="🙂" maxlength="4" />
        <input class="wide" name="name" aria-label="Name" placeholder="Name" required maxlength="40" />
        <button type="button">Add</button>
      </dai-form>
    </section>

    <footer>
      <button type="button" id="share" class="share">Share this chart</button>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./app.js"></script>
  <script type="module" src="./dai-kit.js"></script>
</body>
</html>

--- file: app.js
// The kit draws and writes everything on the page. This script does the two
// things it cannot: fill the "who does it" menu from the people table, and
// wire the Share button. It holds no state of its own; the database is the state.

const opening = document.getElementById("opening");
const app = document.getElementById("app");

try {
  const db = await window.dai.database();
  const select = document.getElementById("who");
  const peopleList = document.getElementById("people-list");
  let shown = "";

  async function fillPeople() {
    const people = await db.query("SELECT id, emoji, name FROM people ORDER BY name");
    const signature = JSON.stringify(people);
    if (signature === shown) return;
    shown = signature;
    const keep = select.value;
    select.replaceChildren(
      ...people.map((p) => {
        const option = document.createElement("option");
        option.value = String(p.id);
        option.textContent = p.emoji + " " + p.name;
        return option;
      })
    );
    if (people.some((p) => String(p.id) === keep)) select.value = keep;
  }

  await fillPeople();

  // The kit redraws the people list after every write to it; follow it.
  new MutationObserver(() => {
    fillPeople().catch(() => {});
  }).observe(peopleList, { childList: true, subtree: true, characterData: true });

  window.addEventListener("dai:merged", () => {
    fillPeople().catch(() => {});
    if (window.daiKit) window.daiKit.refresh();
  });

  document.getElementById("share").addEventListener("click", () => {
    window.dai.requestShare();
  });

  opening.hidden = true;
  app.hidden = false;
  app.inert = false;
  app.removeAttribute("hidden");
  app.removeAttribute("inert");
} catch (err) {
  opening.textContent =
    "The chart could not open: " +
    (err && err.message ? err.message : String(err)) +
    ". Close this document and open it again.";
  opening.setAttribute("role", "alert");
}

--- file: app.css
/* Warm paper, one orange accent, a green for done. */
:root {
  --paper: #fbf7ef;
  --card: #ffffff;
  --ink: #2a2420;
  --muted: #6f655c;
  --line: #eadfce;
  --accent: #b8481b;
  --accent-ink: #ffffff;
  --done: #2a7d50;
  --soft: #fbe4d6;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #1d1a17;
    --card: #27231f;
    --ink: #f3ebe1;
    --muted: #a99d91;
    --line: #3a342e;
    --accent: #f08a5a;
    --accent-ink: #1d1a17;
    --done: #62c58d;
    --soft: #3b2b21;
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
.opening {
  margin: 0;
  padding: calc(40px + var(--dai-safe-top, 0px)) calc(20px + var(--dai-safe-right, 0px))
    calc(20px + var(--dai-safe-bottom, 0px)) calc(20px + var(--dai-safe-left, 0px));
  color: var(--muted);
}

main {
  max-width: 600px;
  margin: 0 auto;
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(20px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(20px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 24px;
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
  font-weight: 800;
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
  background: var(--soft);
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
}

.hint { margin: 6px 0 0; color: var(--muted); font-size: 14px; max-width: 46ch; }

dai-rows {
  display: block;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  overflow: hidden;
}

/* The kit's empty message, when there are no rows. */
dai-rows:not(:has(*)) { padding: 18px 16px; color: var(--muted); }

/* People */
.person {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 56px;
  padding: 6px 14px;
  border-top: 1px solid var(--line);
}
.person:first-child { border-top: 0; }

.avatar { font-size: 26px; line-height: 1; }

input.pname {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 4px 6px;
  border: 0;
  border-bottom: 1px dashed transparent;
  background: none;
  font: inherit;
  font-weight: 700;
  color: var(--ink);
}
input.pname:hover,
input.pname:focus { outline: none; border-bottom-color: var(--accent); }

.tally { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--muted); white-space: nowrap; }
.star { font-size: 12px; font-weight: 700; color: var(--done); }

/* Chores */
.chore {
  display: flex;
  align-items: center;
  border-top: 1px solid var(--line);
}
.chore:first-child { border-top: 0; }

.tick {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 8px 6px 8px 14px;
  cursor: pointer;
}

.tick input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}

.box {
  flex: none;
  width: 28px;
  height: 28px;
  border: 2px solid var(--muted);
  border-radius: 999px;
  display: grid;
  place-items: center;
}

.tick:hover .box { border-color: var(--accent); }
.tick input:focus-visible + .box { outline: 3px solid var(--accent); outline-offset: 2px; }

.is-done .box { background: var(--done); border-color: var(--done); }
.is-done .box::after {
  content: "";
  width: 7px;
  height: 13px;
  margin-top: -2px;
  border: solid var(--paper);
  border-width: 0 3px 3px 0;
  transform: rotate(45deg);
}

.what { display: flex; flex-direction: column; min-width: 0; }
.t { font-weight: 600; overflow-wrap: anywhere; }
.by { font-size: 13px; color: var(--muted); }
.is-done .t { color: var(--muted); text-decoration: line-through; }

.remove {
  flex: none;
  width: 44px;
  height: 44px;
  margin-right: 6px;
  border: 0;
  border-radius: 12px;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 22px;
  cursor: pointer;
}
.remove:hover { color: var(--accent); background: var(--soft); }
.remove:focus-visible { outline: 3px solid var(--accent); outline-offset: -3px; }

/* Forms */
dai-form { display: flex; flex-wrap: wrap; gap: 8px; }

dai-form input,
dai-form select {
  flex: 1 1 8em;
  min-width: 0;
  min-height: 44px;
  padding: 10px 12px;
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
  color: var(--ink);
}
dai-form input.wide { flex: 1 1 14em; }
dai-form input.emoji { flex: 0 0 4.5em; text-align: center; }
dai-form input:focus,
dai-form select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }

dai-form button,
dai-save,
.share {
  min-height: 44px;
  padding: 10px 18px;
  font: inherit;
  font-weight: 700;
  border: 0;
  border-radius: 12px;
  background: var(--accent);
  color: var(--accent-ink);
  cursor: pointer;
}

.share { background: var(--soft); color: var(--accent); }

footer { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
dai-save { display: inline-block; }

button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

/* On a wide window, a card on a quieter ground. */
@media (min-width: 720px) {
  html, body { background: color-mix(in srgb, var(--paper) 90%, var(--ink)); }
  main {
    margin: 40px auto;
    padding: 32px 32px 36px;
    background: var(--paper);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.05), 0 24px 60px -20px rgb(0 0 0 / 0.25);
  }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- A checklist: three rows, the first two ticked. -->
  <rect width="100" height="100" rx="22" fill="#d9602f"/>
  <rect x="20" y="20" width="60" height="60" rx="12" fill="#fbf7ef"/>
  <path d="M28 36l5 5 9-10" fill="none" stroke="#2a7d50" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M28 54l5 5 9-10" fill="none" stroke="#2a7d50" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="35" cy="70" r="6" fill="none" stroke="#b8481b" stroke-width="4"/>
  <path d="M50 36h22M50 54h22M50 70h22" stroke="#2a2420" stroke-width="5" stroke-linecap="round"/>
</svg>
```
