Here is a family chore chart. Everyone adds themselves, chores are given to a person (or to anyone), set to daily or weekly, and ticked off with one tap. The top of the page shows how far each person is through their chores this week.

I built it as a document that can be passed around, not a single-person one, because a family chart only works if the kids' ticks and the parents' edits all survive when copies meet. It is not a closed two-person session, since a family is usually bigger than two and there is no way yet to seat a third person. That means anyone holding a copy can add chores and tick them off. Open it in the DAI opener to make changes; opened straight in a browser it will show the chart but refuse to save ticks, and it says so.

Which person's chores you are looking at is kept on your own copy only, so one person filtering to their own list does not change anyone else's screen. If two people edit the same chore before their copies meet, the chore shows "Changed twice" and you pick which version to keep.

```text
dai bundle v1
name: Family chores

--- file: schema.sql
-- Family chores · shape: passable
--
-- The decision: several people in one family add chores and tick them off,
-- each on their own phone, and the document is handed around so that every
-- copy's changes are kept. A family is more than two people and has no
-- fixed roster, so this is passable, not a session.
--
-- What that costs, and why:
--   * members, chores and completions are shared. They are written through
--     window.dai.replicated and read through the _current views.
--   * No PRIMARY KEY, UNIQUE or CHECK on them. A chore's identity is its
--     entity. Two people ticking the same chore on the same day is two
--     completions; the page counts the chore as done once.
--   * Nothing derived is stored: whether a chore is done, and each person's
--     progress this week, are computed from the completions every time.
--   * A completion is a fact somebody entered (the day it was done), not a
--     record of when the row was written.
--   * Which person the screen is filtered to is about this copy, so it is
--     local.

-- dai:replicated
CREATE TABLE IF NOT EXISTS members (
  name TEXT NOT NULL
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS chores (
  title     TEXT NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',   -- the members row's entity, as hex; '' for anyone
  cadence   TEXT NOT NULL                 -- 'daily' or 'weekly'
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS completions (
  chore_id TEXT NOT NULL,                 -- the chores row's entity, as hex
  done_on  TEXT NOT NULL                  -- the day it was done, YYYY-MM-DD
);

-- Local: never merged. May use keys and checks freely.
CREATE TABLE IF NOT EXISTS settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  view TEXT NOT NULL DEFAULT 'all'        -- 'all', or a member's entity as hex
);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Chores for the whole family, ticked off as they get done" />
  <meta name="dai:does" content="Give each chore to someone and set it to daily or weekly" />
  <meta name="dai:does" content="Tick chores off and see who is on track this week" />
  <meta name="dai:does" content="Hand the chart around so everyone's ticks are kept" />
  <meta name="theme-color" content="#fbf7ee" />
  <title>Family chores</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Local seed only. Shared rows are never seeded with SQL.
    INSERT OR IGNORE INTO settings (id) VALUES (1);
  </script>

  <!-- Nothing to type into until app.js has started: a form on screen before
       then takes typing the app cannot handle yet, and loses it. -->
  <p id="opening" class="opening" role="status">Opening…</p>

  <main id="app" hidden inert>
    <header>
      <h1>Family chores</h1>
      <button id="share" type="button" class="quiet">Share</button>
    </header>

    <p id="notice" class="notice" role="status" hidden></p>

    <section id="week" class="week" aria-live="polite" hidden>
      <h2>This week</h2>
      <ul id="progress" class="progress-list"></ul>
    </section>

    <nav id="chips" class="chips" aria-label="Whose chores" hidden></nav>

    <section>
      <h2 id="list-title">Chores</h2>
      <ul id="list" class="list"></ul>
      <p id="empty" class="empty" hidden></p>
    </section>

    <form id="entry" class="card" autocomplete="off">
      <h2 id="entry-title">Add a chore</h2>
      <div class="fields">
        <label class="wide">Chore <input id="title" required maxlength="80" placeholder="e.g. Empty the dishwasher" /></label>
        <label>Whose <select id="who"></select></label>
        <label>How often
          <select id="cadence">
            <option value="daily">Every day</option>
            <option value="weekly">Once a week</option>
          </select>
        </label>
      </div>
      <div class="actions">
        <button id="save-entry" type="submit">Add</button>
        <button id="cancel-edit" type="button" class="quiet" hidden>Cancel</button>
      </div>
    </form>

    <section class="card">
      <h2>Family</h2>
      <ul id="people" class="people"></ul>
      <p id="no-people" class="empty" hidden>Add everyone who has chores, starting with yourself.</p>
      <form id="add-person" class="row" autocomplete="off">
        <input id="person" required maxlength="30" placeholder="Name" aria-label="Name" />
        <button type="submit">Add</button>
      </form>
    </section>

    <dialog id="conflict">
      <h2>Changed on two copies</h2>
      <p>This chore was edited on both copies before they met. Keep the version that is right.</p>
      <ul id="versions" class="versions"></ul>
      <button id="conflict-close" type="button" class="quiet">Decide later</button>
    </dialog>
  </main>

  <script type="module" src="./app.js"></script>
</body>
</html>

--- file: app.js
// Family chores — a passable document. Shared rows are written through
// window.dai.replicated and read from the _current views; whether a chore is
// done and each person's progress are derived, never stored; a merge redraws;
// a conflict is shown, not decided silently.

const $ = (id) => document.getElementById(id);
let db; // opened by the start-up at the end of this file
const shared = window.dai.replicated;

/** The entity of the chore being edited, or null when adding. */
let editing = null;

const rows = (sql, bind) => (bind === undefined ? db.selectObjects(sql) : db.selectObjects(sql, bind));

// ---- days ---------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayYmd = () => ymd(new Date());

/** Monday of this week, and how many days of the week have begun (1 to 7). */
function thisWeek() {
  const now = new Date();
  const sinceMonday = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday);
  return { start: ymd(monday), elapsed: sinceMonday + 1 };
}

function dayWords(ymdText) {
  const [y, m, d] = ymdText.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  return day.toLocaleDateString("en-US", { weekday: "long" });
}

// ---- small helpers ------------------------------------------------------

function say(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}

/** Runs a shared write and says what went wrong, rather than failing silently. */
function write(fn) {
  try {
    const result = fn();
    say("");
    return result ?? true;
  } catch (error) {
    const message = String(error?.message ?? error);
    say(
      message.startsWith("WRITE_SURFACE_UNAVAILABLE")
        ? "Open this document in the DAI opener to add or change anything."
        : `That did not save: ${message}`,
    );
    return false;
  }
}

function button(label, onClick, className = "quiet") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// ---- reading ------------------------------------------------------------

const getView = () => rows("SELECT view FROM settings WHERE id = 1")[0]?.view ?? "all";

function members() {
  return rows("SELECT lower(hex(_r_entity)) AS id, name FROM members_current ORDER BY name COLLATE NOCASE, _r_lc");
}

function chores() {
  return rows(
    `SELECT lower(hex(_r_entity)) AS id, title, member_id, cadence, _r_conflicted AS conflicted
       FROM chores_current ORDER BY title COLLATE NOCASE`,
  );
}

/** Completions since the start of this week, for working out what is done. */
function completionsThisWeek() {
  return rows(
    "SELECT lower(hex(_r_entity)) AS id, chore_id, done_on FROM completions_current WHERE done_on >= ?",
    [thisWeek().start],
  );
}

/** The completions that count a chore as done right now: today for daily, this week for weekly. */
function doneNow(chore, completions) {
  const since = chore.cadence === "daily" ? todayYmd() : thisWeek().start;
  return completions.filter((c) => c.chore_id === chore.id && c.done_on >= since);
}

// ---- drawing ------------------------------------------------------------

function drawChips(people) {
  const nav = $("chips");
  nav.replaceChildren();
  nav.hidden = people.length === 0;
  const view = getView();
  const make = (label, value) => {
    const b = button(label, () => {
      // Local table: an ordinary UPDATE is right here.
      db.exec({ sql: "UPDATE settings SET view = ? WHERE id = 1", bind: [value] });
      draw();
    }, "chip");
    b.setAttribute("aria-pressed", String(view === value));
    return b;
  };
  nav.append(make("Everyone", "all"), ...people.map((p) => make(p.name, p.id)));
}

function drawWeek(people, allChores, completions) {
  const { start, elapsed } = thisWeek();
  const list = $("progress");
  list.replaceChildren();
  const groups = people.map((p) => ({ name: p.name, id: p.id }));
  if (allChores.some((c) => !people.some((p) => p.id === c.member_id))) {
    groups.push({ name: "Anyone", id: "" });
  }
  let any = false;
  for (const g of groups) {
    const mine = allChores.filter((c) =>
      g.id === "" ? !people.some((p) => p.id === c.member_id) : c.member_id === g.id,
    );
    if (mine.length === 0) continue;
    let expected = 0;
    let done = 0;
    for (const chore of mine) {
      const days = new Set(
        completions.filter((c) => c.chore_id === chore.id && c.done_on >= start).map((c) => c.done_on),
      );
      if (chore.cadence === "daily") {
        expected += elapsed;
        done += Math.min(days.size, elapsed);
      } else {
        expected += 1;
        done += days.size > 0 ? 1 : 0;
      }
    }
    any = true;
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = g.name;
    const meter = document.createElement("progress");
    meter.max = expected;
    meter.value = done;
    meter.setAttribute("aria-label", `${g.name}: ${done} of ${expected}`);
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${done} of ${expected}`;
    item.append(label, meter, count);
    list.append(item);
  }
  $("week").hidden = !any;
}

function drawList(people, allChores, completions) {
  const view = getView();
  const names = new Map(people.map((p) => [p.id, p.name]));
  const shown = allChores
    .filter((c) => view === "all" || c.member_id === view)
    .map((c) => ({ ...c, owner: names.get(c.member_id) ?? "" }))
    .sort((a, b) => {
      if (a.owner === "" && b.owner !== "") return 1;
      if (b.owner === "" && a.owner !== "") return -1;
      return a.owner.localeCompare(b.owner) || a.cadence.localeCompare(b.cadence) || a.title.localeCompare(b.title);
    });

  $("list-title").textContent =
    view === "all" ? "Chores" : `${names.get(view) ?? "Chores"}'s chores`;

  const list = $("list");
  list.replaceChildren();
  const empty = $("empty");
  if (shown.length === 0) {
    empty.hidden = false;
    empty.textContent =
      people.length === 0
        ? "Start by adding your family below, then add the first chore."
        : view === "all"
          ? "No chores yet. Add the first one below."
          : "Nothing for this person yet.";
  } else {
    empty.hidden = true;
  }

  for (const chore of shown) {
    const done = doneNow(chore, completions);
    const isDone = done.length > 0;
    const item = document.createElement("li");
    item.className = "chore" + (isDone ? " done" : "") + (chore.conflicted ? " conflicted" : "");

    const tick = document.createElement("button");
    tick.type = "button";
    tick.className = "tick";
    tick.setAttribute("aria-pressed", String(isDone));
    tick.setAttribute("aria-label", `${chore.title}: ${isDone ? "done, tap to undo" : "tap when done"}`);
    tick.textContent = isDone ? "✓" : "";
    tick.addEventListener("click", () => toggle(chore));

    const text = document.createElement("div");
    text.className = "text";
    const title = document.createElement("strong");
    title.textContent = chore.title;
    const meta = document.createElement("span");
    const latest = done.map((c) => c.done_on).sort().pop();
    meta.textContent = [
      chore.owner || "Anyone",
      chore.cadence === "daily" ? "every day" : "once a week",
      isDone && chore.cadence === "weekly" ? `done ${dayWords(latest)}` : isDone ? "done today" : "",
    ].filter(Boolean).join(" · ");
    text.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (chore.conflicted) {
      actions.append(button("Changed twice — choose", () => openConflict(chore.id), "warn"));
    }
    actions.append(
      button("Edit", () => startEdit(chore)),
      button("Delete", () => {
        if (write(() => shared.remove("chores", chore.id))) draw();
      }),
    );

    item.append(tick, text, actions);
    list.append(item);
  }
}

function drawPeople(people) {
  const list = $("people");
  list.replaceChildren();
  $("no-people").hidden = people.length > 0;
  for (const p of people) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = p.name;
    item.append(name, button("Remove", () => removePerson(p)));
    list.append(item);
  }
}

/** Rebuilds the "Whose" choices without losing what is selected in the form. */
function drawWhoOptions(people) {
  const select = $("who");
  const keep = select.value;
  select.replaceChildren();
  const anyone = document.createElement("option");
  anyone.value = "";
  anyone.textContent = "Anyone";
  select.append(anyone);
  for (const p of people) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    select.append(o);
  }
  if ([...select.options].some((o) => o.value === keep)) select.value = keep;
}

function draw() {
  const people = members();
  const allChores = chores();
  const completions = completionsThisWeek();
  // A filter on a person who has since been removed falls back to everyone.
  if (getView() !== "all" && !people.some((p) => p.id === getView())) {
    db.exec("UPDATE settings SET view = 'all' WHERE id = 1");
  }
  drawChips(people);
  drawWeek(people, allChores, completions);
  drawList(people, allChores, completions);
  drawPeople(people);
  drawWhoOptions(people);
}

// ---- acting -------------------------------------------------------------

/** Ticks a chore off, or takes the tick back. Reads the state now, not when it was drawn. */
function toggle(chore) {
  const current = doneNow(chore, completionsThisWeek());
  write(() => {
    if (current.length > 0) {
      for (const c of current) shared.remove("completions", c.id);
    } else {
      shared.insert("completions", { chore_id: chore.id, done_on: todayYmd() });
    }
  });
  draw();
}

function removePerson(person) {
  if (write(() => shared.remove("members", person.id))) draw();
}

$("add-person").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("person").value.trim();
  if (!name) return;
  if (write(() => shared.insert("members", { name }))) {
    $("person").value = "";
    draw();
  }
});

function resetForm() {
  editing = null;
  $("entry").reset();
  $("entry-title").textContent = "Add a chore";
  $("save-entry").textContent = "Add";
  $("cancel-edit").hidden = true;
}

function startEdit(chore) {
  editing = chore.id;
  $("title").value = chore.title;
  $("who").value = chore.member_id;
  $("cadence").value = chore.cadence;
  $("entry-title").textContent = "Edit chore";
  $("save-entry").textContent = "Save changes";
  $("cancel-edit").hidden = false;
  $("title").focus();
}

$("entry").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = {
    title: $("title").value.trim(),
    member_id: $("who").value,
    cadence: $("cadence").value,
  };
  if (!values.title) return;
  // change() takes every column, not only the ones that changed.
  const ok = write(() =>
    editing ? shared.change("chores", editing, values) : shared.insert("chores", values),
  );
  if (ok) {
    resetForm();
    draw();
  }
});

$("cancel-edit").addEventListener("click", () => resetForm());

$("share").addEventListener("click", () => window.dai.requestShare());

// ---- conflicts ----------------------------------------------------------

function openConflict(entity) {
  // The competing versions are the current heads of this chore. A tombstone
  // among them means the other copy deleted it while this one edited it.
  const names = new Map(members().map((p) => [p.id, p.name]));
  const versions = rows(
    `SELECT title, member_id, cadence, _r_deleted AS deleted
       FROM chores_heads WHERE lower(hex(_r_entity)) = ?
      ORDER BY _r_lc DESC`,
    [entity],
  );
  const list = $("versions");
  list.replaceChildren();
  for (const v of versions) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = v.deleted
      ? "Deleted on one copy"
      : `${v.title} · ${names.get(v.member_id) ?? "Anyone"} · ${v.cadence === "daily" ? "every day" : "once a week"}`;
    item.append(
      text,
      button(v.deleted ? "Delete it" : "Keep this", () => {
        // Writing the choice settles the conflict: a change or a remove names
        // every current version as its parent.
        const ok = write(() =>
          v.deleted
            ? shared.remove("chores", entity)
            : shared.change("chores", entity, { title: v.title, member_id: v.member_id, cadence: v.cadence }),
        );
        if (ok) {
          $("conflict").close();
          draw();
        }
      }),
    );
    list.append(item);
  }
  $("conflict").showModal();
}

$("conflict-close").addEventListener("click", () => $("conflict").close());

// ---- the other copy's rows ----------------------------------------------

/*
 * Never redraw under a finger (SHARED-POINTER-HOLDS-THE-SCREEN).
 *
 * A merge can arrive at any moment, and a redraw replaces what was pressed. If
 * it lands between a press and its release, the browser fires no click at all
 * and the tap is lost with nothing said. So while a pointer is down, what a
 * merge would do waits, and happens when the pointer lifts, after that
 * release's click.
 */
let pointerDown = false;
const afterPointer = [];
document.addEventListener("pointerdown", () => {
  pointerDown = true;
}, true);
for (const type of ["pointerup", "pointercancel"]) {
  document.addEventListener(type, () => {
    pointerDown = false;
    setTimeout(() => {
      if (pointerDown) return;
      for (const run of afterPointer.splice(0)) run();
    }, 0);
  }, true);
}
const whenPointerLifts = (run) => (pointerDown ? afterPointer.push(run) : run());

// Nothing else says the other person's rows arrived. The forms are written
// once in the HTML and draw() never rebuilds them, so what is being typed
// survives the redraw.
window.addEventListener("dai:merged", () => whenPointerLifts(() => {
  if (db) draw();
}));

// Start-up (NO-INPUT-LOST-WHILE-OPENING): nothing can be typed into until this
// has finished, and if it fails the person is told, not left at "Opening…".
try {
  db = await window.dai.openDatabase();
  resetForm();
  draw();
  $("opening").hidden = true;
  $("app").hidden = false;
  $("app").inert = false;
} catch (error) {
  $("opening").classList.add("failed");
  $("opening").textContent =
    `The chart could not be opened: ${error?.message ?? error}. ` +
    "Try opening the document again in the DAI opener, or ask whoever sent it for a new copy.";
}

--- file: app.css
:root {
  color-scheme: light dark;
  --bg: #fbf7ee;
  --card: #ffffff;
  --ink: #2a2620;
  --muted: #7a7164;
  --line: #e8dfcc;
  --accent: #d9731a;
  --on-accent: #ffffff;
  --done: #3f8a56;
  --warn: #a8480a;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1713; --card: #25211b; --ink: #f1ebdf; --muted: #a79d8b; --line: #38322a;
    --accent: #f0a05a; --on-accent: #1a1713; --done: #7fcf98; --warn: #f0b35a;
  }
}
* { box-sizing: border-box; }
/* A display rule below would otherwise show what the page hid. */
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--ink); line-height: 1.45; }
main {
  max-width: 640px;
  margin: 0 auto;
  padding: calc(20px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(16px + var(--dai-safe-left, 0px));
  display: grid;
  gap: 24px;
}
/* The top right corner belongs to the host's menu button. */
header { display: flex; align-items: center; gap: 12px; padding-right: 56px; }
h1 { margin: 0; font-size: 28px; flex: 1; letter-spacing: -0.01em; }
h2 { font-size: 13px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.card h2 { margin-bottom: 12px; }
input, select {
  font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line);
  border-radius: 10px; padding: 8px 12px; min-height: 44px; width: 100%;
}
button {
  font: inherit; min-height: 44px; padding: 0 16px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent);
}
button.quiet { background: transparent; color: var(--accent); }
button.warn { background: transparent; color: var(--warn); border-color: var(--warn); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.opening {
  margin: 0; color: var(--muted);
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px)) 0 calc(16px + var(--dai-safe-left, 0px));
  text-align: center;
}
.opening.failed { color: var(--ink); text-align: left; max-width: 36em; margin: 0 auto; }
.notice { margin: 0; background: var(--card); border-left: 4px solid var(--warn); padding: 10px 12px; border-radius: 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
.week { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
.progress-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.progress-list li { display: grid; grid-template-columns: minmax(4em, 8em) 1fr auto; align-items: center; gap: 12px; }
.progress-list .count { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 14px; }
progress { width: 100%; height: 12px; accent-color: var(--done); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 999px; }
.chip[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.chore {
  display: grid; grid-template-columns: 52px 1fr; gap: 6px 12px; align-items: center;
  background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 10px 14px 10px 10px;
}
.chore.conflicted { border-color: var(--warn); }
.tick {
  width: 52px; height: 52px; padding: 0; border-radius: 999px; font-size: 26px; line-height: 1;
  background: transparent; color: var(--on-accent); border: 3px solid var(--line);
}
.chore.done .tick { background: var(--done); border-color: var(--done); }
.chore.done .text strong { color: var(--muted); text-decoration: line-through; }
.text { display: grid; gap: 2px; min-width: 0; }
.text strong { overflow-wrap: anywhere; }
.text span { color: var(--muted); font-size: 14px; }
.row-actions { grid-column: 2; display: flex; flex-wrap: wrap; gap: 6px; }
.row-actions button { min-height: 44px; }
.empty { margin: 0; color: var(--muted); }
.fields { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.fields label { display: grid; gap: 6px; font-size: 14px; color: var(--muted); }
.fields .wide { grid-column: 1 / -1; }
.actions { display: flex; gap: 8px; margin-top: 14px; }
.people { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 4px; }
.people li { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.row { display: flex; gap: 8px; }
dialog { background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 14px; max-width: min(520px, 92vw); padding: 20px; }
dialog::backdrop { background: rgb(0 0 0 / 0.4); }
.versions { list-style: none; padding: 0; display: grid; gap: 8px; }
.versions li { display: flex; justify-content: space-between; align-items: center; gap: 10px; }

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#d9731a"/><rect x="22" y="20" width="56" height="60" rx="8" fill="#fbf7ee"/><g fill="none" stroke="#3f8a56" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M32 38l5 5 9-10"/><path d="M32 62l5 5 9-10"/></g><g stroke="#d9731a" stroke-width="6" stroke-linecap="round"><path d="M56 38h14M56 62h14"/></g></svg>
```
