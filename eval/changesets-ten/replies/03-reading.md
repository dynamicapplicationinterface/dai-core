```text
dai bundle v1
name: Reading list

--- file: schema.sql
-- Reading list
--
-- One table. A book is "next" (on the list), "reading" (in progress) or
-- "done" (finished). Every count on the page is a query over these rows.

CREATE TABLE IF NOT EXISTS books (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'next' CHECK (status IN ('next', 'reading', 'done')),
  note        TEXT NOT NULL DEFAULT '',
  added       TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS books_by_status ON books (status, added);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="What to read next, and what you got through" />
  <meta name="dai:does" content="Keep a list of the books you want to read next" />
  <meta name="dai:does" content="Start a book, then finish it with a note to remember it by" />
  <meta name="dai:does" content="Show how many you have finished and how long ago" />
  <meta name="theme-color" content="#faf6ef" />
  <title>Reading list</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- seed rows; the table is declared in schema.sql
    INSERT INTO books (title, author, status, note, added, finished_at) VALUES
      ('The Remains of the Day', 'Kazuo Ishiguro', 'done', 'Quiet and devastating. Read it again in winter.', datetime('now', '-60 days'), datetime('now', '-12 days')),
      ('Braiding Sweetgrass', 'Robin Wall Kimmerer', 'done', '', datetime('now', '-40 days'), datetime('now', '-3 days')),
      ('Piranesi', 'Susanna Clarke', 'reading', '', datetime('now', '-9 days'), NULL),
      ('The Overstory', 'Richard Powers', 'next', '', datetime('now', '-8 days'), NULL),
      ('Pachinko', 'Min Jin Lee', 'next', '', datetime('now', '-7 days'), NULL),
      ('A Month in the Country', 'J. L. Carr', 'next', '', datetime('now', '-6 days'), NULL);
  </script>

  <main>
    <header>
      <p class="eyebrow">Your shelf</p>
      <h1>Reading list</h1>
      <p class="progress">
        <dai-value query="SELECT count(*) FROM books WHERE status = 'done'"></dai-value>
        finished
        <span aria-hidden="true">&middot;</span>
        <dai-value query="SELECT count(*) FROM books WHERE status = 'next'"></dai-value>
        to go
      </p>
    </header>

    <section aria-labelledby="h-reading">
      <h2 id="h-reading">Reading now</h2>
      <dai-rows
        query="SELECT id, title, author FROM books WHERE status = 'reading' ORDER BY added, title"
        empty="Nothing in progress. Start one from the list below.">
        <template>
          <article class="book">
            <div class="who">
              <span class="title" data-text="title"></span>
              <span class="author" data-text="author" data-when="author"></span>
            </div>
            <div class="actions">
              <button class="primary" data-run="UPDATE books SET status = 'done', finished_at = datetime('now') WHERE id = :id">Finished</button>
              <button class="ghost" data-run="UPDATE books SET status = 'next' WHERE id = :id">Put back</button>
            </div>
          </article>
        </template>
      </dai-rows>
    </section>

    <section aria-labelledby="h-next">
      <h2 id="h-next">Up next</h2>
      <dai-rows
        query="SELECT id, title, author FROM books WHERE status = 'next' ORDER BY added, title"
        empty="The list is empty. Add the next book you hear about.">
        <template>
          <article class="book">
            <div class="who">
              <span class="title" data-text="title"></span>
              <span class="author" data-text="author" data-when="author"></span>
            </div>
            <div class="actions">
              <button class="primary" data-run="UPDATE books SET status = 'reading' WHERE id = :id">Start</button>
              <button class="ghost" data-run="DELETE FROM books WHERE id = :id">Remove</button>
            </div>
          </article>
        </template>
      </dai-rows>

      <dai-form run="INSERT INTO books (title, author) VALUES (:title, :author)">
        <input name="title" placeholder="Title" aria-label="Title" required maxlength="120" />
        <input name="author" placeholder="Author (optional)" aria-label="Author" maxlength="80" />
        <button>Add</button>
      </dai-form>
    </section>

    <section aria-labelledby="h-done">
      <h2 id="h-done">Finished</h2>
      <dai-rows
        query="SELECT id, title, author, note,
                      CASE WHEN d >= 60 THEN (d / 30) || ' months ago'
                           WHEN d >= 30 THEN 'last month'
                           WHEN d >= 2  THEN d || ' days ago'
                           WHEN d >= 1  THEN 'yesterday'
                           ELSE 'today' END AS when_done
               FROM (SELECT id, title, author, note,
                            cast(julianday('now') - julianday(finished_at) AS integer) AS d,
                            finished_at
                       FROM books WHERE status = 'done')
               ORDER BY finished_at DESC, title"
        empty="Nothing finished yet. The first one will show up here.">
        <template>
          <article class="book done">
            <div class="who">
              <span class="title" data-text="title"></span>
              <span class="author" data-text="author" data-when="author"></span>
              <span class="when" data-text="when_done"></span>
              <input class="note" aria-label="Your note on this book" placeholder="Add a note&hellip;" maxlength="300"
                     data-text="note"
                     data-run="UPDATE books SET note = :typed WHERE id = :id" />
            </div>
            <div class="actions">
              <button class="ghost" data-run="UPDATE books SET status = 'reading', finished_at = NULL WHERE id = :id">Read again</button>
              <button class="ghost" data-run="DELETE FROM books WHERE id = :id">Remove</button>
            </div>
          </article>
        </template>
      </dai-rows>
    </section>

    <footer>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./dai-kit.js"></script>
</body>
</html>

--- file: app.css
/* Paper and ink. */
:root {
  --paper: #faf6ef;
  --card: #ffffff;
  --ink: #26211b;
  --muted: #7a6f62;
  --line: #e6dccb;
  --accent: #a4472b;
  --accent-ink: #ffffff;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #1b1814;
    --card: #25211c;
    --ink: #f1e9dc;
    --muted: #a99d8d;
    --line: #38322a;
    --accent: #e08a6b;
    --accent-ink: #1b1814;
  }
}

* { box-sizing: border-box; }

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

/* Color runs to every edge; content is pushed clear of what a phone covers.
   The right side keeps extra room so nothing sits under the host's round
   button in the top right corner. */
main {
  max-width: 600px;
  margin: 0 auto;
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(20px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(20px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 28px;
}

header { display: flex; flex-direction: column; gap: 4px; padding-right: 48px; }

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
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.05;
}

.progress {
  margin: 6px 0 0;
  align-self: flex-start;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}

h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

section { display: flex; flex-direction: column; }

dai-rows {
  display: block;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}

.book {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 12px 14px;
  border-top: 1px solid var(--line);
}

.book:first-child { border-top: 0; }

.who {
  display: flex;
  flex-direction: column;
  flex: 1 1 200px;
  min-width: 0;
  gap: 1px;
}

.title { font-weight: 650; overflow-wrap: anywhere; }
.author { color: var(--muted); font-size: 14px; }
.when { color: var(--muted); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; margin-top: 2px; }

.actions { display: flex; gap: 6px; flex-wrap: wrap; }

button {
  min-height: 44px;
  min-width: 44px;
  padding: 8px 16px;
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: pointer;
}

button.primary,
dai-form button,
dai-save {
  background: var(--accent);
  color: var(--accent-ink);
}

button.ghost {
  background: none;
  border-color: var(--line);
  color: var(--muted);
}

button:hover { filter: brightness(0.95); }

button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.note {
  width: 100%;
  min-height: 44px;
  margin-top: 6px;
  padding: 8px 10px;
  font: inherit;
  font-size: 14px;
  font-style: italic;
  color: var(--ink);
  background: none;
  border: 1px dashed transparent;
  border-radius: 8px;
}

.note:hover,
.note:focus { border-color: var(--line); }
.note::placeholder { color: var(--muted); }

dai-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

dai-form input {
  flex: 1 1 160px;
  min-width: 0;
  min-height: 44px;
  padding: 10px 12px;
  font: inherit;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
}

footer { display: flex; justify-content: flex-end; }

dai-save {
  display: inline-block;
  padding: 12px 22px;
  border-radius: 10px;
  font-weight: 600;
  cursor: pointer;
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#a4472b"/>
  <path d="M50 28c-8-6-20-8-30-6v50c10-2 22 0 30 6z" fill="#faf6ef"/>
  <path d="M50 28c8-6 20-8 30-6v50c-10-2-22 0-30 6z" fill="#f0dcc0"/>
  <path d="M50 28v50" stroke="#a4472b" stroke-width="3"/>
</svg>
```
