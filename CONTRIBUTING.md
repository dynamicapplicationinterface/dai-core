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

Four tiers, each run less often than the one before it and each checking more.

| Tier | When | Command | What runs |
| --- | --- | --- | --- |
| Iterate | while editing | `npm run test:iterate -- tests/x.spec.ts` | the specs named, chromium and node, reusing the last build if nothing it reads changed |
| Commit | before a commit | `npm run test:commit` | the specs that claim what changed against `HEAD` (`scripts/impact.mjs`), or everything when a shared file changed |
| Push | before a push | `npm run test:push` | the checks CI's checks job runs (the build, then the conformance, dictionary, confusable-table and merge-fixture checks), then the whole suite on chromium and node, through the count gate |
| CI | every push | `.github/workflows/test.yml` | the whole suite on all three engines, the node project once, typecheck and the reference readers |

Three engines are CI's job. Running them all locally is what made the loop
too slow to use; a local run that checks one engine well is worth more than
one that is skipped.

The rule every tier answers to:

> **Run less must not become check less.** If any tier can be satisfied
> without the thing it is meant to catch actually being checked, it is the
> wrong tier.

What that means in practice:

- **The two subset tiers say so.** They print that the count floor was not
  checked. A green subset is evidence about the subset, never about the suite.
- **The push tier cannot be satisfied without the gate.** It refuses a
  filter, a shard, a project list, named specs or a `--reporter` (which would
  replace the gate), and it fails unless the count gate reports that it
  checked the run (`test-results/count-gate.json`). A run where the gate
  silently did not happen is the failure this exists to prevent.
- **The impact map errs wide.** `scripts/impact-map.mjs` works out which specs
  reach which files, from the specs themselves. A source file no spec is known
  to reach makes the commit tier a full run, and `--check` lists every such
  file so it gets a check or a stated reason.
- **Build reuse is the inner loop's only.** The push tier and CI always build
  from scratch.

Run the tiers by habit — there is no hook forcing them. CI is the backstop:
a push that skipped a tier is still checked there, on every engine, before
anything relies on it.
