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

## The rule for waiting

**Wait for the state your next action depends on, not for the first state that
happens to be observable.**

A test that waits for something visible and then acts is claiming the thing it
waited for is what makes the action safe. Three times now it was not:

- `body.loaded` instead of the handshake — the document was drawn before the
  host and the frame could talk, so the next message had nobody to answer it.
- The transient `busy` class — present for a moment, gone before a slow machine
  looked, so the wait was either instant or never.
- The move in the history while the board was still replaying it — the chess app
  replays the last move on open and ignores a tap until the replay ends. The
  history is right from the first frame; the board is not ready for a tap until
  later. Under load the gap is long enough to swallow the tap, and the test then
  waited fifteen seconds on a Play button that could never enable.
- A static heading instead of the form's handler — the CLI test's app drew its
  `<h1>` from markup and attached its submit handler only after SQLite booted.
  The test typed and pressed Enter as soon as the heading showed, the form
  submitted natively, the frame's `form-action 'none'` blocked it, and the text
  was gone with no error. The app now keeps its input disabled until it can take
  input, and the test waits for it to be enabled. The same app and the same wait
  had been copied into `mcp.spec` and `website-checks`, and the next CI run showed
  the copy in `mcp.spec` losing input the same way. When a fixture carries a
  wrong wait, look for its copies before the next run finds them for you.

Each passed on a fast machine and failed on a loaded one, which is what a wait on
the wrong signal looks like: correct ordering by luck.

So before a wait, name what the next action needs, and wait for that. To play a
move, the need is "this piece is picked up" — so tap and wait for the board to
show it selected (`mailbox-link-e2e.spec.ts`, `play()`), not "the move before it
has arrived." If the app gives no signal for the state you need, that is worth
knowing on its own: a person has the same problem, and the fix may belong in the
app.

**The same rule on the time axis: assert against an instant you chose, never
against the clock read again later.** A test that sets a deadline from the wall
clock and checks it after building, signing and auditing is racing its own
machine — under load the audit lands after the deadline and a correct document
reads as expired. Choose the instant once and pin the clock the code under test
sees to it (the expiry tests stub `Date.now` around the audit), the way a timer
is injected rather than slept out. And a save *asked* is not a save *written*:
wait for the written signal (the opener's `dai: save N written`), not the count
of asks.

## The rule for recovering

**A recovery step that repeats the thing under test destroys the test.**

When a wait fails and the test's answer is to do it again — reload the page and
look once more, reopen and retry — the test can pass on the second attempt while
the first was broken, and the first is the one a person meets. A reopen that
runs twice proves only that some reopen works. So a test does not recover by
repeating its own subject. If the failure is in the tooling rather than the
product (D32: the Firefox driver loses a frame the app is drawing in), that is
said in the backlog, made visible in CI, and reported upstream; it is not
papered over by running the step under test until it passes.

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
