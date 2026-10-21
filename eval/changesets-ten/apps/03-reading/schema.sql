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
