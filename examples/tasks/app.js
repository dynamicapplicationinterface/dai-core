/*
 * Tasks — a worked example of an application that lives inside its own file.
 *
 * Everything is held in a SQLite database the container provides, and written
 * back into the same document on save. Nothing is kept in browser storage:
 * that belongs to the browser rather than to the file, so a document sent to
 * somebody else would arrive empty.
 *
 * There are no imports and no network calls of any kind, which is what lets
 * this run from a file:// URL with nothing installed.
 */

const dai = window.dai;
const db = await dai.openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id     INTEGER PRIMARY KEY,
    name   TEXT NOT NULL,
    colour TEXT NOT NULL DEFAULT '#3b82f6'
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    priority   INTEGER NOT NULL DEFAULT 1,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    tags       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const PALETTE = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];
const PRIORITIES = { 3: "Urgent", 2: "High", 1: "Normal", 0: "Low" };

const el = (id) => document.getElementById(id);
const ui = {
  projects: el("projects"),
  list: el("list"),
  empty: el("empty"),
  emptyTitle: el("empty-title"),
  emptyNote: el("empty-note"),
  heading: el("heading"),
  subhead: el("subhead"),
  count: el("count"),
  clear: el("clear"),
  save: el("save"),
  saveLabel: el("save-label"),
  toast: el("toast"),
  compose: el("compose"),
  what: el("what"),
  composeProject: el("compose-project"),
  composePriority: el("compose-priority"),
  composeTags: el("compose-tags"),
  swatch: el("swatch"),
  projectName: el("project-name"),
  meterFill: el("meter-fill"),
  meterLabel: el("meter-label"),
  sort: el("sort"),
  engineLabel: el("engine-label"),
};

const view = { project: null, filter: "all", sort: "priority" };
let colour = PALETTE[0];
let dirty = false;

/* ------------------------------------------------------------------ data */

/*
 * `bind` is omitted rather than passed empty: sqlite-wasm reads an empty array
 * as "parameters were promised and not supplied" and throws, which took down
 * the whole app at boot on its very first query.
 */
const query = (sql, bind = []) =>
  bind.length > 0 ? db.selectObjects({ sql, bind }) : db.selectObjects(sql);

const run = (sql, bind = []) => {
  if (bind.length > 0) db.exec({ sql, bind });
  else db.exec(sql);
  markDirty();
};

function visibleTasks() {
  const where = [];
  const bind = [];

  if (view.project !== null) {
    where.push("project_id = ?");
    bind.push(view.project);
  }
  if (view.filter === "active") where.push("done = 0");
  if (view.filter === "done") where.push("done = 1");

  const order = {
    // Unfinished work first within each ordering: a list that buries what is
    // left under what is finished is a list nobody reads twice.
    priority: "done ASC, priority DESC, id DESC",
    added: "done ASC, id DESC",
    alpha: "done ASC, title COLLATE NOCASE ASC",
  }[view.sort];

  return query(
    `SELECT t.*, p.name AS project_name, p.colour AS project_colour
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${order}`,
    bind,
  );
}

/* --------------------------------------------------------------- drawing */

function drawProjects() {
  const projects = query(`
    SELECT p.*, COUNT(t.id) FILTER (WHERE t.done = 0) AS open
      FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
     GROUP BY p.id ORDER BY p.name COLLATE NOCASE
  `);

  const openAll = query("SELECT COUNT(*) AS n FROM tasks WHERE done = 0")[0].n;

  ui.projects.replaceChildren(
    row({ id: null, name: "All tasks", colour: "var(--ink-3)", open: openAll }),
    ...projects.map((project) => row({ ...project, open: project.open ?? 0 })),
  );

  ui.composeProject.replaceChildren(
    option("", "No project"),
    ...projects.map((project) => option(String(project.id), project.name)),
  );

  function row(project) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project" + (view.project === project.id ? " is-active" : "");

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = project.colour;

    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.name;

    const tally = document.createElement("span");
    tally.className = "tally";
    tally.textContent = project.open > 0 ? String(project.open) : "";

    button.append(dot, name, tally);
    button.onclick = () => {
      view.project = project.id;
      draw();
    };

    item.append(button);
    return item;
  }

  function option(value, label) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = label;
    return node;
  }
}

function drawTasks() {
  const tasks = visibleTasks();
  ui.list.replaceChildren(...tasks.map(taskRow));
  ui.empty.hidden = tasks.length > 0;

  if (tasks.length === 0) {
    const messages = {
      all: ["Nothing here yet", "Add your first task above."],
      active: ["All clear", "Everything here is done."],
      done: ["Nothing finished yet", "Completed tasks will collect here."],
    };
    const [title, note] = messages[view.filter];
    ui.emptyTitle.textContent = title;
    ui.emptyNote.textContent = note;
  }
}

function taskRow(task) {
  const item = document.createElement("li");
  item.className = "task" + (task.done ? " is-done" : "");
  item.dataset.priority = String(task.priority);

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "check";
  check.checked = Boolean(task.done);
  check.setAttribute("aria-label", task.title);
  check.onchange = () => {
    run("UPDATE tasks SET done = ? WHERE id = ?", [check.checked ? 1 : 0, task.id]);
    draw();
  };

  const body = document.createElement("div");
  body.className = "task-body";

  const title = document.createElement("p");
  title.className = "task-title";
  title.textContent = task.title;
  title.title = "Double-click to edit";
  title.ondblclick = () => edit(title, task);

  const meta = document.createElement("div");
  meta.className = "meta";

  if (task.priority >= 2) {
    const flag = document.createElement("span");
    flag.className = "flag";
    flag.dataset.priority = String(task.priority);
    flag.textContent = PRIORITIES[task.priority];
    meta.append(flag);
  }

  if (task.project_name) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = task.project_colour;
    dot.style.width = dot.style.height = "7px";
    chip.append(dot, document.createTextNode(task.project_name));
    meta.append(chip);
  }

  for (const tag of splitTags(task.tags)) {
    const chip = document.createElement("span");
    chip.className = "tag";
    chip.textContent = tag;
    meta.append(chip);
  }

  body.append(title, meta);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.setAttribute("aria-label", `Delete ${task.title}`);
  remove.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 6h10M8 6V4.5h4V6M6.5 6l.6 9.5h5.8L13.5 6"/></svg>';
  remove.onclick = () => {
    run("DELETE FROM tasks WHERE id = ?", [task.id]);
    draw();
    say("Task deleted");
  };

  item.append(check, body, remove);
  return item;
}

/** Inline editing, committed on blur or Enter and abandoned on Escape. */
function edit(title, task) {
  const original = task.title;
  title.contentEditable = "true";
  title.focus();
  getSelection()?.selectAllChildren(title);

  const finish = (commit) => {
    title.contentEditable = "false";
    const next = title.textContent.trim();
    if (commit && next && next !== original) {
      run("UPDATE tasks SET title = ? WHERE id = ?", [next, task.id]);
    }
    draw();
  };

  title.onblur = () => finish(true);
  title.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    }
    if (event.key === "Escape") {
      title.textContent = original;
      finish(false);
    }
  };
}

function drawSummary() {
  const { total, done } = query(
    "SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM tasks" +
      (view.project === null ? "" : " WHERE project_id = ?"),
    view.project === null ? [] : [view.project],
  )[0];

  const open = total - done;
  const name =
    view.project === null
      ? "All tasks"
      : (query("SELECT name FROM projects WHERE id = ?", [view.project])[0]?.name ?? "Project");

  ui.heading.textContent = name;
  ui.subhead.textContent =
    total === 0 ? "Nothing planned" : open === 0 ? "All done" : `${open} to do`;

  ui.count.textContent = `${total} ${total === 1 ? "task" : "tasks"}, ${done} done`;
  ui.clear.hidden = done === 0;

  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  ui.meterFill.style.width = `${percent}%`;
  ui.meterLabel.textContent = total === 0 ? "Nothing to do" : `${percent}% complete`;
}

/** Says what is actually holding the data, and how much of the file it takes. */
function drawEngine() {
  const version = query("SELECT sqlite_version() AS v")[0].v;
  const rows =
    query("SELECT COUNT(*) AS n FROM tasks")[0].n + query("SELECT COUNT(*) AS n FROM projects")[0].n;
  const bytes = dai.exportDatabase(db).byteLength;

  ui.engineLabel.textContent =
    `SQLite ${version} · ${rows} ${rows === 1 ? "row" : "rows"} · ` +
    `${Math.max(1, Math.round(bytes / 1024))} KB in this file`;
}

function draw() {
  drawProjects();
  drawTasks();
  drawSummary();
  drawEngine();
}

/* --------------------------------------------------------------- saving */

function markDirty() {
  dirty = true;
  ui.save.classList.add("is-dirty");
  ui.save.classList.remove("is-saved");
  ui.saveLabel.textContent = "Save";
}

async function save() {
  const result = await dai.saveDatabase(db);

  if (result.saved) {
    dirty = false;
    ui.save.classList.remove("is-dirty");
    ui.save.classList.add("is-saved");
    ui.saveLabel.textContent = "Saved";
    say("Saved into this file");
    setTimeout(() => {
      ui.save.classList.remove("is-saved");
      ui.saveLabel.textContent = "Save";
    }, 2200);
    return;
  }

  // Distinguishing these matters: one is the person changing their mind, the
  // other is the file not being writable from where it was opened.
  say(result.method === "cancelled" ? "Save cancelled" : "This file cannot be saved from here");
}

let toastTimer;
function say(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("is-shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("is-shown"), 2400);
}

/* ---------------------------------------------------------------- events */

const splitTags = (value) =>
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

ui.compose.onsubmit = (event) => {
  event.preventDefault();
  const title = ui.what.value.trim();
  if (!title) return;

  run("INSERT INTO tasks (title, priority, project_id, tags) VALUES (?, ?, ?, ?)", [
    title,
    Number(ui.composePriority.value),
    ui.composeProject.value ? Number(ui.composeProject.value) : null,
    splitTags(ui.composeTags.value).join(", "),
  ]);

  ui.what.value = "";
  ui.composeTags.value = "";
  ui.what.focus();
  draw();
};

// Opened on focus rather than by a toggle: the extra fields are wanted often
// enough to be one keystroke away and rarely enough not to sit there always.
ui.what.addEventListener("focus", () => ui.compose.classList.add("is-open"));
ui.compose.addEventListener("focusout", () => {
  if (!ui.compose.contains(document.activeElement) && !ui.what.value.trim()) {
    ui.compose.classList.remove("is-open");
  }
});

el("new-project").onsubmit = (event) => {
  event.preventDefault();
  const name = ui.projectName.value.trim();
  if (!name) return;
  run("INSERT INTO projects (name, colour) VALUES (?, ?)", [name, colour]);
  ui.projectName.value = "";
  colour = PALETTE[(PALETTE.indexOf(colour) + 1) % PALETTE.length];
  ui.swatch.style.background = colour;
  draw();
};

ui.swatch.onclick = () => {
  colour = PALETTE[(PALETTE.indexOf(colour) + 1) % PALETTE.length];
  ui.swatch.style.background = colour;
};

el("filters").onclick = (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  view.filter = button.dataset.filter;
  for (const other of el("filters").children) {
    other.classList.toggle("is-active", other === button);
  }
  drawTasks();
};

ui.sort.onchange = () => {
  view.sort = ui.sort.value;
  drawTasks();
};

ui.clear.onclick = () => {
  const scope = view.project === null ? "" : " AND project_id = ?";
  run(`DELETE FROM tasks WHERE done = 1${scope}`, view.project === null ? [] : [view.project]);
  draw();
  say("Completed tasks cleared");
};

ui.save.onclick = save;

document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);

  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    save();
    return;
  }
  if (event.key === "/" && !typing) {
    event.preventDefault();
    ui.what.focus();
  }
});

// Closing with unsaved changes loses them: the document on disk is the only
// copy, and nothing is written until a save.
window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

/* ------------------------------------------------------------------ boot */

if (query("SELECT COUNT(*) AS n FROM tasks")[0].n === 0) {
  db.exec("INSERT INTO projects (name, colour) VALUES ('Personal', '#10b981')");
  db.exec("INSERT INTO projects (name, colour) VALUES ('Work', '#3b82f6')");
  db.exec(`
    INSERT INTO tasks (title, priority, project_id, tags, done) VALUES
      ('Try editing this — double-click the text', 2, 1, 'tip', 0),
      ('Add a task of your own', 1, 1, '', 0),
      ('Press Save to write it all into this file', 3, 2, 'important', 0),
      ('Open this file again with the wifi off', 1, 2, '', 1);
  `);
}

ui.swatch.style.background = colour;
draw();

// Watched by the fallback notice in index.html, which shows an explanation if
// this file never got the chance to run.
window.__tasksReady = true;
