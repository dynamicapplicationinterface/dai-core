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
