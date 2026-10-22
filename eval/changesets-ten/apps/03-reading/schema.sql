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
