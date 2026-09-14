---
title: While a person is working
---

# While a person is working

An application in a container changes under the person using it more often
than an ordinary web page does, and at moments they did not choose. There are
two doors, and both have been found open in applications written from these
instructions:

- **Before the application is ready.** The page appears before its script has
  finished starting — in a shared document it waits for the host's write rules.
  A form on screen in that moment takes typing the application cannot handle
  yet. Pressing Enter then makes the browser submit the form itself and replace
  the page in one browser, and does nothing in the other two — after which the
  application's own start-up resets the form. Either way what the person typed
  is gone.
- **While they are in the middle of something.** Another copy's rows arrive —
  from a link somebody opened, or in the background from the mailbox — and the
  application redraws. A redraw that rebuilds an open editor from the stored
  wording throws away what was being typed.

They are one failure: the application changing under a person while they are
working in it, and losing their work without a word. An author who has guarded
one door should guard the other, so they are explained together here, while
each stays a constraint of its own — they happen at different moments and are
fixed in different places.

<!--@include: ./parts/constraint/NO-INPUT-LOST-WHILE-OPENING.md-->

<!--@include: ./parts/constraint/SHARED-REDRAW-ON-MERGE.md-->

## The rule underneath both

Between a person's first keystroke and the moment they save, the part of the
screen they are working in is theirs. Two things follow:

1. **Show nothing they can use until the application can handle it.** Keep the
   interactive page hidden behind a short "Opening…" line until start-up has
   finished. The receipts and tic-tac-toe examples do this in their last lines.
2. **Keep what they are in the middle of outside what the application
   rebuilds.** A form written once in the HTML survives any redraw; a draft kept
   in a local table can be read back; an editor being used can be left alone
   until it is saved or cancelled. The receipts example edits through a form
   that no redraw touches.

## How each was found

Both were found by running applications, not by reading them. The start-up
window made the example's own tests flaky before anyone saw it in the example —
a test typing into a form that was visible and not yet working. The mid-edit
redraw was found by a model writing an application from the model file alone,
then driven over the mailbox on three browsers: on one of them a background
merge landed while a term was being edited. `docs/evaluation.md` describes that
method.

`tests/examples-shared.spec.ts` holds both: a half-finished edit that survives
another copy's receipts arriving, and a submit attempted while the application
is opening that loses nothing — beside the same example with its gate removed,
where the same moment loses what was typed, by whichever route the browser
takes.
