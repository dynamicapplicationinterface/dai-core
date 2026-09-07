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
export const RECIPE = `HOW TO ANSWER
Content is the kit: HTML with dai-rows, dai-value, dai-form, dai-attach and dai-save, and SQL in the document. The kit
removes the dangerous sinks by construction (no statement built from a value, text-only rendering), so
write the app with it and reach for JavaScript only for what the kit cannot do. Transport is whatever the
channel has: when a tool is available, call it with the files as its arguments; when it is not, write the
files as one text bundle, in the format shown at the end of this recipe. There is no third format.

Write a self-contained application that will be sealed into a DAI container: a single file holding the app, its database and its data, opened by double-clicking, with no server and no installation.

STRUCTURE
- index.html is the entry point. Other files (app.css, app.js) are referenced by relative path.
- Any <script> using top-level await must be type="module", or the app opens blank.

NO NETWORK — this is enforced by the browser, not a guideline
The container declares its permitted connections as none, so anything fetched by URL fails silently and the app breaks in front of whoever opened it, far from the cause.
- No CDN <script> tags. Inline the library, or write the code without it.
- No hosted stylesheets or fonts. Write the CSS inline; use system font stacks.
- No remote images. Use inline SVG, a data: URI, or an emoji.
- No fetch, XMLHttpRequest, WebSocket, EventSource, or sendBeacon.

DATA — the four layers, in the order they run
Every DAI app's data is a SQLite database that lives inside the file. There are exactly four places
data comes from, and each has one job. Get these right and the app keeps a person's data across
opens, across devices, and across the versions you make later.

1. schema.sql — the tables. Every CREATE TABLE, each with IF NOT EXISTS, in one file named schema.sql.
   It runs first, before anything else, and its shape is recorded with the file. Nowhere else may
   create a table. Do not put CREATE TABLE in index.html or in JavaScript.

  --- file: schema.sql
  CREATE TABLE IF NOT EXISTS notes (
    id      INTEGER PRIMARY KEY,
    body    TEXT NOT NULL,
    done    INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL DEFAULT (datetime('now'))
  );

2. Seed rows — a few examples on first open, so the app is not an empty shell. Idempotent, so a
   second open adds nothing. In a <script type="application/sql"> block in index.html, or in
   JavaScript; never in schema.sql.

  <script type="application/sql">
    INSERT INTO notes (body) SELECT 'Try editing this' WHERE NOT EXISTS (SELECT 1 FROM notes);
  </script>

3. Writes — everything the person does goes into the database at the moment they do it: a tick, a
   new row, an edit, a reorder. Never keep the state of the app in a JavaScript variable and write it
   "later". On load, read the database and draw from it; after a write, read again and redraw. The
   database is the state.

4. Saving — automatic. Under the app that opens these files, every write is saved as it happens;
   there is nothing to press. Do NOT build a Save button, a "saved" indicator, or a dirty flag. The
   kit's <dai-save> exists for one case — a file opened straight in a browser with no host, where
   saving takes a tap — and it hides itself everywhere else, so include it once, at the bottom, and
   forget about it. If you write JavaScript against window.dai directly, the same applies: write to
   the database and stop. window.dai.saveDatabase(db) still exists, for the no-host case, and
   calling it under a host is harmless.

STORAGE — use SQLite, not browser storage
localStorage, sessionStorage and IndexedDB belong to the browser rather than to the file, so data kept there does not travel with it: send the document to somebody and it arrives empty. Cookies, the Cache API and the File System API are the same. The database is the only place that travels.

  const db = await window.dai.openDatabase();

  // Parameters are bound, never interpolated.
  db.exec({ sql: "INSERT INTO notes (body) VALUES (?)", bind: ["Buy milk"] });
  db.exec({ sql: "UPDATE notes SET done = :done WHERE id = :id", bind: { ":done": 1, ":id": 3 } });

  // Reads: the SQL, then the parameters. (The {sql, bind} form works here too.)
  const rows = db.selectObjects("SELECT * FROM notes ORDER BY id");
  const one  = db.selectObjects("SELECT * FROM notes WHERE id = ?", [3]);
  const count = db.selectValue("SELECT count(*) FROM notes WHERE done = 0");

Pass bind only when there are parameters: an empty array is read as parameters promised and not supplied, and throws.

Use SQL for the work — joins, aggregates, ORDER BY — rather than loading everything and filtering in JavaScript. It is a real database.

CHANGING THE APP LATER — migrations
The schema's shape is what protects the person's data when you change the app. If a later version changes a table, add a migration — one file, named with the next number, holding the ALTER statements that move the old shape to the new — and update schema.sql to match:

  --- file: migrations/002-add-priority.sql
  ALTER TABLE notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

A version whose schema moved without a migration is refused at build. Do not work around that by dropping tables: the old file holds a month of somebody's entries. Adding a table needs no migration; only a changed one does.

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

  <dai-save>Save</dai-save>   <!-- hides itself under a host; see DATA, 4 -->

  <script type="module" src="./dai-kit.js"></script>

- A form's fields become the :parameters of its statement, by name.
- Inside a row, :parameters come from that row's columns, so a control knows which row it is in.
- data-text writes a column as text. Values are never treated as markup.
- A picture goes in the document, in a BLOB column, so it travels with the file:
  <dai-attach run="UPDATE entries SET photo = :file WHERE id = :id" data-id="1">Add a photo</dai-attach>
  and <img data-blob="photo" alt=""> to show it. :file is the picture, scaled and re-encoded before it is
  stored. Never write a file path or a URL to an image the document does not carry — it will not be there
  on the device the file arrives at.
- Anything the kit cannot express is ordinary JavaScript against window.dai, which is still there.

AN ICON, AND ONE LINE
Include a file named icon.svg: a simple, bold mark for this app on a square canvas (viewBox="0 0 100 100"), with a filled background and no text smaller than a third of the canvas. It becomes the app's icon on a phone's home screen and in a browser tab, so it should read at 48 pixels. No external references inside it — a self-contained SVG only.

In the <head> of index.html, put one line about the app in <meta name="description" content="…">: what it is for, in under 60 characters, the way a store page puts a line under an app's name ("A packing list for the beach trip"). It is shown under the name when somebody is deciding whether to open it, so write it for them, not for a search engine.

Then three lines saying what it does, each in its own tag:

<meta name="dai:does" content="Lists every film and show in the order to watch them">
<meta name="dai:does" content="Tick things off as you watch — it remembers where you got to">
<meta name="dai:does" content="Counts down the days until the next one lands">

Exactly what somebody would tell a friend about it, one thing per line, under 90 characters each, starting with a verb. These are the whole of what the person sees before they open it, so write the three things that would make them want to — not the technology, not the format, not what it cannot do. Three, or none: two is a page with a gap in it.

Beside it, <meta name="theme-color" content="…"> with the app's own background colour.

THE WHOLE SCREEN IS YOURS
The app is drawn edge to edge on a phone — under the status bar at the top and the home indicator at the bottom, the way a phone's own apps are. Nothing is reserved for the host, so nothing is done for you: an app that ignores this puts its own title under the clock.

Four custom properties say how much of each edge is covered. They are set before the app draws, and are zero on a screen with nothing in the way:

  --dai-safe-top, --dai-safe-right, --dai-safe-bottom, --dai-safe-left

The rule is: the app's background fills those strips, and the app's content is pushed clear of them. Colour to the edge, content inside it.

  body { background: #faf7ef; }                                    /* to the edge */
  header { padding-top: calc(16px + var(--dai-safe-top, 0px)); }   /* content clear */
  .bottom-bar { padding-bottom: calc(12px + var(--dai-safe-bottom, 0px)); }

A scrolling page usually needs only two lines of this: padding at the top of whatever is first, and padding at the bottom of whatever is last, so the final row is not under the home indicator. Full-bleed images and colour blocks should run past the edges rather than stop short of them; that is the whole point of having the screen.

Leave the top right corner clear of anything tappable. The host floats one small round button there, over the app, and it is how somebody reaches the menu.

ONE APP, EVERY SCREEN
Do not ask which device it is for, and do not build two of them. An app is sent as a link, and the person who opens it may be on a phone in a message, a tablet, or a desktop browser — the sender does not choose. One layout that holds from about 320px wide to a wide desktop window: a single column that grows, sensible maximum widths on text, tap targets no smaller than 44px, and no fixed pixel widths on anything that holds content. Check it at 390 wide and again at 1280 before handing it over. On a phone the strips under the status bar and the home indicator are painted in it, so the app reaches the edges of the screen instead of sitting in a grey frame.

HOW TO HAND IT OVER
If you can attach files, a zip of the files is best. Otherwise write the whole application as ONE fenced code block — open it with three backticks and the word text, close it with three backticks, and put every file inside it in this shape:

\`\`\`text
dai bundle v1
name: Reading list

--- file: index.html
<!doctype html>
<meta name="description" content="Books to read, and the ones you did">
<meta name="dai:does" content="Keep a list of what you want to read next">
<meta name="dai:does" content="Mark a book finished and see what you got through">
<meta name="dai:does" content="Search by author or title as the list grows">
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
Make it look finished: real spacing, a considered empty state, keyboard support, and a dark mode via prefers-color-scheme. It is a document somebody will keep.

BEFORE YOU ANSWER, CHECK
- Every table is in schema.sql, with IF NOT EXISTS, and nowhere else.
- Seed rows are idempotent (WHERE NOT EXISTS).
- Every user action writes to the database immediately, and the screen is drawn from the database.
- No Save button, no dirty flag, no localStorage. One <dai-save> at the bottom, or none.
- No URL is fetched. No CDN. Every <script> with await is type="module".
- icon.svg exists; index.html has a <meta name="description"> line and three <meta name="dai:does"> lines.
- The background reaches every edge; content near one pads with var(--dai-safe-*, 0px); nothing tappable is in the top right corner.
- One layout, working at 390px wide and at 1280px. No second version for a phone.
- The files are handed over as a tool call or as ONE fenced bundle, in the shape above.`;

/** One line each, for a reader who wants the surface rather than the argument. */
export const API: { call: string; does: string }[] = [
  { call: "await window.dai.openDatabase()", does: "Opens the database inside this file." },
  { call: "db.exec(sql)", does: "Runs one or more statements." },
  {
    call: "db.exec({ sql, bind })",
    does: "Runs a statement with bound parameters. Omit bind when there are none.",
  },
  { call: "db.selectObjects(sql, bind?)", does: "Returns rows as plain objects. bind is an array for ? or an object for :name." },
  { call: "db.selectValue(sql, bind?)", does: "The first column of the first row — a count, a setting, a total." },
  {
    call: "window.dai.autosaves",
    does: "True under a host: every write is saved as it happens, and nothing needs pressing.",
  },
  {
    call: "await window.dai.saveDatabase(db)",
    does: "Saves now. Needed only where there is no host (a file opened straight in a browser). Returns { saved, method }.",
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
