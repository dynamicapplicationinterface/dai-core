# claude-opus-5-blind

One completion, for the session prompt `two-player-game`, recorded as the
first measurement of the claim the documentation overhaul was built to make:
a model given only the model file writes a correct session application on the
first attempt.

- **Model:** Claude Opus 5, as a fresh agent with no prior context.
- **Date:** 13 September 2026.
- **Input:** the model file as published at `/recipe.txt` at that commit (the
  model file plus its closing "The app I want is: "), followed by the prompt's
  `ask`. Nothing else. The agent was told not to read any other file and
  reported reading only the model file; that is its report, not something the
  harness could enforce — it had tool access to the repository.
- **Output:** `two-player-game.bundle.txt`, exactly as written, and
  `two-player-game/`, the same bundle unpacked by `parseBundle`. First attempt;
  not edited.

## Result

**Scored by `scripts/evaluate.mjs`:** reached `shaped` — the lint's
shared-table checks passed, it built, and its schema declares the session
profile and stores no derived state. `mounted` and `usable` are not measured
by that harness.

**Driven by hand in the real host** (`hosted-drive.spec.ts.txt`, run once with
`CANDIDATE_DIR` pointing here, Chromium, four browser contexts as four
devices, rows moving by file): passed. The creator started a game and dropped
first; the invitee opened the invite, took the open seat and played; seven
drops crossed between the two copies, each redrawing on arrival; Red's
vertical four won on both copies; a copy forwarded to a third device was told
it was not invited and could not play; a fourth device opening the original
invite contested the seat, and the creator was shown the repair. No page
errors.

## What this did not cover

- **Closeness to the example.** The application follows the tic-tac-toe
  example in the model file closely — the seat logic, the join rule, the
  collision handling and the replay have the same shape. It shows the model
  file teaches a session application by example; it does not show a model can
  reach one for a problem unlike any example. A prompt further from the
  examples is the stronger test.
- **One run, one model.** A rate needs many.
- **Not exercised:** the mailbox path (rows moved by file only), a close,
  a conflicting rename, two drops at one turn, WebKit and Firefox.
- The agent's list of what it found unclear in the model file was checked
  against the code, and the real gaps were fixed in the same change.
