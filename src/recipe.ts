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

THE SCHEMA — declare it once, in schema.sql
Put every CREATE TABLE in a file named schema.sql, each with IF NOT EXISTS. It is run first when the file opens, and its shape is recorded with the file. Do not repeat the CREATE TABLE statements anywhere else.

  --- file: schema.sql
  CREATE TABLE IF NOT EXISTS notes (
    id      INTEGER PRIMARY KEY,
    body    TEXT NOT NULL,
    done    INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL DEFAULT (datetime('now'))
  );

This is what protects the person's data when you change the app later. If a later version changes a table, add a migration — one file, named with the next number, holding the ALTER statements that move the old shape to the new — and update schema.sql to match:

  --- file: migrations/002-add-priority.sql
  ALTER TABLE notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

A version whose schema moved without a migration is refused at build. Do not work around that by dropping tables: the old file holds a month of somebody's entries.

SEED DATA
Insert a few example rows on first run, so the app is not an empty shell when somebody opens it. Make it idempotent, so it does nothing on the second open:

  INSERT INTO notes (body) SELECT 'Try editing this' WHERE NOT EXISTS (SELECT 1 FROM notes);
  INSERT INTO notes (body) SELECT 'Add one of your own' WHERE (SELECT count(*) FROM notes) = 1;

TIMES
Store times as SQLite text in UTC (datetime('now')), and show them the way a person reads them: format with strftime and prefer words — "today", "2 hours ago" — over raw timestamps. Never show 2026-09-04 15:01:27 to a person.

THE SHORTCUT — dai-kit
Every container carries dai-kit.js. It gives you four elements, so most of an application is HTML and SQL rather than code that queries, renders, attaches handlers and redraws. Use it unless the application needs something it cannot express.

  <script type="application/sql">
    -- seed rows only; the tables come from schema.sql
    INSERT INTO tasks (title) SELECT 'Try ticking this' WHERE NOT EXISTS (SELECT 1 FROM tasks);
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

AN ICON
Include a file named icon.svg: a simple, bold mark for this app on a square canvas (viewBox="0 0 100 100"), with a filled background and no text smaller than a third of the canvas. It becomes the app's icon on a phone's home screen and in a browser tab, so it should read at 48 pixels. No external references inside it — a self-contained SVG only.

HOW TO HAND IT OVER
If you can attach files, a zip of the files is best. Otherwise write the whole application as ONE fenced code block — open it with three backticks and the word text, close it with three backticks, and put every file inside it in this shape:

\`\`\`text
dai bundle v1
name: Reading list

--- file: index.html
<!doctype html>
…

--- file: schema.sql
CREATE TABLE IF NOT EXISTS books (…);

--- file: app.js
const db = await window.dai.openDatabase();

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">…</svg>
\`\`\`

One fence around everything, not one per file: the file markers begin with three dashes, and outside a fence a chat window draws them as dividing lines and breaks the application into pieces nobody can copy.

Every file starts with a line reading "--- file: " and its path, at the start of the line. Everything after that line belongs to that file until the next one. If a line inside a file would itself start with "--- file:", put a backslash in front of it.

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
