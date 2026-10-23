-- Packing list
--
-- Ordinary tables with their own keys. One trip per document: its name and
-- dates live in a single row, and every thing to pack is a row of its own.
-- Totals ("3 of 14 packed") are queries in the page, never stored columns.

CREATE TABLE IF NOT EXISTS trip (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  dates TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  what TEXT NOT NULL,
  packed INTEGER NOT NULL DEFAULT 0,
  added TEXT NOT NULL DEFAULT (datetime('now'))
);
