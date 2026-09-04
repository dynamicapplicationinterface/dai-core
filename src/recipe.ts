/**
 * What an assistant needs to know to write an application that works inside a
 * container.
 *
 * One text, three readers. A person pastes it into ChatGPT; the MCP server
 * hands it to a model as part of a tool description; the website publishes it
 * as documentation. Those had begun to drift apart as separate copies, which
 * would end with a model told one thing by the tool and another by the page.
 *
 * It is written as instructions to a model rather than prose about the format,
 * because that is what it is for. Every rule states the consequence of ignoring
 * it: a model that knows *why* a CDN fails will not reach for one when the
 * instruction is a paragraph further away than usual.
 */

/** The rules, addressed to whoever is writing the code. */
export const RECIPE = `Write a self-contained application that will be sealed into a DAI container: a single file holding the app, its database and its data, opened by double-clicking, with no server and no installation.

STRUCTURE
- index.html is the entry point. Other files (app.css, app.js) are referenced by relative path.
- Any <script> using top-level await must be type="module", or the app opens blank.

NO NETWORK — this is enforced by the browser, not a guideline
The container declares its permitted connections as none, so anything fetched by URL fails silently and the app breaks in front of whoever opened it, far from the cause.
- No CDN <script> tags. Inline the library, or write the code without it.
- No hosted stylesheets or fonts. Write the CSS inline; use system font stacks.
- No remote images. Use inline SVG, a data: URI, or an emoji.
- No fetch, XMLHttpRequest, WebSocket, EventSource, or sendBeacon.

STORAGE — use SQLite, not browser storage
localStorage, sessionStorage and IndexedDB belong to the browser rather than to the file, so data kept there does not travel with it: send the document to somebody and it arrives empty. The container provides a real SQLite database that lives inside the file.

  const db = await window.dai.openDatabase();

  db.exec(\`
    CREATE TABLE IF NOT EXISTS notes (
      id      INTEGER PRIMARY KEY,
      body    TEXT NOT NULL,
      done    INTEGER NOT NULL DEFAULT 0,
      created TEXT NOT NULL DEFAULT (datetime('now'))
    )
  \`);

  // Parameters are bound, never interpolated.
  db.exec({ sql: "INSERT INTO notes (body) VALUES (?)", bind: ["Buy milk"] });

  const rows = db.selectObjects("SELECT * FROM notes ORDER BY id");

  // Writes the database back into the file. Nothing is persisted until this runs.
  const result = await window.dai.saveDatabase(db);
  if (!result.saved) { /* the person cancelled, or the file is not writable here */ }

Pass bind only when there are parameters: an empty array is read as parameters promised and not supplied, and throws.

Use SQL for the work — joins, aggregates, ORDER BY — rather than loading everything and filtering in JavaScript. It is a real database.

SEED DATA
Insert a few example rows on first run, so the app is not an empty shell when somebody opens it:

  if (db.selectObjects("SELECT COUNT(*) AS n FROM notes")[0].n === 0) {
    db.exec("INSERT INTO notes (body) VALUES ('Try editing this'), ('Add one of your own')");
  }

THE SHORTCUT — dai-kit
Every container carries dai-kit.js. It gives you four elements, so most of an application is HTML and SQL rather than code that queries, renders, attaches handlers and redraws. Use it unless the application needs something it cannot express.

  <script type="application/sql">
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0
    );
  </script>

  <dai-value query="SELECT count(*) AS n FROM tasks WHERE done = 0"></dai-value> left

  <dai-form run="INSERT INTO tasks (title) VALUES (:title)">
    <input name="title" required>
    <button type="button">Add</button>
  </dai-form>

  <dai-rows query="SELECT id, title, done FROM tasks ORDER BY id" empty="Nothing to do">
    <template>
      <li>
        <input type="checkbox" data-run="UPDATE tasks SET done = 1 - done WHERE id = :id">
        <span data-text="title"></span>
      </li>
    </template>
  </dai-rows>

  <dai-save>Save</dai-save>

  <script type="module" src="./dai-kit.js"></script>

- A form's fields become the :parameters of its statement, by name.
- Inside a row, :parameters come from that row's columns, so a control knows which row it is in.
- data-text writes a column as text. Values are never treated as markup.
- Anything the kit cannot express is ordinary JavaScript against window.dai, which is still there.

HOW TO HAND IT OVER
Write the whole application as one block of plain text, in this shape, so that whoever receives it does not have to guess where one file ends and the next begins:

dai bundle v1
name: Reading list

--- file: index.html
<!doctype html>
…

--- file: app.js
const db = await window.dai.openDatabase();

Every file starts with a line reading "--- file: " and its path, at the start of the line. Everything after that line belongs to that file until the next one. If a line inside a file would itself start with "--- file:", put a backslash in front of it.

Fenced code blocks with the filename above them are understood too, but the markers are the form that cannot be misread.

FINALLY
Make it look finished: real spacing, a considered empty state, keyboard support, and a dark mode via prefers-color-scheme. It is a document somebody will keep.`;

/** One line each, for a reader who wants the surface rather than the argument. */
export const API: { call: string; does: string }[] = [
  { call: "await window.dai.openDatabase()", does: "Opens the database inside this file." },
  { call: "db.exec(sql)", does: "Runs one or more statements." },
  {
    call: "db.exec({ sql, bind })",
    does: "Runs a statement with bound parameters. Omit bind when there are none.",
  },
  { call: "db.selectObjects(sql)", does: "Returns rows as plain objects." },
  {
    call: "await window.dai.saveDatabase(db)",
    does: "Writes the database back into the file. Returns { saved, method }.",
  },
  { call: "window.dai.exportDatabase(db)", does: "The database as bytes, without saving." },
  { call: "window.dai.documentUuid", does: "This document's identity." },
  { call: "window.dai.signature", does: '"valid", "unsigned" or "invalid" for this container.' },
  {
    call: "window.dai.onAppModeChange(fn)",
    does: "Called when the container enters or leaves full-screen App Mode.",
  },
];

/**
 * The recipe with a line inviting the reader to finish it.
 *
 * Only the paste-it-into-a-chat route needs this: the MCP server's model is
 * already holding the request, and a trailing prompt there would read as an
 * instruction to invent one.
 */
export const RECIPE_AS_PROMPT = `${RECIPE}

The app I want is: `;
