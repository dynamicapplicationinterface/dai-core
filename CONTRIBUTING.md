# Contributing

## When a slice is done

A slice is done when all of these hold — not when its code is written and its
own tests pass. Each line is here because the project shipped something that
met every other line and missed this one.

1. **"What calls this?" has an answer on the real path.** A host, an
   application, the compiler — something a person's action reaches. A block that
   is correct, reviewed and tested, and that nothing on that path calls, is not
   done: `filterToSession`, `exportSession` and `deriveSessionMailbox` each
   shipped that way in one pass (backlog D9). `scripts/check-callers.mjs`, run by
   `npm run typecheck`, fails on an export of `src/` whose only callers are its
   own file and the tests.

2. **A test goes through that caller, by the carrier a person uses.** A file a
   person opens, a link a person taps, a move a person plays. Hooks may set up
   scenery, never the fact under test. See `tests/README.md`, "The rule an
   end-to-end test must keep".

3. **Its waits are for the state the next action needs**, not the first state
   that happens to be observable. See `tests/README.md`, "The rule for waiting".

4. **`npm run typecheck` passes**, and the specs it touches pass on all three
   engines, not only the one on the desk.

5. **What it changes for a person is written where they will read it** — the
   constraint in `src/rules.ts` (then `node scripts/build-docs.mjs`), the host
   bridge table, the backlog entry marked with its commit.
