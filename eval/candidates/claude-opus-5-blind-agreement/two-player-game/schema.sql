-- Agreement · shape: session
--
-- The decision: two people (a landlord and a tenant, two housemates) work out
-- an agreement by sending the document back and forth, each on their own
-- phone. Both copies' changes must be kept, so the tables are shared. And it
-- is a closed group of two -- a copy forwarded to a third person must not let
-- them add, edit, accept or seal anything -- so it is a session, not merely
-- passable. Each agreement is its own session, so one document can hold
-- several agreements, each with its own pair of people.
--
-- What that costs, and why:
--   * Who is the first party and who is the second is read from the seats:
--     the creator is the first party, whoever takes the open seat is the
--     second. The names are only what the creator typed.
--   * Terms are rows. Adding is insert, editing the wording is change, removing
--     is remove. Nothing stores "the current text of the agreement".
--   * "The same version" is derived, never stored as a status: the version of
--     an agreement is the set of its live terms, each identified by the exact
--     row version showing (entity, the replica that wrote that version, and
--     its sequence number). Any add, edit or removal makes a new version.
--   * An acceptance is an act: a row saying "I accept this version", carrying
--     the version text it accepted. Who accepted is the row's replica. Agreed
--     is derived: both seated members have an acceptance whose version equals
--     the version showing now. There is no "agreed" flag, so an edit after an
--     acceptance voids it without anyone writing anything.
--   * Sealing is a seal row (the finishing act) followed by closing the
--     session, which stops any row either copy writes later from being
--     admitted: after a seal nothing can change, even on a copy that had not
--     heard of it yet.
--   * No UNIQUE and no CHECK on shared tables. Which agreement is showing is
--     about this copy, so it is local.

-- dai:profile session max_parties=2 close=any

-- dai:replicated
CREATE TABLE IF NOT EXISTS agreements (
  title        TEXT NOT NULL,
  first_party  TEXT NOT NULL,   -- the creator's name, as typed
  second_party TEXT NOT NULL    -- the invitee's name, as typed by the creator
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS terms (
  agreement_id TEXT NOT NULL,   -- the agreements row's entity, as hex
  body         TEXT NOT NULL,   -- the wording of the term
  position     REAL NOT NULL    -- where it sits in the list, chosen when added
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS acceptances (
  agreement_id TEXT NOT NULL,   -- the agreements row's entity, as hex
  version      TEXT NOT NULL    -- the version accepted (see above)
);

-- dai:replicated
CREATE TABLE IF NOT EXISTS seals (
  agreement_id TEXT NOT NULL,   -- the agreements row's entity, as hex
  version      TEXT NOT NULL    -- the version that was sealed
);

-- Local: never merged.
CREATE TABLE IF NOT EXISTS settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  active_agreement TEXT
);
