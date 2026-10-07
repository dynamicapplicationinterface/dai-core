# Open questions from the blind rebuild

Questions the page (docs/format.md, docs/replicated-tables.md) and
conformance/merge/README.md leave open, found while rebuilding `main.rs` blind.

## 1. What is `expected-schema.txt`, and does it cover the roster tables?

**Fixtures:** all 122. Every vector ships `expected-schema.txt`. The visible
difference is in the session vectors (for example `session-two-halves`), where
the file lists `moves` and nothing else.

**What the page says:**

- conformance/merge/README.md's per-vector table does not list
  `expected-schema.txt`, and nothing in the README says what it holds or what
  a reader compares it with.
- replicated-tables.md T1-D21 gives a form for the schema comparison: "one line
  per column, tab-separated, tables in name order and columns in declared
  order, carrying the name, the declared type upper-cased, whether it is `NOT
  NULL`, and the default verbatim", with the `_r_*` columns left out.
  T1-D26 says `replication.tables` lists only the author tables and the system
  tables are "implied by the profile, never enumerated".
- docs/format.md#merge-whole-refusals (`SCHEMA_MISMATCH`) compares "the two
  copies' tables a merge takes", which in a session document explicitly
  includes `_dai_seat`, `_dai_binding`, `_dai_confirm` and `_dai_close`. Their
  author columns (every column but the `_r_` ones) include `seat`, `seats`,
  `close` and `holder`.

**What it leaves open:**

- Whether `expected-schema.txt` is the T1-D21 text, and so whether a reader
  must check it at all.
- Which tables it covers: only the author tables (T1-D21 and T1-D26), or every
  table a merge takes (format.md#merge-whole-refusals).
- Which copy it describes. It could be each copy, `a.db` only, or the shared
  schema of both.
- The spelling of the `NOT NULL` field ("NOT NULL" or empty) and of an absent
  default (empty). The page names the fields but not how they are written.

**What the fixtures show:** for each vector, one line per author column of each
table that is not a roster table or the close, in this form:
`table<TAB>column<TAB>TYPE<TAB>NOT NULL-or-empty<TAB>default-or-empty`. Both
`a.db` and `b.db` produce the same text, including in
`schema-digest-replicated-only`, where one side also holds a local table that
is left out.

**What the reader does meanwhile:** it checks the file against each copy's
author tables in that form. The roster tables are left out, following T1-D26,
and the field spelling is copied from the fixture. The `SCHEMA_MISMATCH`
refusal itself compares every table a merge takes, as format.md says. The
file check can only add failures; no vector passes because of it. If the
answer is that the file is not part of the reader's contract, the check can
be deleted. If the answer is format.md's scope, the fixtures disagree with the
page.
