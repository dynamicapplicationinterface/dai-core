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

## The test loop

Five tiers. The push tier is the gate before a push and CI is the gate before a merge; the push tier does not repeat what CI runs on the same commit (D296).

| Tier | When | Command | What runs |
| --- | --- | --- | --- |
| Iterate | while editing | `npm run test:iterate -- tests/x.spec.ts` | the specs named, chromium and node, reusing the last build if nothing it reads changed |
| Commit | before a commit | `npm run test:commit` | the specs that claim what changed against `HEAD` (`scripts/impact.mjs`), or everything when a shared file changed |
| Push | before a push | `npm run test:push` | drift without the merge fixtures, the typecheck, the dictionary and confusable-table checks; then the node project and the changesets suite whole, and the specs the branch's diff reaches (`scripts/impact.mjs`) on chromium; a diff that reaches everything runs the whole chromium and node suite through the count gate. Minutes, not an hour |
| Full | when you choose | `npm run test:full` | the checks CI's checks jobs run (drift with the merge fixtures, the readers, the hold-outs, the properties), then the whole suite on chromium and node, through the count gate. The push tier before D296 |
| CI | every push that changes code | `.github/workflows/test.yml` | the whole suite on all three engines, the node project once, the count, typecheck, the readers and the properties. A commit that changes only prose skips the engine matrix, the count and the properties (D296) |

Three engines are CI's job. Running them all locally is what made the loop
too slow to use; a local run that checks one engine well is worth more than
one that is skipped.

The rule every tier answers to:

> **Run less must not become check less.** If any tier can be satisfied
> without the thing it is meant to catch actually being checked, it is the
> wrong tier.

What that means in practice:

- **The subset tiers say so.** Commit, and push unless its diff reaches
  everything, print that the count floor was not checked; CI's count gate
  checks it on every push that changes code. A green subset is evidence about the subset, never about the suite.
- **The full tier cannot be satisfied without the gate.** It refuses a
  filter, a shard, a project list, named specs or a `--reporter` (which would
  replace the gate), and it fails unless the count gate reports that it
  checked the run (`test-results/count-gate.json`). A run where the gate
  silently did not happen is the failure this exists to prevent.
- **The impact map errs wide.** `scripts/impact-map.mjs` works out which specs
  reach which files, from the specs themselves. A source file no spec is known
  to reach makes the commit tier a full run, and `--check` lists every such
  file so it gets a check or a stated reason. It reads the tracked files only,
  as CI does from the pushed tree: `git add` a new spec before `--write`, and
  a file left untracked on disk never enters the map.
- **Build reuse is the inner loop's only.** The push and full tiers and CI
  build from scratch; the push tier's second run, the node project, reuses the
  build its first made a minute before.

Run the tiers by habit — there is no hook forcing them. CI is the backstop:
a push that skipped a tier is still checked there, on every engine, before
anything relies on it.
