-- Beach trip
--
-- One family's packing list: ordinary tables, written with the kit, keys and
-- all. Whoever else ends up holding a copy, the host keeps every copy's
-- changes; nothing here has to know.

CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      what TEXT NOT NULL,
      packed INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE IF NOT EXISTS trip (
      id INTEGER PRIMARY KEY,
      dates TEXT NOT NULL
    );
