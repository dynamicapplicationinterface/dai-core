---
title: While a person is working
---

# While a person is working

An application in a container changes under the person using it more often
than an ordinary web page does, and at moments they did not choose. There are
two doors, and applications written from these instructions have been found
with both of them open:

- **Before the application is ready.** The page appears before its script has
  finished starting — in a shared document the script waits for the host's
  write rules. Anything a person types into a form in that moment is lost: the
  browser either submits the form itself and replaces the page, or ignores the
  press and the application's own start-up then resets the form. Which of the
  two happens varies between browsers and between one opening and the next.
- **While they are in the middle of something.** Another copy's rows arrive —
  from a link somebody opened, or in the background from the mailbox — and the
  application redraws. A redraw that rebuilds an open editor from the stored
  wording throws away what was being typed.

They are one failure: the application changing under a person while they are
working in it, and losing their work without a word. An author who has guarded
one door should guard the other, so they are explained together here. Each
stays a constraint of its own, because they happen at different moments and
are fixed in different places — the first in how the page starts, the second in
how it redraws.

<!--@include: ./parts/constraint/NO-INPUT-LOST-WHILE-OPENING.md-->

<!--@include: ./parts/constraint/SHARED-REDRAW-ON-MERGE.md-->

## Where to see them done

The receipts and tic-tac-toe examples show both. Each keeps its page hidden and
inert behind an "Opening…" line until its start-up has finished, and replaces
that line with what went wrong if start-up fails. Receipts edits through a form
written once in the HTML, which no redraw rebuilds.
`tests/examples-shared.spec.ts` holds them to it on three browsers: a half-typed
edit that survives the other copy's receipts arriving; nothing typeable while
either example opens, even when a style rule undoes `hidden`; a failed start-up
that says so; and, beside them, the same example with its gate removed, where
the same moment loses what was typed.

## How they were found

Both were found by running applications rather than reading them, and by the
same method: give a fresh model only the model file, ask for something, and
drive what it writes. `docs/evaluation.md` describes it.

The start-up window showed first as flaky tests: the receipts example's own
tests typed into a form that was on screen and not yet working, and passed or
failed depending on timing. It was confirmed as a teaching defect, not an
example defect, when both blind candidates copied the examples' pattern of
showing their forms before the script had started.

The mid-edit loss was found by the second blind run, a two-person agreement,
driven over the mailbox on three browsers: on one of them a background merge
landed while a term was being edited, and the edit was gone.
