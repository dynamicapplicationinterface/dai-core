# Handoff — <date>, <build>

The shape of a build's handoff since D296. A fact is marked **F.**, an
inference **I.**; a number names the run or commit it was read from.

The handoff goes up in the same push as the build's code, so CI runs the
browser matrix once per build. Its CI table is not in it: the next session's
first commit adds that table from the run on this push. That commit changes
only prose, so CI skips the matrix on it (`changes` job, D296) and the PR
stays mergeable.

## What changed

One line per commit: the short hash, what it changes, and why.

## Entries

The backlog entries this build filed, changed or closed, each with its status
line as it now reads.

## The local gate

`npm run test:push` on `<sha>`: **passed** / **failed**, in <minutes>.

- **F. Drift** (without the merge fixtures, which are CI's): what it said.
- **F. Typecheck and the generated tables:** pass or fail.
- **F. Specs:** what the diff reached by the impact map (or "every spec"),
  then passed / failed / skipped per project. The count floor is checked only
  when the diff reached every spec; say which.
- **F. Run beyond the tier,** if any: an engine, a repeat count, a device.
- Not run locally, and so CI's: the engine matrix, the merge-fixture check,
  the readers, the hold-outs, the properties. `npm run test:full` runs them
  here when a build wants that before its push.

## CI on the push

*Added by the next session's first commit, from the run on this push, read
with `scripts/ci-verdict.mjs <run>` (and `scripts/ci-install-times.mjs <run>`
for the install). The gate line, then one row per engine and job; a test
that passed on its job's retry is named.*

| Engine | Job | Tally |
|---|---|---|
| Chromium | shards 1–4, mailbox | |
| node | whole | |
| WebKit | shards 1–4, mailbox | |
| Firefox (a reading, D32) | whole | |
| — | checks-fast, checks-holdout, checks-properties-node, checks-properties-python | |
| — | count-gate | |

## Open

What this build leaves open, by entry number.
