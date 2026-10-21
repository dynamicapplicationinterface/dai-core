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
