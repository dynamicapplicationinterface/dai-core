-- Beach trip · shape: solo
--
-- The decision: one family's packing list, kept on one phone. Nobody else
-- adds to it and no second copy's changes need keeping, so nothing is shared:
-- ordinary tables, written with the kit, keys and all.

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
