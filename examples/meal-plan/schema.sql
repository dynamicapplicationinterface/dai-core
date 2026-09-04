CREATE TABLE IF NOT EXISTS dinners (
        id INTEGER PRIMARY KEY,
        day TEXT NOT NULL,
        what TEXT NOT NULL
      );
CREATE TABLE IF NOT EXISTS groceries (
        id INTEGER PRIMARY KEY,
        item TEXT NOT NULL,
        got INTEGER NOT NULL DEFAULT 0
      );
