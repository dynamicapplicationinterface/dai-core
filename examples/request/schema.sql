-- Request for answers · shape: session, with author roles
--
-- The decision: one person writes a set of questions and sends a link; one
-- person opens it and answers. Both copies' rows must be kept, so the tables
-- are shared. It is a closed group of two, so it is a session. And the two
-- sides are not interchangeable: the questions belong to the person who asked
-- them, the answers to the person who gave them. That is what `author=` says.
--
-- What that costs, and why:
--   * Every request is its own session. The creator writes it; whoever opens
--     the invite takes the open seat and answers. Which side a person is on is
--     read from the seats, never stored.
--   * author=creator: only the session's creator can write the request and its
--     questions. author=joiner: only the other party can write answers and the
--     submission. The write surface refuses the wrong party by name
--     (ROLE_NOT_PERMITTED), and a row that reaches a copy some other way is
--     kept but never admitted to the _current view.
--   * Nothing about progress is stored. How many questions are answered, and
--     whether the answers were sent back, are derived from the rows.
--   * An answer is one row per question, changed in place by change(). An
--     answer edited on two devices before they met is shown to settle.
--   * An answer is written when the person saves it, not while they type: a
--     row per pause would send half-typed text and invite conflicts. Text not
--     yet saved is held by the page, and sending back saves it first.
--   * Answers stay editable after they are sent back; an edit reaches the
--     writer like any other row. Questions lock, in the page, once the request
--     has been opened: a question changing under an answer is not worth
--     explaining.
--   * That lock is weaker than the roles above. The roles are enforced: a
--     copy cannot write the other party's table. The lock is only the page not
--     offering the control; the writer's copy can still write questions. If
--     that ever has to hold, it needs a rule the runtime enforces, not a
--     hidden button.
--   * Which request is showing is about this copy, so it is local.

-- dai:profile session max_parties=2 close=creator

-- dai:replicated author=creator
CREATE TABLE IF NOT EXISTS requests (
  from_name TEXT NOT NULL,            -- who is asking, as the other person will see it
  title   TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  due_on  TEXT                        -- YYYY-MM-DD, or null for no date
);

-- dai:replicated author=creator
CREATE TABLE IF NOT EXISTS questions (
  request_id TEXT NOT NULL,           -- the requests row's entity, as hex
  position   INTEGER NOT NULL,        -- 1-based order on the page
  prompt     TEXT NOT NULL
);

-- dai:replicated author=joiner
CREATE TABLE IF NOT EXISTS answers (
  question_id TEXT NOT NULL,          -- the questions row's entity, as hex
  body        TEXT NOT NULL
);

-- dai:replicated author=joiner
CREATE TABLE IF NOT EXISTS submissions (
  request_id TEXT NOT NULL            -- the requests row's entity, as hex
);

-- Local: never merged.
CREATE TABLE IF NOT EXISTS settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  active_request TEXT
);
