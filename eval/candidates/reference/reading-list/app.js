const db = await window.dai.openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id       INTEGER PRIMARY KEY,
    title    TEXT NOT NULL,
    author   TEXT NOT NULL DEFAULT '',
    finished INTEGER NOT NULL DEFAULT 0
  )
`);

if (db.selectObjects("SELECT COUNT(*) AS n FROM books")[0].n === 0) {
  db.exec({ sql: "INSERT INTO books (title, author) VALUES (?, ?)", bind: ["The Peregrine", "J. A. Baker"] });
  db.exec({ sql: "INSERT INTO books (title, author, finished) VALUES (?, ?, 1)", bind: ["Piranesi", "Susanna Clarke"] });
}

const books = document.getElementById("books");
const left = document.getElementById("left");
const status = document.getElementById("status");

function draw() {
  const rows = db.selectObjects("SELECT * FROM books ORDER BY finished, id");
  books.textContent = "";

  for (const row of rows) {
    const item = document.createElement("li");
    if (row.finished) item.className = "done";

    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.checked = Boolean(row.finished);
    tick.addEventListener("change", () => {
      db.exec({ sql: "UPDATE books SET finished = ? WHERE id = ?", bind: [tick.checked ? 1 : 0, row.id] });
      draw();
    });

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = row.title;

    const who = document.createElement("span");
    who.className = "who";
    who.textContent = row.author;

    item.append(tick, title, who);
    books.appendChild(item);
  }

  const unread = db.selectObjects("SELECT COUNT(*) AS n FROM books WHERE finished = 0")[0].n;
  left.textContent = unread === 0 ? "Nothing left to read" : `${unread} left to read`;
}

document.getElementById("compose").addEventListener("submit", (event) => {
  event.preventDefault();
  const what = document.getElementById("what");
  const who = document.getElementById("who");
  if (!what.value.trim()) return;

  db.exec({
    sql: "INSERT INTO books (title, author) VALUES (?, ?)",
    bind: [what.value.trim(), who.value.trim()],
  });
  what.value = "";
  who.value = "";
  draw();
});

document.getElementById("save").addEventListener("click", async () => {
  status.textContent = "Saving…";
  const result = await window.dai.saveDatabase(db);
  status.textContent = result.saved ? "Saved into this file" : "Not saved";
});

draw();
