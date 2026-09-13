# claude-opus-5-blind-agreement

The second blind run, chosen to be unlike every example in the model file: a
two-person agreement — terms either person may add, edit or remove, acceptance
of a specific version, and a seal after which nothing changes. A session, but
nothing about it is a board, a turn or a receipt.

- **Model:** Claude Opus 5, as a fresh agent with no prior context.
- **Date:** 13 September 2026.
- **Input:** the model file as published at `/recipe.txt` at that commit, then
  the ask (in the run's prompt; recorded in the commit that added this). The
  agent was told to read nothing else and reported reading only the model file;
  that is its report — it had tool access to the repository.
- **Output:** `two-player-game.bundle.txt` exactly as written, and
  `two-player-game/`, the same unpacked. First attempt; not edited.

## Did it reason, or template?

Both, in a useful proportion. The session plumbing — `seats()`,
`joinIfInvited()`, the `write()` wrapper — follows the tic-tac-toe example
closely, which is how the model file teaches that API. The domain it worked out
from the constraints, with no example behind it: "the same version" as a
fingerprint derived from the live terms' row versions, never stored; acceptance
as a row recording what was accepted, with "agreed" derived so that any edit
voids both acceptances without a status to reset; the seal as a row followed by
a session close; an ordering column of its own because `_r_lc` moves on edit;
a term edited on both copies settled from `terms_heads`, the receipts pattern
applied to a new table.

## Result

**Scorer:** reached `shaped` — lint clean, built, profile declared, nothing
derived stored.

**Driven over the mailbox in the real host** (`tests/blind-agreement.spec.ts`
at the commit that added this, `CANDIDATE_DIR` pointing here): A starts an
agreement with two terms and invites B by link; B joins; an edit crosses by
mailbox; the same term edited on both copies is shown and settled; both accept,
an edit voids both, both re-accept; A seals; B, not yet having heard of the
seal, edits a term — and that late edit is not admitted on either copy; a copy
forwarded to C as a file can read and cannot take part.

- **Chromium: passed. Firefox: passed.**
- **WebKit: failed**, and the failure is the finding.

## The finding: a redraw discarded what was being typed

On WebKit the host's background mailbox poll landed while B's editor was open.
The candidate redraws on `dai:merged` by rebuilding the term list, which
recreated the textarea from the stored wording — so what B had typed was gone,
and saving then wrote nothing. Reproduced deterministically on Chromium by a
second test in the same file: B types into an open editor, A changes a
different term, B's copy receives it, B's text is replaced.

It is the application's bug and the documentation's cause: SHARED-REDRAW-ON-MERGE
told an author to redraw everything when rows arrive and said nothing about
work in progress. It now does, and the receipts example has a test showing it
meets the rule. The first run could not have found this — its rows moved by
file, at moments the test chose.

## What the candidate reported as unclear

Checked against the code:

- **A seal as row plus close** — the candidate folded the close into the seal
  and asked whether that is the "folding" SESSION-CLOSE warns against. It is
  not: SESSION-CLOSE warns against making *ending the activity* close the
  session; a seal is a deliberate final act for which closing is the point.
  The constraint could say so.
- **Using `_r_seq` / `_r_replica` from `_current` as a version identity** —
  sound: they are the row's key, identical on every copy. Not stated anywhere.
- **Recording an accepted version string** — a fact (what was accepted), not
  derived state; the candidate read it right.
- **`session.close()` inside a transaction** — not established.
- **Stable ordering of edited shared rows** — nothing covers it; the candidate
  added a position column.

## What this did not cover

One run, one model. A three-person agreement is impossible today (backlog D6),
so the session stays at two. Closing under `close=creator`, a contested seat and
reseat were not exercised on this candidate (the first run and the examples'
tests cover them).
