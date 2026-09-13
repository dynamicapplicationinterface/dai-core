# Tests

## The rule an end-to-end test must keep

**An end-to-end test uses the carrier a person uses. `__runner` hooks may set up
scenery, never the fact under test.**

This is written from a real miss. The mailbox was reported "proven end to end"
while the e2e injected the document key into both copies through
`__runner.useRelay(base, key)`. That made the two sides share a key for free —
which is exactly the thing real sharing has to *produce*. So the test proved the
mechanism (nudge, seal, append, pull, apply) and said nothing about the key
path, and two real phones never synced. A test that injects the state the real
flow must produce is a unit test wearing an e2e's name.

So, for any test that claims to prove an end-to-end flow:

- The fact under test travels by the carrier a person uses — a file a person
  opens, a link a person taps, a move a person plays. If the claim is "two
  people share a game," the key reaches the second copy through the link, not
  through a hook.
- `__runner` hooks are for **scenery only** — pointing at a local relay, standing
  in for a share sheet, deleting a save dialog. They must never supply the fact
  the test exists to prove. Setting the relay *base* is scenery; setting the
  *key* is the fact — the first is allowed, the second is not.
- Name the test for what it proves. A mechanism test that injects scenery says
  so in its name, so nobody cites it as proof of the thing it stubbed.

`mailbox-mechanism.spec.ts` proves the mechanism with an injected key.
`mailbox-link-e2e.spec.ts` proves the key path: one copy shares a link, the
other opens it, a move crosses, no injected key.

## The rule for mocking a same-origin request

**A test that mocks a same-origin request with `page.route` must block service
workers: `test.use({ serviceWorkers: "block" })`.**

The runner registers a service worker that claims the page and answers same-origin
GETs from a cache-first `fetch` handler. When it controls the page, a request the
app makes is served by the worker and never reaches `page.route` — so the mock is
silently bypassed. Whether the worker wins is a timing race (it depends on when the
worker activates relative to the fetch), so the test passes locally, where the
worker is often not yet in control, and fails on CI, where it is — or the reverse.
A non-deterministic bypass is the worst kind of flake: it reads as a product bug on
one machine and green on another.

This has cost the project three separate times — the reference-link head, stale
route globs, and the identity/opener-thin reds where a mocked `roots.json` and an
aborted `runtime/sqlite3.*` were both served by the worker instead. The knowledge
lived in four tests that already carried the mitigation and did not travel; it
lives here now, and `scripts/check-routes.mjs` (run by `npm run typecheck`) fails
the build on a `page.route` for a same-origin path in a file that does not block
the worker.

Blocking is the right call precisely because these tests are not testing the
worker — they are testing what the page does when a given request returns a given
thing, and the mock is how they say what it returns. A test that *is* about the
worker keeps it and does not mock through it. `idb-timeout`, `launch-failsafe` and
the `write-rules` specs are the standing examples.
