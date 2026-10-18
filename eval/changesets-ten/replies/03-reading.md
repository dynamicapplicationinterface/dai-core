I built this as a solo document: a reading list for one person, kept on one device, so nothing in it is shared or merged. It uses only the kit, so there is no JavaScript of its own. You add a book, start it, mark it finished, or remove it. The list is in three groups: Up next, Reading now and Finished. A count at the top shows how many you have finished. There is a dark mode, and the layout holds from phone to desktop. I haven't run it. I only checked it against the rules.

```text
dai bundle v1
name: Reading list

--- file: schema.sql
-- Reading list · shape: solo
--
-- The decision: one person's list of books, kept on one device. Nobody else
-- adds to it and no second copy's changes need keeping, so nothing is shared:
-- ordinary tables, written with the kit, keys and all. If it is sent to
-- someone, they get their own copy to write in.

CREATE TABLE IF NOT EXISTS books (
  id     INTEGER PRIMARY KEY,
  title  TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'next' CHECK (status IN ('next', 'reading', 'done')),
  added  TEXT NOT NULL DEFAULT (datetime('now'))
);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Books to read next, and the ones you finished" />
  <meta name="dai:does" content="Keep a list of the books you want to read next" />
  <meta name="dai:does" content="Move a book to reading now, then mark it finished" />
  <meta name="dai:does" content="Show how many books you have finished" />
  <meta name="theme-color" content="#f6f1e7" />
  <title>Reading list</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Local seed rows, fixed ids, so a second open adds nothing.
    INSERT OR IGNORE INTO books (id, title, author, status) VALUES
      (1, 'Middlemarch', 'George Eliot', 'reading'),
      (2, 'Pride and Prejudice', 'Jane Austen', 'next'),
      (3, 'Frankenstein', 'Mary Shelley', 'next'),
      (4, 'The Great Gatsby', 'F. Scott Fitzgerald', 'done');
  </script>

  <!-- A page built only from the kit's elements is safe while it starts:
       none of them is a <form>, so nothing submits before the kit is ready. -->
  <main>
    <header>
      <h1>Reading list</h1>
      <p class="progress">
        <dai-value query="SELECT count(*) FROM books WHERE status = 'done'"></dai-value>
        finished ·
        <dai-value query="SELECT count(*) FROM books WHERE status != 'done'"></dai-value>
        to go
      </p>
    </header>

    <dai-form run="INSERT INTO books (title, author) VALUES (:title, :author)" class="add">
      <input name="title" aria-label="Title" placeholder="Title" required maxlength="120" />
      <input name="author" aria-label="Author" placeholder="Author (optional)" maxlength="80" />
      <button>Add</button>
    </dai-form>

    <section>
      <h2>Reading now</h2>
      <dai-rows query="SELECT id, title, author FROM books WHERE status = 'reading' ORDER BY id" empty="Nothing in hand. Start a book from Up next.">
        <template>
          <div class="book">
            <div class="what">
              <strong data-text="title"></strong>
              <span data-text="author"></span>
            </div>
            <div class="acts">
              <button data-run="UPDATE books SET status = 'done' WHERE id = :id">Finished</button>
              <button class="quiet" data-run="UPDATE books SET status = 'next' WHERE id = :id">Put back</button>
            </div>
          </div>
        </template>
      </dai-rows>
    </section>

    <section>
      <h2>Up next</h2>
      <dai-rows query="SELECT id, title, author FROM books WHERE status = 'next' ORDER BY id" empty="Nothing waiting. Add a book above.">
        <template>
          <div class="book">
            <div class="what">
              <strong data-text="title"></strong>
              <span data-text="author"></span>
            </div>
            <div class="acts">
              <button data-run="UPDATE books SET status = 'reading' WHERE id = :id">Start</button>
              <button class="quiet" data-run="DELETE FROM books WHERE id = :id">Remove</button>
            </div>
          </div>
        </template>
      </dai-rows>
    </section>

    <section>
      <h2>Finished</h2>
      <dai-rows query="SELECT id, title, author FROM books WHERE status = 'done' ORDER BY id DESC" empty="No finished books yet.">
        <template>
          <div class="book">
            <div class="what">
              <strong data-text="title"></strong>
              <span data-text="author"></span>
            </div>
            <div class="acts">
              <button class="quiet" data-run="UPDATE books SET status = 'next' WHERE id = :id">Read again</button>
              <button class="quiet" data-run="DELETE FROM books WHERE id = :id">Remove</button>
            </div>
          </div>
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
:root {
  color-scheme: light dark;
  --bg: #f6f1e7;
  --card: #ffffff;
  --ink: #2a2118;
  --muted: #7a6c5a;
  --line: #e4dac8;
  --accent: #8a3b2b;
  font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1814; --card: #272019; --ink: #efe6d6; --muted: #b3a48e; --line: #3a3126; --accent: #e59a85; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { line-height: 1.45; }
main {
  max-width: 600px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: calc(24px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px))
    calc(32px + var(--dai-safe-bottom, 0px)) calc(16px + var(--dai-safe-left, 0px));
}
/* The top right corner belongs to the host's menu button. */
header { padding-right: 56px; }
h1 { margin: 0; font-size: 32px; letter-spacing: -0.01em; }
h2 {
  margin: 0 0 8px; font-size: 13px; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--muted);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
.progress { margin: 6px 0 0; color: var(--muted); }
button, input {
  font: inherit; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 16px;
}
input {
  min-height: 44px; padding: 8px 12px; width: 100%; min-width: 0;
  color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 10px;
}
button {
  min-height: 44px; padding: 0 16px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: var(--bg);
}
button.quiet { background: transparent; color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
dai-form.add { display: flex; flex-wrap: wrap; gap: 8px; }
dai-form.add input { flex: 1 1 10em; width: auto; }
dai-rows {
  display: block; background: var(--card); border: 1px solid var(--line);
  border-radius: 14px; overflow: hidden;
}
.book {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 8px 12px; padding: 12px 14px; border-top: 1px solid var(--line);
}
.book:first-child { border-top: 0; }
.what { display: grid; gap: 2px; flex: 1 1 10em; min-width: 0; overflow-wrap: anywhere; }
.what span { color: var(--muted); font-size: 14px; font-style: italic; }
.what span:empty { display: none; }
.acts { display: flex; flex-wrap: wrap; gap: 6px; }
footer { display: flex; justify-content: flex-end; }
dai-save { display: inline-block; padding: 12px 22px; border-radius: 10px; background: var(--accent); color: var(--bg); cursor: pointer; }
@media (min-width: 720px) {
  main { padding-top: 48px; }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#8a3b2b"/><path d="M50 30c-8-6-18-8-28-6v48c10-2 20 0 28 6z" fill="#f6f1e7"/><path d="M50 30c8-6 18-8 28-6v48c-10-2-20 0-28 6z" fill="#e4dac8"/><path d="M62 24v22l6-5 6 5V26z" fill="#8a3b2b"/></svg>
```

The two seed rows that sit in "Up next" and the two in other groups are example data. Replace them with your own books.
