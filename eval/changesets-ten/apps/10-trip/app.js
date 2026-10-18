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
