-- Receipts · shape: passable
--
-- The decision: two people in one household both add the receipts they paid
-- for, each on their own phone, and hand the document back and forth. Both
-- copies' receipts must be kept, so the receipts table is shared. Anybody who
-- holds a copy may add to it — there is no fixed group to admit — so this is
-- passable, not a session.
--
-- What that costs, and why:
--   * receipts is append-only. It is written through window.dai.replicated
--     and read through receipts_current, never the table itself.
--   * No PRIMARY KEY, UNIQUE or CHECK on it. A receipt's identity is its
--     entity; two people entering the same receipt is theirs to notice.
--   * No stored total, no balance, no "settled" flag. What each person paid
--     and who owes whom are computed from the rows every time they are drawn;
--     a stored total would be wrong after the first merge.
--   * Which name this copy's person goes by is about this copy, not the
--     document, so it lives in a local table.

-- paid_by is the name of whoever paid. (No comment after the last column:
-- see SHARED-NO-TRAILING-COMMENT.)
-- dai:replicated
CREATE TABLE IF NOT EXISTS receipts (
  spent_on TEXT NOT NULL,     -- the date on the receipt, YYYY-MM-DD, as entered
  store    TEXT NOT NULL,
  cents    INTEGER NOT NULL,  -- the amount, in cents
  paid_by  TEXT NOT NULL
);

-- Local: never merged. May use keys and checks freely.
CREATE TABLE IF NOT EXISTS me (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT ''
);
