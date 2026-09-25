# Backlog

The one list: what is undecided, what is decided and still binds, what keeps
recurring, the work, and what only the maintainer can do. It replaces the
separate roadmap. A thing appears once. Where two parts need the same fact, one
holds it and the other points to it.

**Send a link, keep a file.** Someone sends you a DAI app, and you can use it
immediately. On a phone the only executor already installed is the browser, and
a browser executes addresses, not files, so the file stays canonical and the link
is how a document is met first.

Phases 0 to 5 of the plan that sentence set are done, except 3.5 (iOS: a link
cannot reach an installed icon), 4.4 (the wedge, under Not engineering) and 5.2
(propagation without a beacon). Their records are in git history.

---

## 1. Open questions

Undecided, and the shape of the answer is not known yet. No status, no order, no
numbers. **When a question is answered it stops being a question: it becomes
entries in part 4 and leaves this part. It never lives in both.**

- **What 1.0 means.** The earlier target was two interoperable implementations, a
  conformance suite both pass, a published security review, registered media
  types, and the format held by a foundation. Unanswered because one
  implementation exists and nobody outside the project has built on it. What would
  answer it: a second party wanting to.
- **Viewer or editor.** Whether the browser is a viewer with export and the
  desktop app is the editor (the PDF arrangement), or both edit. Unanswered
  because the browser opener now saves in place (OPFS, one lock per document),
  which weakens the original reason for the split. What would answer it: a
  positioning decision about what the site promises.
- **The capability model beyond its mechanism.** The mechanism and the rule for
  picking the first capability are decided (part 2). Open: whether a notification
  is a capability at all, since it reaches out while the document is closed, and
  whether data read in from a device must be marked as never travelling. What
  would answer it: the first real request for a device capability.
- **The synthesis profile's public evaluation.** The kit, the bundle transport,
  `dai check --json` and the model file exist. Open: a public evaluation over
  hundreds of prompts, run against the major models, published. Unanswered because
  two blind runs are not a rate (D14). What would answer it: deciding to make the
  claim in public.
- **A second implementation.** A second reader in Python exists and has found gaps
  in the specification. Open: an independent runner, built outside the project.
  What would answer it: someone outside wanting to build one.
- **The standards track, past the media type.** The order is decided (part 2).
  Open: when a Community Group is worth approaching. What would answer it: the
  Python reader writing as well as reading, and one participant who is not us.
- **Native runners and a second engine.** Whether a phone app that owns `.dai`, and
  an engine in another language, are worth building. Unanswered because the
  evidence they need is whether documents actually get opened on phones through
  the web opener. D16 is the parked native iOS host.

D17's retention question is **an entry, not a question here**: its shape is known
(a retention period, and what a late copy is told) and it waits on one specific
thing, D18.

---

## 2. Decisions that still bind

Rulings from closed work that govern what comes next. The history of each is in
git. If a ruling is overturned, it is replaced here, not annotated.

**Updates, counting, and the author's voice** (21 September, with the V1
direction; the walk these serve is `docs/v1-walk.md`)
- **What an update may touch.** An update changes the author's part and never
  the person's rows. Taking it is the person's choice, and their data stays
  either way. An update that cannot carry the rows forward **is not applied**:
  the person is told why in one sentence, and the version they already had keeps
  working. The card says three things — what changed, that their data is kept,
  and **Update / Not now**. Nothing here is automatic, and nothing here is
  silent: an update that cannot be explained is an update that does not happen.
- **The relay counts version pings and nothing else.** A copy tells the relay
  which version it holds. The count is "copies checking in" — not people, not
  installs, not sessions, and nothing is derived from it. It is the smallest
  fact that answers "did the update reach anyone", and the relay learning less
  than that would answer nothing.
- **An author's message travels with an update** and shows as a card on next
  open, under D45's authority: the person decides, the author sets a default,
  and the default is never an authority. It is **never a push the author
  chose** — an author who can wake a device at will is a different product from
  this one.
- **Succession is the only update** (D85). A rebuild under the same
  `documentUuid` with no shared ancestry is **refused, with a sentence**. The
  `take` path stays for what it was built for: a copy descended from this
  device's own history coming back. Update has one spelling, and it is the one
  that carries the rows forward under the pinned key.
- **The ping is one mechanism, for both counting and updates.** A copy sends
  its document id, its version and its publisher key, and the relay answers
  whether there is a successor under that publisher key. The relay learns those
  three things and **nothing else** — not who, not when beyond the count, not
  what is in the document. Designed in `docs/version-ping.md`; its four open
  choices were ruled 21 September and are the next four lines.
- **The version is the build digest** — the SHA-256 of the manifest's signed
  entries. No format change, and it does not move when a person writes a row.
  Because a digest carries nothing a person could read, **the announcement
  carries a human-readable label and the author's note beside it**: the label
  is what the card shows, the digest is what the machinery compares.
- **The announcement carries the successor's full address**, and therefore its
  key. **The relay holds what the author published, never what a person
  wrote** — that sentence is in the page, in those words, because the property
  it draws the line around is the one everything else here rests on.
- **The count is kept per version and per document.** Per version answers "did
  the update reach anyone"; per document answers "is this app used"; both are
  check-ins, never copies, and never reported as installs.
- **One relay object per document**, matching the mailbox. A busy author does
  not serialize every reader of every document they have published through one
  object, and the blast radius of one document's traffic stays that document's.
- **Persistence is asked after the first thing worth keeping is written**
  (D55), never at boot. The request that follows a person's own first save is
  the one a browser is willing to grant, and the one they can make sense of.
- **A share defaults to data off for a document with no replicated tables.**
  A document that replicates is shared to be joined, and its data is the point;
  a single-user document shared to a friend is the app, not the sender's
  entries.
- **The link is the backup, and it is said on screen** (D53): at install, and
  in the share card. A property nobody is told is a property nobody can act on.

**Carriers and copies**
- **Send a link, keep a file.** The link is the first-contact carrier; the file is
  canonical.
- **An invite carries one session.** `requestShare(session)` filters the copy to
  that session's rows, with none of the sender's other sessions or local tables. A
  saved whole-document file is not an invite into one game (`tests/README.md`).
- **A key belongs to the game, carried by the invite** (D37). Who invites first,
  and how often, does not decide whether two copies reach each other. Games made
  before per-game keys were not migrated: they restart.
- **One mailbox per session** (D8). The relay learns as little as it can: each
  game its own address, sealed batches, payloadless push.
- **Session documents built before per-session mailboxes cannot be repaired in
  place** (D10); they are re-created, and the app says so.
- **Two copies of a document that cannot merge** (D36):
  - "Arrived" and "written" are recorded separately.
  - When both changed since they last matched, the opener refuses and explains;
    it never silently picks.
  - This covers the non-replicated path only; replicated documents merge.
  - Never try to make timestamps correct. There is no correct order between
    concurrent copies, and a cleverer clock only moves where the silent pick
    happens.
- **Every host-to-frame message is held until the bridge listens** (D33). The
  payload is the one named exception.

**Sessions and roles**
- **Roles are the two session roles, applied per table** (D15): `author=creator`
  or `author=joiner` on a replicated table's marker. The wrong party's write is
  refused with `ROLE_NOT_PERMITTED`, and its rows are stored but never admitted.
  Both halves are enforced and proven.
- **A page-only lock is not a role.** Request's question lock once opened is the
  page not offering the control. The writer's copy can still write the table. If a
  lock ever has to hold, it needs a rule the runtime enforces.

**Notifications and the badge**
- **The badge count comes from the app** (D34): `window.dai.reportWaiting`. Between
  opens it is a remembered report plus the games that moved, so it is a hint and
  never authoritative. It clears on open, on returning to the page, and once this
  person's publish is confirmed.
- **Who decides whether a document notifies** (D45):
  1. The person. A recipient can revoke permission in the operating system's
     settings at any time.
  2. The author sets a default for the document.
  3. The author's choice is a default, never an authority. A document can ask not
     to notify; it can never insist.
- **Every push ends in a notification.** iOS revokes a subscription that shows
  none.

**Storage and the relay**
- **The store's lifecycle rule is scoped to the store's own keys** (D17): sixteen
  hex-prefix rules, applied 16 September. Mailbox batches do not expire. Retention
  itself is still an entry.
- **One lock for a document's library record, with one spelling** (D41). Every
  writer of `revision` holds it, and a guard checks.

**Building and testing**
- **Done means it has a caller** (D9). A tested building block that nothing calls
  is not done; the check runs in `npm run typecheck`, and the definition is in
  `CONTRIBUTING.md`.
- **Tests wait for the signal the next step depends on**, not the first observable
  one, and a recovery step that repeats the thing under test destroys the test.
  Both rules are in `tests/README.md`.
- **Tests drive the page by clicking, then someone looks at the screen.** A test
  that calls the API cannot see a control shown by mistake; a passing test cannot
  see how a screen reads cold.
- **Reading the code is the hypothesis; running it is the test.**
- **"Landed" means the CI verdict was read.** Until then it is "pushed, CI
  running". Written down because it was broken the day it mattered: a report
  called three screen changes landed while their run was still going, and the
  verdict two minutes later was a failure on three engines.
- **A change to a shared surface runs everything that presses that surface**,
  found by the control's own id — `grep send-go` — and not by what was edited.
  The same failure's first half: the local set was chosen by searching for the
  ids in the diff, and the six tests that broke reach that sheet through a
  helper naming none of them.

### manifestVersion 3

Decided 5 September, one deliberate bump before any second implementer exists.
Spec §9 is normative for version 3 and was written before any code; the
Python reader was changed from the spec text alone in a fresh context at every
step, and found nine gaps in the text, all closed. The order was readers
before writers: every reader accepts version 3 and refuses unknown versions
as `UNSUPPORTED_MANIFEST_VERSION` before any compiler writes one.

- **Signed set:** the shell leaves it; `signedEntries` is sole authority; the
  reverse reconciliation applies to version 2 too.
- **Fields:** `publisherName`, `supersedes`, `generator` signed and optional;
  `identity` outside the signed set. Carrier labels 12 and 13.
- **Envelope:** untagged, tag 18 accepted; RFC 9338 countersignature slot at
  label 11, verified only against held keys, never a refusal.
- **Trust:** two stores; three states; conflict by three named rules
  (`document`, `mixed-script`, `skeleton`); one content-hashed UTS #39 table
  every host loads; host labels shown first; root lists for organisations.
- **Identity:** Sigstore bundle verified offline against held Fulcio and Rekor
  roots; five checks (chain through CA issuers only, key, timestamp, logged
  signature, logged signer); absent on any failure. A test Fulcio and Rekor mint the
  vectors.
- **Vectors:** 24 cases, 7 trust steps, 9 identity vectors, 2 countersignature
  vectors, all agreed by both readers.

**The flip landed** in `f8b8f8e`, after desktop v0.2.0 shipped the reader and
its installers were published. Every compiler writes version 3 now; version 2
is read and stays in the suite as a regression. What it left open is in part 4:
"Identity: what manifestVersion 3 left" and "CDDL and byte vectors for carriers".

### Decided, 5 September (the four that were undecided)

- **`strict-dynamic`: no.** It stops a nonce'd script being tricked into
  loading an attacker's script from an allowlisted host; this format has no
  allowlist and no network. Recorded in spec §4.2 so nobody hardens their way
  into it. The residual it stood in for is different — with a public nonce, a
  stored value pushed through `innerHTML`, `document.write`, `srcdoc` or
  `createContextualFragment` does execute — and the control for that is
  Trusted Types (`require-trusted-types-for 'script'`, Baseline since
  February 2026 in all three engines). Free for kit-only apps, a lint warning
  for JavaScript apps until they are clean. **Tracked as the item below.**
- **What a model emits: one content rule, two transports.** Content is the
  kit, because it removes the sinks by construction and a grammar only
  constrains shape, which is not where the failures are. Transport is the JSON
  tool payload when tools exist (`create_dai_app`, whose input schema is the
  grammar for free) and the text bundle, parsed tolerantly, when they do not.
  No grammar-constrained bundle is built. Written into the recipe's header.
- **The first capability: deferred by rule, not by argument.** The mechanism is
  decided — an unforgeable `MessagePort`, declared in the signed manifest,
  never network — and the pick is made by evidence: the first capability is
  built when the pilot produces ten apps that are unusable without it. Print is
  the presumptive first. Attachments (4.5) need none; `<input type="file">`
  works inside the sandbox. Spec §4.7.
- **Standards path.** Media type now: `application/vnd.dai` is a vendor-tree
  form, not an RFC; the registration is drafted at
  `docs/media-type-registration.md` and the desktop no longer declares `.dai`
  as `text/html`. Community Group not until the Python reader also writes and
  there is one participant who is not us. RFC never, unless adoption forces it.

### Not doing

- Native phone apps as a prerequisite for first use.
- OS file association or share target as the first-use foundation.
- A smart relay. The moment the store does more than hold bytes, the format
  has a dependency and cannot be self-hosted in an afternoon.
- A marketplace as the distribution model.
- Real-time sync or two-person editing. Succession plus export, never a CRDT.
- **Shapes a session deliberately does not support**, listed so nobody proposes
  them as oversights:
  - *Open participation* — anyone with the link may write. That is the abuse
    surface with no roster to close it: a forwarded link is a new writer, and
    nothing can take the pen back.
  - *Time-bounded participation* — "you may write until Friday." The parties have
    no clock they agree on; an offline copy's clock is whatever it says.
  - *A hub with many private spokes* — one party, many others, each unable to see
    the rest. Not ruled out as a need; it may fold into asymmetric roles (D15)
    rather than become a shape of its own.

---

## 3. Patterns

Not defects. The shapes that keep recurring, and the most reusable thing in this
file.

### The shape that keeps recurring — one thing carrying two identities

Four defects, filed separately because they were found separately, are one
shape. Recorded here as a pattern rather than split across four entries,
because the codebase clearly has a habit and the next instance will not announce
itself as a member of the family. At four it is a property of the codebase, not
a coincidence.

- **D36 — `savedAt` means both "when this was written" and "what it has seen".**
  A copy that only opened and saved outranks a real move made elsewhere.
- **D37 — a key means both "this document" and "this game".** Two people who
  each invited first derived different mailbox addresses and published moves
  the other never read.
- **D41 — a lock spelled two ways is two identities for one lock.** The save
  path took `dai:<uuid>` under a local alias, so a guard reading the source
  reported it as unlocked and every writer that should have held it looked
  unprotected.
- **D56: `u` means both "this document's id" and "the store this link fetches
  from".** `HINT_KEY = "u"` (`src/link.ts`) and `REFERENCE_KEYS.url = "u"`
  (`src/store.ts`) are defined in two files for one fragment. An icon's address
  keeps the hint and loses the store address, so an icon made from a store link
  cannot fetch its document on the one device it was built for, a device that
  no longer holds it.

**What they share.** One stored value, or one name, standing for two facts.
Nothing throws. Each half of the meaning is individually correct, so no
assertion about the *value* catches it — D36's clock is a real clock, D37's key
opens a real mailbox, D41's alias takes a real lock. The failure appears only
where the two meanings diverge, and by then the symptom is two copies
disagreeing, or a guard reporting the opposite of the truth.

**Why it is hard to see.** Each one reads perfectly at the line where it is
written. The ambiguity lives between two call sites that never appear on the
same screen.

**What has actually caught instances.** Not unit tests on values. A test over
the *shape* (`library-record.spec` reads every library write), a breadcrumb that
prints which of the two meanings is in play (the lane line names whether an
address came from the game's key or the document's), and a guard that fails when
a second spelling appears. When an instance is found, the fix is to collapse the
two meanings into one — one spelling, one owner — never to teach the checker
about the second.

**The question to ask of a new stored field or name:** can this be read as two
different facts by two different callers? If so, either split it into two fields
or give it one owner, before it is written twice.

**The cheap prevention, for names: check for a collision where a name is
defined.** D56 is the plainest case. A link's fragment is one namespace written
by three definers: the inline carrier, `REFERENCE_KEYS`, and `HINT_KEY`, each in
its own file, with nothing that sees all three. One registry of fragment field
names, or one assertion that no two definers share a key, would have refused `u`
the day the hint was added. The same applies to any namespace several modules
write into: `localStorage` keys, `dai:` lock names, IndexedDB store names.
**Built for the fragment, 17 September:** `src/fragment.ts` holds the
fragment's `key=value` fields and refuses to load on a collision (D56). Not the
whole namespace, as first claimed: the head script, `#handoff` and the service
worker read or write the fragment outside it (D58, and the file says so). The
other namespaces named here are not covered yet.

### The other shape that keeps recurring — a check that passes for a reason unrelated to what it claims

Eight instances, found in eight different kinds of check. Recorded as one pattern
because each looked like a different accident and none of them was.

- **A probe that could not tell "nothing" from "I could not look" (D37).** It
  returned an empty list when a dynamic import failed, then when it guessed a
  database name, then a version. Each empty result read as a finding about the
  product. The rule that came out of it is in D37: a probe must be able to say
  it failed.
- **A tier that passes by running nothing (D40).** `test:commit` on a clean tree
  prints "nothing a spec reaches changed" and exits 0. The green means no spec
  was asked, not that none failed.
- **A test that agreed by accident (D15).** "A refused write left nothing
  behind" is a claim about the rows *this copy* wrote; the assertion counted the
  whole table. It passed locally because the relay had not delivered the other
  party's legitimate rows yet — a reason with nothing to do with whether a
  refused write leaves anything. In CI the relay had delivered, and it failed on
  a feature that was working.
- **A test that could not fail for any reason that mattered (model file size).**
  Written beside the budget check: "the prompt form of the model file contains
  the model file". The prompt form is built as the file plus one line of text,
  so the assertion restated how the string is built and could not catch anything.
  It was removed before it was committed. The earlier three passed by accident on
  a given run; this one was built unable to fail at all.
- **A test that asserted the defect as the expected behavior (D36).**
  `returning-document`, "opening your own copy after they moved does not make
  yours look newer", had him make a move of his own, then expected her copy to
  open over it. Neither copy had seen the other, so that was a genuine
  divergence, and the test required a silent pick that dropped his move. It
  passed, and what it passed for was the bug. It stayed green as coverage until
  the fix refused the divergence and the test went red for being right. This
  one is the sharpest of the five: the others agreed by accident or could not
  disagree, and this one encoded the loss as the spec. Reading a test's title is
  not enough; read what its assertions would require the product to do, and ask
  whether that is what anyone wants.
- **A test that checked a thing was built, never that it worked (3.5, D56).**
  `reference-link.spec`, "the home-screen icon for a document that came by link",
  reads the icon's `start_url` and asserts its parts, including
  `toContain(`u=${built.manifest.documentUuid}`)`, which is the collision that
  breaks it. It never launches that address on a device without the document,
  which is the one case the icon exists for. D36's test encoded a defect in a
  behavior; this one encoded a defect in an address, by asserting its shape.
  What caught it was launching the address in empty storage.
  **The fix produced a variant, recorded here:** a rename emptied a test without
  failing it. `returning-document`'s icon test spelled the old key, so after the
  rename its trap was never set, and it stayed green over the regression it
  exists to catch. The defense is the same as the pattern's: make it produce its
  other answer. Here that meant putting the old behavior back in and watching
  which version of the test noticed.
- **A wait that measured a size instead of the thing it waited for (D71).**
  `sectioned-mount` waited for "the save with the row" by polling until the
  stored database was over 1,024 bytes. Every save of that document is 16,384
  bytes, with the row or without it, so the first save satisfied the wait, and
  on Firefox the test read a database without the row. **The byte check was
  itself the fix for the previous sighting of the same race** (WebKit, a sleep
  replaced by a wait). The fix obeyed "wait for the signal the next step
  depends on" in form and chose a stand-in the real state never had to reach.
  Now the wait reads the row out of the exact bytes. Proved the right way: with
  the bytes made to lack the row while the screen still shows it, the test fails
  *at the wait* (expected 1, received null), not later at the second runner.
  The lesson for a fix to a flaky wait: say what the next step needs, then check
  that the new condition cannot be true without it.
- **A wait on saves asked, commented as saves acknowledged (d22).**
  `d22-reopen:132` waited on `__runner.saves` before reopening, with the comment
  "a save is acknowledged". `saves` is `hostSaves`, incremented on the line that
  logs "asked". So the test reopened as soon as a save was *requested*, and on a
  slow CI Firefox the reopen landed before the write. The copy came back under
  the sender's id: the exact corruption the test exists for, reached through its
  own wait, and read for a week as a rare unexplained flake. **The earlier
  ruling-out used the same wait, so it could not see the race.** "The reload
  beating the adoption's save: twelve runs, every one kept B's id" asked
  whether a reload after `saves > 0` loses the id, and `saves > 0` was true
  before the write either way. The fix is `__runner.savesWritten`, counted where
  "written" is logged. Of the two tests reading `saves`, this was the one
  confused; `schema-run` counts saves asked, after waiting for the "Saved"
  label, which is what it means.

**A rule, because this one has a preventable cause: tests import the constants
they assert on.** The other instances were found by forcing a check's other
answer. This one has a mechanism. Every literal a test spells out in place of a
product constant (a fragment key, a storage key, a lock name, a message) is a
wire that a rename can cut. The test keeps running, keeps passing, and the suite
reports the same count either way. An imported constant moves with the rename;
a spelled one silently stops being connected. So when a test needs a value the
product defines, it imports that value. The exception is a test whose subject
*is* the literal, such as a frozen byte vector or a published format string. It
spells the value on purpose, and says so.

**The same family, in a search: a search that did not run looks like a search
that found nothing.** The first sweep for the old key missed both of those
tests because shell escaping mangled its pattern. It returned no matches, which
read as "none left", the same failure as the probe that could not tell empty
from unreadable (D37). What found them was matching exact literal text, and for
an edit, a script that states how many times each replacement must match and
refuses to write anything if one count is wrong. A search that can come back
empty should be one that can also be seen to have run.

**It is a class, not a one-off: a tool that answers confidently about something
it never looked at.** Four instances in one week, all on the tooling side of
the work:
- **The probe (D37)** returned an empty list when its import failed, then when
  it guessed a database name.
- **The search (D56)** returned no matches because shell escaping mangled its
  pattern.
- **The mutation runner (18 September)** passed a test-name pattern to
  Playwright through a shell, unquoted. The pattern split into words, so one
  "proof" ran a different set of tests, and reported that they passed.
- **The load-check proof (D68, 18 September)** passed an inline script through
  a shell to load `src/bridge.ts` after each mutation. The shell mangled it, so
  the script never ran. Both mutations "refused to load", which was the wanted
  answer, and so did the **unmutated** file, which should have loaded. The
  exit code reported a failure the script never reached. A `=>` in it was also
  taken as a redirect, and left two empty files in the repository. Only running
  the unmutated control first exposed it: a check that fails on the correct
  input has not tested anything. Redone with the loader in its own file and the
  control required to print `LOADED 28 names` before any mutation counted.

- **The test run against a stale build (19 September).** `reuseExistingServer`
  is on locally, so a preview server left from an earlier run is reused — and
  the build step in its command is skipped with it. A run then tests the build
  that server started with. `sender.spec` failed twice against a website built
  before the runtime changed, and the failure read as the change; everything
  else that day ran green against pages that were equally old, which reads
  exactly like a green run. **A green run against a stale build is
  indistinguishable from a green run** — nothing in the output says which build
  answered. Guarded now in `tests/global-setup.ts`: when a server is already
  listening and the build it serves is older than what builds it, the run is
  refused with both timestamps and the ports to stop. Proved both ways — with a
  stale server up the run refuses before a test starts, and with it stopped the
  same spec runs. The guard's own first version was an instance of this
  pattern: it asked `127.0.0.1` while the servers bind `localhost`, which on
  Windows answers on `::1`, so it reported no server and stayed silent.

**None of them complained.** Each produced a well-formed, plausible answer.
The tell was never the tool; it was arithmetic or a stray detail beside the
answer: "125 passed" for a proof that should have run one test, and a test
failing in a full run after the search had said nothing was left. A near
relative from the same day: a proof run aimed at the wrong case (a raised count
floor, which was already caught). Its `run.txt` said `failed: playwright exited
1`, which is why it proved nothing about the gate, and only that line gave it
away.

**What to do about it.** Make tools state what they looked at, not only what
they found: the count of tests a proof ran, the files a search opened, the
number of matches an edit expected. Then read that before reading the answer.
A proof that should run one test and reports anything else has not proved
anything. Pass patterns to child processes as arguments, never through a shell
string. And when a result would be good news, check the arithmetic first.

**A near relative: a sampling method that overwrites its own samples.** For
D28, three CI runs were taken as `gh run rerun` of one run. Each attempt
replaced the previous attempt's saved artifacts, so when the third finished,
only its traces existed. One of run 2's failures (`returning-document:192` on
Firefox) could then never be read: its evidence had been destroyed by the
method that was collecting evidence. The logs survived, the traces did not, and
nothing said so until the download was attempted. It is D47's lesson one level
up. There, a local rerun erased `test-results/` before anyone read it, and the
fix was a keeper that copies the evidence aside before the next run. Here the
fix is the same move at CI's level: a separate, fresh run for each sample (an
empty commit per run, or a new branch run), or each attempt's artifacts
downloaded before the next attempt starts. The general question: **does taking
the next sample destroy the last?** If so, the method cannot take a rate.

**The corollary: a check like this is worse than no check.** An absent test is
visibly absent. A test that cannot fail counts as coverage, sits in the totals,
and is trusted in review, while proving nothing. A suite can get quietly weaker
while its numbers go up. Before adding a test, name the change it would catch; if
there isn't one, don't add it.

**It was first seen before this week.** In September's first CI repair, three tests
asserted a lower-case filename the compiler never produces, and one of them asserted
the *absence* of a file under a name the compiler would never write. It could not
fail on Linux at all, so it would have passed however wrong the code became. The
same repair left a second lesson that belongs with this one: a green local run is
evidence about one machine. Before this week, "506 passing" was reported for
thirteen commits from a local run while CI was red.

**What they share.** Each check produced the answer its author expected, for a
reason other than the one it was written to test. That is why they are dangerous
rather than merely wrong: a check that fails for the wrong reason gets
investigated, and a check that passes for the wrong reason gets trusted.

**What has caught them.** Not a second look at the green. In every case, making
the check produce its *other* answer on purpose: forcing the probe to report its
own failure; asking what a tier ran rather than what it returned; and, for the
roles test, putting the broken assertion back with delivery forced and
reproducing CI's exact failure locally — which turned "I think this is why" into
"this is why". A check has only been proven when it has been seen to go red for
the reason it claims to guard, and green when that reason is absent.

**The question to ask of a passing check:** what else would make this pass? If
the honest answer is "the thing it checks for not having happened *yet*" — a
relay not delivered, a module not loaded, a spec not selected — the check is
agreeing by accident.

- **A test project chosen by a word in a comment (24 September).** Playwright's
  `node` project is every spec whose text never says "page", "browser" or
  "context"; a spec that does is sent to the browser projects instead, where a
  test with no `page` fixture runs as a node test would. `tests/seal.spec.ts`
  said "the page is killed" in a comment, left the node project, and its first
  "pass" was the file never running under the project it was run with. The fix
  is not rewording comments: it is making project membership explicit, a list
  or a path convention, so a file cannot fall out of a project by prose (D110).
- **Reference readers that agreed on everything while covering nothing (24
  September).** After the identity sitting's step 3, the Python and Rust merge
  readers agreed with the TypeScript on every merge vector while neither
  handled a seal at all: no vector carried one, so agreement said nothing about
  seals, and Rust would have refused honest sealed rows as tampering. **The fix
  was adding cases the readers had to disagree on** (two vectors with real
  signed batches, and the headers in the canonical dump), watching both readers
  fail, and then bringing them level. The reusable lesson: agreement between
  implementations is evidence only for what the vectors exercise.
  A second case, same day: the Rust reader looked a row up in another table by
  the arriving row's column positions, and agreed everywhere until the vectors
  first used two shared tables (identity step 4 review; fixed in aaed42c).
- **A tool that reports success for work it did not do (21 September).**
  `context.setOffline(true)` stops a loopback request on Chromium and does not
  on Firefox: the call returns, the flag reads as set, and the publish goes
  straight through to a relay on `localhost`. A test written on it does not
  fail — it stops being a test of anything, because the connection it cuts was
  never cut, and the code path it exists for is never entered. It belongs to
  this pattern rather than to a Firefox bug list: the danger is not that the
  call is broken, it is that the green stays green. Found writing D46, where
  the cut is now made by refusing the append at the relay, which every engine
  sees the same way; `tests/offline.ts` is still right for cutting a real
  network to test serving from cache. **The general form:** when a test's setup
  is an instruction to the browser rather than something the test can observe,
  assert the setup took effect before trusting what follows.
- **A red that was red because a race was lost (D117, 25 September).** Two
  WebKit iPhone tests were filed as the known reds of a lost key, and failed on
  every local run; on CI they passed, because CI's machine won the race between
  a mailbox starting and the relaunch that throws the page away. The red was
  true of this machine's timing, not of the defect, and the green on CI would
  have been read as the bug not existing. The fix to the test was the one from
  the phone race of 9 September: force the losing order (the relay reaches only
  the load after the relaunch) instead of hoping for it. A red is proven the
  same way a green is: on the reason it names, whatever wins the race.

### A third shape — a breadcrumb written before the thing it describes

One instance so far, kept here because the reasoning generalizes past it and
because breadcrumbs are what this project reaches for when a product bug cannot
be reproduced.

- **D46, 21 September.** `pending send retried by the poll timer` was written at
  the top of the retry, before the send was attempted. It read as a record of a
  retry; it was a statement of intent. So the trace claimed a send had been
  retried while the connection was still cut, and the test's own assertion —
  that nothing is reported as retried during a cut — failed on CI on Chromium
  and Firefox after passing locally every time.

**What makes it a shape and not a slip.** A line written before its subject is a
prediction, and a prediction is wrong exactly when the thing fails — which is
precisely the run someone is reading the trace to understand. The breadcrumbs
are then most misleading in the only case they exist for. It is the mirror of
the two-identities pattern: there a value means two things, here a line means
"about to" and is read as "did".

**The rule.** Write the line after the thing succeeds, and name what happened,
not what is about to. Where the attempt itself is worth recording — a retry loop
a reader needs to know is running — say so once, in words that are true at the
moment they are written ("still failing; retrying every 3s"), and stay silent
after: a line per tick buries the one that matters, and repetition is not
information.

**The question to ask of a breadcrumb:** if the next line of code throws, is
this line still true? If not, it is in the wrong place.

---

## 4. The work

Everything that could be built, defect or feature; the distinction does not change
how it is handled. Each entry's status is one of: `open`, `ruled — not built`,
`waiting on <the specific thing>`, or `parked — trigger: <what un-parks it>`.

### When an entry is picked up

These questions are **surfaced, not gates**. They do not block a build, and they do
not need an answer before work starts. Where the answer is obvious, one line.
Where it is not, say so and raise it: a named unknown is the point, and an unknown
that stops the work is not. The decision is still made, and the work moves.

1. **Does a person understand what happened?** Every real defect in the week of
   15 September was silent: the invite that dropped games, the stale copy that
   resumed, the badge that did not clear. The harm was never only that the wrong
   thing happened; it was that nothing said anything.
2. **What does this change about what someone else can see or infer?** D45's
   relay-visibility cost came from asking exactly this.
3. **What already-built thing does this touch?** Roles touched the merge path.
   Per-game keys silently disabled the mailbox. Both were found late.
4. **What can a test not see here?** Operating-system state, a screen, a first
   impression. The badge's two holes passed CI and `test:push` and were found with
   a phone.
5. **What does an author have to know that is not written down?** `author=` existed
   undocumented for a day.

### Screens: decide before building

The pattern in Request's eight problems was one reflex: something needs to be
possible, so put a control on the screen. A "New request" form under an open
request, a Save button per answer, a full-size "Remove question" beside a live
answer. Each was a true statement about what the app can do, arranged in the order
it was built. That is utility-first, and it is the wrong starting point. For any
entry that touches a screen:

- **Every screen has one primary action.** On Request's answerer view it is "Send
  answers back". Everything else gets smaller, moves, or disappears until it is
  needed. That rule alone would have removed three of the eight before a screenshot
  existed.
- **Write the screen down before building it.** For each side: what it is for, the
  one thing a person does, what they see in what order, and what is deliberately
  absent. A paragraph per screen, not a mockup, in the entry before the code.
- **The screenshot pass stays, as confirmation rather than discovery.** Tests click
  through the page, then someone looks at the screen.
- **Beauty is a requirement, not polish.** A thing that works and looks unconsidered
  does not get shown to anyone, so it is never held by someone who is not us, which
  is where every real defect has come from.

### Silent loss and divergence

#### D36 — Two copies that cannot merge carry no lineage

*Status: waiting on a ruling that allows a format change.*

The decision is in part 2. What it cannot see: an arriving copy carries a stamp and
a database, not where it came from, so "further along" means "stamped later than
the last match", not "descended from it". A reply built from an older copy can still
be taken silently, which is the behavior before D36, not a new loss. Making it exact
means each copy carries its own lineage, which is a change to the format and the
inline carrier. The decision is `src/copy-choice.ts`; its evidence and tests are in
the commit that built it, `9815648`.

#### D46 — A move that failed to send waits for the next write, not for the connection

*Status: fixed, 21 September.* The poll timer retries a pending send. The
sealed bytes already saved are sent again — not a fresh ask of the frame, which
would re-seal and defeat the relay's dedup by digest — and the breadcrumbs name
the timer: `send failed at <address>; kept pending`, then `pending send retried
by the poll timer`, then `watermark published by the poll timer's retry`. The
sentence on screen ("it will send when the connection returns") and
`MAILBOX_APPEND_FAILED`'s wording are now true, so neither changed.

**Proved** by `mailbox-mechanism`, "a move that could not be sent goes when the
connection returns, with no further writes": the relay refuses the append, B
plays one move, **nothing else happens** — no write, no pull, no reopen — the
relay accepts again, and the timer carries it; A sees the move without being
told to pull. With the retry removed it fails at "the poll timer retried the
send" on Chromium and Firefox.

**A note on cutting the connection:** `context.setOffline(true)` stops a
loopback request on Chromium and **not** on Firefox (measured 21 September; the
publish went through and nothing failed). So this test refuses the append at the
relay instead, which every engine sees the same way. `tests/offline.ts` stays
the way to cut a real network for serving-from-cache tests.

**Caught by CI on both engines, and worth keeping: the first breadcrumb named an
intention, not an event.** `pending send retried by the poll timer` was written
before the send was attempted, so it appeared while the connection was still
cut — and the test's own assertion, that nothing is reported as retried during
the cut, failed on Chromium and Firefox. Locally it had passed every time.
- **Fixed** by writing the line after the send succeeds, and by giving the
  failing case a line of its own that is true when written: the **first** failed
  retry says `pending send still failing at <address>; retrying every 3s`, and
  every tick after it is silent until something changes. The interval is read
  from the live poll rate, not written into the sentence, because the poll slows
  as the page sits idle and a fixed number would become a lie by the second
  minute. A fresh send failure starts a fresh outage, so the line may speak
  again.
- **The local pass is fixed, not waited out.** The first attempt at a local
  guard counted refused appends and waited for a second one, reasoning that the
  publish path tries once so anything further is the timer. That was wrong — a
  move publishes on more than one lane, so refusals arrive in a group with no
  tick involved — and it did not reproduce the red. The new failing-retry line
  is the signal that was missing: the test waits for it, which is proof a tick
  ran inside the cut, and only then asks what was reported. **Reproduced
  locally with that wait in place:** putting the breadcrumb back above the
  attempt fails on Chromium exactly as CI did, and making every failed tick
  speak fails at "the ticks after the first carry no new fact and stay silent",
  2 where 1 is expected.
- **The general shape,** which is worth remembering: a breadcrumb written before
  the thing it describes is a claim about what is about to happen, and it will
  be wrong exactly when the thing fails — which is the case anyone reading the
  breadcrumbs is investigating.

*Status: open.*

Open, not ruled. Found writing D34's clear-on-move test.

When a publish to the relay fails, the mailbox session keeps the sealed batch
pending and says "A move could not be sent yet; it will send when the connection
returns." Nothing makes that true. The batch is sent again only when this copy
writes something else (a later move, a rename) or when the document is next
opened. The polling timer pulls; it does not publish. So a move made with no
connection, followed by nothing, sits on this device while the other player waits,
and the message says it will send on its own.

The question: whether a pending publish is retried on the poll or on regaining a
connection, or whether the message changes to say what actually happens. Either
way, the sentence and the behavior have to agree.

#### D18 — Nothing can tell a hole in a mailbox history from an empty stretch

*Status: parked — trigger: D17's retention decision (see the entry for the rest).*

The property that makes D17 silent. The relay's `since` returns the batches whose
objects it can find and the cursor at the end (`mailbox-do.ts` skips a missing
object); the host's `catchUp` moves its cursor to that cursor
(`src/mailbox-sync.ts`); and the merge has no way to notice rows that never
arrived. It could not use the sequence numbers either: a replica's rows are
numbered across every session it writes in, and an invite carries one session's
rows, so a gap in the numbers is normal and says nothing. The only
`…Gap` check in the merge (`mergeCoverageGap`) is about tables, not history.

Why it matters: a missing batch and a batch never written look the same from
every side, so any loss in the relay — an expiry, a failed write, an operator's
mistake — arrives as a quietly incomplete game rather than an error.

The same shape as D50's iOS boundary: gone and never-there look alike. The
difference is that here one party, the relay, can tell them apart. D50 has no
such party.

The relay is the one place that can tell: it holds the counter and knows which
numbers it cannot serve. **Un-parks with D17's retention decision, or with the
first relay change that could lose an object** — `since` names the numbers it
cannot serve, and the host refuses to move its cursor past a hole and says so
("this game's history has gaps here; ask for a new invite") instead of merging a
partial past.

#### D17 — Mailbox batches are deleted at 90 days: silent data loss on a fuse

*Status: waiting on D18 — the rule is applied; retention is undecided.*

Found while checking whether the junk item (D12) would be cleaned up. The
lifecycle rule on `dai-store` — `shared-documents-90-days`, confirmed applied to
the live bucket on 14 September (`wrangler r2 bucket lifecycle list`) — has an
empty prefix. It was written for shared documents, but it covers everything in
the bucket, and the relay writes every mailbox batch there under
`mailbox/<id>/<seq>`. So every batch is deleted 90 days after it was written.
The mailbox has been live since 10 September: **the first real batches go on or
about 8 December.**

This is silent data loss, the same shape as the lost-move bug: the cursor says one
thing and the rows say another. The relay's counter lives in the Durable Object
and does not expire, so `head` keeps reporting every batch while `since` quietly
skips the ones that are gone. A copy that is up to date loses nothing; a device
that comes to a game late — a new phone, a reinstalled app, a copy offline for a
season — catches up from a history with holes in it, and nothing complains,
because a missing row is indistinguishable from a row never written (D18).

**Stop the clock first** — a console change, not code. `infra/r2-lifecycle.json`
now holds the rule scoped to the store's own objects: sixteen rules, one per hex
digit `0`–`f`. Every store key is a lowercase 64-hex hash (the presign route
refuses anything else), with `.json` and `.png` beside it, and preview ids are
random 64-hex, so these cover every stored document and never match
`mailbox/`. Mailbox batches then stop expiring; batches already written keep
their age but no longer match a rule. **The maintainer applies it** — it is production
bucket configuration:

    cd apps/relay
    npx wrangler r2 bucket lifecycle set dai-store --file ../../infra/r2-lifecycle.json
    npx wrangler r2 bucket lifecycle list dai-store

— and the list should show sixteen `shared-documents-90-days-<digit>` rules and
no rule with an empty prefix.

**Applied, 16 September 2026**, through the Cloudflare dashboard rather than
wrangler: the bucket's Object lifecycle rules. The old empty-prefix rule was
deleted first, so nothing could expire while the replacements went in. Checked
from screenshots of the whole list:
- sixteen rules, `shared-documents-90-days-0` to `-f`, with prefixes `0` to `f`;
- each deletes objects after 90 days and aborts uploads after 1 day;
- every rule is Enabled;
- no rule has an empty prefix, and none matches `mailbox`;
- no bucket lock rules.

The `e` rule was missed on the first pass and added once the list was read back.
That is the reason to read the applied list rather than trust the steps. Mailbox
batches no longer expire. Retention itself is still open, below.

**What stays open: retention must be decided deliberately.** Keeping every batch
for ever is safe while the question is open and is not an answer. The decision
is how long a mailbox keeps its history, and what a copy that arrives after that
is told — which needs D18's relay that can say "these numbers are gone".
Retention was deferred by the ruling; this rule decided it by accident, and the
scoped rule un-decides it.

**Un-parks before 8 December if the scoped rule is not applied — and otherwise
before any game is expected to outlive a retention limit, or a device can join a
long-running game from the mailbox rather than by an invite.**

#### D12 — A relay deploy has a window where a post lands in old code

*Status: parked — trigger: a deploy that needs a new route clients use (see the entry).*

Found deploying push on 14 September. The worker and its Durable Objects change
version at different moments: for a short window after `wrangler deploy`, new
routing was live while a mailbox object still ran the old code, which treats
every POST as an append. A check that posted to the new `/subscribe` route in
that window was stored as a batch instead — `mailbox/subscribe/1` in
`dai-store`, 36 bytes, unreferenced by anything.

The rule is in `apps/relay/README.md`: after a relay deploy, check with a read —
a GET is a read in both versions — and post only once it answers as the new code.

The junk item: left in place. Under the bucket's current lifecycle rule (empty
prefix, 90 days) it would expire with everything else; once D17's scoped rule is
applied, `mailbox/` stops expiring and it stays until somebody deletes it — a
36-byte object nothing reads. Deleting it is the maintainer's (`npx wrangler r2 object
delete dai-store/mailbox/subscribe/1`), and nothing depends on it.

Why it matters: the window is short, but it is exactly when somebody verifies a
deploy, and a relay write is somebody's mailbox.

**Un-parks as a code change if a deploy ever needs a new route used by clients
the moment it ships** — then the worker must refuse a route its objects do not
yet know, or the object must reject a path segment that is a verb.

#### d22-reopen — a reopened copy came back as the sender

*Status: **fixed, 19 September** (`dfc8d31`, conformance `a716445`; CI
35450652603 green on every engine). Escalated the same day: on Firefox CI a
reopened arrived copy came back under the sender's replica id, the
game-killing class (T1-D22/D33), and turned `main` red (run 35410311642). D80
remains: this closes the route the phones took to it, not the forgery.*

**The fix, and its numbers.** The host records this device's replica id per
document before the frame first writes (`replica:<uuid>` in IndexedDB) and
hands it over with the write rules on every mount. The frame writes under it
whatever the mounted file carries. Before: **21 of 21** runs that hit the
window came back as the sender. After: **0 of 15**, with the window hit in 15 of
48 runs (Chromium and WebKit). A run that misses the window skips and says so.
- **The hit rate is lower than before** (31%, against about 60%) and was not
  made equal. The likely reason is that the record's own IndexedDB write, just
  before the first save, speeds that save up. That is not verified.
- **A guard** holds an ordinary reopen to the recorded id, for a copy started
  here and one that arrived. With the frame made to ignore the record, it failed
  on both engines ("A writes under the id recorded for A").
- **`:132` now waits on saves written** (`__runner.savesWritten`), not asked.
  Pattern: the eighth instance of a check passing for an unrelated reason.
- **Tried and dropped:** not writing the library record until the first save.
  It closed the window, but it also un-kept every document that had been
  opened and not yet written. 27 failures, among them `runner:541` ("reopens
  what was open"): open, reload, gone.
- **Not explained:** the overnight local run that surfaced those 27 also hung
  at 1407 of 1412 for three hours with no test timing out. The five queued
  WebKit `push-e2e` tests never started. The in-flight test was probably
  WebKit D80 at `[1407]`, which finished its logging. The line reporter cannot
  say more.

**The route, reproduced 19 September (21 of 21 reached, Chromium and WebKit).** The
condition is a reopen that lands **after the arrived copy's first save is asked
and before it is written**. By then the library record exists, holding the
arrived file, which carries the sender's id. The reopen finds no stored
database, mounts that file as this device's own copy, and keeps the sender's id.
The breadcrumbs match the Firefox CI traces line for line: adopted A → B, "save
1 asked", no "written", then "reopen mounted the library's own copy", then
"replica kept (own copy): A → A". Test: `d22-reopen`, "a reload between the
first save asked and written keeps the copy's own id", which reloads on the
"save 1 asked" line. The write still lands first in about a third of runs (the
old page can unload before it logs "written"); the reopen then reads "mounted
the stored database", and the test skips, saying the window was missed. Every
run that reached the window, 21 of 21, came back under the sender's id. Held as
`test.fail` until the fix.
- **Why CI met it by chance:** `:132` waits on `__runner.saves`, which counts
  saves *asked* (`hostSaves`, incremented where "asked" is logged), and its
  comment says "a save is acknowledged". On a slow Firefox the write lost the
  race. The earlier ruling-out ("the reload beating the adoption's save, twelve
  runs") ran with that same wait, so it could not see it.
- **What it means on a phone:** a joiner who closes or loses the page within
  that window, or whose storage is not kept, comes back as the creator. That is
  **D80's precondition**, and from there the other copy believes every move.
  Not fixed.

**19 September, matched by call from the kept traces.** In both attempts, page
A's trace logs "adopted (arrived copy): none -> 95f8f8fb…" and keeps
`95f8f8fb…` across its own reopen. That is A's id. Page B's trace logs "replica
adopted (arrived copy): 95f8f8fb… -> 3283d704…", and after the reload "reopen
mounted the library's own copy (no stored database)", then "replica kept (own
copy): 95f8f8fb… -> 95f8f8fb…". **B came back as A.** The retry has the same
sequence with its own ids (`3071deb1…` for A, `bdc3395c…` for B). The new
fact is the fallback: the test had waited for B's first save to be acknowledged
(`__runner.saves > 0`), yet the reopen found no stored database and mounted the
arrived file, which carries A's id, as B's own copy. Where the acknowledged
save went is the open question. Traces in the run's
`playwright-report-firefox-whole` artifact.

A cluster of tests fails on Firefox in CI and passes on retry or when run
locally: `cli:88`, `mcp:129`, `mcp:147` (twice on 14 September: the list item
never appeared after a form submit), `website-checks:93`, and — the one that
matters — `d22-reopen:132`. They read as CI load and timing, not product defects, so they
are watched rather than chased: a test that passes on retry costs less than a
consistent red, and the hard cross-engine failures came first.

**`d22-reopen:132` is not a flake. It is a confirmed corruption, not yet
explained.** It guards the bug that killed games: a reopened arrived copy must
keep its own replica id (T1-D22/D33), because a copy that writes under another
replica's id collides with that replica's rows.

On 14 September (run 34896291954, Firefox, two workers) it failed once and passed
on retry, and for the first time CI kept the trace (D27). The trace shows device B
open the arrived copy and adopt its own id (`ba40f82d…`), and after a reload come
back as **`4e5cbefd…` — device A's id.** That is matched by call, not by value:
`4e5cbefd…` is what page A's own reads returned, before and after A's own reopen.
So this is not "the id changed". **The copy came back as the sender** — the exact
corruption the test exists for, where B's next move collides with A's rows. It
had happened before: 13 September (run 34791102890), the same assertion, Firefox
CI, passing on retry.

**19 September (run 35410311642, `5ae32d0`, a backlog-only push, Firefox 155; matched above):
failed and failed its retry**, the first time it has not passed on retry. It
turned `main` red. Same assertion: B's id before the reload was `3283d704…`;
after it, `95f8f8fb…`. The opener's own breadcrumb says "replica kept (own
copy): 95f8f8fb… -> 95f8f8fb…", so the reopen kept whatever it mounted.
`95f8f8fb…` is A's id, matched by call (see the top of this entry). The
retry has the same shape with its own ids. Both traces are kept in the run's
`playwright-report-firefox-whole` artifact. The run before it (`e875d6c`, same
runtime) passed this test. Not investigated: held behind the iOS icon
regression.

Ruled out, each by evidence — do not propose them again without new evidence:

- **A slow library read turning the reopen into an arrival.** A reload remounts
  through `launchFromLibrary`, which sets "own copy" directly; it never makes
  the storage-dependent resume decision.
- **The reload beating the adoption's save to storage.** Twelve runs, chromium
  and Firefox at four workers, reloading B with no wait for any save at all:
  every one kept B's id.
- **The two-tabs revision guard refusing the save.** The trace has no refusal
  message, no error acknowledgement and no failed save state. (The one "Not
  saved" in it is a comment in the page source.)

Not reproduced locally: twelve runs on Firefox at four workers passed ten; the
two failures were at a different step (the first open), not the id.

What the trace could not show is *why*: the replica decision is made inside the
frame, and which database the reopen mounted and whether the save landed were
visible nowhere. `2eb401e` logs all three to the console, permanently — the
frame's decision with the id before and after, each save asked and written, and
which database a reopen mounted and where it was read from — and D27 keeps the
trace. The next sighting should read `kept (own copy): <A's id> -> <A's id>`,
next to the database that reopen mounted. Until then, leave it: the evidence has
been taken as far as it goes. The cost of a wrong "flaky" call here is a game that
loses moves in the field.

### Storage eviction

Six entries from one review, filed together because they are one situation seen
from six places: the browser sweeps this device's stores, and the opener has no
idea it happened. Nothing here is ruled yet.

**What holds for all six.**

- **No wipe detection exists anywhere.** `TrustStorageUnavailable` is the only
  storage condition the code names, and it covers one thing: the trust store
  could not be reached. An IndexedDB that opens cleanly and is empty is
  indistinguishable from a fresh device, and every path treats it as one.
- **All of it is script-writable, and all of it is subject to ITP.** `opfs.ts`
  keeps the library, the pins, the publishers and the mailboxes in IndexedDB
  (`dai_runner_storage`; stores `sqlite_databases`, `cartridges`, `pins`,
  `publishers`, `mailboxes`). The one correction to the review: the file does use
  OPFS for a document's database bytes — `saveDatabaseToOpfs` writes a
  `<uuid>.sqlite` file through `navigator.storage.getDirectory()` and falls back
  to IndexedDB only when that is unavailable or throws. That does not change the
  conclusion, because OPFS is script-writable origin storage too and is swept by
  the same eviction. It changes the *inventory*: a wipe takes both the file and
  the fallback, and a partial sweep could take one and not the other.
- **The seven-day phone test cannot be repeated until D49 is built.** See D49.
  Any entry here that would be answered by a device reading is waiting on that,
  not on a decision.

#### D49 — Persistence is asked for at boot and the answer is thrown away

*Status: open. It blocks any repeat of the seven-day phone test.*

**What it means to a person:** whether the documents on this device survive a week
of not being opened is decided by the browser, and nobody — not the person, not
the opener — can find out which way it was decided.

`apps/runner/src/main.ts:92`, the whole of it:

```
// Storage Eviction Defense: call navigator.storage.persist() on boot
if ("storage" in navigator && typeof navigator.storage?.persist === "function") {
  void navigator.storage.persist().catch(() => {
    // Permission denied or non-fatal failure
  });
}
```

Three things are true of those five lines:

- It runs at page boot, **before any document is open**. That is the weakest
  moment for the browser's heuristics: no engagement, no install signal, nothing
  the person has done with this origin yet. It is the request least likely to be
  granted, made at the only moment the code makes it.
- `void` and the empty `catch` **discard the result**. The promise resolves to a
  boolean saying whether the origin is now persistent, and that boolean is
  dropped on both paths.
- **`persisted()` is never read anywhere.** Nothing on the device records whether
  either context is durable.

**The consequence to record explicitly: the seven-day phone test is
uninterpretable.** It measured an install whose persistence status was never
known, and what it saw is the expected outcome for an unpersisted one. It is not
evidence of a defect and it is not evidence against one. It cannot be rerun into
an answer either, because a rerun would measure the same unknown.

**The tab and the home-screen install are separate contexts and can be granted
differently.** A grant read in one says nothing about the other, so both need
reading, and a device check has to say which context it was in.

**The screen, written before the code.**

*What it is for:* letting a person — or a person holding a phone days later, with
no cable and no inspector — say whether this device's documents are durable, and
which context they are answering for.

*The one thing a person does:* read one line. There is no control, because there
is no decision to make here: the browser grants persistence or it does not, and a
button that asked again would be a control that usually does nothing.

*What they see, and where:* one quiet line beside the build stamp, in the same two
places and for the same reason the stamp is in both — the menu sheet
(`#sheet-version`), and the chooser (`#chooser-version`), because the person who
most needs to read this is the one whose document is gone, and that person is
looking at the chooser, which has no menu. It names the context and the answer:
`kept on this device · installed` / `not kept · tab`. Failure is silence, exactly
as `showVersion()` does it: a browser that cannot answer says nothing rather than
apologising for a diagnostic nobody asked for.

*It survives a page load by being re-read, not remembered.* `persisted()` is a
live question with a live answer, so the line is read again whenever it may have
changed: at load, and once more when the boot request settles. Storing the last
reading would be worse than useless: the store holding it is the store under
discussion, and a wipe would take the reading with the thing it described.

**Corrected 18 September: two claims in `b6ff876` were not true of the code until
now.** A review of `454858c..7abb896` found them. Both are fixed, and the claims
are true as of the fix, not before it.
- **"Gathered on render" and "read live, never cached."** The line was read once,
  at load, at the same time as the boot request, and never again. On a device
  that granted the request, the screen said "not kept" for the rest of the visit.
  The first launch after installing is when this is read before a multi-day
  phone test, so the next test would have measured something other than what
  the screen said, which is the entry's whole purpose defeated. Fixed: the line
  is read again when the request settles, and the newest reading wins, so a slow
  earlier one cannot land after it. Tests: "when the boot request is granted,
  the line on screen says so" and "a reading asked before the grant cannot land
  after it". Each fails with its fix removed (`"not kept · tab"` where `"kept
  on this device · tab"` was expected).
- **"`null`, not `kept:false`, when the browser will not answer."** That was
  true of `readPersistence` and not of `askToPersist`, which turned a rejected
  `persist()` into `kept: false`. "The browser refused" and "the browser would
  not take the question" are the distinction this entry is built on. Fixed:
  the request has its own type with three answers (`kept`, `not kept`, `not
  taken` with the browser's reason), and the breadcrumb keeps them apart. Test:
  "a request the browser would not take is not reported as a refusal". It fails
  with a rejection collapsed back to "not kept".

*Deliberately absent:* any explanation of eviction on the chooser, any "your data
may be deleted" warning, and any request button. The line is a reading. What a
person should *do* about an unpersisted device is D53's sentence — keep the link —
and it belongs where that is said, not here.

The launch details panel (`launchDetails()`) gets the same two facts as a line,
which is free: it already exists for exactly this argument ("a phone has no
inspector, so 'it hangs' is all a report can say without this"), and a stalled
launch on a wiped device is a case worth having it in. That is a second surface,
not the primary one — it only appears when a launch stalls.

When it is picked up:

1. *Does a person understand what happened?* No, and neither does anyone else.
   This is the entry that makes the rest of the cluster answerable.
3. *What already-built thing does this touch?* `showVersion()` and the two version
   slots; `standalone()` in `platform.ts`, which already knows the context and is
   used for nothing like this today.
4. *What can a test not see here?* Whether a grant is real. Persistence is a
   browser decision made from operating-system state and engagement history, and
   no test can grant it or observe the true one — headless Chromium grants it
   freely, which is the opposite of the case that matters. What a test *can* see
   is that both contexts are distinguished, that the result is recorded rather
   than discarded, and that a browser without the API says nothing. Prove the
   guard both ways: the line must be absent when the API is missing, not blank.

**Built 17 September; CI on 18 September found what Chromium could not.** Run
35335170825 failed three D49 tests on Firefox and three on WebKit. Chromium,
the only engine run locally, passed. A probe on all three engines showed two
different causes:

| Engine | `navigator.storage` | `persisted()` | `persist()` |
|---|---|---|---|
| Chromium | present | `false` | `false` |
| Firefox | present | `false` | no answer after 5 s |
| WebKit (Playwright's build) | absent | — | — |

- **Firefox: a flaw in the build.** The boot code awaited the request before
  writing the standing reading, and Firefox can leave `persist()` unanswered,
  most likely on a permission prompt. That part is inferred: no answer was
  seen, not a prompt. So neither line was written, on the engine where the
  question is visible to a person. Fixed: the reading is independent of the
  request, and the request is written down when made ("asked at boot; waiting
  on the browser") and again when answered. A test holds it ("a request the
  browser never answers does not silence the reading"). With the old chained
  order put back, it fails on all three engines, reproducing CI's Firefox
  failure without depending on Firefox's timing.
- **WebKit: the product was right; the tests assumed the API exists.** With no
  Storage API, the opener said nothing, exactly as designed. The tests now stub
  the answers they need and run identically on every engine, rather than
  skipping one. What a real browser grants stays a device reading. Real Safari
  does have the API, so this is about the test engine, not the product.

#### D55 — When persistence should be asked for

**A sighting to keep, 19 September (one, not yet a pattern):**
`runner.spec.ts:1138`, "an icon per document, not for every…", failed on
Firefox in CI and passed on retry: `#keep-cta` never took its `nudge` class
(`expect(locator).toHaveClass(/nudge/)`). The nudge is the offer to keep a
document, raised on first use, which is the moment this cluster is about.
Trace kept in run 35488662772, artifact `retried-firefox-whole`,
`runner-keeping-it-per-devi-9428f-s-per-document-not-for-ev`. Not
investigated, and not tied to the D79 change: that defers a redraw, and the
nudge is raised from the kit's first-use signal, which it does not touch.


*Status: ruled and built, 21 September. The phone reading is what remains.*

**Ruled: the request is made after the first thing worth keeping is written,
never at boot.** Built in `main.ts` — `askForPersistence()`, called from the save
path once a save is written, once per page, and never for the document's own
setup SQL, which every copy runs and nobody would mind losing. The *reading*
stays at boot: it asks the browser nothing and answers a question somebody can
be looking at before they have written anything (D49).

**Proved** by `tests/storage-persistence.spec.ts`, "is not asked at boot, nor on
opening a document, but after the first thing worth keeping": three moments in
order, because a test that only checked the end state would pass with the
request back at boot. Opening a document is in the test deliberately — it is the
obvious place to move the request to, and it is still before there is anything
to lose. Proved the other way by putting the ask back at boot, which fails at
"nothing is asked for at boot".

**What no test here can see, and it is the whole point of the change:** whether
moving the moment changes what a browser answers. That is engagement heuristics
on a real device; a headless Chromium grants freely, the opposite of the case
that matters. The phone reading this entry has always wanted is now the only
thing left in it.

---

*Status before the ruling, kept because the reasoning is the record:*

**What it means to a person:** whether the browser says yes when the opener asks
for durable storage depends almost entirely on when it asks, and today it asks at
the worst available moment.

D49 is about reading the answer. This is about the question: `persist()` currently
runs at page boot, before any document is open, with no engagement, no install
signal and nothing the person has done with this origin. That is the request least
likely to be granted, made at the only moment the code makes it.

The candidates, none ruled:

- **After a first save.** The person has made something. Strongest engagement
  signal, and the latest of the three.
- **After a first open.** Earlier, weaker, but it covers a document that is read
  and never written.
- **On install / on keeping a document as an app.** The clearest statement of
  intent a person ever makes here, and the moment Chrome's own heuristics weight
  most heavily. It is also the context that matters most (see D49: the installed
  context is the one a home-screen icon launches into).

It could be more than one of these; asking again after a refusal is cheap and the
answer can change as engagement accumulates.

**Why it is not folded into D49.** D49 is a reading, and it is correct whatever
this is ruled to be. Changing *when* the request happens changes the outcome being
measured, so doing both in one commit would mean the first reading taken is a
reading of a thing that has just changed. D49 first, then a reading, then this.

When it is picked up:

2. *What does this change about what someone else can see or infer?* Nothing; the
   request is local and invisible.
4. *What can a test not see here?* The thing that matters. No test can tell a
   well-timed request from a badly timed one, because the heuristic is the
   browser's and a test browser grants freely. This one is answered by a device
   reading before and after, which is why it waits on D49.

**A fact for the ruling, from CI on 18 September: on Firefox the request may
be visible.** In automation, Firefox left `persist()` unanswered for as long as
it was watched. The likely reason is that it asks the person with a permission
prompt rather than deciding on heuristics as Chromium does. That is inferred
from the missing answer, not seen on a screen. If it holds, the opener has
been putting a permission prompt in front of every first-time Firefox visitor
at page load, before they have opened anything, and it did so before D49 too.
That weighs heavily toward asking later, at a moment the person would
recognize as a reason. A desktop Firefox check (open the opener fresh and look)
would confirm or rule it out in a minute.

**Read, 18 September: on Firefox, a first visit gets a permission prompt on
load.** Seen on screen, no longer inferred.
- **Browser.** Firefox 153.0, build `20260722113508` (codename Nightly). This is
  the Firefox that ships with Playwright (`ms-playwright/firefox-1538`), launched
  directly as an ordinary visible browser with no automation attached. Desktop
  release Firefox is not installed on this machine. So this is a proxy reading:
  Gecko with Firefox's own permission UI, not the release build a visitor runs.
  A release-build reading would confirm it and is not yet taken.
- **Profile.** A brand-new, empty profile directory made for this visit
  (`-no-remote -new-instance -profile <new dir>`). Nothing remembered, no prior
  dismissal. Cleared site settings on an old profile were not used, because
  Firefox remembers dismissals and a second visit reads differently from a first.
- **Page.** `https://opendai.app/`, the production opener, serving `f75478c`
  (its build stamp). Captured from the real screen 12 s after launch, because
  the prompt is browser chrome and a page screenshot cannot show it.
- **What was on screen.** Before anything was clicked, a doorhanger under the
  address bar: "**Allow opendai.app to store data in persistent storage?**",
  with "Learn more", an unticked "Remember this decision", and **Allow** and
  **Block**. Behind it the chooser, with the D49 line reading `not kept · tab`,
  the correct standing state while the request is unanswered.
- **What it explains.** It is why `persist()` went unanswered in automation on
  Firefox (CI, 18 September): the request was waiting on this prompt.

So the opener has been putting a permission question in front of every
first-time Firefox visitor at page load, before they have opened anything, and
it did so before D49 too. Nothing about when `persist()` is called was changed
for this reading. That is the decision this entry exists to make, and changing it
first would change what the reading measured.

Not read: what the line shows after Allow or Block is pressed (item 1's fix,
seen live), and whether "Remember this decision" left unticked means the
question comes back on every visit. Both are one more minute in the same
profile.

**Attempted 18 September, not taken: these readings need a person's click.**
The same setup (Playwright's Firefox 153.0 launched directly, a fresh profile,
the real screen captured) put the prompt on screen again. Clicks sent to Allow
from this machine's automation were ignored four times. The pointer was checked
on the button (the display is 2880×1620 at 150%; logical (801, 277) is physical
(1202, 416), where Allow is drawn). Firefox was confirmed as the foreground
window. The pointer rested on the button for 3 s before one attempt, and another
was clicked at physical coordinates from a DPI-aware process. The prompt never
changed, not even a hover highlight, so the injected input did not reach it.
Nothing was answered, so there is no after-Allow, after-Block or second-visit
reading.

**Why, checked rather than assumed: this machine's injected input does not
reach Firefox at all, prompt or not.** The obvious explanation is that the
prompt is privileged chrome that rejects synthetic input. That may be true of
Firefox, but these attempts cannot show it. The missing hover pointed
elsewhere, and a hover grants nothing. A second check on a fresh profile rested
the injected pointer on the page's own "Open a file" button. That button has a
hover style (`#slot #open:hover { background: var(--accent-press); }`,
`apps/runner/index.html:545`), so the check could fail. Compared pixel for pixel
against a capture with the pointer parked elsewhere, the button did not change:
0 differing pixels, `#007aff` in both. So in this environment, injected pointer
input has no effect on Firefox's page content either. **The readings need a
person at the machine.** Retrying the automation will not change that, whatever
the prompt does with synthetic input, which stays untested. The three still wanted, each on its own fresh profile at
`https://opendai.app/`: the D49 line after Allow; the line after Block; and,
with "Remember this decision" left unticked, whether the prompt returns on a
second visit. A person with a mouse can take all three in about five minutes.

#### D50 — An icon that outlives its storage is greeted as a stranger

*Status: built, 17 September, for an icon made from a file and one made from a
store link or a `/d/` link (the link half became reachable when D56 was fixed).
An icon made from an inline link is not covered by the ruling; see below.*

**A boundary, not a gap: on iOS the page cannot tell an icon's first launch from a
wiped one, because any "launched before" marker lives in the storage the wipe
reaches.** Same shape as D18's hole versus empty stretch, with one difference: in
D18 the relay can tell the two apart, so that one is fixable; here nothing can.

**What it means to a person:** they tap the icon they have had for weeks and are
told, in effect, that they have never opened this document — go find the file
again. It is not that nothing was said; it is that the wrong thing was said.

The OS keeps the home-screen icon and its `start_url` after every script-writable
store has been swept. So **an icon launched for a uuid the library does not hold
*is* the had-it-and-it's-gone case** — it is the one signal that survives the
wipe, and the code treats it as identical to a first open.

`apps/runner/src/install.ts:70` already describes the situation in prose, while
doing nothing with it:

> `?doc=<uuid>` finds a document this device already keeps, which is the right
> answer once it does — and it is nothing at all on a device that has been reset,
> or where storage was evicted, or where somebody added the icon and opened it
> for the first time a week later.

That comment names three cases. Only the third — never opened — is the one the
code acts on.

The message a person actually gets, `apps/runner/src/main.ts:4047`:

> `This icon is for ${name}. Open ${name} from your files once — tap Open a file
> and choose it — and it will be here every time after that.`

**Record that as a wrong statement, not a missing one.** "Open it from your files
once" is false for someone who did exactly that a week ago; and "it will be here
every time after that" is the promise that has just been broken, repeated.

**A correction to the premise, found while writing the sentences.** The icon is
the had-it-and-it's-gone signal only where the icon shares storage with the
browser. On Android and desktop it does (`installShareStorage()`): an icon is
made from a document the device holds, so a launch for one it does not hold
means the document was there and is gone — wiped, or removed by the person. **On
iOS the icon has storage of its own (6.3), and its first launch has exactly the
same shape as a wiped one.** `main.ts:4038`'s comment is written for that case,
which is why its message is not simply wrong: it is right for an iOS icon's
first launch and wrong for every wipe. Nothing in the page can tell the two
apart, because a marker saying "this icon has launched before" would live in the
storage that gets wiped. So on iOS, where eviction matters most, the sentence has
to be the weaker one. That is a real cost and it is recorded, not designed away.

Every icon launches with `#u=<uuid>` in its fragment (`launchAddress()`,
`install.ts:136`); the link-backed one carries the link beside it, the other
carries `?name=`. Neither says whether it has launched before.

**The sentences, written before the code.** The rule for all four: say what is
true now, never what happened (it cannot be known), and never repeat a promise
storage has just broken. "It will be here every time after that" goes, in every
variant.

*The `?doc=`-style icon — a document that arrived as a file, no link to follow.*
The bytes exist nowhere the opener can reach. Today's message, `main.ts:4047`, is
the wrong statement this entry is about.

- **Shared storage (Android, desktop):** "**{name} isn't on this device any more.
  If you still have the file, open it here and this icon will open it again.**"
  "Any more" is true for both causes, a wipe and a removal, and claims neither.
- **iOS:** "**This icon is for {name}, and it isn't on this device. If you have
  the file, open it here and this icon will open it.**" No "any more", because on
  a first launch it would be false; no "once", because for someone who did
  exactly that last week it is an accusation.

*The link-backed icon.* This one recovers: it follows its link, and the document
comes back. What it gets wrong today is silence — it lands on the card as though
this were the first meeting, which on a shared-storage device it is not.

- **Shared storage:** "**{name} wasn't on this device any more, so it was fetched
  again from its link.**" On the card, above the app; the card's primary action
  stays Open.
- **iOS:** nothing new. On a first launch the ordinary card is the truth, and on a
  wipe the same card is at least not false. A sentence that is right in only one
  of two indistinguishable cases is not written.

*Deliberately absent from all four:* any account of why ("your browser cleared
storage" cannot be known and would be a guess stated as fact); any warning about
the future; any mention of persistence. What a person should do so this does not
happen again is D53's sentence, and D49's reading is where durability is shown.

**Open inside this entry, not ruled:** whether the link-backed sentence should
say what the fetched copy lacks. For a replicated document the mailbox catches
it up; for one that is not, the copy is the document as it was when the link was
made, and anything done on this device since is gone. A sentence that says so
would be true and would be the first time a person hears it. It is also the
sentence most likely to be wrong in detail, so it waits for someone to trace
both paths rather than going into the first build.

**Not covered by the ruling: an icon made from an inline link.** Its bytes are in
its own address, so it recovers even after a wipe. But it never shows a card: the
hint counts as consent (`main.ts:1433`, "a fresh storage … should open it, not ask
again"), and the document mounts directly. So the ruled link sentence has no
surface to go on, and "fetched again" would be false there anyway, because
nothing is fetched. Left unbuilt, not given an improvised home.

**Built, 17 September.** `iconLostItsDocument()` and `iconWithoutItsFile()` in
`main.ts` write the sentences. `#card-returning` sits above the card head. Both
conditions for "any more", standalone and shared storage, are required; anything
less gets the neutral sentence, so the strict answer costs saying less, never
saying something false. The card sentence appears only when the fetched document
is the one the icon named, because the payload is authoritative.
`tests/icon-after-wipe.spec.ts` holds the file-icon split: shared storage, iOS, a
tab, and a first-time link that must *not* carry the sentence.

When it is picked up:

1. *Does a person understand what happened?* They are actively misled, which is
   worse than the silent defects of the week of 15 September.
4. *What can a test not see here?* Whether iOS gives an icon's first launch empty
   storage in practice — 6.3 says so, and it has not been read on a phone since.
   The whole iOS half rests on it.
3. *What already-built thing does this touch?* 3.5 and `install.ts`'s `link`
   field. An icon built from a link can fetch the document again; an icon built
   from `?doc=` cannot, so the two cases get different true sentences, not one.

#### D51 — The library remembers the app and the database is gone

*Status: the silence is fixed, 21 September. The loss itself is not — nothing
here recovers data, and nothing can.*

**Built.** The reopen says one true sentence:

> *Velvet Chess* opened empty: what this device had saved for it isn't here any
> more. If you have a link to it, or another copy, open that here and the data
> comes back with it.

- **It names the app**, so it is about something the person recognizes.
- **It says what they can do.** That is the half a notice usually leaves out,
  and it is the only way out that exists: the copy is gone from this device, and
  a link or another copy is what brings it back (D53 is why there is no other).
- **It does not guess why.** Nothing in the opener can know whether the storage
  was swept, cleared or never written; a cause would be invention.
- **Said only where this device is known to have written something worth
  keeping**, which the library record's `wrote` says. A copy stored on arrival
  and reopened before anything was written to it reaches the same branch, and
  telling that person they lost data would be inventing a loss.

**The first version of that condition read `revision`, and was wrong** (fixed 22
September). `revision` counts every committed save — the setup SQL every copy
runs, and whatever an application writes for itself before a person has touched
it: chess lays out a practice board when it opens. So a copy nobody had used
could be told it had lost something, and the test guarding the sentence turned
on whether it read the count before or after that write. It passed on Chromium
and flaked on WebKit (run 35640958946, passed on retry), which is how it was
found.

`wrote` is set by the first save the runtime does not mark as setup — the same
signal D55's storage request waits for, which is not a coincidence: "the first
thing worth keeping" is one fact and now has one name.

**Proved** by `tests/empty-reopen.spec.ts`: a game is made, the save is waited
for, the stored database is swept from both OPFS and the IndexedDB fallback
while the library row is left alone — the exact half-state — and the reopen is
read from the screen. Both halves proven to fail for the reason they guard:
with the sentence gone the screen still says "Loading…", and with the condition
gone the copy that was never written to is told it lost something.

**One of those guards was worthless when first written, and the pattern caught
it.** The honesty test opened a file and checked the screen said nothing — but a
first open does not come through the library at all, so it passed however wrong
the condition was. It now constructs the state that does reach the branch: a
library row with no saves and no database. *What else would make this pass?*
answered it.

**What it means to a person:** their app opens, looks right, and is empty. No
entries, no games, no answer.

`apps/runner/src/main.ts:734` — a reopen loads the stored database, and when
there is none it mounts the container as it arrived and says nothing about the
difference:

```
const opfsDb = await loadDatabaseFromOpfs(cartridge.manifest.documentUuid);
if (opfsDb && opfsDb.byteLength > 0) {
  loaded = await resealCartridge(cartridge, opfsDb);
} else {
  loaded = cartridge;
}
```

The library row surviving while the database does not is exactly the state a
partial sweep leaves (see the inventory note above: the file and the fallback are
separate). The breadcrumb underneath it already logs the distinction — "reopen
mounted the library's own copy (no stored database)" — so the opener knows. The
person is not told.

When it is picked up:

1. *Does a person understand what happened?* No. This is the purest instance of
   the theme in the cluster: the right thing is known, in the right place, at the
   right moment, and not said.

#### D52 — A session document can restore its bytes and still be unplayable

*Status: open. Blocked on the same missing primitive as D48 and Transferable
ownership.*

**What it means to a person:** the game comes back, all of it, and they cannot
take their turn in it.

Even where the bytes are fully recovered from a link, the seat is not:

- A link arrival takes **a fresh replica id**.
- **The old seat binding is still in the restored rows**, so the seat reads as
  bound, not open.
- **Heads are filtered by member replica**, so the new replica's writes are not
  admitted.

The way back in is a creator reseat plus a fresh invite — and **reseat is gated on
seat authorship by replica**, so a creator who lost storage cannot perform it for
themselves. That is D48's asymmetry reached by a second road: storage loss rather
than a lost tab.

**Three items now block on the same absent primitive: a person-held identity
independent of any device.** D48 (taking a lost seat back), Transferable ownership
(its key-holder identity), and this. A primitive that blocks three things is a
different priority from one that blocks one, and whoever weighs any of the three
should weigh the identity itself rather than the item in front of them.

When it is picked up:

3. *What already-built thing does this touch?* Seats, reseat, the head filter,
   and the invite path — the same surfaces D48 ruled on.
5. *What does an author have to know that is not written down?* That restoring a
   session document's bytes is not restoring a seat. Nothing says so today.

#### D53 — The key dies with the storage, so a link is the only backup

*Status: open — as a statement to be written somewhere a person can read, not as a
defect.*

**What it means to a person:** if this device forgets a document, the copy on the
relay is unreadable forever, by them and by everyone. Keeping the link is the only
backup that exists.

After eviction the relay still holds the ciphertext, and nobody can derive the key
again. `documentKey` lives in the evicted library row and is on no server, by
design — `opfs.ts` says so in the field's own documentation:

> The root the whole exchange runs on: minted once at creation, kept here for the
> life of the document, carried in every share link, and the key the store seal
> and the mailbox both use.

**This is the design working as intended.** File it as a stated property, not a
fault: it is the same property that makes a link safe on a home screen (3.5) and
makes a stranger's file safe to keep. What is missing is that a person is never
told it, and cannot act on it if they are not.

**Said on screen, 21 September**, in the two places where the action it implies
is still available:
- **The keep sheet**, while somebody is deciding to keep the document here:
  *"Keeping Beach trip here is not a backup. The link or file you opened it from
  brings the app back; what you write in it stays on this device."*
- **The share card**, the one moment a person makes a link on purpose. With the
  data travelling: *"Keep this link yourself: it is the way back if this device
  ever forgets this app."* Without it: *"This link carries the app without your
  entries, so it is not a copy of them. What you have written lives on this
  device only."* Not on an invite, which carries one game to one person and is
  not answering this question.

**The first version of the keep sentence was wrong in the way this entry warns
about.** It split on whether the document arrived by link and called the link
"the way back" — true of the app, false of the entries, because a link carries
the document as it was when the link was made and the opener mints one for a
file-borne document at mount. Beside somebody's log, "the way back" reads as
"my log is safe". Caught by the test, which was reading the sentence on screen
rather than asserting a flag.

`tests/share-and-keep-sentences.spec.ts` holds both, proven by removing each
sentence.

When it is picked up:

2. *What does this change about what someone else can see or infer?* Nothing —
   and that is the point being recorded.
5. *What does an author have to know that is not written down?* That the link is
   the backup. It is written in a code comment and nowhere a person will meet it.

#### D54 — After a wipe, a notification loses the document's name

*Status: open. Small, and first.*

**What it means to a person:** the first thing they see after a wipe they do not
know about is a notification that has forgotten what their document is called.

Cached manifests go with everything else, so the push worker's name lookup misses
and the notification reads "A shared document" instead of the name.

Small in mechanism, and it is worth filing separately because of **when** it
happens: the notification arrives before the person has opened anything, so it is
the first observable symptom of the wipe, and today it is a symptom nobody can
read as one. It is also the cheapest place in the cluster to *detect* a wipe from,
since the worker already knows it looked for a manifest and did not find it.

When it is picked up:

1. *Does a person understand what happened?* No, but this is the one place where
   a person might notice something is wrong before losing anything further.
3. *What already-built thing does this touch?* The push worker's name lookup, and
   D44/D45's notification decisions.

#### D59 — On a Mac, "Add to Dock" gets the assertive D50 sentence

*Status: the wrong sentence is gone, 21 September. The Mac reading is still
wanted, and is what would move it back.*

**Fixed by narrowing what may be asserted, not by deciding the open question.**
`installStorageIsRead()` (`platform.ts`) says whether a platform's installs have
been read, and a standalone install on macOS is unread, so it gets the neutral
sentence: *"This icon is for X, and it isn't on this device."* If a Dock app
does have its own storage, that sentence is true on a first launch and after a
wipe alike; if it shares the browser's, it is still true, only less specific
than it could be. Neither reading can make it false.

- **Narrow to macOS on purpose.** Windows and Linux installs are the same origin
  and the same storage, which is not in doubt; calling every desktop unread
  would take a true sentence from them to fix a Mac.
- **Both witnesses count.** `navigator.platform` and the user agent: on a real
  Mac they agree, and a Mac claimed by either is treated as one. The first
  version read `platform` alone and the test's Mac was not a Mac to it — a check
  that passed because the thing it checked had not happened.

**What a Mac would settle:** add a document's page to the Dock, launch it, and
read whether its library is Safari's. If it has its own, this entry is closed as
built; if it shares, the assertive sentence can come back for macOS.

**It reaches every Safari desktop, which is the point and was also a surprise on
CI.** Safari desktop only runs on macOS, so a standalone Safari install *is* the
Dock app this entry is about. What that exposed: Playwright's WebKit reports a
Macintosh user agent with a `Win32` platform (measured, 21 September), so four
tests that had left the platform to the engine were about macOS on WebKit and
about Windows everywhere else, and said nothing about which. They pin both
witnesses now. **The rule:** a test whose subject is platform-dependent states
its platform; the engine's own idea of what it is running on is not the
platform the test means. The assertive sentence and the "fetched again" card
both rest on the same claim, so both follow this line.

`tests/icon-after-wipe.spec.ts` holds it: an install on a Mac never says "any
more". Proved by making macOS read as known, which brings the assertive sentence
back and fails the test.

**What it means to a person:** a Mac user whose Dock app has never held a
document may be told it "isn't on this device any more", which is D50's
wrong statement in its other direction.

`iconLostItsDocument()` is `standalone() && installShareStorage()`. A Safari
"Add to Dock" app on macOS is standalone, and `platform()` classes it as
`desktop`, so `installShareStorage()` says it shares storage with the browser.
The review says a Dock app has storage of its own, like an iOS home-screen
app. If so, its first launch looks like a wipe, exactly the iOS boundary, and
it should get the neutral sentence. Needs a Mac: add a document's page to the
Dock, launch it, and read whether its library is Safari's.

#### D60 — A notification tap can reach the D50 sentence, which says "icon"

*Status: fixed, 21 September.*

**Built.** The sentence follows how the person arrived, which the address says:
an icon's carries the document's name, a notification's carries only the id
(`sw.js`). With no name, the words are *"That document isn't on this device any
more. If you still have the file or a link to it, open it here."* — and on iOS,
or any install whose storage is unread, the same without "any more". No "icon",
because they did not tap one, and no "your document", which was a stand-in for
the name the address never had.

`documentNotHere(name, fromIcon)` replaces `iconWithoutItsFile(name)`: four
sentences, because two things vary and only one of them is the platform.

**How "did they tap an icon?" is answered, and the first answer was wrong.** It
was read from the absence of a name, which looks right and is not: an icon made
without a name launches with `?doc=` and no name, so its owner was told about a
notification they had not tapped. The runner's own `?doc=` test caught it within
the hour. It is read from the address now — a query naming the document is an
icon, a bare fragment is not — and an icon with no name gets a sentence of its
own, *"This icon is for a document that isn't on this device"*, rather than
borrowing the stand-in "your document".

**Still open, and separate:** whether a notification for a wiped document should
say something else entirely. It is the D54 moment — the first thing seen after a
wipe — and that is a question about what a notification is for, not about this
sentence.

`tests/icon-after-wipe.spec.ts` holds both notification cases. Proved by making
the no-name path fall back to the icon sentence, which fails on the word "icon".

A notification opens `/#opener-doc=<uuid>` (`sw.js`). If the document is no
longer held and the page is standalone, that is D50's file-icon path, and the
sentence says "this icon will open it again", to someone who tapped a
notification, not an icon. It also has no `?name=`, so it reads "your
document". The sentence was written for one entry point and is reachable from
two. Whether a notification for a wiped document should say something else
entirely (it is the D54 moment: the first thing seen after a wipe) is part of
the question.

#### D64 — `iconLostItsDocument()` is named for a detection it does not do

*Status: fixed, 21 September, in the change that rewrote the sentences it feeds
(D59, D60).* It is `installSharesBrowserStorage()` now, which is what it checks;
"so the document was here" is left to the caller, where D50's reasoning is
written down. Renamed there rather than filed for later because the change was
already rewriting the branch, and leaving a name that claims a finding next to
new wording invites exactly the misreading this entry predicted.

It is `standalone() && installShareStorage()`: a platform check. It detects
nothing about whether a document was lost. The name claims the case D50 argues
can only be inferred, and the next caller will read it as a finding. A name like
`iconSharesBrowserStorage()` says what it checks, and leaves "so the document
was here" to the caller, where D50's reasoning is written down.

### Reaching a person

#### 3.5 iOS, solved by the link

*Status: open — the link reaches Safari, never an installed icon.*

**Built.** The per-document manifest's `start_url` is now the link the
document arrived by, when it arrived by one — the whole link, key included.

The icon used to launch into `?doc=<uuid>`, which finds a document this device
already keeps. That is the right answer once it does, and nothing at all on a
device that has been reset, had its storage evicted, or where somebody added
the icon and opened it a week later: the icon opens on an empty chooser. A
link is the document — it says where the bytes are and carries the key in its
fragment — so an icon built from one fetches it again and then runs offline.
The fragment is kept by the browser and never sent to a server, so the
property that makes a link private is the one that makes it safe on a home
screen. A document that arrived as a file still gets `?doc=`, which is the
honest answer when there is no link to point at.

Tested both ways in `tests/reference-link.spec.ts`.

**Was broken for every icon made from a link; fixed 17 September (D56).** The
test above asserted the icon's `start_url` and never launched it on a device
without the document. `tests/icon-after-wipe.spec.ts` now launches it, for a
store link and for a `/d/` link.

**Exit not met, and cannot be met here:** an iOS device test needs an iOS
device. Everything above is the mechanism it would exercise; what is left is
somebody holding a phone, or a device lab — the same decision 5.1 is waiting
on.

#### D56 — An icon made from a store link cannot fetch its document again

*Status: fixed, 17 September. Found by running while building D50; ruled and
fixed the same day. The icon hint has a key of its own, and the fragment
namespace is defined in one file that refuses a collision.*

**How long that address can be, measured: 11,847 characters.** A launch
address is built from the link the document arrived by, and an inline link
*is* the document, so for a file or inline arrival the `start_url` in the
manifest the worker serves carries the whole payload. A phone reading on
`e1f9b45` measured one at 11,847 characters; the same document measured here
gives 2,124, and a store arrival — which needs no payload, because its
`/d/<hash>` path and key fetch the document again — gives 266.

**That is deliberate and stays.** An iOS home-screen app starts with storage of
its own and nothing in it, so for a file or inline arrival the address is the
only thing the icon can open from; shortening it would take an inline icon's
one way in (`document-icon.spec.ts` holds this, and a change that shortened it
was reverted on 23 September for exactly that reason). What was fixed instead
is the *printing* of it: no line on the sheet, the launch panel or the
breadcrumb prints a fragment payload.

**Whether the length contributes to the icon flip is unmeasured, and this is
the ask.** What iOS does with a `start_url` that long — whether Add to Home
Screen accepts the manifest at all, truncates it, or silently falls back to the
page's own address, which is what an icon showing the opener would look like —
has not been tested on a device, and the sittings that produced this entry
could not have told the difference. It is a candidate, not a cause. What would
settle it: on a real iPhone, add two icons — one for a document that arrived
inline (a long address) and one for a store arrival (a short one) — and read
what each icon is called and what it opens.

**Ruled: a distinct hint key, and not the shape-reader.** The options below were
weighed on the assumption that installed icons in the field needed repairing.
**There were none; only test installs existed.** So reading `u` by shape would
have been a compatibility path with nothing to be compatible with, and a
permanent workaround kept alive for a problem that could be fixed cleanly while
it was still cheap. That is why the option that repairs more was not built. It
was the right choice only if an installed base existed, and one did not.

**What was built.**
- `src/fragment.ts` defines the fragment's `key=value` fields in one registry,
  `FRAGMENT_KEYS`: inline `a`; reference `h k u c s`; the opener's hint,
  `opener-doc`. `INLINE_KEY`, `REFERENCE_KEYS` and `HINT_KEY` are derived from
  it, so no caller's names or types changed. **Corrected 18 September:** as
  first written, this said "every field", and the file's own comment said "every
  field a link's fragment can carry, defined in one place". Three things read
  or write the fragment outside it. The head script in `index.html` matches
  `a`, `h` and `k` by regex, before any module loads, to decide whether a page
  is arriving. `#handoff` in `main.ts` is a whole-fragment marker a studio page
  opens the opener with. And `public/sw.js` writes the hint into a
  notification's address and cannot import. The file now names all three. The
  first two are D58.
- **The collision check sits at the point of definition.** The module runs
  `fragmentCollisions()` on its own registry when it loads and throws on a
  duplicate. Proved both ways. On the real set it is silent
  (`tests/fragment-keys.spec.ts`). With the real registry mutated back to the
  defect (`hint: "u"`), nothing starts: the build behind the test servers
  refuses with `fragment keys collide: "u" is claimed by reference.url and
  opener.hint`, so no build or test can run on a colliding set. The spec also
  names both claimants of a synthetic duplicate, and holds each owner's constant
  to the registry, so no copy can drift from it unchecked.
- **Every writer that bypassed the constant now goes through it:** the `?doc=`
  rewrite (`main.ts`), the launch details label, and `link.ts`'s own `get("a")`.
  The one copy that cannot import, the service worker's notification address in
  `public/sw.js`, is held to `HINT_KEY` by `push-e2e`, which reads the
  notification the worker actually shows.
- **Tests stopped spelling the key.** Every `#u=`, `/[#&]u=/` and
  `toContain("u=")` now builds from `HINT_KEY`. Six were missed by the first
  search, and the first run of the touched specs caught them. A rename can no
  longer leave the tests behind.
- **The two `test.fail` marks came off in the same commit.** Both tests pass
  unmarked: a store-link icon and a `/d/` icon each fetch their document on a
  wiped device and show D50's card sentence.
- **The full push tier found two more, and one had been hollowed out, not
  broken.** `document-icon.spec.ts:132` failed on `` `u=${uuid}` ``, a missed
  literal. `returning-document.spec.ts:396` passed. It builds an icon address
  by hand to set a trap: the hint names a document this device holds, and the
  newer payload must still win. After the rename its `u=` was no longer a hint,
  so the trap was never set and it passed without testing anything. Proved by
  putting the old hint-first ordering back into the product. The corrected test
  failed (`Expected "move1"`, `Received "no moves"`), and the old one passed.
  Both now use `HINT_KEY`. The missed literals got past the first search because
  its pattern was mangled by shell escaping; the second search matched the
  literal text and found only store-URL `u=`s besides these two.

**Before the next phone sitting: delete and reinstall every icon on the test
phones.** The ruling that there was no installed base was right about the
field and wrong about the test phones. An icon installed between R7 (when the
hint moved into the fragment as `#u=`) and this fix carries `#u=<uuid>`, and `u`
is no longer the hint. From reading the launch path (not run):
- **An icon made from a file** (`?name=…#u=<uuid>`) now has no hint, no document
  and no reference, so it falls through to the resume path. That opens whatever
  was open last, which may be a *different* document than the one the icon
  shows, with nothing on screen saying so.
- **An icon made from a store link** still carries `u=<uuid>`, which
  `referenceFrom` still reads as a store URL. It stays broken exactly as it
  was before the fix.
- **An icon made from an inline link** opens its own document, because the
  document is in the address.

A reading taken through the first kind would be a reading of the wrong
document, which is D49's failure arriving by another road. An icon made after
this fix carries `opener-doc=`. Reinstalling costs a minute; a phone check taken
through a stale icon costs the check.

Everything below is the entry as it stood before the ruling, kept for the
evidence and the reasoning.

**What it means to a person:** the icon that 3.5 built to survive exactly this, a
device that no longer holds the document, does not survive it. After a wipe it
opens the chooser and tells them to find a file they never had.

The icon's hint and the reference link's store address are the same field:

- `src/link.ts:125`: `export const HINT_KEY = "u";`
- `src/store.ts:54`: `export const REFERENCE_KEYS = { hash: "h", key: "k", url: "u", clear: "c", session: "s" } as const;`

`withHint()` (`apps/runner/src/install.ts:109`) drops every existing `u=` part
before adding its own, so an icon built from a store link loses the store
address and gains `u=<uuid>`. On launch, `referenceFrom()` (`src/store.ts:616`)
reads that `u` as the store URL:

```
const u = fragment.get(REFERENCE_KEYS.url);
if (u) {
  try {
    const url = new URL(u);
    ...
  } catch {
    return undefined;
  }
}
```

`new URL("<uuid>")` throws, so the whole reference is `undefined`. On a device
that holds the document it does not matter: the hint finds the library copy
first. On a device that does not, which is the only case the link was there for,
nothing is fetched.

**Evidence, run:** `tests/icon-after-wipe.spec.ts`, "launched on a wiped device,
fetches the document again and says so on the card". A chore chart is published
to a local store and opened by its link, and the `start_url` is read from the
manifest the opener wrote. That address is then launched in a fresh browser
context, as an installed app. The card never appears. The chooser shows:

> your document isn't on this device any more. If you still have the file, open
> it here and this icon will open it again.

That is D50's file-icon sentence, reached because the reference was unreadable,
with no name because a link icon carries no `?name=`.

**The test is marked `test.fail` on purpose. Do not delete it, skip it, or remove
the mark to make the suite look green.** A test marked that way still runs, and it
counts as passing only while the defect is there. When D56 is fixed, Playwright
reports an unexpected pass, and that is the signal to take the mark off. A skip
would run nothing and show nothing (D24). Deleting the test would remove the only
check that launches an icon's address on a device without its document.

**It belongs to both patterns in part 3.** `u` is one name carrying two identities
(the fourth instance), and 3.5's test checked the address was built rather than
that it worked (the sixth).

`tests/reference-link.spec.ts:376` asserts the collision into the manifest,
`expect(manifest!.start_url).toContain(`u=${built.manifest.documentUuid}`)`, and
never launches the result on a device without the document.

**Confirmed by running, 17 September: a `/d/<hash>` link fails the same way.**
It was first only read, then run before any repair was designed, because it
decides which repair helps. The test ("a /d/ link with no store in it") points
the default store at a local one through `__daiStore`, opens
`/d/<hash>#h=<hash>&k=<key>`, and reads the icon's real `start_url`:

```
/d/<hash>?ground=…#h=<hash>&k=<key>&u=<uuid>
```

The icon's `u=<uuid>` is the only `u` in that fragment. Launched on a wiped
device, it fetches nothing, and the chooser shows the file-icon sentence. So
**every link icon the production opener has ever made is affected**, not only
icons from links that name a custom store. The test was run unmarked first, so
the failure was read before the `test.fail` label went on.

**What that does to the repair options.** A new hint key repairs nothing
already installed, and the icons already installed are the ones that exist.
Reading by shape where the address is read (a uuid-shaped `u` is the hint) is
the only option of the three that repairs a `/d/` icon without touching it,
because a `/d/` icon never had a store `u` to lose. Icons made from links that
named a custom store would still fall back to the default store. That is a
consequence, recorded so the ruling can weigh it. It is not the ruling.

**Why it is not fixed inside D50.** Icons already on home screens carry this
address and cannot be rewritten; only the opener that reads them can change. The
choices look different for those icons:

- **Tell the two `u`s apart by shape where they are read.** A uuid-shaped `u` is
  the hint, a URL-shaped one is the store. `hintedUuid()` already validates the
  uuid shape. That would repair every existing `/d/<hash>` icon without touching
  it. An icon that named a custom store has already lost it, and would fall back
  to the default store.
- **A new hint key** for icons made from now on. That is cleaner, and it repairs
  nothing already installed.
- Both: read by shape for the icons in the field, write a distinct key from now on.

When it is picked up:

3. *What already-built thing does this touch?* 3.5, the D50 card sentence
   (built, unreachable until this is fixed), the 6.4 relaunch (which also uses
   `launchAddress()`), and every installed icon.
4. *What can a test not see here?* Nothing, as it turns out. This was always
   visible to a test that launched the address instead of only reading it.

#### D57 — The two fragment parsers disagree about a repeated key

*Status: open. From the review of `454858c..7abb896`, 18 September. Same family
as D56.*

**What it means to a person:** a link carrying a key twice opens one thing in
one part of the opener and another thing in another, and nothing says so.

`src/link.ts`'s `fragmentFields()` builds a `Map` in a loop, so a repeated key
keeps its **last** value. `src/store.ts` reads the same fragment through
`URLSearchParams.get()`, which returns the **first**. A fragment with two `h=`,
or two hints, is then read two ways by the same opener. D56 was one name
standing for two facts across two files; this is one fragment read by two rules
across the same two files. The fix is presumably one parser, and a refusal for
a repeated key rather than a choice between its values, but that is not ruled.

#### D58 — Two readers of the fragment sit outside the registry

*Status: open. From the review of `454858c..7abb896`.*

`src/fragment.ts` holds the fragment's `key=value` fields and refuses a
collision. Two things read the fragment without going through it:
- **The head script in `apps/runner/index.html`** matches `/^#(a|h|k)=/` and
  `/[#&](h|k)=/` by regex, before any module loads, to decide whether a page
  is arriving. It cannot import. A renamed or added link field would leave it
  deciding on the old names, with nothing failing.
- **`#handoff` in `main.ts`** is a whole-fragment marker (`location.hash ===
  "#handoff"`) a studio page opens the opener with. It cannot collide as a key
  today, since it has no `=`, but it is a third way of reading the fragment that
  the registry does not know about.

The service worker's copy of the hint is the third outsider, and it is already
held by `push-e2e` through the notification it shows. The head script and
`#handoff` have no equivalent guard.

#### D63 — A dozen comments still call the hint `#u=`

*Status: open. From the review of `454858c..7abb896`.*

The hint is `opener-doc` now, and `u` is a live key that means the store URL.
Around a dozen comments in `install.ts`, `main.ts`, `sw.js` and the tests still
describe the hint as `#u=` (for example `install.ts:143`, "`#u=`, not
`?doc=`"). A comment naming the wrong field is the next person's D56: it tells
them `u` is the hint. They should say `opener-doc`, or name `HINT_KEY`, or be
explicitly historical ("was `#u=` until D56").

#### 6.3 iOS: a link cannot reach an installed icon

*Status: open — detail of 3.5.*

A home-screen web app and Safari are separate storage on iOS: separate
library, OPFS and pins. A link tapped in Messages always opens Safari, and
there is no way to route it into an installed web app — no share target, no
URL scheme, no file handler, and universal links need a native app. So a game
played from a home-screen icon never sees a move that arrives by link, and
6.1's ordering never gets the chance to run.

The cheap answer, untested on a device: install a document that travels as a
*bookmark* rather than a web app — `display: browser` in its own manifest —
so the icon and the links share Safari's storage. It costs the standalone
chrome and can be decided per document, since the library already records
which documents this device has both received and shared.

The expensive answer is a native iOS host with universal links.

#### 6.4 The post-merge relaunch to `#u=` hangs at a document address

*Status: waiting on an on-device reading.*

**Separate from 6.3.** Not the storage split — a real hang in the relaunch
step itself. After a merge on the card at a document address (`/d/<id>`), the
opener relaunches to the document's own address with the update hint
(`#u=<uuid>`) so iOS re-reads the manifest and status-bar colour as the page
first appears. The relaunch does not complete: the person is left on a page
that never finishes mounting the merged copy.

**Reproduce from a document address, not the root.** The relaunch only runs
for a copy that arrived by link (`arrivedByLink` set, `launchAddress` targets
`/d/<id>#…u=…`); opening the same file from `/` takes a different path and
never exercises it. So a reproduction that starts at `/` will not see it, which
is how it survived every green run.

Findings from reading, for whoever picks it up:

- The relaunch is in `apps/runner/src/main.ts`, the `platform() === "ios"`
  block after `keptOnDevice` (~1251–1298). When the target shares the current
  path and differs only in fragment it does `location.hash = …;
  location.reload()`; otherwise `location.replace(target)`. On `/d/<id>` the
  same-path branch is taken, and `location.hash = …` followed by
  `location.reload()` is the suspect — a programmatic hash set immediately
  before a reload has bitten this repo before (memory: a hash change is a
  same-document navigation; reload timing/bfcache on iOS is the risk).
- The `#u=` **open** path it reloads into (~2900, `hintOnly`) is *not*
  iOS-gated, and it is **confirmed healthy off-iOS**: opening a held replicated
  document by navigating straight to `#u=<uuid>` finds the copy by uuid, calls
  `launchFromLibrary`, and mounts the board with a working write surface (tried
  9 Sep, a throwaway repro). So the hang is **not** in the open path — it is
  isolated to the iOS **reload** step above it: `location.hash = …;
  location.reload()` on iOS Safari, and its interaction with the
  `launching`/`booting` paint and bfcache. That half is device-only; the
  reproducible half is eliminated.
- `card.ts` `onMerge` does not itself relaunch; it merges, hides the card, and
  records consent. Whatever triggers the relaunch is the ingest/mount path, not
  the card handler — confirm which, because "post-merge" may mean the relaunch
  is fired by a later mount rather than by the merge.

Do not ship a fix without an on-device reading or an off-iOS reproduction of
the `#u=` open path. This class of bug has cost this project repeatedly when
reasoned about from a desk; the relaunch mechanics are iOS Safari's and the
harness runs desktop.

#### D11 — A large document crashes Safari on iPhone

*Status: waiting on a phone heap reading, then a ruling on the next fix.*

Found with Moon Garden, an asset-heavy game: a 50 MB container kills the Safari
tab on an iPhone. The trace L1 records is the same document — the whole 5.29 s
lands on the `blob:` document load with the blob already built, so it is the
frame's own boot, not the assembly before mount, and preparing before Get cannot
move it. What kills the tab has not been measured.

Why it matters: a crashed tab looks, to the person holding the phone, like their
phone is broken. There is no message, no card, nothing to report — and the
document never said it was too big.

Three parts:

1. **The measurement that is not done.** Build containers at 5, 10, 25 and
   50 MB; open each on a phone and on a desktop; report where each dies and
   with what (tab reload, an out-of-memory page, a hang). Then profile one that
   dies: peak heap, how many copies of the payload are alive at once, and when
   each is released. Suspects to check, in the order they are cheap to rule
   out: inflating the whole archive at mount rather than per entry; holding the
   compressed and the inflated bytes at the same time; minting a blob URL for
   every asset whether the app asks for it or not; reading every entry into
   memory to digest it rather than digesting a stream.
2. **The two card defects** are L1's: Get disabled until the container is
   identified, and a failed launch that says so on the card instead of flashing
   back to it looking untouched. They are not repeated here.
3. **The refusal.** Whatever the ceiling turns out to be, a document too large
   for the device is refused by name with a sentence, before the tab dies.
   Measure the desktop as well as the phone, because the two answers decide
   what kind of refusal this is. If a laptop opens 50 MB and a phone dies at
   15, the limit belongs to the device, not the format, and the message must
   say *too large for this device*, not *too large*. The document is fine,
   and a bigger device can open it.

**Desktop ladder, 14 Sep.**
- **The documents:** four, with 5, 10, 25 and 50 MB of incompressible assets. Each asset is 1 MB of random bytes, and every one is shown as an image, so the frame mints a URL for each.
- **Their files:** 7.5, 14.2, 34.2 and 67.5 MB. The file runs about 1.35 times the asset size.
- **The method:** each was opened through the local opener, from the file pick to the app reporting every asset settled, in Playwright on Windows.
- **The result:** all twelve opened.

| Assets | File | chromium | firefox | webkit | chromium peak JS heap |
|---|---|---|---|---|---|
| 5 MB | 7.5 MB | 1.3 s | 1.3 s | 1.8 s | 136 MB |
| 10 MB | 14.2 MB | 2.0 s | 2.1 s | 2.7 s | 381 MB |
| 25 MB | 34.2 MB | 3.9 s | 5.0 s | 6.6 s | 615 MB |
| 50 MB | 67.5 MB | 8.2 s | 9.9 s | 11.3 s | 1118 MB |

**What the table says:**
- **Peak heap is about 20 times the asset size, and it grows in step with it.** It is 1.1 GB for 50 MB of assets. That is suspect one in the ladder above, many copies of the payload alive at once, now with a number.
- **An iPhone tab gets far less than a desktop.** The Moon Garden crash at 50 MB is consistent with this ratio, even before the phone numbers are in.
- **Where the fix is:** the likely win is in the runtime's own copies, not in a cap. Halving the copies would roughly halve the ceiling.
- **Heap was sampled every 200 ms:** the true peak can only be higher.
- **Which heap:** it is the page's heap. Whether it includes the app frame's heap depends on process placement.
- **Timing grows in step with size** on every engine.
- **Some rungs cannot travel as a link:** the 25 and 50 MB rungs are files over the store's 25 MB cap, so a person can get them only as a file.

**iPhone ladder, 14 Sep (Safari tab, opendai.app, file from the Files app):**

| Assets | File | Result |
|---|---|---|
| 5 MB | 7.5 MB | opened |
| 10 MB | 14.2 MB | opened |
| 25 MB | 34.2 MB | **failed on the first try** with Safari's "A problem repeatedly occurred" page, then opened on the second |
| 50 MB | 67.5 MB | **failed:** "A problem repeatedly occurred on https://opendai.app/", the process killed for memory |

The app's "settled in N ms" counts only from its own script. By then every image had already settled, so it reads 0 ms and says nothing about load time. The phone's load time is the wall clock from Open to "Opened".

**What the 25 MB failure means.** "A problem repeatedly occurred" is Safari's page after the tab's content process is killed twice. On iOS that is the system ending it for memory, not a script error, so nothing in the page can catch it or report it. Two consequences follow:
- **The refusal must come first.** It has to happen *before* the memory is spent: the opener estimates the peak from the file size and the device, and refuses on that estimate. It cannot come from a try/catch around the open.
- **Near the ceiling, the failure is intermittent.** The same 34 MB file failed, then opened. To a person, a document that crashes sometimes looks like a random bug, which is worse than a clean refusal.

At the desktop ratio of about 20 times, this document peaks near 600 MB, so the phone's ceiling sits around there.

**The measurement is done** (part 1's ladder). On this iPhone, a document with about 10 MB of assets opens reliably. Around 25 MB of assets (a 34 MB file) is the edge, where it sometimes fails. At 50 MB (a 67.5 MB file) it fails. Desktop opens all four. So this is a device limit, not a format limit, and the refusal must say *too large for this device*.

**The hypothesis the profile tests.** This list comes from reading the load path, not from measuring it. Each numbered copy is a claim the profile confirms or rules out on its own, by heap measurement on the ladder in desktop chromium, where the heap can be read. The ladder's generator is kept outside the repo; rebuild it from the description above. A profile that arrives with a list to check is worth more than one that measures blind.

**Opener: reading the picked file**
1. **The file's bytes.** `readCartridge` reads it with `file.arrayBuffer()` ([cartridge.ts:39](../apps/runner/src/cartridge.ts)).
2. **The whole file decoded to a text string** (cartridge.ts:45). A JS string holds about twice the file size.
3. **Verification copies in the core.** `verifyContainer` extracts the base64, decodes it, and unzips every entry, adding decoded and inflated copies. Each entry is also hashed.

**Shell: the mounted container's own check**
4. **The whole payload through `atob`**, which makes a binary string and then a byte array ([bootloader.ts:320](../src/runtime/bootloader.ts)).
5. **Unzipped entries,** held alongside the compressed bytes.
6. **A copy of each entry before hashing it.** `sha256` copies into a fresh array before calling `digest` (bootloader.ts:390).

**Handing the app to the frame**
7. **A copy of every entry for the frame.** `toArrayBuffer` runs per entry (bootloader.ts:2911). The transfer then moves that copy, and the originals stay for resealing.
8. **A blob of every asset, made up front.** The frame makes one per non-script asset as soon as the payload arrives, whether or not the app asks for it (bootloader.ts:2517).

**The fixes, ordered by what can be proved, not by what is clever.**

The first three are plumbing inside code this project owns. Each will have a number attached once the profile runs, and each raises the ceiling:
- **No giant string.** Find the payload in the file's bytes and decode it in chunks, not with one `atob` or a whole-file text decode. This addresses copies 2 and 4.
- **Hash in place, and release as you go.** Digest without the defensive copy, and drop the compressed bytes once an entry is inflated. This addresses copies 3, 5 and 6.
- **Transfer instead of duplicate.** Keep the resealing copy as a Blob rather than a heap array, so the frame's copy is the only one in the heap. This addresses copy 7.

The fourth is different in kind, and it is also the most work:
- **Assets on demand.** Keep assets as Blob slices and make a URL only when the app asks for one, so the first screen costs only what it shows. This addresses copy 8. It does not raise the ceiling; it separates document size from memory. Choose it after the three above have their numbers, not before, and not because it is the most interesting.

**The first fix, built 15 September: no giant decode string.** What reading the
code found, and what was built:
- **The core's `fromBase64`** pushed every decoded byte onto a `number[]`,
  then copied it into bytes. A JS number array spends several bytes an
  element, so this was probably the largest copy of all. It belonged to copy 3
  ("verification copies in the core"), not to the text decode. It now counts,
  then writes into one exactly-sized `Uint8Array`, with identical output.
- **The shell's `decodeBase64`** ran one `atob` over the whole payload (copy 4).
  It now decodes in 1 M-character pieces into one pre-sized `Uint8Array`.
- **Not removed: the whole-file text decode (copy 2).** `parseContainer`
  returns the page as `html`, a string, and the opener depends on it: the
  shell-seal check compares it and the library stores it. Removing that string
  changes what the opener keeps for every document. It is bigger than this fix
  and is not done.

Measured before and after, on the same ladder documents, peak JS heap in
desktop chromium, two runs each:

| Assets | Before | After | Change |
|---|---|---|---|
| 5 MB | 144 / 125 MB | 195 / 196 MB | about 60 MB higher, not explained |
| 10 MB | 312 / 359 MB | 247 / 199 MB | about −110 MB (−35%) |
| 25 MB | 615 / 615 MB | 492 / 492 MB | −123 MB (−20%) |
| 50 MB | 1316 / 1099 MB | 1020 / 1026 MB | −80 to −290 MB (−7% to −22%) |

Time to ready fell slightly at the larger sizes (50 MB: 11.8–12.3 s to 10.6 s).

**What this does not say:**
- **The 5 MB rise is real in the numbers and unexplained.** A 200 ms sampler
  on a small page mostly measures when collection runs, but it is reported as
  measured, not written off, and is the first thing to look at next.
- **The device ceiling was not measured.** It is desktop chromium only. If a
  phone gains in proportion, the ceiling moves by roughly a fifth at the sizes
  that matter, which is a hypothesis to measure on a phone, not a result.

**Before the next fix, two cheap checks on the 5 MB number** (ruled 15 Sep):
- Force a GC before sampling (`HeapProfiler.collectGarbage` over CDP). If
  the rise is collection timing, it vanishes.
- Check whether the new path allocates in proportion to the payload rather
  than a constant. Suspects to run, not assume: the pre-sizing count pass in
  `fromBase64`, and the shell's `clean` copy when the payload has line breaks.

If the rise does not vanish, it says something about the new path.

**The measurement that decides the rest: the phone.** Desktop cuts do not say
whether the iPhone's ~34 MB ceiling moved, and that is the ceiling that stops a
person. Measure it: open one document at one size through the opener on a
phone, before and after, and read the heap. That is not
the full ladder.

The remaining fixes (hash in place, transfer instead of duplicate, assets on
demand) and the refusal threshold both wait on that phone number, not only on
a ruling.

**An option, not a step: large documents held in the sectioned form.** The opener could store a large document as a sectioned `.dai` (no base64, with a table of sections) so a reopen reads only the sections it needs. That is a storage-format change with its own consequences, and it pays only once the simpler copies are gone.

**Not in this list: verifying twice.** The opener verifies the file and the mount verifies it again, and that repetition is visible above. Skipping the second check is a trust ruling, not a memory fix: the mount's own check is what protects a document opened with no opener at all. It is D31, with its own decision. Nothing in D11 approves it.

**Then the refusal.** It comes before the open, estimated from the file size and the device, because a killed process cannot report anything. Its threshold is set from the ratio *after* the fixes above, not from today's.

Every size limit in the code today is a policy limit: 32 kB for a link, 25 MB
for a store, the archive caps against decompression bombs. The one that
actually stops a person is a memory limit nobody has measured. 25 MB is what
the store allows, and some number well below it is what a phone survives.
Until this is measured, the system's only honest statement about size is "it
worked when we tried it."

What this is **not**. Not a reason to move assets to a server: a game that needs a
CDN is a web game, and a file that carries its own assets is the format working
as intended. Not a media-in-the-database question: Moon Garden's database was
20 KB; the size is all archive entries.

**Un-parks now, as a measurement** — it needs only a phone and the ladder above,
and nothing built first. The fix
un-parks from what the profile names.

#### D35 — The same document held on two installs is correct but illegible

*Status: parked — trigger: someone other than the developer holds one document on two icons.*

Two invites to the same game can end up on two home-screen icons: two storage
containers, two databases, reconciled only through the relay. The mailbox makes
the result right, but nothing tells the person which icon is which, or that they
are the same game. It is the same family as the tab-versus-installed-app note
already on the roadmap.

**Trigger:** somebody other than the developer holds one document on two icons.
Until then it is recorded, not built.

#### D42 — The opener's card makes a stronger claim about an unsigned document than it means

*Status: open.*

Open, not designed. The card is the first thing a stranger sees, before the
document itself, and for every unsigned document it says **"Not signed" in
orange** on the "Made by" row. Both the word and the color read as a warning.
What it actually means is narrower: nobody has put a name to this build. The
document is still verified and runs in the same sandbox as any other. Every
example and every demo built without a signing key opens this way.

The question to settle: what the card should say about an unsigned document,
and what it should look like. The wording should state what is and is not
known, with no more alarm than that warrants. Signed and unsigned should still
be distinguishable at a glance.

In the same entry: once a document is open, the **"Enter App Mode" chip sits
over the bottom right corner of the application**, covering whatever the app
puts there. That is the same kind of problem, the host's own UI changing a
stranger's first look at somebody else's document.

Where: the wording is in `apps/runner/src/card.ts` ("Not signed" in the facts
row, and a longer "Not signed — anyone could have made this." elsewhere on the
card). The chip is `#dai-app-mode` in the runtime template.

#### 5.2 Propagation without a beacon

*Status: open — the opener's half is a test; the dashboard is the relay's.*

Distinct fetches per `/d/<id>` at the relay, which sees the request and never
the content. The opener sends nothing. The dashboard belongs to whoever runs a
relay, not to this repository.

**The opener's half is done, and it is the half that could go wrong.**
Everything a store can count, it counts by serving files: a request is a log
line, and the store holds ciphertext and never holds the key, so the number is
real and says nothing about what is in the document. Everything else would be
a beacon — an open reported, a session, a name, or "just an anonymous count" —
and no amount of care about the payload changes what a program that phones
home about a file somebody was sent is.

That property is one script tag away from gone, so `tests/no-beacon.spec.ts`
holds it: opening a document makes not one request off the opener's own
origin, and the page carries no analytics, no error reporter and nothing
loaded from anywhere else. It watches every request rather than a list of
hosts somebody remembered to keep up to date.

**Not here, deliberately.** The dashboard is the relay operator's. For the R2
bucket behind `store.opendai.app` that means Cloudflare's own request
analytics, which already counts requests per object and holds no more than
that. Anything this repository shipped would be this project asking to be told
about other people's documents.

---

#### QR for a reference link

*Status: parked — trigger: a store becomes ordinary.* Only useful once people hold
reference links routinely; see the sender's last-line work in git history (2.5).

### Notifications

#### D34 — Badge the home-screen icon on an incoming move

*Status: waiting on the remaining phone checks — built and deployed.*

**Pulled by:** correspondence chess on real phones. A move arrives hours later,
the notification is swiped away or missed, and nothing on the home screen says it
is your turn. The person has to open the document to find out.

**What is already true.** VAPID is per-origin and belongs to the opener, so every
document mounted from `opendai.app` shares one keypair and one push pipeline.
Confirmed on a device: separate documents installed to the home screen get
separate icons, separate storage containers and separate subscriptions. So a
badge set by one install affects only that install's icon.

**The change.** In the service worker's push handler, alongside the existing
`showNotification`, set `navigator.setAppBadge(n)` to the number of games in that
install where it is this player's turn. Call `clearAppBadge()` when the document
mounts and after the local player moves.

**Open: where `n` comes from. Decide this before writing the two lines.** The
relay's push is payloadless (Track 5): the worker learns that a mailbox moved, and
nothing else. The rows are encrypted, and "whose turn is it" is the
application's knowledge, not the opener's, so the worker cannot count waiting
games from a push alone. The options:
- **The app reports its count.** While mounted, the application tells the host
  how many games wait on this player (a small `window.dai` call, and a new
  surface to specify), and the host keeps that per document. On a push the worker
  sets the badge from the last reported count, plus the mailboxes that have moved
  since the document was last open.
- **The worker counts moved mailboxes.** It counts the mailboxes in this install
  that moved since the document was last mounted. That is honest about what the
  host knows. For turn-based play it approximates "games waiting on you", because
  the relay does not wake the device that made the move. But a rename or a close
  also moves a mailbox, so it is "games with something new", not "your turn".
- **The frame is woken** to compute it. This is not available: nothing runs the
  document while the app is closed, which is the whole point of push.

The entry's own rule, never hardcode 1, holds under either workable option. They
differ in whether the number means "your turn" or "something new", and the
badge must not claim more than the host knows.

**Ruled, 15 September: the app reports its count.** It is the only option that
can pass the guard-both-ways test below.

**Its limitation, on purpose.** The app is not running when a push lands, so the
badge between mounts is the last count the app reported plus the mailboxes that
moved since: a remembered number plus a guess. It drifts the moment a mailbox
moves for something that is not a turn, such as a rename, a close or a resend.
So **the badge is approximate between mounts**, and `clearAppBadge()` on mount,
followed by the app's fresh report, is what makes it honest again: every time the
person opens the document, the count resets to the truth. Nothing may treat the
number as authoritative or build on it. It is a hint to open the app, and the
app is where the truth is.

**Constraints:**
- **The push handler is the supported path.** `setAppBadge` runs in the push
  handler while the app is closed; that is not a workaround. No timer, no poll:
  the badge changes only because a push arrived.
- **iOS needs the notification too.** It requires notification permission before
  a badge renders, and requires every push to show a notification. The badge
  supplements the notification and does not replace it. No silent-push path
  exists on iOS, and attempting one risks the subscription being revoked (noted
  in the push review).
- **Android shows a dot.** Its launchers largely ignore numeric badges.
  Feature-detect with `'setAppBadge' in navigator` and treat the count as best
  effort.
- **Never hardcode 1.** A second waiting game must show 2, or the badge goes
  stale on its first real use.

**Tests:**
- A badge appears on a closed install when a move arrives, and the count matches
  the waiting games.
- With two documents installed, a push for A badges only A's icon.
- The badge clears on mount and after a local move.
- Where the API is absent, feature detection means nothing throws.
- Guard both ways: a push that is not this player's turn must not raise the
  count. Under the moved-mailbox option this test cannot pass, and that is the
  test that forces the decision above.

**Depended on the push pipeline being live. It is, as of 16 September.**
`DAI_PUSH_PUBLIC_KEY` is set on the opener and a real push reached a phone from
the relay: the notification arrived on the lock screen and the home screen,
titled by the app, while the document was closed. **No badge appeared, which is
correct — nothing calls `setAppBadge` anywhere in the opener.** The absence is
this entry, not a setting anybody can turn on: iOS exposes a badge switch per
app, but a web app's badge only renders when the page or its worker sets one.

**Built.** The count is decided in one file, `apps/runner/public/badge.js`,
which the service worker loads with `importScripts` and the opener's page loads
with a script tag.

- **The report.** `window.dai.reportWaiting(sessions)` in the runtime: the
  sessions waiting on this person, sent whole every time it may have changed.
  Only session ids pass the frame. The opener keeps the latest report per
  document in its own IndexedDB store, `dai_badge`, and clears the icon, since
  the person is looking. Tic-tac-toe reports the games where it is your move.
- **The push.** For something new, with the document not on screen, the worker
  adds that game to the games that moved since the report, and sets the badge to
  the number of distinct games in either set. The game is the lane's session,
  or for a lane from before per-game mailboxes, the mailbox. The notification
  is unchanged and still always shown, and a badge failure never gets in its
  way.
- **Open.** Mounting a document clears what moved and clears the icon. The
  app's next report replaces the remembered part.
- **A store of its own,** not a field on the mailbox record: the open app writes
  its lane's whole record back on every save, which would erase anything the
  worker had added.
- Each entry keeps `shown`, the number last given to the icon, beside the sets it
  came from, so a trace can read both.

**Tests.**
- `tests/badge-count.spec.ts` loads the real `badge.js`, not a copy. A move for a
  game not waiting raises the count, and two games show 2. A push for a game
  already waiting does not raise it, and a game moving twice counts once. The
  report replaces what moved, opening clears it, and one document's entry
  leaves another's alone. The API is called to set and clear, and where it is
  absent, throws, or rejects, nothing throws.
- `tests/push-e2e.spec.ts`, "the badge counts games waiting on this player", with
  the real relay and worker:
  - The app is closed and the other player moves: 1.
  - The app is opened: cleared, and the game is reported as waiting.
  - Closed again, the other player renames the game during this player's turn.
    The push is real, but not a new turn: still 1, not 2.
  - The app is opened and this player moves: nothing waits, cleared.
- Proven to fail for the reason each guards:
  - Counting without de-duplication gives 2 at the rename, and two unit tests fail.
  - The worker not recording a push leaves 0 where 1 is expected.
  - The opener not recording opens or reports leaves no entry at all.

**Not covered, and said so.** No test can see the icon: they read what the worker
gave it. Per-install icons (a push for A badges only A's icon) rest on each
home-screen install having its own storage, which is a phone check. So is iOS
rendering the badge at all, and Android showing a dot. The Request example does
not report yet, so its icon counts "something new", not "waiting on you".

**On a phone, 16 September (iOS, home-screen install of a chess document that
does not report waiting games).** With the app closed, the other player joined,
saved their name, and made a move. That was three pushes and three
notifications, and the icon read **1**. So:
- the badge renders on iOS from the worker;
- one game that moved several times counts once on a real device;
- every push still ended in a notification.

**Two games, 16 September:** the same two players with two games running in the one
chess document, and a move arriving in each while the app was closed. The icon read
**2**. The count is per game, not per person, and it does not stop at 1.

Not yet read on a phone: clearing on open without a move, two icons, Android, and
the Request run with a document that reports. (The clear after a move is read; see
the fix below.)

**Found on a phone after CI and `test:push` were green: the badge did not clear
when the player moved.** Chess, badge "1". Opened from the home-screen icon, made
a move, closed: still "1". Reopened (it reloaded) and closed: cleared. Nothing in
the suite could have seen it: a badge is operating-system state, and the tests
read only what the opener gave it.

**Diagnosed before fixing, from the code, then confirmed by a test run before the
fix.** The opener cleared the badge in two places only: when a document mounts,
and when the app reports its waiting games.
- **Not built:** there was no clear on this player's own move. The entry above
  said it clears "after a local move"; that held only for an app that reports,
  whose report after the move did the clearing. Chess does not report, so its
  move cleared nothing.
- **A second gap in the same report:** opening from the icon resumes the page iOS
  kept, and a resumed page does not mount again. So the clear on open did not run
  either, until a reload.
- **The test run before the fix split exactly that way.** The reporting app
  cleared on the move and failed only on resume. The non-reporting app failed at
  the move.

**Fixed.**
- The mailbox session reports a publish only once the relay has confirmed it
  (`onPublished`, for a new move and for one resumed from an earlier visit). The
  opener clears the badge then, for every app, reporting or not.
- A mounted document coming back into view (`visibilitychange`, `pageshow`) clears
  it, which is what opening from the icon is on a phone.

**Tests** (`push-e2e.spec.ts`, "the badge clears after this player's own move is
sent", run for tic-tac-toe as it is and with its report removed):
- A move that cannot reach the relay does not clear.
- The same move, once sent, does.
- Returning to a resumed page clears.

Each is proven on the non-reporting app, the one with nothing else to clear it:
- no clear on publish fails at the move;
- clearing before the publish is confirmed fails at "a move that never left";
- no clear on resume fails at the return.

**Confirmed on the phone, 16 September, after the fix deployed (`2055c00`):** on the
same iOS chess install, the badge appeared for an incoming move, and after this
player moved, it disappeared. That is the clear on a confirmed publish, for an app
that does not report, which is the case that had nothing clearing it before.

**Noted on the phone, not ruled: one move clears every game's badge.** With the icon
at 2 (two games, each waiting), a move in one game cleared the badge completely,
though the other game still waited. That is how it was built: a confirmed publish
clears the whole document's badge, the same as opening it. For chess, which does not
report waiting games, the opener cannot know the other game still waits. Whether that
is a flaw is open:
- **As built,** the badge means "something new since you last looked". Acting in the
  document clears it.
- **The alternative,** without anything new reaching the relay: a confirmed publish
  already knows its game's mailbox, so it could drop only that game from the count and
  leave 1. An app that reports would have its reported count shown rather than
  cleared to 0. The badge then means "games waiting on you", and can stay up while
  the app is open.

**Found alongside, filed as D46:** a publish that fails is sent again only on
this copy's next write or next open, not on a timer. The test sends the stuck move
with a rename for that reason.

**Seen alongside, not built:** a join and a name change each alert like a move.
The worker cannot tell them apart, since the push carries nothing. The shared
tag replaces each notification, but `renotify` alerts again every time. Whether
something that is not a turn should alert is its own question.

So the blocker is gone and the decision is made; what is left is the two lines
in the push handler, the `window.dai` surface for the app to report its count,
and the five tests above — including the guard-both-ways one, which is what
ruled out counting moved mailboxes.

**The open item closed, 21 September: the badge means "games waiting on you", and
only a document that says so is counted.** Two changes, one on each side of the
report:
- **The chess fixture reports.** `reportWaiting` sends the games where this
  player can move, on every draw — which is after every move, every merge and
  every open. It was the non-reporting app in every reading above, including the
  phone reading where one move cleared a badge of 2.
- **A document that has never reported is not counted at all** (`badge.js`:
  `count` returns 0 unless the entry carries `reports`). The number is the
  application's knowledge; for a document that never says, a count is the worker
  guessing on its behalf, and nothing the person does can correct the guess,
  because the correction *is* the report. An app that reports an empty list is
  saying "none", which is different from never saying, so the flag is what the
  report sets, not the presence of a `waiting` list.

**Proven, 21 September.**
- `tests/badge-count.spec.ts`, "a document that never reported is not counted at
  all": two pushes for a silent document show 0; its first report counts both
  games that moved while it was shut; a later report listing one drops the other,
  and an empty report is 0. Red without the guard (`Expected 0, received 1`).
- `tests/badge-reported.spec.ts`, driven as a person does it in the opener: two
  chess games made as White, neither played, and the badge store reads two
  waiting; one move in one game and it reads one. Red with the fixture's report
  call removed (`Expected 2, received 0`) — the entry exists, because mounting
  writes one, and it holds nothing.
- `push-e2e.spec.ts` and the rest of `badge-count.spec.ts` unchanged and green,
  with three of its cases adjusted for the new flag rather than for a new number.

This also settles the "not ruled" note above for a reporting app: with chess
reporting, a move in one of two games leaves the other's count standing, because
the report after the move lists it. The clear-on-publish path is unchanged for
apps that do not report, and there are now none in the fixtures.

#### D44 — A burst of shared writes becomes one notification

*Status: built, 21 September. Waiting on a phone reading of the window's
length.*

**Built.** One alert per game per quiet window, in the worker alone.
`NOTIFY_WINDOW_MS` in `apps/runner/public/sw.js` is **15 seconds**, and a wake
inside it is still shown — it replaces what is on screen, with the newest
content — but does not alert: `renotify: false`, `silent: true`. It is never
skipped, because a push that shows nothing is what gets a subscription revoked
on iOS.

- **The window runs from the last alert, not the last wake.** A game that keeps
  moving then alerts once per window rather than never, which is what "one
  notification per game per window" has to mean for a game that stays busy.
- **A store of its own** (`dai_notify`), for the same reason the badge has one:
  the open page writes its whole mailbox record back on every save and would
  erase anything the worker had put there.
- **A storage failure alerts.** The fallback is the behavior before this
  existed, never a wake swallowed in silence.
- **The number is provisional and marked so in the code.** This entry asks for
  it to be chosen against real use; the only reading so far is that the setup
  burst fits inside a few seconds. It wants a phone sitting.

**Proved** by `push-e2e`, "a burst of writes while a game is set up alerts once,
and a later one alerts again" — the sequence from the phone: Ada closes her app,
Bo joins, saves his name, and moves. Three writes, three real wakes delivered to
her device, one alert. Then the window passes with nothing happening and one more
write alerts again.

**What the test reads, and why not the obvious thing.** Not the number of
notifications on screen: the tag means it is one either way. The first attempt
read the current notification's `silent` flag and failed — the join travelled as
two batches, so an alert was raised and folded over before the test could look.
It reads the worker's own record of when each game last alerted, which is the
decision itself rather than its shadow, and the on-screen notification for the
content. A general form of the rule in part 3: **a state that gets overwritten
cannot be sampled; read the decision, not the display.**

**Proven to fail for the reason it guards, both halves:**
- Alerting on every wake fails at "one notification on screen, carrying the
  newest of them, not alerting" — `silent: false` where true is expected.
- A window that never reopens (alert only if the game has never alerted) fails
  at "a write after the window alerts again", with the recorded time unmoved.

**Still open in this entry:** the window's length against real use, and whether
a burst that folds should say how many writes it covered.

**Seen on a phone, 16 September** (D34's first reading): setting up one game
produced three alerts in quick succession: the other player joining, saving their
name, and making the first move. The document was a chess install; the mechanism
is the opener's and applies to any shared document. Each was a real shared write
that was published to the mailbox and woke this device. The worker cannot tell
them apart, because the push carries nothing. It gives each the same tag, so each
replaces the last on screen, but with `renotify: true` every one of them alerts
again.

**The ruling:** a burst inside a short window becomes one notification. Replace
rather than stack, and drop `renotify` for a wake inside the window. Whatever is
decided later about labelling writes, three alerts in ten seconds should be one.

**Why it is separable and goes first:** it fixes the observed problem in the
worker alone. No protocol change, nothing new reaches the relay, and no author
declares anything. The setup burst may turn out to be the whole problem: a
one-time burst per game may not justify per-write labelling (out of scope in D45)
at all. Read that from use before deciding the more expensive change.

**Constraints that hold:** every push still ends in a notification, because iOS
revokes a subscription that shows none. A folded wake replaces the earlier
notification silently; it is not skipped.

**Open: the window's length.** It needs a number chosen against real use, not
designed now.

#### D45 — An author declares whether a document notifies

*Status: ruled — not built.*

Ruled, not built.

**Today.** Every shared document notifies, and no author can turn that off. The
opener subscribes each mailbox to push, the relay wakes the other devices on
every new batch, and the worker shows a notification for every wake. Nothing in
a document says anything about it. That default arrived by accident, not by
decision.

**The ruling: authors get per-document on or off,** declared in the document and
surfaced through the SDK. Correspondence chess wants alerts; a shared packing
list or a passable receipt probably should not nag anyone.

**Why it is cheap.** The choice is made before anything is published. The opener
knows the document before it subscribes, so a document that declares no
notifications never subscribes. No new information reaches the relay, and the
rows still arrive the next time the app is opened or polls.

**The order of authority:**
1. **The person.** A recipient can revoke notification permission in their
   operating system's settings at any time, whatever the document says.
2. **The author** sets the default for the document.
3. An author's choice is a default, never an authority. A document can ask not
   to notify. It can never insist on notifying someone who declined.

**Open, not ruled:**
- **Where the declaration lives:** a schema marker beside `author=`, or the
  manifest. `author=` went into the schema because it describes the tables and
  is signed with them, and the build refuses a role it cannot honor (D15).
  Re-read that reasoning when this is decided: notifying is about the document,
  not a table, which may point the other way.
- **The default** for a document that declares nothing.

**Out of scope here: per-write labelling,** where some writes in a document
notify and others do not. That costs relay visibility. The decision would happen
per batch at publish time, and the relay would learn whether each batch was worth
waking someone for. D8 gave each game its own mailbox address so the relay learns
as little as possible. Do not fold it in here. It is a separate question with a
separate cost, and D44 may remove most of its motivation.

### Screens people meet

Added: two shipped surfaces that draw a real state wrongly. They are where the design
rule above applies first.

#### L1 — The card must not hand over a container that isn't ready

*Status: open.*

Pressing Get on a large document while its assets are still loading produces a
page flash and a return to the card, with no message. A person who taps promptly
is punished for it, and nothing tells them what happened.

**Measure first, before any UI.** A trace of a slow Get (a large game) put the
~5.29 s on one row: the `blob:` **document load** of the mounted container, with
the blob URL already created before that row began. So the delay is **not** the
pre-mount work — inflate, digest, assemble and blob construction all finished
before it — and it is not download or engine: the service worker fulfils the
asset requests so their sizes read 0 B (not a volume signal), and `sqlite3.wasm`
/`sqlite3.mjs` are 304s at ~38 ms. The scripts *inside* the container frame
(`blob:null/…`, `about:srcdoc`) are 1–98 ms. What is left is the frame's own boot
— HTML parse plus main-script execution before the document's `load` fires. So
the profile must attach **inside that frame boot**, and it decides the whole
item: because the 5.29 s lands after navigation, preparation-before-Get cannot
move it, which points at the mount/boot path (or the app's own startup for a
large document) needing the work — streaming or otherwise. Confirm with the
profile before touching the card.

Then two parts. **Prepare before the press:** the card fetches and verifies the
container as soon as it is shown, so for most documents Get is instant, and Get
stays disabled until the container is at least identified — a press can never
land on nothing. **Hold if it is not ready:** if preparation is still running
when Get is pressed, stay on the card and show progress rather than navigating.

One path for every document — do **not** gate on a size threshold. Show the
progress affordance only when the wait passes a few hundred milliseconds, so a
small document looks exactly as it does today and a large one stops blinking.
And the blink is its own defect: a launch that fails must say so **on the card**.
A card that reappears looking untouched is the unrendered-failure pattern again.

**Exit:** the profile run has named where the ~5.29 s goes in the mount path and
which fix that implies; Get is disabled until the container is identified; a slow
document shows progress on the card and never navigates until it is ready; a
launch that fails leaves a message on the card rather than a card that looks
untouched; a small document renders no progress affordance (its prepare finished
under the threshold).

#### L2 — The make-one page's step 3 has four states and one layout

*Status: open.*

Step 3 shows an empty bordered box beside "Open it now" — the link output
rendered before a link exists, which reads as a field someone is meant to fill
in — and "Build my file" stays visible after the file is built, where pressing
it again is not a legible action. Both are symptoms of one layout serving four
states.

Step 3 has exactly four states, each needing its own layout:

- **nothing built yet** — Build my file, and nothing else;
- **building** — progress, the button disabled;
- **built** — the file's name and size, Open it now, the link with a copy
  control if there is one, and a quiet Start over that clears the loaded assets;
- **failed** — what went wrong, in that block, with a way to retry.

**Exit:** no empty link box before a link exists; Build my file is gone once the
file is built; each of the four states renders its own layout, asserted one per
state.

#### The desktop window shows the host's icon, not the document's

*Status: open.* The desktop window should show the document's own icon.

### Authoring and the kit

#### D70 — The bridge's load-time check ships inside every document, where it can never fire

*Status: ruled — not built. Move it in the same pass as D69, so the runtime
bundle and the host fingerprint change once, not twice.*

**What it means to a person:** every document is about a kilobyte bigger than
it needs to be, to carry a check that cannot fail by the time it is carrying it.

`src/bridge.ts` checks its own names as it loads: no value twice, and each value
equal to `DAI_HOST_` plus its key. That check is right, and it caught both
mutations it was built for (D68). But the runtime bundles the module, so the
check runs in every document, at every open, in a bundle whose strings were
fixed when it was built. There, it can never find anything. Routing the runtime
through the owner grew the bundle from 63,865 to 64,910 bytes (+1,045): the two
objects and the check, which the build did not inline. Every document carries
that runtime.

The check belongs where the names can still change: at build time, or in a test
(`tests/bridge-wire.spec.ts` already runs beside it). The runtime keeps only the
names. Moving it changes the runtime bundle and so the host fingerprint. D69's
collapse of the `dai:*` names will change them anyway, so both go in one pass,
one new host.

#### D76 — The runtime could expose its public event names to authors

*Status: parked — a possible later addition, ruled out of D69 (18 September).*

Authors cannot import from `src/`, so today they learn `dai:merged` from the
model file (`src/rules.ts`, whose anchors point at `src/frame.ts`). The runtime
could also expose the public names, for example `window.dai.events.MERGED`, so
an application references the runtime's own value and not a string it typed.
Not done: it is an API addition, and a new public surface is itself frozen the
day it ships (D75). Un-parks if an author's typed name is ever the cause of a
bug.

#### D69 — The runtime's messages to the app frame have no owner either

*Status: open. Ruled to follow D68: after the bridge names have their owner.*

**What it means to a person:** an author's document listens for these names.
If the runtime and the kit drift apart, someone else's app stops redrawing, or
stops saving, at runtime, with nothing failing in this repository's build.

The same problem as D68, on the other side of the runtime. Between the document
runtime and the application frame it hosts (the kit, and any author code) runs a
second set of messages and events: `dai:merged`, `dai:write-rules`,
`dai:save-state`, `dai:request-share`, `dai:sessions` and more. Each is a string
literal at every place it is sent or heard.

**This one matters more than D68.** The host bridge is spoken between two
programs this repository builds together. This surface is the one *authors*
write against: `dai:merged` is how an application learns the other party's row
landed (`rules.ts`, the model file). A name that drifts here breaks documents
nobody in this repository can see or test. It needs an owner, and, unlike the
bridge, it probably also needs to be a published, versioned list.

**Size, and the first job.** A grep on 18 September found **37** distinct
`"dai:…"` strings in hand-written source, but they are not all messages. The
`dai:` prefix is shared by at least four kinds of name: frame messages, events
dispatched on `window`, schema markers (`dai:replicated`, `dai:profile`) and
local-storage and lock keys. One prefix with several meanings is the part-3
pattern itself. Before an owner, each string needs classifying, as D68 did by
parser and by runtime tap. Then only the frame messages and events are
collapsed. Where the kit's source lives, and how it reaches a document, is to
be established as part of that; it was not checked here.

**Groundwork, 18 September.**

*The prefix, split by kind.* The `dai:` prefix names at least nine kinds of
thing:
1. **Runtime ↔ app-frame messages.** About 30, in `src/runtime/bootloader.ts`.
2. **Window events raised for authors.** `dai:merged`.
3. **Opener ↔ service-worker messages.** `dai:which-document`,
   `dai:shell-updated`, `dai:mailbox-moved`.
4. **Window-to-window handoff.** `dai:opener-ready`, `dai:handoff`, already
   constants in `src/handoff-tab.ts`.
5. **SQL markers.** `dai:replicated`, `dai:profile`, already owned by
   `REPLICATED_MARKER` and `SESSION_PROFILE_MARKER` in `src/replicated.ts`.
6. **Local-storage and lock keys.** `dai:opens:`, `dai:ground:`, `dai:resume`,
   `dai:install-asked`, `dai:keep-after-reload`, and `dai:<uuid>` locks.
7. **Key-derivation labels.** `dai:mailbox:key:`, `dai:mailbox:id:`,
   `dai:mailbox:v1`. Renaming one would make every existing mailbox
   undecryptable, so these are frozen harder than any message.
8. **Document metadata.** `<meta name="dai:does">`, written by authors and read
   by the card.
9. **Mentions in author documentation and lint.** `rules.ts`, `recipe.ts`,
   `lint.ts`.

Only 1 and 2 are D69's subject. Kinds 4 and 5 already have owners. Kinds 3, 6
and 7 are different namespaces with different owners, and are not collapsed
here.

*How the app-frame end is written.* Not in a separate file, and not in the kit.
The frame side of the conversation is TypeScript functions inside
`bootloader.ts` (`bridgeMain`, `frameLoader`), injected into the app frame as
text: `"(" + bridgeMain.toString() + ")()"` (`bootloader.ts:2760–2765`). A
function serialised that way loses its module scope, so it cannot use an
imported constant. The kit is also text, `KIT_SOURCE`, a string in
`src/kit.ts`, and it spells one message, `dai:used`. Every shell-to-frame send
goes through one helper, `toFrame(...)`.

*Which names are frozen.* The opener mounts every document in its **own** shell
(`main.ts:858`, `hostShell(... HOST_RUNTIME)`), so a document's kit and author
code always run against the opener's current runtime, whatever built them. So:
- **internal:** names between the shell and `bridgeMain`. Both ends are in one
  runtime bundle, always the same version, so they can be renamed;
- **public:** names the kit or author code sends or hears (`dai:used`, the
  `dai:merged` event). These cross versions like the host bridge and are frozen.

*Two collisions found.*
- **`dai:merged` is both the event authors listen for (`bootloader.ts:1318`,
  `:1453`) and a message type (`:2170`, `:2175`, `:3479`).** One name, two
  meanings.
- `dai:insets` (the shell's answer, `:3338`) and **`dai:insets?`** (the frame's
  question, `:2222`) are two names differing by a trailing `?`. The first
  inventory pattern did not allow `?` and merged them.

*One bridge message outside D68's owner.* `dai:isolation-report` crosses from
the frame through the shell to the **opener** (`main.ts:2130`). It is a
host-bridge message spelled with the frame prefix, and not in `TO_HOST`.

*Live or dead, by observation.* A temporary tap, removed afterwards, watched the
chromium suite: 700 tests, 2,933 `dai:` messages. **It was partly blind, and
the pairs show where.** It saw everything the app frame sent up (19 names, from
`dai:save-state` ×540 to `dai:error` ×1) and everything that reached the opener
(`dai:isolation-report` ×3, `dai:handoff` ×1). It saw **nothing** sent from the
shell down to the app frame, because the frame is sandboxed without same-origin
access and cannot be listened in on. `dai:sessions-answer` arrived 258 times
while its request, `dai:sessions`, was never seen. So the downward names
(`dai:sessions`, `dai:flush`, `dai:apply-batch`, `dai:authored-since`,
`dai:replica-id`, `dai:write-rules`, `dai:insets`, …) are **inferred live from
their replies, not observed**. Names with no reply to infer from are
*unestablished*, not dead. The service-worker surface showed no traffic at all,
which cannot tell untested from unseen. And as with D68, observation measures
what the tests exercise.

*What authors are told.* `rules.ts` names six: `dai:merged`, `dai:replicated`,
`dai:profile`, `dai:does`, `dai:error` (to say it never reaches the application)
and `dai:request-share`. The website docs name five of the same. Fourteen of
`rules.ts`'s anchors quote `dai:` text, and `tests/rules.spec.ts` checks every
anchor still matches its file, so routing names through an owner will need
each anchor on a routed literal re-pointed.

#### D1 — The kit writes shared tables with raw SQL, and never redraws on a merge

*Status: open.*

Run, not read (13 September, against the rewrite in `node:sqlite`): a kit write
control — `data-run` or `<dai-form run=…>` — against a replicated table fails.
An INSERT throws SQLite's own `NOT NULL constraint failed: <table>._r_replica`,
which is not a named refusal; an UPDATE or DELETE of an existing row throws
`REPLICATED_TABLE_IMMUTABLE`. The same in a session document. The kit catches
none of them (`src/kit.ts` `run`), so the throw escapes the click handler, a
form keeps what was typed, and the person sees nothing. And the kit redraws only
after its own writes (`refresh`), never on `dai:merged`.

Documented for now as: the kit's write controls are for local tables; shared
tables are written through `window.dai.replicated`; the kit's reading elements
work over the `_current` views, and an app redraws them on a merge with
`window.daiKit.refresh()`.

That undermines the kit's own argument — most of an app as HTML and SQL rather
than code — exactly where the format is most distinctive. Two changes:

1. **The kit listens for `dai:merged` and calls `refresh`.** Small, and it helps
   every app, shared or not. No trigger needed: take it with the next kit change.
2. **A kit write control that targets a replicated table goes through the write
   surface** instead of raw SQL — `INSERT` to `insert`, and a change or remove
   addressed by the row's entity rather than by `WHERE id =`. This needs a
   design for how a control names an entity and, in a session document, a
   session. **Trigger:** the first eval candidate for a shared prompt that fails
   `shared-raw-write` through a kit control, or the next shared example that
   would be shorter in the kit — whichever comes first.

**Exit:** a kit-only shared app (the receipts example rewritten in the kit)
inserts, changes and removes a shared row and redraws when the other copy's row
arrives, with no JavaScript of its own; the constraint text changes to match in
the same commit.

#### D7 — The walkthrough's example shows its forms before it has started

*Status: open.*

`examples/tasks` — the application the make-one walkthrough compiles — puts two
`<form>`s on screen (`index.html`, the new-project and compose forms) while
`app.js` is still waiting on its top-level `await dai.openDatabase()`. That is
the window NO-INPUT-LOST-WHILE-OPENING closes: whatever a person types there is
lost, by a replaced page or a reset form depending on the browser. Out of the
change that added the rule, which fixed the receipts and tic-tac-toe examples.

**Exit:** `examples/tasks` keeps its page hidden and inert until start-up has
finished, shows what went wrong if it fails, and the walkthrough still builds
and opens it.

#### D13 — The in-browser compiler skips the build-time schema check

*Status: parked — trigger: the next change to the rewrite, or the website compiler (see the entry).*

The open half of D5, recorded there under Change 2: the Node build loads a
shared-table document's rewritten schema into SQLite and refuses to build if it
does not load, but the website's in-browser compiler (`compileInBrowser`) has no
engine at build time, so a rewrite defect there still builds and then fails at
open. D5's scoreboard row reads done, which is why this has its own line.

Why it matters: the in-browser compiler is the door a person uses on the
website, so the check that now protects every other door does not protect the
public one.

**Un-parks with the next change to the rewrite, or when the website compiler
builds shared-table documents for anyone but us** — load the opener's already
staged SQLite engine in the compiler page and run the same two-open check.

#### D20 — A table constraint in a shared table rewrites to SQL that will not load

*Status: parked — trigger: D13, or the next change to the rewrite.*

Found by building every shipped example through the Node build (15 September).
The rewrite appends the replication columns after the author's column list. When
that list ends in a table-level constraint — `UNIQUE (game_id, ply)`, a table
`CHECK (…)`, a `FOREIGN KEY` — the columns land after the constraint, and SQLite
refuses the table: `near "_r_replica": syntax error`. `examples/chess-foil` is
the instance; it is wrong on purpose and never meant to open, and the test now
asserts the build refuses it.

Why it matters: the Node build refuses it, but with SQLite's grammar error rather
than a sentence about the rule, and the in-browser compiler (D13) has no engine,
so it would seal the document and it would fail on the device of whoever opened
it. The D5 family again: the rewrite's text assumed a shape the author's SQL
does not have to take.

Two fixes, either sufficient: place the replication columns before the first
table constraint, keeping the author's constraints; or refuse a table
constraint in a shared table by name. A `UNIQUE` there is already wrong by the
rules — it refuses the very conflict a merge exists to show — so refusing it by
name is the cheaper and clearer of the two for that case; a table `CHECK` may be
legitimate and argues for placement.

**Un-parks with D13, or the next change to the rewrite** — whichever comes first.

#### D25 — `website/public/demo.dai.html`: tracked, written by nothing, read by nothing

*Status: open.*

Found giving the generators check modes (14 September). `scripts/build-demo-cartridge.js`
writes a demo document to the repo root and to `apps/runner/public/`, neither of
them committed. The tracked demo is a third file, `website/public/demo.dai.html`,
which no script writes and nothing in the repository names.

It stays. "Nothing references it" is what the caller check said about two live
Vue exports (D9) — the site can link a public file from somewhere a text search
of this repository does not reach, and a person can have been given its URL. A
stale demo costs nothing; a wrongly deleted one costs an afternoon.

**Exit:** find out what it is — where it came from, whether the live site or
anyone links it — and then keep it on purpose, regenerate it from a script, or
remove it with the reason.

#### D43 — Whether the model file should carry the examples' stylesheets

*Status: parked — trigger: the model file becomes genuinely large.*

Open question, not scheduled. Each example's bundle in the model file includes
its `app.css`. Styling is not what the model file teaches, and the stylesheets
are a real share of it: the session example's alone is about 4.9 KB of the
119,444 bytes.

Leaving `app.css` out of every bundle would change what a fresh model sees
across the board. A model that sees no stylesheet may write worse pages, or
may simply write its own. That is a question for a blind run, not a reading.

Not an option: a shortened stylesheet kept for the model file beside the real
one. That is one thing with two copies that can drift apart, the defect family
in the pattern entry.

**Trigger:** the model file becoming genuinely large. `tests/model-file-size.spec.ts`
makes any growth a deliberate budget change, so the growth that would prompt
this will be visible when it happens.

#### D14 — Two blind runs is not a rate

*Status: parked — trigger: a public claim about how reliably a model builds, or the next large rewrite of the model file.*

The documentation's success test is a model building an app it has never seen
from the published pages alone. Two such runs exist
(`eval/candidates/claude-opus-5-blind`, `…-blind-agreement`). Both passed, and
both found real defects the pages had hidden: the first, the places its agent
found the model file unclear, each checked and fixed; the second, a WebKit
failure that turned out to be the documentation's cause — the redraw-on-merge
rule (`SHARED-REDRAW-ON-MERGE`), which the first run's rows could not have hit.
That is a good sign and says the method works; it is not a measure of how often
a model succeeds, and nothing can be claimed from it as one.

Why it matters: the documentation is written for models as much as people, and
"a model can build from it" is the claim it is judged by. Two runs cannot tell a
page that works from a page that got lucky twice.

**Un-parks when a claim about how reliably a model builds from the pages is about
to be made in public, or before the next large rewrite of the model file** — run
enough prompts across shapes to state a rate, with the method in
`docs/evaluation.md` ("A blind run: the documentation's own defect list"), and
commit every run under `eval/candidates/` as the method says.

### The specification

#### D75 — What can never change without breaking documents already out there

*Status: open. The link-field and key-derivation gaps are closed (`tests/fragment-wire.spec.ts`, `tests/mailbox-labels.spec.ts`, 18 September); the SQL markers, `window.dai` and refusal codes are not.*

**What it means to a person:** these are the things that, if changed, make a
document, link or icon someone already has stop working, with nothing to tell
them why. Every document carries its own runtime, the opener keeps every earlier
host, and a link or icon lives as long as someone keeps it. So these are frozen.
Each needs a check that fails if it changes. A check that only compares the
code with itself (a registry against its own constants) cannot catch a
consistent rename, which is exactly the dangerous change.

| Surface | Where it is defined | What protects it | Gap |
|---|---|---|---|
| Host bridge names (29) | `src/bridge.ts` | `tests/bridge-wire.spec.ts` writes every value out | none |
| Frame public names (`dai:merged`, `dai:used`) | `src/frame.ts` `FRAME_PUBLIC` | `tests/frame-wire.spec.ts` | none |
| Link fragment fields (`a`; `h k u c s`; `opener-doc`) | `src/fragment.ts` | collision check at load; `fragment-keys.spec` holds the constants to the registry; **`tests/fragment-wire.spec.ts` writes every value out** | none. Proved: with `h` renamed to `x`, `fragment-keys` passed and `fragment-wire` failed |
| Key-derivation labels | `dai:mailbox:key:`, `dai:mailbox:id:` (`src/mailbox.ts`), `dai:mailbox:v1` (`mailbox-session.ts`) | `v1`: `session-mailbox-e2e` derives with the literal. `key:` and `id:`: **`tests/mailbox-labels.spec.ts`**, known answers checked against an HKDF with the labels typed out | none. Proved: with `key:` renamed, `mailbox.spec` passed and `mailbox-labels` failed |
| SQL markers (`dai:replicated`, `dai:profile session`) | `REPLICATED_MARKER`, `SESSION_PROFILE_MARKER` in `src/replicated.ts` | `rules.ts` anchors, and the parser's own tests | anchors hold the constant's line, not the string |
| `<meta name="dai:does">` | read by `apps/runner/src/card.ts` | a `rules.ts` anchor on the reader | none named |
| Container bytes (manifest, CBOR, envelope) | `src/core.ts`, `src/cose.ts` | `conformance/vectors.json`, `tests/vectors.spec.ts`, the Python reader | none |
| Kept hosts | `apps/runner/public/hosts/*` | `tests/host-retention.spec.ts` | none |
| The `window.dai` functions authors call | `bootloader.ts` `bridgeMain` | `rules.ts` anchors on some | no single list; not every function anchored |
| Refusal codes a host records | `src/refusals`, registry | `refusal-registry.spec` checks presence; **`refusal-wire.spec` holds all 66 spellings** (20 Sep) | closed: a consistent rename of `BLOB_MISMATCH` through the registry, its thrower and its spec fails the wire test while the registry check passes |

**The cheap move for each gap** is the one the two wire tests already make: one
test per surface that writes every frozen value out in full, the allowed
exception to importing constants. The first three gaps are small; the last two
need their list written down first.


Added: the specification and the refusal registry are what an author and a second
implementer read, and they lag the code in the same way.

#### D2 — The refusal registry omits the codes an app author actually meets

*Status: open — 22 codes registered; a test fails on a missing one.*

`src/refusals.ts` is the registry, and `tests/site-claims.spec.ts` holds the
host-bridge table to it — every registered name is in the table. The check runs
one way only. The codes a developer writing an application meets are thrown in
the frame and are not registered: `REPLICATED_TABLE_IMMUTABLE` and `ROW_REJECTED`
(the replicated-table triggers, `src/replicated.ts`), `NOT_SEAT_CREATOR`,
`WRITE_SURFACE_UNAVAILABLE`, `WRITE_RULES_NOT_DELIVERED`, `NO_DOCUMENT_OPEN`
(`src/runtime/bootloader.ts`), `NOT_REPLICATED`, `SCHEMA_MISMATCH`,
`UNSUPPORTED_LEVEL` (`src/replicated-frame.ts`), `REPLICATION_SCHEMA_INVALID`,
the `MAILBOX_*` family and the `MERGE_*` family. So `site-claims` passes while
the codes a developer sees are undocumented — a checker that covers less than
it appears to.

**Exit:** every code the source can throw or return as a refusal is in the
registry, and a test enumerates them from the source (the `RAISE(ABORT, …)`
strings and the thrown and returned code strings) and fails on one the registry
lacks — so the next code cannot be added without its entry.

**Landing (15 September).** `tests/refusal-registry.spec.ts` reads the codes out
of `src/` in the positions where a code is raised — `new …Error("CODE")`
(including a code leading a template message), `refused: "CODE"` and its
`|| "CODE"` fallbacks, `RAISE(ABORT, 'CODE')`, `refuse…("CODE")`, and an error
class's `code = "CODE"` — and fails on one the registry lacks. Positions rather
than every upper-case string, because the bridge's message names and the
environment variables are strings too. It also fails if it finds fewer codes
than it did when written, so a pattern that stops matching cannot pass by
finding nothing. The scope is `src/` — the library and the runtime inside every
container; the opener's own internal failures, such as an IndexedDB open that
never answers, are the host's business. `src/rules.ts` quotes codes as
documentation and is not read.

Twenty-two codes were raised and unregistered — twenty-one found by searching
by hand, and the twenty-second, `MAILBOX_BATCH_UNKNOWN_TABLE`, found only by the
test, which is the case for having it: the shared tables' two
(`REPLICATED_TABLE_IMMUTABLE`, `ROW_REJECTED`), the write surface and its rules
(`WRITE_SURFACE_UNAVAILABLE`, `WRITE_RULES_NOT_DELIVERED`, `NO_SOURCE`,
`MERGE_MODULE_MISMATCH`, `MERGE_MODULE_UNUSABLE`, `NO_DOCUMENT_OPEN`,
`NOT_SEAT_CREATOR`), the merge (`MERGE_UNAVAILABLE`, `NOT_A_DATABASE`,
`NOT_REPLICATED`, `SCHEMA_MISMATCH`, `UNSUPPORTED_LEVEL`, `MERGE_FAILED`,
`APPLY_FAILED`), the mailbox (`MAILBOX_KEY_INVALID`, `MAILBOX_BATCH_TRUNCATED`,
`MAILBOX_BATCH_MALFORMED`, `MAILBOX_BATCH_UNKNOWN_TABLE`, `MAILBOX_APPEND_FAILED`) and the build
(`REPLICATION_SCHEMA_INVALID`). Each is registered with what it means, and
`website/docs/host-bridge.md` has a second table, *While a document is open*,
for them — the first table's heading is about refusals before mounting.

#### D3 — The specification is behind the code to the point of contradiction

*Status: open — scope when asked.*

`docs/spec-v0.2.md` §9 says a reader MUST accept `manifestVersion` 2 and 3 and
MUST refuse any other value; the code accepts `[2, 3, 4]`
(`SUPPORTED_MANIFEST_VERSIONS`, `src/container.ts`) and a replicated build emits
4 (T1-D25). There is no normative text for version 4, replicated tables, the
`_heads` / `_conflicts` / `_current` views, the session profile, seats and
bindings, the close, or `dai:merged`. The website's `docs/specification.md` is
headed v0.1. The design record for all of it is
`docs/profiles-and-confidentiality-2.1.1.md`, superseded in places by the
numbered decisions in `docs/replicated-tables.md`.

Scoped separately, when asked for: a v0.3 that is normative for version 4,
with the Python reader implemented from its text as version 3 was.

#### D19 — The published specification says a reader must refuse version 4

*Status: parked — trigger: the next docs change.*

`docs/spec-v0.2.md` §9 (line 957): "A reader MUST accept `manifestVersion` 2 and
3, and MUST refuse any other value." Version 4 is what a document with shared
tables is built as (T1-D25), and every reader here accepts it. So a published,
normative sentence contradicts shipped code, in the specification the media-type
registration points to.

Why it matters: a third implementer reading the spec would build a reader that
refuses every shared document, and be right by the text. The full v0.3 (D3) is
the real fix and stays parked; this sentence cannot wait for it.

This is its own small item, split out of D3 so it does not sit with a track it
is not part of. The change: accept 2, 3 and 4; say version 4 is defined by the
design record until v0.3 (`docs/replicated-tables.md`); refuse any other value.

**Un-parks with the next docs change** — it rides with whatever touches the
documentation next.

#### CDDL and byte vectors for carriers

*Status: open.* Left over from manifestVersion 3: the carriers in spec 2.4 have no
CDDL and no byte vectors.

#### D68 — The host bridge reference describes a protocol that no longer exists

*Status: open. Marked in place, 18 September; not rewritten.*

**What it means to a person:** someone building a host from the published
reference would build one that cannot save a merge, share a link, or keep a
session, and would believe it complete.

**Closed, 20 September:** the reference is generated from `src/bridge.ts` by
`scripts/build-docs.mjs` into `website/docs/bridge-reference.md` — all 29
messages, each with its own note from the owner's doc comment — and the roadmap
section points at it. The drift check is `build-docs --check`, which
`rules.spec` runs: adding `DAI_HOST_THERMOSTAT` to `TO_HOST` fails it by name
(`stale: website/docs/bridge-reference.md`, exit 1).

`docs/roadmap.md`'s "The host bridge" section was last edited on 2 September
(`ea0cb91`). The bridge has grown since: `DAI_HOST_REQUEST_SHARE` arrived on
7 September (`15f4355`), and `DAI_HOST_MERGE` and `DAI_HOST_WRITE_RULES` on
9 September. Counted on 18 September, the code uses **28** `DAI_HOST_*` message
types (`src/`, `apps/runner/src/`), and the section's tables document **6**
(`HANDSHAKE`, `HANDSHAKE_ACK`, `SAVE`, `SAVE_ACK`, `REFUSED`, `CLOSING`). Among
the 22 missing: the write rules and their refusal, merge and its result, the
authored/apply-batch exchange, sessions, share requests, replica id, flush,
insets, ground and canvas. Its refusal-reason table is likely behind too, and
was not recounted.

A reference that describes a protocol that no longer exists is worse than none,
for the same reason a test that cannot fail is: it is trusted. The section now
opens with a line saying what it is current as of, and pointing here. The
rewrite is its own piece of work: enumerate every message from the code, say
which direction each flows and why, and decide whether the reference belongs
in the roadmap, the specification (§4.4) or its own page. It should also get a
check that fails when the code gains a message the reference does not name, the
D56 prevention applied to documentation.

**Groundwork, 18 September: the names have no owner.** Every `DAI_HOST_*` name
is a string literal written at each place a message is sent or checked, in four
hand-written files across three programs: the document runtime
(`src/runtime/bootloader.ts`), the web opener (`apps/runner/src/main.ts`,
`apps/runner/src/mailbox-session.ts`) and the desktop host
(`apps/desktop/src/main.ts`). Nothing declares the set: no union type, no enum,
no constants object. A drift check against "the list" is not possible until
there is one, so the ruling is to give the names a single owner that the runtime
and the web opener both import, as `src/fragment.ts` owns the link fields, and
to build the check after.

**Live or dead, established two ways before anything is collapsed.**
- *Handled* is a property of the code, so it was read with the TypeScript
  parser, not a regex. Every literal site was classified by its place in the
  syntax tree: the value of a `type:` property is a send; a `===` or `case` is
  a handler; the `ask(request, reply)` helper's second argument is an awaited
  reply. That covered 65 sites in 69 files.
- *Sent* was shown at runtime. A temporary tap in the opener page, removed
  afterwards, recorded every bridge message in both directions across the whole
  chromium suite: 700 tests, 4,996 messages. It could see both directions:
  every request/reply pair matches (`HANDSHAKE` 220 : `HANDSHAKE_ACK` 221,
  `SAVE` 281 : `SAVE_ACK` 280, `SESSIONS` 258 : `SESSIONS_ANSWER` 258, and so
  on).

Result:
- **Live both sides: 27.** Each has a sender in one program, a handler in the
  other, and was seen on the wire. Every one flows in exactly one direction:
  16 runtime → host, 11 host → runtime. With `CLOSING`, all 28 split 17 and
  11.
- **Live one side only: 1, `DAI_HOST_CLOSING`.** The runtime sends it (seen 15
  times), and the web opener has no handler. Only the desktop host handles it.
  On the web it goes out and nothing receives it.
- **Dead: none.** All 28 were sent in the suite. Some rarely:
  `WRITE_RULES_REFUSED` twice, `REFUSED` three times, `REPLICA_ID` four times.

**What "sent" measured.** It was measured by watching the chromium suite, so it
measures what the tests exercise, not what the product can do. All 28 appeared,
so the question did not arise this time. But a name that never appeared would
not have shown whether it was dead or only untested: a zero from this method
distinguishes neither. Before a name is called dead on this evidence, it needs
the parser's answer as well (no send site anywhere), or a test that drives the
path.

**The desktop, recorded and not changed (deferred until mobile V1, not
abandoned).** The desktop build copies the *current* runtime into
`apps/desktop/public/runtime/` on every build (`scripts/stage-runtime.mjs`,
`prebuild`/`predev`). That folder is gitignored, and a stale local copy from
5 September knows only 8 names. Read as "the runtime the desktop ships", that
copy was misleading. The real gap is the host: `apps/desktop/src/main.ts`
handles 4 names (`HANDSHAKE`, `SAVE`, `REFUSED`, `CLOSING`) and sends 2
(`HANDSHAKE_ACK`, `SAVE_ACK`), while the runtime a desktop build would carry
sends 17. The desktop rewrite starts from the owner.

### Trust, verification and offline

#### D74 — The mailbox's key-derivation labels are wire format, and two are unpinned

*Status: fixed, 18 September. `tests/mailbox-labels.spec.ts` pins the `key:` and `id:` labels by known answer; `v1` stays pinned by `session-mailbox-e2e`.*

**What it means to a person:** if one of these strings changed, every game
already in progress would stop receiving moves, silently: the mailbox would be
derived under a different key and address, and read nothing.

`dai:mailbox:key:` and `dai:mailbox:id:` (`src/mailbox.ts:105–106`) and
`dai:mailbox:v1` (`apps/runner/src/mailbox-session.ts:76`) are HKDF `info`
labels. They are the strictest frozen surface here: stricter than a message
name, because nothing can translate a key derived under an old label. `v1` is
pinned in effect, since `tests/session-mailbox-e2e.spec.ts` derives with the
literal. `key:` and `id:` are pinned by nothing. A test that derives a known key
and address from a fixed document key, and compares with values written out in
full, would pin all three. That is the D75 move.


#### D31 — A document the opener has verified is verified again when it mounts

*Status: waiting on a trust ruling.*

**The observation.** Found while reading the load path for D11. The opener checks a picked file in full (`verifyContainer`: digests, the shell against its sealed copy, the signature). Then the mounted container's own bootloader does the whole check again, with its own decoded and inflated copies. On a large document the second pass is a real share of the peak memory that kills a phone tab.

**Not redundant, even though it is the same routine.** The two checks guard against two different threats that happen to use the same code:
- **The opener's check** protects *the opener's* decision to mount the document.
- **The document's check** protects the document anywhere: in a plain browser, on a static host, with no opener in the picture.

Removing either one loses the thing only it defends.

**Why this is not simply a fix.** The mount's own check is what protects a document opened with no opener: a file opened straight in a browser, or by some other host. It is also what the container's shell promises. Skipping it whenever an opener has already looked moves trust from the document to the host. That may be right, but it is a decision about who vouches for the bytes that run, not a memory optimization, and it is not taken here.

**The questions a ruling has to answer:**
- Under a host that has verified, can the shell's check be skipped? Or should it be kept and made cheaper (streamed, and hashed in place as D11's fixes do)?
- If it is skipped, how does the shell know the host really verified, and verified *these* bytes, rather than taking the host's word?
- What does a document opened with no host keep, unconditionally?

**Status.** Undecided. D11's memory fixes do not depend on it and must not be read as approving it.

#### D29 — An offline reopen sometimes fetches the document's icon from the network

*Status: open.*

`offline-second-open.spec.ts:26` ("comes back on its own, engine and all") reopens
a document this device already holds with the network cut, and requires that
nothing reaches it. On Firefox in CI (run 34889745158, 14 September) its first
attempt failed: this was requested, twice —

    http://localhost:5175/doc-icons/6d4410af-bbf0-4cc0-840c-97a46ded3904.png

It passed on retry.

A second sighting, the same day (run 34900932214, Firefox, 889b3b4), and it
widened what this is: the request that reached the network was not the icon but
the confusable table —

    http://localhost:5175/confusables.bd086572.json

so it is not about icons. An offline reopen sometimes lets *whatever the page
asks for during the open* reach the network — the icon one time, the confusable
table the next. The trace of this attempt was kept (`retried-firefox-whole`,
D27).

That is not test noise. The test's claim is the offline promise — a document you
have opens with no network — and assets went to the network anyway. That it
happens only sometimes, to a different asset each time, points at a race
between the page's requests during an open and the service worker being ready to
answer them from its cache, not at any one asset.

**Lead (14 September, from a kept trace):** both assets are ones the *browser*
fetches for itself from the page's head, not ones the page's code asks for. The
built opener page carries `<link rel="prefetch" href="./confusables.<id>.json">`
(injected by `apps/runner/vite.config.ts`), and a document's icon address
`/doc-icons/<uuid>.png` is what its per-document manifest names for the icon —
the service worker answers that path from its own cache (`sw.js`), but a
manifest's icons and a prefetch are fetched by the browser. A trace from a
different spec (static-opener, Firefox, run 34903935645) shows the prefetch in
action: the confusable table requested once and aborted (`NS_BINDING_ABORTED`),
then fetched again 77 ms later by the page itself and answered 200. If Firefox
makes those browser-initiated fetches without passing through the service
worker, that is exactly how they would reach the network during an offline
reopen. Not yet proven: the next D29 trace should show whether the request that
escaped was the prefetch or manifest fetch, or the page's own.

**A third sighting, 15 September** (run 34964053176, Firefox, `09ec0ba`): again
`confusables.bd086572.json`, and again it passed on retry. Its trace is kept
(`retried-firefox-whole`, 211 KB), and it is the first kept trace where the
escape is the confusable table, so it can answer the lead's open question: did
the request come from the prefetch link or from the opener's own
`confusables()` call? `sw.js` collects the file for its cache (line 99), so the
answer is about timing, not about whether the worker knows the file.

**Answered from that trace (15 September): it is the prefetch.** During the
offline reopen the table was requested twice:
- **The page's own fetch** (`Sec-Fetch-Mode=cors`) was answered 200 by the
  service worker.
- **The browser's own prefetch** (`Sec-Purpose=prefetch`, `no-cors`, from the
  `<link rel="prefetch">` that `apps/runner/vite.config.ts` injects) failed with
  `NS_BINDING_ABORTED`. The test records exactly that: `cutTheNetwork` counts a
  request that *failed* after `setOffline(true)`, and one the worker answers
  never fails.

So on Firefox a prefetch is not answered by the worker, and offline it goes to
the network and fails. The earlier icon sighting fits the same shape: a request
the browser made for itself, from the head.

**Dropping the prefetch link would move the failure, not remove it (checked
15 September, after the question was asked before ruling).** The link is not
only a prefetch: it is how the worker learns the table's name. `sw.js`
precaches every `src`/`href` it finds in `index.html` (`appAssets`), and its own
comment says the table is "named in the page by a prefetch link so this worker
can find it". Take the link away and the table leaves the precache. The
opener's own `confusables()` fetch (`apps/runner/src/confusables.ts`) then goes
to the network at the moment it is needed. On an offline reopen that fails, and
the opener falls back to `NO_TABLE`: publisher names compared by folding only,
which is weaker, said so in the state it produces, but still a regression of
the offline promise.

**Ruled and built, 15 September: break the dependency, not the symptom.** The
worker names the table in its own precache list (`PRECACHE` in `sw.js`, the
content-hashed name stamped by `vite.config.ts` at build and asserted, like the
cache name). The page's scan no longer looks for it, and the prefetch link is
gone. What is available offline is unchanged, and an offline reopen no longer
fires a request the browser makes for itself. `offline-second-open` holds both
halves: no prefetch in the page, and the table in the worker's cache after an
offline reopen. It was proven both ways by stamping a wrong name, which fails
the cache check.

**Why the scan was the real fault.** A worker that discovers its own precache
list by pattern-matching the page silently stops caching anything the page
stops mentioning. That is the same failure family as the `*.dai.html` ignore
rule that hid the isolation probe: a mechanism that works by scanning covers
less than it appears to, and nothing says so. It is the third instance this
week. The page scan still finds the hashed `assets/` bundle; that entry is
correct today for the same reason this one was, and is worth the same scrutiny
the next time the build's output changes shape.

**Then the premise moved (15 September, a probe).** Every Firefox "escape" D29
has recorded failed with `NS_BINDING_ABORTED`: the confusable prefetch twice, and
the document icon. A probe gave the baseline. While offline, a same-origin
address nothing has cached, which has to try the network, fails with
`NS_ERROR_OFFLINE` on Firefox and `net::ERR_FAILED` on Chromium, three runs of
three each. So `NS_BINDING_ABORTED` is a request the browser or the page
*cancelled*, not one that reached the network. `cutTheNetwork` counts every
`requestfailed` as "went to the network", so the Firefox sightings were the
detector counting cancellations. Three clean offline reopens under the probe
showed no aborted request at all, which fits an intermittent cancel, not a leak.
The icon has three references in the head (two `<img>` and `apple-touch-icon`,
written by `describedAs`); a load cancelled as the page settles is enough.

**Measured after the precache change, against a baseline.** Six Firefox repeats
of `offline-second-open` at three workers:
- **With the change:** 3 of 6 failed on the icon.
- **With the committed `sw.js` and `vite.config.ts`:** 2 of 6 failed on the icon. The other 4 got past the icon and failed on the new "no prefetch link" assertion, which is that assertion catching the old code.

The icon failure is the same on both sides, so the change did not cause it. In
every icon failure the "escaped" loads were `NS_BINDING_ABORTED`, each followed
a few milliseconds later by the same icon answered 200 by the worker: a load
cancelled and made again, not a request that reached the network. The rate is
high enough (about 1 in 3 under load) that the detector proposal above is what
stands between this test and a reliable Firefox retry.

**Ruled and built, 15 September: the guard counts what it means.**
`cutTheNetwork` sorts a failure by its error text:
- **Reached:** a request that tried the network.
- **Set aside:** a cancellation. It is logged as it happens, in passing output
  too, and listed in the failure message, so it is set aside rather than
  ignored.
- **Unrecognized:** counted as reached and named, so a new engine or error
  makes the guard louder, never quieter.

`tests/offline-detector.spec.ts` proves it both ways on each engine: a genuine
uncached fetch while offline must be caught with a recognized error, and a
cancelled load must be set aside and seen to be.

The engines cancel differently, as two probes measured:
- **Chromium** reports a fetch the page aborts, and an image the page removes,
  as `net::ERR_ABORTED` every time.
- **Firefox** reports nothing for a page's own abort. It reports
  `NS_BINDING_ABORTED` only for a load a navigation cuts off, about one in
  three. That is why D29 appeared only sometimes, and always just after a
  reload.

So on Firefox the test repeats the setup (four worker-served loads, then a
reload) until a cancellation happens. The check itself runs once, on the first.

With the guard in, `offline-second-open` passed 6 of 6 on Firefox under the same
load that failed it 3 of 6. The log names four cancelled icon loads
(`NS_BINDING_ABORTED`) it set aside. That settles D29's remaining sightings as
cancellations. If the test fails again, it is new information.

**Proposed, for a ruling: make the guard count what it means.** `cutTheNetwork`
should count a failure that means the request tried the network
(`NS_ERROR_OFFLINE`, `net::ERR_INTERNET_DISCONNECTED`, `net::ERR_FAILED` and the
like) and set aside a cancellation (`NS_BINDING_ABORTED`, `net::ERR_ABORTED`),
naming each one it sets aside so nothing is hidden. Proven both ways: an
uncached fetch while offline must still be caught, and an aborted load must not
be. Changing what a guard counts is exactly the change that needs that proof,
because a guard that ignores too much is as broken as one that fires on
everything.

**What the evidence pointed to before the ruling:** keep the name discoverable to
the worker, but not as something the browser fetches for itself. For example,
name the table in the page in a form the browser does not fetch, such as a
`<meta>` the worker's scan reads, or have the worker precache the content-hashed
name directly. Then the page's own fetch is answered from the cache, as the
engine's is, and the browser has no prefetch to send past the worker. The test
for it is the one that caught D29: an offline reopen with nothing reaching the
network, plus the table present, not `NO_TABLE`.

**Exit:** find why the page's requests can reach the network during an offline
open — a worker not yet controlling the page, or a request made before its cache
is consulted — and close that for every asset; the test then holds it every time.

#### Firefox loads the thin engine network-first

*Status: open.* A thin link carries no engine, so the opener supplies
`runtime/sqlite3.wasm` and `.mjs` from its own cache. Chromium serves them
cache-first; Firefox requests them from the network first and falls back to cache,
so a thin document opened offline still runs but makes two failed engine requests on
the way (found by the strict offline assertion in `tests/offline.ts`, which is why
`inline-link` asserts only that it opens, while the full-document offline tests
assert nothing reached the network). Minor, since the app works offline on both, but
it is a real difference on the primary carrier, so worth a look at how the engine is
loaded on the thin path (WASM or module fetch versus a cache-first fetch the worker
answers).

#### D21 — A new confusable table leaves untouched publisher pins on the old one

*Status: parked — trigger: the next change to the confusable table.*

Found deciding D9's `refreshed`. A publisher pin stores its name's lookalike
"skeletons", computed against the confusable table the opener held when the pin
was saved, and the lookup that warns "this name looks like one you know" searches
by those stored skeletons (`bySkeleton`). Every save recomputes them against the
current table (`src/publisher.ts`), so a pin that is used again is brought up to
date. A pin nobody touches after the opener ships a new table keeps skeletons
from the old one — and a lookalike the new table would catch is not found,
because the stale pin is filed under the old skeleton.

`refreshed` was meant to cover this, one pin at a time as a host met them. It
could not: the pins that matter are exactly the ones a lookup never finds. It
was never called and is deleted.

Why it matters: the lookalike warning is the defence against a name impersonating
a publisher somebody already trusts, and a table update is when it is meant to
get better. Rare — the table changes only when the opener ships a new one — and
silent.

**Un-parks with the next change to the confusable table**: when the opener loads
a table whose id differs from a pin's, re-index every pin once (the store needs a
way to list them), then carry on.

#### D22 — The runtime's own save zips without the fixed timestamp

*Status: parked — trigger: the next change to the runtime's save path.*

Found looking at the share-sheet race (14 September). Every place that builds a
payload zips with `mtime: ZIP_EPOCH`, so the same entries always make the same
bytes — except `resealContainer` in `src/runtime/bootloader.ts` (line 643), the
save a document makes inside a browser with no host, which stamps the current
time. It was not the cause of the race it was found beside: that export went
through the host's reseal, which pins the timestamp.

Why it matters: two saves of the same data give different bytes, so anything
that compares saved documents by their bytes — a digest, a de-duplication, a
test — sees a change where there is none. Nothing does that today.

**Un-parks with the next change to the runtime's save path**: `mtime: ZIP_EPOCH`
there, as everywhere else.

#### The desktop host signs with a key it keeps

*Status: open.* The desktop window builds unsigned, because `compileInBrowser` no
longer mints a key. It is the one host that *could* keep one: it has a filesystem
and a config directory, so it should offer to, and reuse the same key next time,
which is what makes a publisher pinnable across documents. Until then `/desktop`
says plainly that it does not.

#### D67 — A database written by one SQLite build and opened by another is untested

*Status: open. Moved from the roadmap's numbered plan (item 4), 18 September,
where it was the only record. No test exists.*

**What it means to a person:** a document kept for years could open in a newer
opener, or in the desktop app instead of the browser, and read differently
from how it was written, with nothing saying so.

A `.dai` file carries a SQLite database, and different hosts open it with
different engine builds: the browser opener's WebAssembly SQLite, the desktop
app's, and whatever a later version of either ships. Page size is pinned at 4096
for new databases (`tests/container.spec.ts:644`, "pins a new database to 4096
and holds it across save and reopen", holds that *within one engine*). Nothing checks a database written by one engine
build and opened by another. `tests/one-engine.spec.ts` sounds as if it does, but
it guards something else: that there is one container *compiler*.

This is the silent-divergence family. The likely failures are not a refusal but
a quiet difference: a file-format feature one build writes and another reads
differently, a collation or `LIKE` behavior that changes a query's answer, or
the replicated views (`_current`, `_heads`) computing a different head on a
different engine. The roadmap's proposal was a matrix test, each engine writing
and every engine reading, before anyone keeps years of data in one. Not ruled.

#### Identity: what manifestVersion 3 left

*Status: open.* `hostLabel` UI beyond a prompt; a QR for the safety number; a real
Sigstore signing flow at build time.

### Protocol changes

#### D48 — Getting a player back into a game they are already in

*Status: partly ruled. The honest message and the documented meaning are built; chess
keeping its Share button after join is ruled and small; taking a lost seat back is ruled
not ready.*

**Ruled, 16 September.**
- **One call, one meaning; no alias.** `requestShare(session)` is the only call. An
  alias beside it would be one act with two names, the D41 shape. The meaning is now
  in `SESSION-INVITE`, including "keep offering it after the other party has joined".
- **The honest message ships first.** A copy whose seats all belong to other devices
  was told "you have not been invited". That is false for a player on a new device or
  browser, and it tells them they do not belong when the truth is their device is gone.
  A copy cannot tell that player from someone the game was forwarded to, so the message
  is written to be true for both: the seats belong to other devices, and a player who
  played elsewhere should carry on there. Changed in tic-tac-toe, Request and the chess
  fixture, and in `SESSION-MEMBERSHIP`; the forwarded-copy test now also asserts the
  word "invited" is gone.
- **Chess keeps its Share button after the other player joins.** That button is the
  recovery path for the common case (a lost tab, data intact). Small, and soon.
- **Taking a lost seat back stays unbuilt.** The sentence cannot be finished, because
  nobody can say who may claim a seat.

**One missing primitive now blocks three items.** Taking a lost seat back needs an
identity a person holds apart from any one device. So does Transferable ownership
(its key-holder identity), and so does D52 — a session document that restores its
bytes after a storage wipe and is still unplayable, which reaches this same wall by
a different road. A primitive that blocks three things is a different priority from
one that blocks one. Whoever next weighs any of the three should weigh the identity
itself, not each item alone.

**The asymmetry: a lost creator is worse than a lost joiner, and more likely.** The
creator is the person most likely to have started from a phone and moved on. Seats,
reseat, close under `close=creator`, and every `author=creator` table are bound to the
creator's replica id, so a creator on a new device cannot be recovered by anyone,
while a lost joiner's seat could at least be repaired by the creator if the history
question were answered. The chess fixture used to tell a creator on a new device to
"open an invite from" the player who started the game: themselves.

**Seen.** A player in a Safari tab closed it and lost the link. Their data was
intact in the opener's storage; only the address was gone. The other player tried
to send them back in, and the only thing the app offered made a new game.

**What the code says, which changes the diagnosis.** The SDK can already make a
link to a session that exists. An invite is `window.dai.requestShare(session)`, and
it mints nothing: `exportSession` filters the sender's document to that session's
rows, and the link carries that game's key. Calling it again for a live game makes a
link to the *same* game. The new game came from the chess app. Its Share button is
shown only to the creator, and only until someone has joined
(`tests/fixture/chess/app.js`: `$('share').hidden = !(seat && seat.amCreator &&
!joined && …)`). After that, the only control left is Rematch, which creates a new
session. So an app today *can* send someone back in; what is missing is a name and a
meaning for doing it, so no app knows it should.

**1. The acts, named.**

| Act | What it means to a person | Exposed today |
|---|---|---|
| Start a game with someone | "Here is a new game; open it and you are the other player." | Yes: `session.create()`, then `requestShare(session)` |
| Send a game again | "Here is our game; open it to get back to it." | Yes, unnamed: the same `requestShare(session)` on a live game |
| Take a lost player's place back | "Your old device is gone; this puts you back in your seat, with your moves." | **No, and cannot be built on today's roster** (see 3) |
| Hand a seat to someone else | "You play my side from now on." | No. It is transfer, parked under Transferable ownership |

So there are four, and only the first two are possible. They are one call.

**2. What an invite means.** One sentence: **a link to one game, carrying that game's
rows and its key; opening it gives you the game, and gives you the open seat if one is
still open.** Read that way, "start a game with you" and "here is the game again" are
not two acts. They are the same link, and what it does depends on the recipient's
state, which is where the two meanings the word "invite" was carrying come apart.
That is the one-thing-two-meanings pattern again, living in the *name* and not the
mechanism: the SDK and the documentation call it an invite, so apps treat it as
"start". The call does not need splitting. Its meaning needs writing down, and
"invite" is the wrong word for half of what it does.

**3. What opening the link does, by recipient.**
- **Holds the game (same browser, storage intact):** the arriving copy is a sibling
  and merges (the second-invite path, already fixed), and the copy keeps its own
  replica id, so the player is back. They may not need a link at all: opening
  `opendai.app` in the same browser reopens the last open document
  (`rememberOpen`, then `launchFromLibrary` at start-up), and held documents are
  listed there. This case is a discoverability gap, not a missing primitive.
- **Holds nothing (storage evicted, a different device, a different browser such as
  a home-screen install versus a Safari tab):** this is the case that matters, and
  today it cannot work.
  - A player's identity in a game is the replica id that bound their seat, and it
    lives only in that device's storage. A fresh copy has a new replica id.
  - Opening the link gives the new copy the game's rows, but the seat is already
    bound to the old replica, so there is no open seat. `joinIfInvited` joins only an
    open seat, and the app shows the not-invited state. The rightful player is told
    they were never invited.
  - The one roster repair, `session.reseat`, runs only for a contested seat, is
    refused for anyone but the creator, and by its own comment "drops every binding
    to the old value … eject that joiner and vanish their moves". So even if the new
    copy contested the seat and the creator reseated, the player's past moves would
    stop being admitted.
  - **If the lost player is the creator, nothing can be done.** Seats, reseat, close
    under `close=creator`, and every `author=creator` table are bound to the creator's
    replica id.
  - What would make it work is a roster act that **admits a new replica as the
    successor of a bound one, keeping the old replica's rows admitted.** That raises
    the question the sentence cannot yet answer: who may say that the new device is
    the same person? Today the only identity is possession of the old storage. An
    answer needs a key the person holds apart from any one device, which is the same
    missing key-holder identity Transferable ownership depends on. **Until that
    exists, the honest behavior is to say so:** a copy that holds a game's rows, whose
    seat is bound to a replica it is not, is told "this game's seat belongs to a
    device this copy is not; that device's player can continue", not "you were not
    invited".

**4. Against D38.** Unchanged. D38's hard part is an offer that travels over the
existing mailbox instead of by link, with its own consent. Sending a game again is
already a link and already exists, so it takes nothing off D38. They share only the
existing carrier.

**5. The API surface.**
- **No new call, and nothing in the frozen link format changes** for sending a game
  again. It is `requestShare(session)` as it is, and every link already sent keeps
  working.
- **What changes is documentation and naming.** `SESSION-INVITE` and the reference
  describe the call as the invite. They should state the sentence in 2, and name
  sending a game again as a use of it, including that an app should keep offering it
  after the other player has joined. A rename (for example an alias such as
  `shareGame`) is possible but not needed, and it would be a second spelling of one
  act, which D41 argues against.
- **Taking a lost player's place back is a protocol change, stated loudly:** a new
  roster row kind or rule and a change to the admission views, gated on a key-holder
  identity that does not exist. It does not change the link format, but it changes
  what the relay-less merge admits, and it cannot be built before the identity
  question is answered.
- **The not-invited message for a player whose seat is bound elsewhere** is a small,
  honest change in the example apps and the documentation. It needs no protocol
  change and could come first.

**The rule this item is about.** The sentence for "start" and "send again" can be
written, so those are ready: they are documentation. The sentence for "take a lost
player's place back" cannot be finished until someone can say who is allowed to
claim a seat, so that act is not ready to build.


#### 6.2 A data-only carrier

*Status: open.*

Every move sends the whole application. The recipient already has it, byte for
byte, and only the database changed. This is the complaint that started it.

The mechanism exists one level down: a compact link already elides the shell,
the kit and the engine, names them by digest, and has the receiver rebuild
them. The same move applied one level up — leave out the application when the
receiver holds that `documentUuid`, name it by digest, let their copy supply
it — turns a megabyte per move into a link shorter than a paragraph, with no
store, no upload and no expiry. It carries no code at all, so it is a smaller
trust surface than what is sent today, and the schema reconciliation that
already runs is what refuses a database that does not fit.

Needs: the carrier and its grammar in the spec, a refusal a person can act on
when the receiver does not have the application (naming it, and who to ask),
and a second choice in the send sheet — the application, or just the data.

#### D6 — A session seats two people, whatever max_parties says

*Status: open — documented as a two-person limit meanwhile.*

`-- dai:profile session max_parties=N` signs N into the document, and the
roster treats it as a ceiling (`rosterOf` flags more seats than N,
`src/replicated-roster.ts`; `SEATS_EXCEED_CAP`). But nothing reads N to mint
seats: `session.create()` takes no arguments and mints the creator's seat and
one open seat (`src/runtime/bootloader.ts`), and the surface has no call that
adds a seat — `reseat` replaces the open one. So a document declaring
`max_parties=4` can only ever seat two members, and the other two people have
no seat to bind. Found while choosing a prompt for the second blind run; the
documentation claimed "one open seat per other party" until corrected.

Documented meanwhile: `SESSION-PROFILE` and the session shape say a session
seats two today, and to declare `max_parties=2`.

And the cap is not enforced anywhere (found 15 September, deciding D9's
`rosterOf`). More seats than `max_parties` was flagged only by `rosterOf`, a
TypeScript statement of the roster rule that nothing on the real path called; the
`_dai_member` view that decides membership has no cap, and neither has any write
path. So "`SEATS_EXCEED_CAP`" is registered and raised by nothing. Enforcing the
cap is part of this item's exit, in the view, where membership is decided.

**Exit:** a session can seat up to `max_parties` people — either `create()`
mints `max_parties - 1` open seats, or a creator-only `session.invite()` mints
one more up to the cap — with an invite per seat (which D4's per-session invite
is the natural carrier for); an end-to-end test seats three; the documentation
drops the two-person limit in the same change.

#### D38 — A rematch has to be sent as a link, which is absurd between two people already playing

*Status: parked — trigger: someone asks for a rematch (see the entry).*

Two people playing each other share a private channel already: the game's
mailbox, sealed under a key only they hold. A rematch could mint a new game and
deliver its key **in-band** through that channel, so playing again needs no link
at all — and "play somebody else" stays the same operation with the key
delivered by link instead. One mechanism, two deliveries.

**Deliberately not built (ruled 15 September), for two reasons:**

1. **It changes what an arriving message can do.** The standing rule is that
   nobody is seated without a person opening something (T1-D34) — that rule is
   consent, and it is load-bearing. In-band delivery makes a row capable of
   creating a game. Even framed as an offer, that is a change of kind, and it
   does not belong inside a commit whose job is fixing a live bug.
2. **It re-links what D8 separated on purpose.** Each game was given its own
   address and its own key so that a relay cannot tell that two games share a
   document or a person, and there is a privacy test holding that. Putting game
   two's key into game one's channel re-links them. That may be acceptable — but
   it has to be argued on its own, with D8's test updated knowingly rather than
   incidentally.

**The trigger that un-parks it:** when somebody asks for a rematch and finds
sending a link absurd. That will happen, and that is when the argument above is
worth having.

**A rule that is settled either way — removal is local.** When a person removes
the other player, it means *on their own copy only*: they leave, and may invite
somebody else. It never ejects the other person from their copy. Symmetric
ejection lets two people destroy a live game with no arbiter to decide who was
right, and the tier this sits in is social and conditional — detectable, not
preventable. **One replica never gets the power to destroy another's copy.**
Stated here in those words because the next person to touch it will assume
ejection should propagate.

#### D23 — The inline dictionary is frozen, and the corpus it was built from has moved

*Status: parked — trigger: a better ratio matters, or a carrier change is due anyway.*

Found by giving `scripts/build-dictionary.mjs` a check mode (14 September). The
dictionary (`f19f8e91`) was built on 5 September from the recipe, the shell
template, the kit and the example apps; every one of them has changed since,
and a rebuild today gives `4abb6072`.

It must not be rebuilt as things stand. A link names the dictionary it was
compressed against, and the opener holds exactly one (`src/inline.ts`), so a
new dictionary refuses every link made against the old one — every document
shared by link since 5 September. Until the check, one bare run of the script
did exactly that, silently. It now refuses without `--replace`, and its check
holds that the committed dictionary is whole rather than that it matches the
corpus.

What the drift costs: links compress a little worse against text the apps no
longer contain. Small.

**Un-parks when a better ratio matters, or a carrier change is due anyway**: the
opener must accept the old dictionary and the new one side by side before a new
one ships, so a link made against the old one keeps opening.

#### Transferable ownership

*Status: parked — trigger: a transferable instrument is needed, and only after Track 4.*

Not scheduled. Recorded because the shape is decided
(`docs/transferable-ownership.md`, TO-D1) and issue
[#1](https://github.com/dynamicapplicationinterface/dai-core/issues/1) asks for
it — and because doing it the other way, a hosted account or ownership carried in
the signed manifest, would be expensive to undo.

**The park, and the sentence that un-parks it.** Transfer is re-encryption plus a
signed transfer row: a chain of transfers verified offline by anyone holding the
file, with a witnessed relay tier as an opt-in service. The cryptographic claim (a
holder without the key cannot open it) is absolute; the social claim (only one
party holds it) is conditional and, offline, detectable rather than prevented —
the decision keeps those two apart. It sits on `recipient-bound` (Track 4,
registered and unimplemented) and on a key-holder identity that does not exist yet
— no enrollment, no passkey-derived key in use, no way for one opener to learn
another opener's public key — so it cannot be built before those, and refusing a
superseded copy needs revocation-by-policy machinery that `main` does not have.
**Un-parks when an enterprise use case needs a transferable instrument**, and only
after Track 4 has landed under it. Until then it is thinking, not work: PR #2 stays
open and unmerged.

**The key-holder identity this depends on now blocks three items**, not one: this,
D48 (taking a lost seat back), and D52 (a session document restored after a storage
wipe, unplayable because the seat is bound to a replica that is gone). The park
stands, but the primitive underneath it should be weighed on its own rather than as
a precondition of whichever item is in front of whoever is reading.

#### Device capabilities

*Status: parked — trigger: the first real request for a device capability.*

Not scheduled. Recorded because the shape is decided by things already built,
and doing it the other way would be expensive to undo.

**The bridge is the model.** `requestShare()` is the template: the application
never holds the capability, it asks; the host performs the action in its own
UI; the person decides; the application receives a result. A health read is the
same shape — `requestHealth({ types, from, to })`, the host's own sheet naming
what it will read, the host writing the rows into the application's database.
The application never touches the device API and cannot ask twice unseen.

**The card already accounts for it.** `claimsFor()` prints a promise only when
the host holds every clause behind it, so a host with device access stops
displaying "Can't see your other tabs, files or apps" on its own, with no
special case. That is the part usually got wrong and it is already built.

**Prefer growing hosts to growing the format.** The web opener cannot read
HealthKit; there is no web API, so only a native host ever could, and a
capability in the format is one most hosts cannot honour. A workout tracker is
an ordinary document opened by a capable host, degrading the way applications
already degrade on `hasSqliteEngine`. Nothing in the manifest reserves a
capability field today, and adding one later is a `manifestVersion` bump, which
readers already refuse by name.

Three hazards, worst first:

- **Notifications are not a read.** A read is the person handing data in while
  looking at the application. A notification is the document reaching out while
  it is *not open*, which breaks "inert when closed" — a stronger property than
  the network one, and the reason it is safe to keep a stranger's file. The
  honest version is the host scheduling a reminder about a document, which is
  the host's notification and not the application's.
- **Data read in is data that travels.** The document is the database, so a
  heart rate read in can be sent by "Share app". The include-data toggle is not
  adequate consent at that stakes; this likely needs data marked as never
  travelling, which is a real format change and the expensive part.
- **It makes signing load-bearing.** Unsigned is tolerable today *because* a
  document can do nothing. Unsigned and reading health data is not the same
  proposition, so capabilities are gated on publisher trust — which means the
  trust and identity work has to be finished first, not shipped alongside.

#### D16 — A native iOS host: App Clip and Messages extension

*Status: parked — trigger: onboarding friction is what blocks use (see the entry).*

Two things a web opener cannot do on an iPhone. An **App Clip** is the seamless
first open: a QR code or link goes straight to the card, with no browser tab and
no "add to home screen" step in between. A **Messages extension** is how a game
reaches somebody inside the conversation it was sent in, without asking them to
install anything — today a move on iOS is only delivered by push to an
installed web app (see Track 5 slice two), which is an instruction a person has
to follow first.

Why it matters: onboarding is where the format loses people, and on iOS the web
route's best case still has a step a person can refuse. Why it waits: it is a
second host — a native app, its own review, its own release — and the web opener
has to be right first. "Native phone apps as a prerequisite for first use" stays
in *Not doing*; this is an addition for people who already have one.

**Un-parks when onboarding friction is what blocks a pilot.**

### Hosts

#### D72 — The opener and its service worker speak in unowned names

*Status: fixed, 20 September.* `src/worker.ts` owns the four names, and
`apps/runner/src/main.ts` reads them from it. `sw.js` is a classic worker
(`register("./sw.js")`, no `type: "module"`, one `importScripts`) and cannot
import, so it keeps its literals and `worker-names.spec` holds them to the
owner — the kit's arrangement, with `dai:isolation-report` as its one named
exception (the bridge owns it) and the `dai:ground:` / `dai:mailbox:` prefixes
left to D73 and `src/mailbox.ts`. Proved to fire both ways: renaming
`SHELL_UPDATED` in the owner fails it, and giving `sw.js` a name nobody owns
fails it.

*Status: open. Split out of D69, 18 September; not collapsed in that pass.*

`dai:which-document`, `dai:shell-updated` and `dai:mailbox-moved` pass between
the opener page and its service worker, each spelled wherever it is sent or
heard, like the bridge names before D68. `sw.js` is plain script and cannot
import, so an owner here needs the same route the bridge's hint took: a test
that reads the names off the worker's real traffic. The observation tap in D69
saw no traffic on this surface at all, which cannot tell untested from
unexercised. That is worth knowing before the owner is built.

#### D73 — The opener's storage and lock keys share the dai: prefix with everything else

*Status: fixed, 20 September.* `src/keys.ts` owns all seven — the three
constants, the three per-document makers (`dai:ground:`, `dai:install-asked:`,
`dai:opens:`) and the library lock (D41's `dai:<uuid>`, spelled once). `main.ts`
and `install.ts` read them from it; `storage-keys.spec` refuses a second
definer, checks no two makers can produce one string, and holds the head
script's hand-built copy of the ground prefix to the owner, since a script that
runs before any module cannot import. Proved to fire: a key spelled by hand in
`main.ts` fails it, and renaming the ground key in the owner fails the head
script check.

**The masking is fixed (20 September).** The version stamp now tracks
`buildEnd(error)` and skips its work when the build failed, so `closeBundle`
no longer reads a `dist/sw.js` that was never written. Proved by putting the
duplicate back: the build reports `install.ts (196:9): Identifier "groundKey"
has already been declared`, where it used to report ENOENT.

**Found while routing it:** `install.ts` had its own `groundKey`, so the import
collided — and the build reported the version-stamp plugin's ENOENT instead,
because that plugin reads `dist/sw.js` in `closeBundle` and the real error
never reached the console. Three clean builds in a row said the same wrong
thing. The duplicate is renamed at its use; the masking is not fixed.

*Status: open. Split out of D69.*

`dai:opens:`, `dai:ground:`, `dai:resume`, `dai:install-asked`,
`dai:keep-after-reload`, and the `dai:<uuid>` document locks are local-storage
and Web Lock names in the opener. Some are already constants in the file that
uses them (`RESUME_KEY`, `KEEP_AFTER_RELOAD`); the head script spells
`dai:ground:` itself (D58). They are one namespace, written from several files,
with nothing that sees all of it: D56's shape. They are not wire format, since
they never leave the device, but a rename strands what a person has stored
under the old key.

#### D66 — The desktop app opens one document at a time, and a second replaces the first

*Status: open. Moved from the roadmap's numbered plan (item 3), 18 September,
where it was the only record.*

**What it means to a person:** opening a second document on the desktop closes
the one they were working in.

The desktop app is single-instance (`apps/desktop/src-tauri/src/lib.rs:555`,
`tauri_plugin_single_instance`). A second launch hands its file path to the one
existing `main` window and exits, and the frontend opens it there, replacing
whatever was open. Single-instance was chosen to close a race on the trust
registry: two processes touching it at start-up. That reason still holds. The
roadmap's verdict was that for a document application this is the wrong shape,
and that the right one is **a window per document, with a single owner for the
registry**. Not ruled. It touches the trust registry's ownership, the
`dai://open-cartridge` event, and every save path that assumes one open document.

### Test and CI integrity

None of this is product. Each entry is about whether the suite's verdict can be
trusted.

#### D47 — `static-opener` fails in full local runs, and nobody has read why

*Status: fixed, 18 September. The teardown closes its servers' connections before
closing the servers. Which connection held it is still not established; see
below.*

Open. `tests/static-opener.spec.ts:147`, "a /d/ link on a plain static host opens
the document", has failed in the full local `test:push` run several times this
week. Each time it passed when run alone, and it was called environmental. The
error text was never read.

The latest, 16 September, during D34's clear-on-move change: 1 failed out of
1,053, then 3 of 3 alone. Rerunning overwrote the original error text, so this
sighting explains nothing either.

**The rule for the next failure: read the error and keep the result directory
before rerunning anything.** "It passed alone" is not an explanation. A spec that
fails only under a full run's load or ordering is saying something about load or
ordering, and a rerun discards the only evidence of what.

**17 September: a full run with the evidence kept, and it passed.** `test:push` at
`b6ff876`, four workers, log and `test-results/` copied out before anything else
ran: 1,057 passed, 0 failed, 2 skipped, 5.9 minutes. `static-opener.spec.ts:147`
passed in **1.2 s**. The other two tests in the file took under a second each.

What that does and does not say:

- **It does not close this.** One clean run is not a rate (the D14 argument), and
  the earlier sightings were "several times this week" across runs.
- **It weakens the budget explanation.** The test is `test.slow()` (90 s) and wraps
  a `compileDirectory`, a `#card-open` click with a 60 s timeout, and a `loaded`
  wait with another. Read as code, that suggests a slow run could overrun. But
  under the same full-run load the whole test took 1.2 s, so being somewhat slow
  does not reach 90 s. **A failure here is a stall of about a minute at one step,
  not a slow run.** The next failure's error will name which wait expired, and
  that is the question it should be read for.

**18 September: it failed again, the evidence keeper kept it, and the stall is
in the test's own teardown, not in any wait.** A push-tier run at `5a68727`
(`test-runs/2026-09-18T17-32-50-751Z-5a68727`) failed `static-opener:147` with
"Test timeout of 90000ms exceeded", naming no wait. The kept trace records every
step's start and end. Every step finished within about **1 second** with every
assertion passing: the navigation, the card click, `toHaveClass(/loaded/)`,
`toContainText("Beach trip")`, and the three network checks. Then nothing
until the 90 s timeout. What runs after line 239 is the `finally` block:
`await` on `opener.close()` then `store.close()`. Node's `server.close()` calls
back only when every connection has ended. Node 24 closes idle keep-alive
connections for it, but a connection with a request in flight holds it open,
and the page stays open until the test body, `finally` included, returns. So
the test can deadlock with its own server until the timeout. That also explains
why it passes in 1.2 s alone and under light load, and hangs only sometimes.

- **Established:** the stall is in teardown, after the test passed. It is not
  the product, and not a wait running out (the earlier budget theory is dead).
- **Not established:** which connection holds the server open. The page's
  network log in the trace shows 23 requests, all completed. The opener's
  service worker fetches in the background and is outside that log, so it is
  the suspect, but that is inference.

**Not fixed; the fix is small and testable when picked up.** Close the
connections explicitly (`server.closeAllConnections()` before `close()`), or
bound the teardown. Either takes a teardown hang off the test's clock. To
confirm the cause first, log `server.getConnections()` at close time on the
next failure.

**Fixed, 18 September.** The failure itself cannot be reproduced on demand: the
test passes alone in about a second, and hung only under a full run's load. The
kept failing run is its evidence. What *was* reproduced on demand is the
mechanism. A small script had a page hold a request open to a Node server, then
timed `server.close()` as the test does it. Without the fix, it was still
waiting when the 10 s bound ran out. With `closeAllConnections()` first, it
closed in 0 ms. The fix is applied to all three teardowns in
`static-opener.spec.ts` (the first describe's `afterAll`, and the `/d/` test's
opener and store servers), since all three had the same hazard. Closing open
connections at shutdown is correct whichever connection it was. That question
stays open, and the service worker stays the suspect.

**Recording the next one needs no discipline: built, 17 September.** Playwright
clears `test-results/` at the start of every run, so the evidence died the moment
anyone reran. `npm run test:push` now copies a failed run's `test-results/` into
`test-runs/<time>-<commit>/` (gitignored, newest ten kept) before it exits, and
prints where. `scripts/lib/keep-evidence.mjs`, held by
`tests/keep-evidence.spec.ts` in both directions: a failure is kept whole, and a
pass keeps nothing. Each direction was proved by mutation. The next failure here
arrives with its error already kept; read which wait ran out.

**Corrected 18 September: "copies a failed run's `test-results/`" was true only
of runs Playwright itself failed.** The keeper decided "failed" from
Playwright's exit, while the tier decided it from the exit and the count gate:
two places deciding one thing. Fixed: one verdict, `whyFailed()`, read by both.
It counts a missing report, an unchecked run, a missing project count and any
gate complaint. The copy is wrapped (`keepEvidenceSafely`), so a failure inside
it is reported and the tier still exits by its own verdict, instead of an
exception taking its place.

**Which gate failures the old keeper actually missed, found by running.** The
review named a floor drop: tests stop being collected and everything reports
success. A real full run with the Chromium floor raised out of reach showed the
gate reporter already turns a complaint into a failed Playwright result
(`run.txt`: `failed: playwright exited 1`). So the old keeper kept that case
too, and that run proved the wiring but not the gap. The runs it missed are the
ones where Playwright exits 0 and the gate is *absent*: no report written (the
reporter did not run), or no count for a project. The old tier failed those runs
and kept nothing. A second real run, with the gate reporter removed from the
local config, passed 1,078 tests with Playwright exiting 0. The new tier kept
it, with `failed: the count gate did not report, so this run was not checked`.
Unit tests and two mutations cover the rest: the verdict ignoring the gate, and
the copy unguarded.

#### D61 — `icon-after-wipe`'s file icon is written by hand, not taken from `launchAddress()`

*Status: open. From the review of `454858c..7abb896`. The disconnected-test shape
again.*

`tests/icon-after-wipe.spec.ts:60` writes `FILE_ICON` as a literal address
(`?name=Chores#${HINT_KEY}=…`). It imports the hint key, so a rename of the key
reaches it, but the *shape* of the address is still spelled out. If
`launchAddress()` changes how a file icon's address is built (a new parameter,
the name moving into the fragment), the test keeps launching the old shape and
keeps passing. It should launch the address the opener actually writes: read
from a real manifest, as the store-link tests in the same file already do.

#### D65 — Both players in the crossed-invite tests are named "Ada", so a swapped name cannot fail them

*Status: fixed, 19 September. Seen in a CI screenshot on 18 September; the
product was checked and is right.*

**Fixed.** `inviteNewGame` takes the player's name, and B sets up as "Bo" in
both crossed-invite tests. `nameIfAsked` asserts the seat prompt names the other
player ("Ada invited you" on B, "Bo invited you" on A), so a swapped name fails.
Passed 4 of 4 on Chromium. Ruled urgent by D80, which is the class of bug two
identical names could never catch.

**What was seen.** In run 35341691229 (Firefox, `mailbox-link-e2e:1287`, the
D32 sighting), page A's last screenshot shows the chess seat prompt: "Ada
invited you to play Black", with "Ada" already in the name field. The test names
page A "Ada" only on the next line. Kept at
`retried-firefox-whole/mailbox-link-e2e-a-game-co-07e52--order-reach-each-other-too-firefox/trace.zip`,
screenshot `page@065375879da0fa23e22f1840e4080c49-1789733097345.jpeg` (60 s after
Open).

**What it is, read from the code.** Not placeholder text, and not a product
defect:
- The prompt names the *creator* of the game being joined,
  `playerName(g, g.creator_color)` (`tests/fixture/chess/app.js:291`). That was
  B's game.
- The field is prefilled with this device's remembered name,
  `store.settings().setup_you`, from setting up its own game.
- `inviteNewGame` (`tests/mailbox-link-e2e.spec.ts:299`) sets up **both**
  devices with `#setup-you` = "Ada". So B's game really was created by "Ada",
  and A really did remember "Ada". The screen said something true about what it
  was given.

**The weakness is the test's.** With both players named the same, the crossed
invite tests cannot tell a correct name from a swapped one. If the prompt ever
named the joiner as the inviter, or put the other player's name on this side of
the board, these tests would still pass, and a screenshot of them reads as a bug
to anyone who looks. It is the disconnected-test shape again: an assertion that
holds whichever way the thing goes. The fix is presumably two names in the
fixture (A sets up as "Ada", B as "Bo", as `nameIfAsked` already does), plus one
assertion on the prompt's text, but that is not ruled.

#### D62 — `keep-evidence.spec` plants a file Playwright never writes

*Status: open. From the review of `454858c..7abb896`.*

The fixture writes `error.md`, where Playwright writes `error-context.md`, the
file a person actually opens to read a failure. The name was changed to keep the
spec on the node project: the project split routes any spec containing the word
"context" to a browser. So the test proves the keeper copies *a* file, not the
one that matters. The copy is recursive, so it almost certainly makes no
difference, but "almost certainly" is what the test was for. The real name can
be built without the literal word, or the routing rule can be made less blunt.

#### D71 — `sectioned-mount` waits for a size that every save already has

*Status: fixed, 18 September. The wait now reads the row out of the bytes it
uses (`node:sqlite`), and fails at the wait when the row is absent. The seed
database is 0 bytes, so the old check passed on the first save, not on the
seed. It is the seventh instance in part 3's "passes for an unrelated reason".*

`tests/sectioned-mount.spec.ts:110`, "a row written in one runner is there when
the sectioned file opens in another", failed on Firefox in run 35378663791
(`abb0c3a`) and passed on retry. The second runner read `0` where it expected
`1`: the element was found 58 times, so the frame was visible and the row was
missing. Not D32, not D28.

The kept trace, on one timeline:
- **+1.63 s** the test clicks *tick*;
- **+2.77 s** `save 1 asked (16384 bytes)`;
- **+3.04 s** `save 1 written`, and at the same instant the test's wait passes
  and it reads the database;
- **+4.13 s** `save 2 asked`, then `save 2 written` at +4.49 s;
- **+4.71 s** the second runner, opened from the database read at +3.04 s,
  shows `0`.

**The wait is a proxy that cannot fail on the thing it stands for.** It polls
until the stored database is larger than 1,024 bytes, taking that to mean the
save with the row has landed. But SQLite writes whole 4,096-byte pages, and
every save in this trace is 16,384 bytes, with or without the row. The test
took save 1 as the save with the row, and a second save followed a second
later. Most likely save 1 held the state before the tick and the row went into
save 2, but the bytes were not opened to confirm it. The product saved
normally: both saves were asked and written. The test read too early.

The test's own comment records that this 1,024-byte wait was the fix for an
earlier WebKit sighting of the same race. So the earlier fix was a proxy too,
the "wait for the state the next step needs" rule (`tests/README.md`) met in
letter and missed in substance. What the next step needs is a database
*containing the row*. The fix is to wait for that, by reading the row out of
the bytes, or by waiting for the save that follows the tick. Not a byte count.

#### D77 — Every test run and every install kept whatever host it built

*Status: fixed, 18 September.*

**What it means to a person:** a kept host is a promise that links made against
it keep opening. Test runs were making that promise for runtimes nobody
shipped: in-between states of a change, and once a runtime with a kit a test
had broken on purpose.

`npm run build` was `tsup && node scripts/retain-host.mjs`, and three things
other than the deliberate build ran it: Playwright's global setup
(`tests/global-setup.ts`), the push tier's CI-mirroring checks
(`scripts/test-tier.mjs`), and `prepare`, which is every `npm install`. So any
test run after a runtime edit kept a host. During D69 that happened four times:
`bf675b53…` (the check removed, routing not yet done), `0964f957…` (the kit
interpolated, 17 KB too big), and two from two runs of one spec: `7a21bbdc…`
from the real kit and `614bf718…` from the kit with its literal mutated to
`dai:use`. (First reported the other way round. The deliberate build that
followed kept `7a21bbdc…` from the real kit, which settled it. That host was
itself replaced before D69 landed: the kit's comment was moved out of the
string, and the host D69 shipped with is `42328a9cd436a2fd`.) None was
deployed; all four were caught and removed by hand, which is the kind of
catching that eventually fails.

**Fixed.** `retain-host.mjs` writes only with `--keep`, and only `npm run build`
passes it. Global setup, the push tier and `prepare` run `npm run build:lib`
(`tsup` alone). Without `--keep` the script says which host it would keep and
writes nothing. A forgotten deliberate build is still caught:
`host-retention.spec` reads the committed tree. Proved: a Playwright run that
built (its output shows `build:lib`) left the hosts folder at 44 entries and
`index.json` unchanged, where the two runs just before the fix each kept one.
CI's workflows still run `npm run build`, harmlessly: each CI run starts from a
fresh checkout.

#### D78 — The lint spells the public merge event by hand

*Status: fixed, 19 September, with the d22 fix.*

**Fixed.** The check reads `FRAME_PUBLIC.MERGED` in any of the three quotes.
The author-facing sentences at `lint.ts:258` and `:262` still say `dai:merged`
as text. **It did not change the fingerprint:** the deliberate build after it
kept the same host as before it (`1a89d50f2e0a5461`). `src/lint.ts` is not part
of the runtime a host carries, so waiting for a fingerprint change was
unnecessary; it could have gone in at any time.

**What it means to a person:** nothing today; the spelling is right. It is the
one place outside `src/frame.ts` that still writes a frame name out, so a
rename there would leave the lint looking for the old one and telling every
author their shared app has no merge listener.

`src/lint.ts:359` tests app source against `/["'`]dai:merged["'`]/`. The tests
now take the name from `FRAME_PUBLIC.MERGED` (D69 step 5); this is runtime
code, so routing it changes the runtime and keeps a host. The fix is one line
(build the pattern from `FRAME_PUBLIC.MERGED`), made in the same change as the
next runtime change that is keeping a host anyway, not on its own.

#### D85 — A rebuild under the same id replaces the person's rows, and says nothing

*Status: refused, 22 September. The update path it points at is the ping
(`docs/version-ping.md`), which is designed and not built.*

**Built: a different build of the application, arriving over something a person
wrote here, is refused before any question about the data is asked.** One
sentence, and nothing on the device changes:

> This copy of *Logbook* did not come from the one on this device, so opening it
> would have put what you have written aside; nothing was opened and nothing
> here was changed. A new version from the same author keeps your entries and
> says so before it opens.

- **The build is the signature** (`buildOf`), which covers the author's files
  and not the database, so it is identical for every copy of one build however
  it travelled and different for every rebuild. The library record keeps it as
  `build`.
- **Both sides must be able to say which build they are.** An unsigned
  container cannot — anybody can make one that looks like any other — and an
  older record does not have it written down. Either way it is undecided and
  nothing is refused.
- **Only where something of the person's is here** (`wrote`, D51's flag).
- **`chooseCopy` is untouched.** The refusal stands in front of it, because it
  is not a question about data and the data cannot answer it.

**Three wrong answers first, each caught by an ordinary test, and each worth
keeping because they all looked right.**
1. *A digest over the archive.* It moved on every save: the manifest inside the
   archive carries `savedAt`. Reopening a document you had been writing to read
   as a different application, which the succession spec caught.
2. *A digest over the manifest's entry digests.* It moved between carriers: an
   inline link rebuilds them, so a copy that arrived as a link read as a
   different application. `returning-document` caught that.
3. *Refusing inside `chooseCopy`.* To reach it, "no arriving database" had to
   become `BLANK_DIGEST` rather than `undefined` — and that value is also what
   gets **recorded** as the match, so a blank first open changed what every
   later comparison was measured against. A test about a move sent back went
   red, in a place with no obvious connection to the change.

**What the measurements corrected in this entry's own premise.** It said a
rebuild "takes a person's log". A rebuild straight from the compiler has never
saved, so it carries **no stamp**, and the old rule kept it out silently — the
person opened the new version of their app and was shown the old one with
nothing said. The taking happens only where the author opened the build before
shipping it. Both are refused now, and the entry's claim was half right about a
real problem.

**Proved** by `tests/rebuild-refused.spec.ts`: an app is installed, two entries
are written and saved, the author rebuilds under the same id, and the arrival is
refused with the sentence while both entries stay on screen in the copy that was
already open. The guard is proved by disabling the refusal, which lets the
rebuild through. Its companion holds the other half: the same rebuild arriving
at a copy nobody has written to opens as it always has.

**What it means to a person:** the author ships a new version of the app they use
every day, they open it, and their history is gone — or the app will not open at
all. Which of the two depends on a comparison they never see.

An author who rebuilds a document keeping its `documentUuid` has not made an
update: the id is the document, so the arrival is a contest between two
databases. `chooseCopy()` (`src/copy-choice.ts:113`) decides it, and:
- where it returns `take`, `main.ts:1861-1866` writes the arriving database over
  the stored one — **with no sentence on screen**. A rebuild carrying an empty
  database is exactly the shape that takes a person's log with it;
- where it returns `diverged`, nothing opens, which is the right refusal to the
  wrong question: their copy and the author's build were never two edits of the
  same data.

**The silence is defensible where it was designed and not here.** `take` was
built for a copy of your own document coming back from somebody you play with —
further along, descended from your own history, which `matchedDigest` and
`history` establish. An author's rebuild is none of those things and reaches the
same branch.

**What exists instead, and is most of the answer:** succession — a *new* uuid
with a signed `supersedes`, adopted only under the key this device already
pinned, copying the old database across once (`main.ts:3588`, `main.ts:1721`).
`tests/succession.spec.ts` already proves data carried forward, adoption refused
under a different key, and "refuses loudly when no migration reaches, and loses
nothing". It meets the update contract in decision 1 — except that nothing
delivers it: an installed copy cannot learn a successor exists.

**When it is picked up:** the contract is decision 1 in part 2, and the walk's
step 4 is the case to satisfy. Two things to decide, neither ruled here:
1. whether a same-uuid rebuild should be refused outright, with a sentence, so
   that "update" has exactly one spelling (succession);
2. what a copy does to learn of one, given decision 2's ping is the only thing
   the relay will know.

#### D121 — The warm merge writes the library record from a read taken before it

*Status: open. Filed 25 September from the cold review of D117 (its finding 8);
read, not run.*

`saveCartridgeToLibrary({ ...heldHere, mergeStanding: true })` in `ingest`'s
warm merge path spreads a record read before the arriving key was filed and
before the merge's own save, and writes it outside `withLibraryLock`. That is
the D41 shape: a write built from a stale read can put `revision` back and
refuse every later save, and can drop the key just filed. The shape lint passes
it because it spreads. Take it under the lock from a fresh read, as
`amendLibraryRecord` does.

#### D120 — What else the iOS relaunch leaves behind

*Status: open. Filed 25 September from the cold review of D117, which asked what
the first load holds that the relaunched load does not. Each read, not run.*

The review enumerated the state of all three relaunching paths (ingest's keep
path, `launchFromLibrary`, `finishMerge`); the key was D117. Three more cross
nothing, or cross wrongly:

1. **The card's publisher warning does not survive.** `installSuppressed` is set
   in `ingest` when the card calls the publisher a conflict (a stranger wearing
   a known name) and read before offering to keep the app. The relaunched load
   starts it false and `launchFromLibrary` never sets it, so on an iPhone the
   open the card warned about can be offered the keep-this-app prompt at the
   first use. Desktop takes no relaunch and keeps the suppression. Carry it
   across named for its document, or have `launchFromLibrary` ask
   `publisherState` again.
2. **`IOS_RELOAD_TAKEN` names no document.** A reload that stalls (the iOS bug
   the launch guard exists for), followed by the person going somewhere other
   than Tap to open, leaves it for the next load in the tab, which then believes
   it was a relaunch and skips its own. The new `IOS_RELOAD_CARRIED` is stored
   as `<uuid> <what>` and read only by a load for that document; this one wants
   the same.
3. **`finishMerge` relaunches when the flush failed.** The result of
   `flushDocument()` is ignored, so a flush that times out relaunches into a
   stored copy without the merged move, and "the move could not be added" is
   never said. Treat a failed flush as not applied.

Also seen, low: the ingest rehearsal relaunches with no flush of the frame's own
boot writes; they are written again after the relaunch and the seq floor keeps
them from colliding.

#### D119 — The contested-seat e2e fails its own setup on WebKit

*Status: open. Named 25 September from CI run `36120722040` (identity step 3,
`df75e52`); reproduced locally on WebKit, two in two. The first thing the next
session opens.*

`tests/mailbox-link-e2e.spec.ts`, "a forwarded invite contests the seat, nobody
is seated, both are told, and the creator repairs", fails on WebKit at its setup
check "A's copy tried to read and was refused while the two opened": 0 reads
refused. Chromium and Firefox pass it.

**A setup check failing means the precondition did not hold, not that the
product did the wrong thing.** Start at the precondition: *is the refusal
actually reaching WebKit's traffic?* The test blocks A's relay reads with a
context route and counts the aborts. Two readings fit 0: the route never sees A's
reads on WebKit (harness; the same family as the clipboard stub earlier), or A
made no read in that window (the product: its poll did not run while B and C
opened). Which one it is decides whether the rest of the test ever tested
anything on WebKit. It is not the seat model until that is known.

#### D118 — The creator ejects a confirmed seat

*Status: open, not built. Filed 24 September from the ruling on the seat
model's first-ask consequence.*

Over the mailbox the creator's copy seats the first ask it reads, so if a
forwarded invite reaches the wrong person first, they are seated and the seat
is theirs for good (IDENTITY-SEAT-CONFIRMED). The answer today is the one a
person already has: start a new game and do not forward the link. A
creator-side eject of a confirmed seat was considered and not ruled in: a hold
that never moves is the property T1-D29 exists for, and the model was just
rebuilt to stop history being erased. **The open question** that any eject has
to answer first: what happens to the ejected player's moves that were already
admitted. Retiring the seat drops them, which is the erasure the rebuild
removed.

#### D117 — The iOS relaunch loses an invite's key on a device that does not hold the app

*Status: fixed on `identity/signed-authorship` (identity step 5, 25 September);
closed when that branch's CI verdict is read green on WebKit. Filed 24
September. Latent on main, exposed by the seat model.*

A stranger on iOS opening an invite, which is the phone walk's core path: the
link carries the game's key; the load that opens it relaunches at the
document's address; the load after the relaunch opens the copy from the
library, and the library holds **no document key and no game key**. So the copy
runs no mailbox, and the page says "Updates from the other copy arrive when you
invite someone, or open a shared link", which is what the person just did.
Seen with the relay set as a deploy sets it (the `dai-relay` meta on every
load), in `tests/invite-identity.spec.ts`, WebKit, iPhone: "the recipient is not
the sender, on an iPhone" and "test 1" both fail at "the copy runs a mailbox
session". The desktop shape of the same tests passes on Chromium and WebKit.

**Why it was not seen before.** The arriving key is filed at arrival only when
the device already holds the app (`arrivedKey && arrivedSession && heldHere` in
`apps/runner/src/main.ts`, the same guard on main); otherwise it is filed when
the mailbox starts, and the relaunch comes first. Under the first seat model a
recipient bound its own seat, so it looked alive, seated and playing, without
ever reaching the creator. Under the seat model it waits to be seated by the
creator's copy, which never hears it ask.

**Same family as the relaunch identity regression** (23 September, in
`docs/identity.md`): the iOS relaunch dropping something the first load had.
A launch or relaunch path change gets a cold review of its own before anything
downstream leans on it. **Order:** a named red for the lost key, then the fix,
then that review; then D80.

**The two "known reds" were red for a race.** On CI (run `36120722040`, before
the fix) both iPhone tests *passed*; on this machine they failed every time. The
load that opens the link mounts once behind the launch screen before it
relaunches, and a mailbox started in that mount files the key; whether it
starts before the relaunch goes is a race, which CI's machine won. A red that
depends on a race is red for a reason unrelated to its claim (part 3, "a check
that passes for a reason unrelated to what it claims"), and so is its green. The
named red (`tests/invite-identity.spec.ts`, "D117: an invite's key survives the
iOS relaunch") forces the losing order: the relay reaches only the load after
the relaunch, so nothing on the first load can file the key but the fix. Red
three times in three with the fix's two filing lines taken out, green with them.

**What was built.** Two carriers, each shown red without it:
- `relaunchAtOwnAddress`, the one door all three relaunching paths go through,
  files what the load holds only in memory before it navigates
  (`fileArrivedKey`, read back from the library, bounded at 3 s so a library that
  never answers cannot hold the launch screen), and leaves its own account in
  session storage (`KEYS.IOS_RELOAD_CARRIED`, named for its document).
- The relaunched load reads a key from its own address when the library holds
  none for that game (the `hintOnly` branch). It fills a gap and never replaces a
  key held (D37). This is what repairs a phone D117 already stranded: from the
  cold review, which reproduced one and showed it never recovering on reopen.
- The arrival line says what crossed, on a load that followed a reload or had to
  take the key from its address, and nowhere else: what the load before said it
  filed, and whether the library holds the key this address names, asked
  separately ("carried across: the game's key, filed · the address's key held
  here: yes"). With the filing removed it read "NOT filed · … no".

The rest of what the review found the relaunch leaves behind is D120.

#### D116 — The seat check is superlinear in moves

*Status: open. Filed 24 September from the cold review of identity step 5
(finding 10).*

Reading a seated table's `_current` view took 5.5 s at 1,000 moves on the
reviewer's machine, 55% of it the seat check; the heads walk was already
superlinear before the seat check was added (it recomputes supersession over
the admitted rows on every read, `headsView` in `src/replicated.ts`). Chess
games are short enough that nobody notices; a long game or a tracker will. The
answer the headsView comment already names is a materialized membership set
recomputed on merge, not a return to a stored flag. Measure again on the seat
model that replaced the first-signer rule before choosing.

#### D115 — The seat-table scan misses writes it could be shown

*Status: open. Filed 24 September from the cold review of identity step 5
(finding 8).*

`seatWritesIn` (`src/seat-check.ts`) is a text scan. The reviewer's cases
(`%TEMP%\review5s\scan.spec.ts`) show what it can miss: a schema-qualified or
quoted table name, a name split across a string concatenation, an INSERT
spanning lines, the session writers reached through an alias, a bracket, an
optional call or a computed property. That is expected of a scan and changes
nothing that matters, in the spec's words: the scan is a courtesy; admission
is the enforcement. A seat written around the kit seats nobody, because only
the creator's confirmation holds an open seat and the creator is checked from
the rows (IDENTITY-SEAT-CONFIRMED). What is open is whether to widen the scan
toward what it can be shown, or to say in the lint's text that it is a
courtesy.

#### D114 — A backdated clock wins a contested seat

*Status: closed 24 September, into the seat model (identity step 5).*

The first model held a contested seat by the first verified signer: the lowest
clock, then the lowest author id. The clock is the author's own, so a joiner
who backdated it won, and the review showed worse: the same trick took the
creator's seat, and a backdated seat row made a joiner the creator. The fix
this entry named, a seat settled by what the creator signs rather than a clock
anyone sets, is what was built: the session id commits to the creator, the
creator's seat is the creator's, and the open seat is held by whoever the
creator's copy confirms (`IDENTITY-SEAT-CONFIRMED` in `src/rules.ts`; the
attacks are `tests/seat-attacks.spec.ts`).

#### D113 — A publish in flight overwrote a write's "not up to date"

*Status: closed 24 September (740b2cb). Kept for the cross-reference below.*

A publish already in flight had answered before a write; the write's AUTHORED
marked the lane not up to date, and the publish then finished and set it up to
date again from its stale answer. A closed game's lane could retire with its
close unsent. Now a write (or a landed seal's nudge) during an in-flight
publish asks for another. Found by the no-retire test in
`tests/mailbox-link-e2e.spec.ts`, red 3 of 6 on the code before the fix.

**Corrected 24 September: it did not clear returning-document:511.** That was
recorded here as likely, not isolated, and it recurred on Firefox in run
36059363617 (7d5a3f0), both attempts, carrying D32's full signature: the
document mounted, its frame cannot be entered, a reload does not recover it, a
fresh page in the same context can enter it. It is D32 (see there), not this.

#### D112 — A move held for a save that never lands is honest but silent

*Status: open. Ruled 24 September (identity step 4 review): filed, not this
sitting.*

A sealed batch is published only once a save holding its seal has landed. When
the store keeps refusing (a full quota, a save refused as from another tab) the
move stays on this device, the lane stays open, and nothing is lost; that fails
closed. But the only thing the person sees is the save failing. Nothing says
that the move was not sent, so the other player waits and this one believes
they have played. What closes it: a kit sentence, owned by the kit like the
loss sentence, shown while a batch of this person's is held ("Your last move is
saved here but hasn't been sent."), and cleared when it leaves. The frame
already knows (the \`held\` answer); the host would carry it to the kit.

#### D111 — The reference readers take the verifier's word for every signature

*Status: open. Ruled 24 September (identity step 4): accepted for the sitting,
filed as the successor; not this sitting.*

The merge vectors carry `verdicts.json`, the TypeScript verifier's answer for
every header, and the Python and Rust readers merge by it. They do the coverage
rules themselves, and three vectors (a stowaway row, a tampered batch, a lost
pointer) fail a reader that has one rule wrong, so they are tested on what they
claim. But a reader that consumes the verifier's verdict cannot catch the
verifier being wrong, and the reference readers exist to show the format can be
read without trusting the TypeScript. What closes it: each reader does its own
canonical rows, digest and ES256 check (`cryptography` in Python, `p256` in
Rust) against the `pub` the vectors already carry, and `verdicts.json` becomes
a file it checks its own answer against rather than one it takes. No fixture
change is needed.

#### D110 — Which Playwright project a spec runs in is decided by its prose

*Status: open. Filed 24 September; an instance of "a check that passes for a
reason unrelated to what it claims" (part 3).*

`playwright.config.ts` builds the `node` project from every spec whose text
never matches `\b(page|browser|context|browserName)\b`. A comment or a test
title with one of those words moves a node-only spec into the browser projects,
silently: `tests/seal.spec.ts` did, and a run of `--project=node` then ran none
of it and reported green. What closes it: membership stated, not inferred: a
path convention (for example `tests/node/`) or an explicit list, with a check
that every spec is in exactly one.

#### D109 — The sequence floor's publish route has no test of its own

*Status: open. Filed 24 September from the identity sitting's review fixes
(#1/#3).*

The per-document sequence floor is raised before a save is written and before
a mailbox batch is sealed (`beforePublish` in
`apps/runner/src/mailbox-session.ts`). The save route is held end to end by
`tests/seq-floor.spec.ts` (removed and received again). The publish route is
not: proving it needs a save lost *after* a publish, deterministically, and no
harness does that yet. Until one does, a change that dropped `beforePublish`
would pass every test. What would close it: a way to make the host refuse or
lose one save on demand (scenery), then a test that publishes, loses the save,
reopens, and asserts the next row is above what was published.

#### D108 — An old host meets a new document

*Status: open. Ruled 24 September: filed, nothing built until step 6.*

The skew that can happen is not an old document on a new host: the runner mounts
every document with its own runtime (`hostShell(..., { runtime: HOST_RUNTIME })`),
so a document never runs its old code here. It is the other way round. An
installed copy on a phone runs whatever host its service worker cached, and a
cached host from before signed authorship, handed a document that carries
`_dai_batch`, would write unsigned rows into a signed document, which is
exactly what step 6's legacy rule forbids.

The guard belongs in the format: a document declares its format version, and a
host below that version mounts it read-only, with the update sentence ("This
app needs an update before it can be written to; what's here is kept"). This is
step 6's legacy rule seen from the other side; step 6's scope is both
directions (`docs/identity.md`, Migration of existing documents).

#### D107 — The crossed-invite tests pass on retry on Firefox

*Status: open. Two sightings, both on Firefox, both passing on retry: run
35943543565 (`mailbox-link-e2e.spec.ts:1294`, "the same crossed invites in
the other opening order reach each other too") and run 35999516080 (`:1242`,
"both invite before either opens, and each game still reaches the other
copy", a 60-second visibility timeout). The two tests are one scenario in two
orders.*

#### D106 — The message-name scan cannot see a template literal or a split `type:`

*Status: open, minor. Filed 24 September from the identity sitting's cold
review.*

`literalProblems` (`src/names-check.ts`) reads line by line: any quoted
`DAI_HOST_…`/`DAI_FRAME_…` string, and a quoted `dai:…` string in a `type:`,
a `.type ===` comparison, or a `case` label. It does not see a name assembled in
a template literal (`` `dai:${x}` ``) or a `{ type:` whose value is on the next
line. Nothing in the tree does either today. What would close it: scan the
TypeScript AST for string and template literals in those positions instead of
lines.

#### D105 — Two tabs on one held copy can both write under one author

*Status: open. Filed 24 September from the identity sitting's cold review.*

`IDENTITY-ONE-LIVE-COPY` keeps one copy of a document per device, but two tabs
can show that one copy at once. D41's lock refuses the stale tab's *save*; it
does not stop the stale tab stamping rows or publishing them to the mailbox. So
two tabs can issue the same `(author, seq)` for different rows, and the
exchange refuses one as tampering.

**Likely closer, not built:** the per-document sequence high-water mark the
sitting keeps in IndexedDB beside the person key. If each tab reserves its seq
through one IndexedDB transaction before it stamps, two tabs cannot reserve the
same number. Row identity by content hash (D104) removes the hazard outright.

#### D104 — Row identity by content hash, in place of `(author, seq)`

*Status: open. Ruled 24 September: noted, not built.*

A shared row's version is named by `(_r_replica, _r_seq)`: an author and a
counter. Since the identity sitting, the author is the device's person key,
the same for every copy that device holds. A counter is only safe when one
writer holds it, so this version keeps one live copy per document per device
(`IDENTITY-ONE-LIVE-COPY` in `src/rules.ts`, rule 7 of `docs/identity.md`).
The hazard it guards against is two live copies on one device issuing the same
pair for different rows, and the exchange refusing one as tampering.

Content hashes remove the hazard rather than guarding it: a row version named
by the hash of its content, the way a commit id is. Two copies cannot issue the
same name for different rows, because the name is the row. What it touches:
the merge key, `_r_parents`, the batch digest (which already hashes canonical
rows), the conformance readers, and every stored document, so it is a format
version.

#### D103 — The desktop host has no person key

*Status: open. Ruled 24 September: desktop gets the person key the day it
sends write rules, and not before.*

`apps/desktop` sends no write rules today, so its documents never write shared
rows and never need an author id. The day it does, it takes the same path as
the runner: the key made on first use and kept in the host's own store, the
author id handed to the frame on every mount, and one live copy per document
(`docs/identity.md` rule 7; `IDENTITY-ONE-LIVE-COPY`). A loose file opened
twice is merged into the held copy, not opened beside it.

#### D102 — `launch-address.spec.ts:123` passes on retry on WebKit

*Status: open. First seen 23 September, run 35935079996 (WebKit shard 1/2,
job 107430182690, commit a7ab452): "after a store arrival, keeps the path and
the key that fetch it again" failed, then passed on retry. The commit touched
nothing it exercises.*

#### D101 — `MergeReport.refused` is a name a quieter one would serve

*Status: open. A naming nit, filed 23 September during the identity sitting; no
behavior changes with it.*

`MergeReport.refused?: string` (`src/replicated-frame.ts`) means "the merge
did not run", and about a dozen callers test it for truthiness. The identity
sitting adds `refusedBatches: {author, reason}[]`, meaning "the merge ran and
refused these", so the two are kept apart by name, as ruled. The old name reads
as though it might be the list. What closes it: rename it to what it means
(for example `notRun`) across its callers on a quiet day, as its own change.

#### D100 — A frame message name written as a literal outside its owner

*Status: **fixed in step 2 of the identity sitting**, under the naming family
(binding rule 8 of `docs/identity.md`): the name is `TO_HOST.REPLICA_ID_ANSWER`,
and `check-names` now refuses a message name spelled outside its owner.*

`"DAI_FRAME_REPLICA_ID"` is spelled out at `src/runtime/bootloader.ts:3546`
(the frame's answer to a replica id request) and at
`apps/runner/src/main.ts:4994` (the host's listener for it). Neither `src/bridge.ts`
nor `src/frame.ts` owns it, so nothing keeps the two copies in step and
`check-names` never sees it. It is the replica id request the tests read
identity through, so it is exactly the name the identity sitting touches.

Held by `tests/bridge-literals.spec.ts`: once `check-names` scans for message
literals outside their owners, this literal turns the typecheck red, so the
scan and the fix land in the same change.

#### D99 — After a merge from a link, the sample game is on screen and the invited one is only in the list

*Status: open. Found on a phone 19 September, seen again 23 September; never
fixed. Not reproduced under test yet.*

Opening an invite `/d/` link lands on the practice board the app lays out for
itself, and the game the link was for is one row down in the games list. The
person taps a link somebody sent them and arrives somewhere that is not what
was sent.

**Repro, from the phone:** on a device that already holds the document, open an
invite link for a game that copy does not yet have. The merge lands — the game
is in the list and playable when chosen — but the board on screen is the
sample. A device that has never held the document does not show it; there the
invited game is what opens.

**What it is probably about:** which game a copy calls active after a merge.
The application decides that for itself (`tests/fixture/chess/store.js`, the
active-session read), and a merge that brings a game in does not say "and this
is the one to show". Until it is decided, whichever game the copy was last on
wins, and on a fresh copy that is the sample.

What closes it: after a merge that brings in a session this copy did not have,
the session the arriving link named is the one on screen — with a test that
opens an invite on a copy that already holds the document and asserts the board
shows the invited game rather than the sample.

#### D98 — The notification permission is asked in the middle of sealing an invite, and the share sheet does not come back

*Status: open. Found on a phone 23 September; not fixed.*

Sharing a game asks for notification permission while the invite is being
sealed. The system prompt takes the screen, and when it is answered the share
sheet is gone — the person is left on the board with no link and nothing said.
Whatever they answered, they have to start the share again.

**Repro, from the phone:** on iOS, with notifications not yet decided for this
origin, open a game, Share, tick *Send personal saved data*, press *Copy link*.
The permission prompt appears during the seal; answer it either way; the sheet
is not on screen afterwards.

**The rule this breaks:** a flow a person started is theirs until they finish
it. Asking for a permission mid-flow takes the screen away from a thing they
asked for, and a system prompt is not something the page can draw over or
recover from — so the ask belongs after the share is done, never inside it, and
a flow interrupted by a system prompt resumes where it was.

What closes it: the ask moves to after the link exists and the sheet has been
answered; and a test that resolves a permission prompt mid-share and asserts
the share sheet is still on screen with its link.

#### D97 — A copy opened from the library was called this device's own, and an arrival kept the sender's identity

*Status: **fixed 23 September**, same day it was found on a phone. Ruled and
fixed; the deliberate path it shades into is D80, still open.*

**What a person saw:** opening an invite that carried the game gave the
recipient the creator's seat — the same position, no name asked, and "waiting
on player 2" from the creator's side. An invite shared with the data checkbox
off gave a fresh game, correctly.

**The mechanism, measured.** A replica id is per copy, and the chess fixture
decides "am I the creator" by asking whether any seat row was authored by its
own replica — so a copy running under the sender's id *is* the sender, to the
application. On iOS an arrival is followed by the relaunch to the document's
address, and the load after it opens the copy out of the library.
`launchFromLibrary` declared that "this device's own copy", which tells the
frame to keep whatever `_dai_replica` the file carries; for an invite sent with
data that row is the sender's, and nothing had been written on this device yet,
so `ensureReplica` kept it. Desktop never relaunches and never had it. A blank
copy has no `_dai_replica` row to keep, which is why every invite sent without
data looked right.

**Ruled, 23 September.** The host's recorded replica id is the sole owner of
this device's identity; the frame takes it over on every mount, resume or
arrival; `ensureReplica` never keeps a row that differs from the id the host
handed it; and `mountIsOwnCopy` no longer decides identity. Ownership now means
*this device has written this copy* — the stored database is the witness.

**Why the invite tests did not catch it.** `inviteNewGame` never touched
`#send-with-data`, so every invite in that suite was a blank copy, and the
suite runs desktop contexts, where the relaunch does not happen. Nothing
compared the recipient's replica id with the sender's. The helper now takes a
`withData` option and the two crossed-invite tests run both shapes; measured on
the code before the fix, those two at six repeats of each shape failed 9 of 12.
None of them was passing *because* the copy was blank — they assert that moves
cross, which they do either way.

Held by `tests/invite-identity.spec.ts`: an invite with data, a fake store, a
recipient on an iPhone user agent, asserting after the relaunch that the
recipient's replica differs from the sender's and that the app asks who they
are. Red on `7653c44` on the iPhone case; the desktop case passes on both sides
of the fix.

**Note for whoever holds identity next.** This closed an accident. It does not
touch what a copy can do on purpose (D80), and it leaves the identity primitive
where it was: an id recorded per document per device, taken over by a frame at
mount. The sitting that redesigns that primitive subsumes this entry — see
`docs/identity.md`.

#### D96 — Keep could offer to put a file-borne document in the store, so its icon is short

*Status: open, filed 23 September for the storage sitting. Not fixed, and not
to be built without the sentence below being settled first.*

An icon for a document that arrived as a file or an inline link carries the
document in its own address, because an iOS home-screen app starts with empty
storage and the address is the only thing it can open from (D56: 11,847
characters, measured). A document that came from a store needs none of that —
its `/d/<hash>` path and key fetch it again — so those icons are short.

So Keep could offer the same footing to a file: seal this document, put it in
the store, and make the icon from the short address. The icon would then
survive a wipe the way a store arrival does (D50), and nothing long would ride
in an address that iOS may or may not tolerate.

**It needs a sentence, and the sentence is the hard part.** The opener's
promise is that nothing is uploaded — it is on the chooser, in the words a
person reads before they open anything. Putting the document in a store is an
upload, sealed or not, and it cannot happen because the icon would be tidier.
So it is an offer, made once, in words that say what leaves the device and what
the store can and cannot read, with the file-only icon as the answer for
somebody who says no.

Whoever takes this: decide the sentence first, then the mechanism. The
mechanism is small — `publish()` already exists and the store path is the one
`/d/` arrivals use.

#### D95 — The relaunch mark rides in `identity.link`, and only `launchAddress` takes it out

*Status: open, filed 22 September beside the fix that added the mark. Not
fixed.*

A relaunch loads `?relaunched=1` (`apps/runner/src/install.ts`, `RELAUNCHED`),
and the load that arrives with it reads it, then takes it off the visible
address. Between those two moments the page's own address carries it, and
`arrivedByLink` is set from `location.href` on the link paths — so the mark can
be copied into `identity.link`, and from there into anything built from that
link. One place removes it: `launchAddress`, which deletes the key before it
writes an icon's address. Everything else that builds on a link — a sent copy,
a manifest's `start_url`, a card's address — is clean only because it goes
through there or because the strip happens first.

That is one guard for a value that travels, and the review that asked for the
strip asked for this to be written down rather than trusted. What would close
it: the mark never reaching `arrivedByLink` at all (read and dropped before
anything copies the address), so no builder has to know about it.

#### D94 — `mergeCancelled` outlives the merge it cancelled

*Status: open, filed 22 September from the second cold review's follow-up. Not
fixed.*

`mergeCancelled` (`apps/runner/src/main.ts`) is set when the person ends a
rehearsed merge with Tap to open, and it is set back to false where the next
merge is armed — which is the rehearsal branch in `launchFromLibrary`, and
nowhere else. A merge that does not go through that branch (a copy arriving
while a document is already open, a merge on a platform that never rehearses)
runs with whatever the last cancellation left. Nothing has been seen to fail:
`applyPendingMerge` is the only reader, and it is reached from the same branch.
It is a flag whose lifetime is shorter than its scope, which is how the
`reloadGate` guard went wrong (D-review of 025166c, Q1.3).

What would close it: clear it where a merge is asked for — `openThenMerge` and
the card's merge action — rather than where one is rehearsed, and a test that
cancels a rehearsed merge on one document and then merges into another.

#### D93 — Five more tests wait for the address to change rather than for the load it causes

*Status: open, filed 22 September while fixing the cold review's Q1.1. Not
fixed.*

`runner.spec.ts:955`, `:994`, `:1029`, `:1321` and `viewport.spec.ts:216` wait
with `page.waitForURL(/opener-doc=/)` after a first open on iOS. The address
changes on the page that is about to be replaced, so anything done next can
land on a page nobody will see — the defect behind the retry in "the offer is
per document" (cold review, Q6), fixed there by waiting for the arrival line to
say the load after the relaunch. Measured here: `runner.spec.ts:949` failed
once under parallel load on WebKit and passed 5 of 5 alone.

What closes it: each waits for the settled load — the arrival line's "iOS
reload: taken on the load before this one" — and then asserts the address.

#### D92 — A keep request written in the browser cannot be ended by the install that answers it

*Status: open, filed from the cold review of 6979d91 (Q4), 22 September.
Partly mitigated, not fixed.*

The keep sheet's request is held until the person answers it, and one of the
answers is the document being seen running as an installed app
(`apps/runner/src/install.ts`, `describe`). That clear cannot reach the case it
was written for: session storage belongs to one tab, and a home-screen app is a
separate one — on iOS it is a separate partition entirely. So the note written
in the browser tab is never seen by the installed app, and the tab still shows
the sheet again for an app the person has already added. The test that holds
the clear writes the note and reports standalone in the same tab, which is a
state no device reaches.

Mitigated on 22 September by the sheet's own words: Done now reads "Done — I've
added it", so a sheet seen again says what to press.

What would close it: something the browser tab can read that the install
happened — `getInstalledRelatedApps` where it exists, a launch of the icon
writing to storage both sides share (not iOS), or the page asking plainly
the next time it is opened. Undecided which; the phone reading comes first.

#### D91 — The data: manifest decode has no test for a malformed address

*Status: open, filed from the review of b8e39e3 (Q3), 22 September. Not
fixed.*

`dataManifest()` in `apps/runner/src/main.ts` is read inside the `try` of
`arrivedManifestReading()`, so a malformed `data:` address cannot throw out of
the arrival line or the launch panel. Traced by reading, not by running: a
missing comma, bad percent-encoding, bad base64, invalid JSON, and JSON `null`
(which throws on `.start_url`) each land in the `catch` and print "a data:
manifest (unreadable)"; JSON that parses to a string prints "? → ". None of
these has a test. `tests/arrival-line.spec.ts` covers the well-formed case and
a fetch that never answers. What closes it: one test per shape above, each
asserting the line reads "(unreadable)" and the panel still fills.

#### D90 — Keep can cost an extra load when the relaunch could not reach the document's address

*Status: open, filed from the review of 454e2db (Q1.7), 22 September. Not
fixed.*

`keepHere()` (`apps/runner/src/install.ts`) navigates when the page is not at
the document's launch address, and does not set `KEYS.IOS_RELOAD_TAKEN`. Since
the relaunch gate moves every open there first, `keepHere` navigates only when
the gate could not get there — `sameLaunch` disagreeing with the address the
reload landed on, which the gate reports as "not taken: still not at the
document's address after a reload". In that state each press of Keep loads the
page, and the load after it is not marked as a reload, so the gate reloads once
more before the guard stops it: two loads per press, no loop. Not seen; needs
`sameLaunch` to mismatch persistently. What closes it: `keepHere` marks its load
the way the gate does, or defers to the gate, with a test that forces the
mismatch and counts loads.

#### D89 — A resume reload that stalls on the bare opener has no Tap to open

*Status: open, filed from the review of 454e2db (Q1.6), 22 September. Not
fixed.*

`guardLaunch()` rescues a stalled relaunch only when the body carries
`launching` or `booting` (`apps/runner/src/main.ts`, the guard's timeout). The
worker paints `launching` only on a document's own address. A resume from the
bare opener (`/`, the document open last time) relaunches before mounting, so
its body has neither class: if that reload is the one iOS drops, the person is
left on "Loading …" in the chooser with no Tap to open. The icon, link and file
paths are covered — they are under the splash or a mounted cover. What closes
it: mark the body as launching when a relaunch is taken from a page that is not
already under the splash, and a test that stalls the reload on `/` and expects
Tap to open.

#### D88 — On a phone-sized screen, the menu's Share control is below the fold and scrolling does not reach it

*Status: **fixed 22 September.** The mechanism was not "below the fold": the
sheet layer is fixed and anchored to the bottom, so a menu taller than the
screen overflowed **upward**, past the top, where nothing can scroll. At
390×844 the controls lost were Add to Home Screen and Share app (which is also
D87 — the keep press landed on nothing). `.sheet-panel` and `.keep-panel` are
now capped to the viewport (`100dvh` less the top inset) and scroll inside it;
no sentence was shortened. The walk now presses Keep and Share with ordinary
clicks, and `expectReachable` checks every button in the menu, the keep sheet
and the share card on the iPhone viewport — without the fix it fails naming
those two controls. No other control was past an edge at that size.*

*The entry as first filed:*

**What it means to a person:** on a 390-point screen — an iPhone's width — the
document menu is taller than the screen, and **Share app** is past the bottom of
it. Scrolling does not bring it back.

Measured on CI's WebKit at 390×844: Playwright scrolled, reported *"done
scrolling"*, and then refused the press with *"element is outside of the
viewport"*. A forced press needs a point on screen and there is none. The walk
reaches the control through the element itself so the rest of step 5 can be
read, and says so where it does it.

**What is not yet known:** whether the sheet is meant to scroll and does not, or
whether it is simply too tall for the shortest screens with every control shown.
The menu holds the keep control, Share, Save a copy, Change something, Remove,
the build stamp, the storage line and the worker line — which is a lot for a
phone, and D87 is about the first of those on the same screen.

**Why it matters for V1:** step 5 of the walk is "share the link to a friend",
and on the device the walk is for, the control that does it cannot be pressed.

#### D87 — On iOS, Keep reloads and the instructions it asks for can be closed before they are read

*Status: **closed as a misdiagnosis, 22 September — it was D88.** The race this
entry describes could not be produced; the failure it was filed for never
reached the code it blames. The original text is kept below, because the way it
went wrong is the useful part.*

**What the probe showed.** Instrumenting `keep()`, `describe()` and the one call
site of `describe()` in `main.ts`, and driving the walk's step 1 on an iPhone
viewport:

```
dai: PROBE mount describe, rehearsing=true,  href=http://localhost:5175/
dai: PROBE describe start, sheet open=false, pending=none
dai: PROBE mount describe, rehearsing=false, href=…/?ground=%23f2f8fb#a=…
dai: PROBE describe start, sheet open=false, pending=none
```

and **no `keep pressed` line at all**, across four presses. `keep()` was never
called. There was no reload from Keep and no note waiting — the second mount is
the ordinary open, landing at the document's launch address, which the opener
had already made the page's address. The press landed on nothing, because the
button was above the top of the screen: the menu, taller than 390 points, had
overflowed upward out of a layer that cannot scroll (D88). Add to Home Screen is
the first button in that menu.

**Tested directly, the race does not happen.** `tests/keep-intent.spec.ts` writes
the note Keep leaves and then drives a first open — the two-load case, a
rehearsal mount and then the load that counts, each describing the document —
which is where this entry said the intent would be consumed on a page about to
be discarded. The sheet appears and stays. The test is kept as a guard (proved
to go red when the pending sheet is never shown); no code was changed for it,
because there was nothing reproduced to change.

**How the first diagnosis went wrong.** One early probe caught the sheet open
six seconds after a press, and four later runs did not. The story fitted —
`describe()` does close any open sheet before it shows one, and a reload is two
mounts — and it was written down before the one probe that would have tested it:
whether `keep()` ran at all. Reading the code produced a mechanism that exists;
running it showed the failure was somewhere else.

**One question left for a ruling rather than code:** `describe()` still closes an
open sheet on every mount, so a remount while a person has the keep sheet open —
a copy arriving, a succession — would take it away. That is not what the walk
hit and has not been seen, and the ruling on D87 asked for the intent to survive
whatever draws next. Making the note last until the person answers is a small
change; it is not made here because nothing has yet shown it is needed.

---

*The entry as first filed:*

**What it means to a person:** they tap **Add to Home Screen** on an iPhone, the
page blinks, and nothing happens. Tapping it again works.

On iOS there is no install prompt, so `keep()` calls `keepHere()`
(`install.ts:452`), which reloads the page at the document's own launch address
— that is what makes the icon belong to the document rather than to the opener —
and leaves a note in `sessionStorage` (`KEEP_AFTER_RELOAD`) asking for the sheet
of instructions to be shown once the page comes back. After the reload,
`describe()` shows it.

**`describe()` closes any open sheet before it shows one** (`install.ts`,
`closeSheet()` at the top of `describe`). It runs on every mount, so a later
call — a remount, a rehearsal, the document being described again — closes the
sheet the reload just opened. Whether the person sees the instructions depends
on which happens last.

**Measured, in the walk spec's own run.** Six seconds after the tap, with an
iPhone user agent on WebKit:

```
KEEP {"url":"http://localhost:5175/?ground=%23f2f8fb#a=AfGfjpHtXW1sU1UY3gcKNCAR…",
      "body":"loaded","cta":false,"sheet":false}
```

`sheet: false` is `hidden === false` — the sheet was open at that moment, and the
document had remounted from its inline launch address. In four later runs of the
same test the sheet was gone by the time anything read it, and in two it stood.
That is the race, and its rate here is roughly one in three.

**Why it is not a test problem.** The second tap is reliable *locally*, because
the page is already at the document's launch address and `keepHere` does not
reload again — which is exactly what a person discovers by accident.

**On CI it does not survive at all** (runs 35680220168 and 35681323325, WebKit).
Four presses, each waiting fifteen seconds for the sheet, and it is never there:
a slower machine remounts more times and `describe()` closes it each time. So
the walk holds step 1 as its own test, marked `fixme` with this entry named —
a known failure rather than a false green, and `fixme` rather than `skip`
because it is a defect in the product and not a step a browser cannot take. It
turns green by fixing this, and nothing else in the walk waits on it.

**When it is picked up:** the fix is presumably for `describe()` not to close a
sheet it is about to be asked to open, or for the pending note to be honoured
after the last describe rather than the first. Neither is decided here. What a
test can see is the sheet's state after a mount; whether a person on a real
iPhone sees the blink is a phone check, and it is the same one step 1 of the
walk already needs.

#### D86 — `Identity` declares `link` twice

*Status: open, trivial, filed because it is the kind of thing that stops being
trivial later.*

`apps/runner/src/install.ts` declares `link?: string` at **line 64** and again at
**line 80**, with a doc comment on each. TypeScript tolerates it because the
types match, so nothing fails today. Two declarations of one field are two places
to write down what it means, and the naming family's whole argument is that one
fact gets one owner. Noticed while reading the install path for the V1 walk.

#### D84 — `session-mailbox-e2e` timed out once on Firefox and passed on retry

*Status: one sighting, recorded not chased.*

CI run 35611549321 (commit `8be9630`, 21 September): `session-mailbox-e2e.spec.ts:175`,
"two games travel in two mailboxes, and one game's key opens only its own",
failed on Firefox after **1.2 minutes** and passed on retry #1 in **14 seconds**.
The whole job was otherwise green, and nothing in that commit touches session
lanes.

The shape — a timeout on the first attempt and a fast pass on the second — is the
same one D32 wore, and the same one the unexplained 1407 hang wore. It is
recorded here rather than investigated because one sighting cannot tell a slow
runner from a real stall. **What would make it readable:** the next time it
appears, its trace is in that run's kept artifacts; two sightings with the same
step stalled is the point at which it becomes a defect rather than a weather
report.

**Not to be merged with D32, which had its own sighting the same day**
(`returning-document:365`, run 35618925872, filed in D32's table). That one is
in the file and on the path D32's measured rate covers; this one is neither. Two
Firefox retries in a day is the reason to write both down and the reason not to
call them one thing.

#### D83 — A test that fails never reaches its own teardown, and its contexts outlive it

*Status: fixed for `mailbox-link-e2e`, 20 September. The general shape is open.*

**What it means:** a local run that hangs after the last test, and a worker that
never exits.

Every test in `mailbox-link-e2e` makes its own browser contexts and closes them
on its last two lines. A test that throws never reaches them, and this file has
one that **throws by design on every run** (D80, held as `test.fail`). Its two
contexts, their pages and their mailbox polling then outlive the test for the
rest of the worker. That is the shape of the run that hung at 1407 of 1412 on
19 September: the WebKit worker was last seen starting D80, five queued
`push-e2e` tests never started, and no test timed out.

**Fixed here** with one `test.afterEach` in that file, closing every context the
browser still holds; every test in it takes the `browser` fixture, so there is
no Playwright-owned context to close by mistake. Not proved to be the hang's
cause — the hang has not been reproduced — only that the leak it would need is
real and is now closed.

**Open:** every other spec that closes contexts on its own last line has the
same shape, and a `test.fail` is not needed for it — any failure does it.

#### D82 — A move the screen accepted was erased by a later merge, and the person was told nothing

*Status: open, not fixed. Seen 19 September while building D79's second case.*

**What it means to a person:** you made a move, you watched it appear, and later
it was simply gone. Nothing said so, and nothing you can look at says why.

Hal moved; the O was written and drawn. Gil's close of the session then arrived,
and the close had not seen Hal's move, so the move is late by the session's own
rule (T1-D31) and every copy drops it. The board went back to eight empty
squares with no word. Read from the probe's frame log: the mark drawn at 2517
ms, the close merged at 5553, the board redrawn without the mark.

**It is general, not about closes.** Any row this copy accepted locally can be
refused once other rows arrive: late relative to a close, a row from a seat that
was contested or replaced (D80), a party that turns out not to be admitted. The
screen shows the optimistic state until the merge says otherwise, and the app
has no way to tell the person "the thing you did did not survive" — the merge
reports what it applied, never what it took away from this copy.

**What would be needed:** the merge's report would have to name rows this copy
had authored and no longer holds, so an app can say so. Nothing does today, and
that is the design question, not the sentence to show.

**Related:** D46 (a move that failed to send waits for the next write, the same
family of a write the person believes is done), D79 (the same screen lying by
omission, there by dropping a tap), D80.

#### D80 — A copy can seat itself as any player, and the other copy will believe it

*Status: **open, V1 blocker.** Proven 19 September; not fixed. The fix is what a
seat is bound to, and that is its own sitting.*

**One way in closed, 23 September, and it was not this one.** A phone found a
recipient opening an invite that carried the game and coming up as the creator:
same seat, same position, no name asked. That was an *accident of identity* —
on iOS the arrival is followed by a relaunch, the load after it opened the copy
out of the library, called it this device's own, and so kept the
`_dai_replica` row the file carried, which is the sender's. Nobody chose
anything; the copy simply was the sender, and the seat followed. Fixed by
making ownership mean "this device has written this copy" (a stored database)
rather than "this came from the library", held by
`tests/invite-identity.spec.ts`.

D80 is the deliberate path and stays open: a copy that *sets* `_r_replica` to
somebody else's id, or claims a seat it was never bound, is still believed by
the other copy, because a row's author is writer-set and merge-trusted. Closing
the accident narrows what can happen by mistake; it does nothing about what can
be done on purpose, and the sitting that settles what a seat is bound to is
still owed.

**What it means to a person:** the other player's phone can make moves as you,
and your phone will show them as yours. Nothing on either screen says anything
is wrong.

**Found on two phones, 19 September.** The joiner moved from the wrong seat.
The creator's phone announced the move as the creator's own and oriented the
board as the creator. Both copies ended holding the creator's game with the
joiner gone. They converged on a wrong state, and nothing was shown.

**The mechanism, read from the code and then run:**
- A row's author is `_r_replica`, a column the writing copy sets to its own
  replica id. The merge admits it as written (`applyBatch`,
  `src/runtime/bootloader.ts`): no signature, nothing only that copy holds.
- "Creator" is whichever replica id authored the session's seat rows. The role
  gate on writes (`authorGate`), the admission view (`seatAuthor` in
  `src/replicated.ts`) and the chess app's seat (`myColor`, `store.js`) all ask
  that one question.
- **D37 and D15 cannot both hold with one shared key.** D15 says the wrong
  party's writes are refused by the writer's key. D37 gives both copies the same
  per-game key, which can prove "a member of this game wrote this" but not
  which member. D15 therefore rests on `_r_replica`, which the writer sets.
  **D15 landed second** (`e6949d5`, 16 September, after D37's `14cb352` on 15
  September). Before D37 the key was per document and just as shared, so D15
  has never rested on anything a copy could not forge.

**Proof:** `mailbox-link-e2e`, "D80: a copy running under the creator's id is
not believed to be the creator". Ada creates and invites, Bo joins as "Bo" and
plays e5. Bo's copy is then given Ada's replica id, the precondition the phones
reached by d22's route. Bo moves White's d4 through the board. Ada's copy
admits d4 authored as Ada (`r` = Ada's id). It fails on `bf2b845` and is held
as `test.fail` on Chromium and WebKit until the fix, which removes the mark.

**What happens to the roster in this version (step 2 answered for D80):** the
rows stay. Both copies still list two members, Bo's binding and "Ada vs Bo".
What is lost is Bo's identity: his copy *is* Ada now, so anything it writes,
names included, is Ada's. Whether the phones' missing seat row came from this
or from how the route got there waits on d22's reproduction.

**Not the route.** The route is d22's: a reopened copy that came back under
the sender's id. The plain reopen of the invite on one device keeps the
joiner's id (the guard test before this one, Chromium and WebKit, also with the
stored database removed).

**For the sitting:** `docs/d80-seat-brief.md` — every identity that exists
today and what each survives, the five things a seat could be bound to with what
each costs on the wire and in the four cases, and what D82 needs from the same
design. Facts only; the recommendation is the sitting's.

**Related:** D37 (the shared per-game key), D15 (roles), D48 (taking a lost seat
back), D65 (two names, so a swap can fail a test), the key-holder identity
primitive (*Three items now block on the same absent primitive*; this is a
fourth), and d22 (the route).

#### D81 — A joiner who installs after joining in Safari gets a second, broken seat

*Status: open, not fixed. Found running D80's route, 19 September.*

**What it means to a person:** on iOS the home-screen app and Safari keep
separate storage. Somebody who joins a game in Safari and then installs it opens
a copy that knows none of their game. That is the post-install walk failing at
its second step.

Run as the invite reopened in a fresh browser context after Bo had joined,
named himself and played e5 (Chromium, 19 September). The new copy:
- took a new replica id and **bound Bo's seat a second time** (two binders:
  contested);
- lists **only the creator** as a member;
- holds Black's name empty and **never received e5**, Bo's earlier move, after
  five pulls;
- still showed **"Your move."** on the Black side, so it invites a move from a
  seat it does not hold.

Readings are from the D80 guard test's fresh-storage variant, run once. It is not
kept as a test yet; a test for this should assert what the walk is meant to do,
which is a design question D48 already owns.

#### D79 — A tap is lost when a merge redraws the screen under the finger

*Status: fixed, 19 September, in the applications and the kit. The screen not
saying so when an accepted row is later refused is D82, open.*

**What it means to a person:** you tap a square while the other player's move is
arriving, and nothing happens. No mark, no message. You tap again.

**The mechanism.** A redraw replaces the elements it drew. Every app here
redraws on `dai:merged`, which is what the rule tells authors to do, so a merge
landing between a press and its release replaces the element that was pressed —
and **Chromium then fires no `click` event at all**. Measured in the frame:
`pointerdown` on a cell at 2349 ms, the board rebuilt at 2395, `pointerup` on
the *new* cell at 2407, and no click, anywhere. The handler never runs, nothing
is written, nothing is said.

**That fact is why delegation is not the fix.** A listener on the board catches
nothing, because there is no click to catch. Reimplementing the tap from press
and release was rejected too: it inherits scrolling, pointer capture, a finger
that slides off, long-press, touch-cancel, the keyboard and assistive technology
— and every author who copies the pattern inherits them.

**The fix: never redraw while a pointer is down.** A flag set on
`pointerdown`, cleared on `pointerup`/`pointercancel`; a redraw notes itself
and runs when the flag clears, after that release's click. `click` keeps its
native meaning, the press and the release meet the same element, and
`replaceChildren` stays in the fixture so the fix is proved on the hard case.
The handler then reads the state **when it acts**, not from the draw that bound
it, because the merge that was held back may have changed whose turn it is.

- **Applications:** `examples/tic-tac-toe` (in `draw()`), and the merge
  listeners of `examples/receipts`, `examples/request` and
  `tests/fixture/chess`. Four apps were in this shape.
- **The kit** (`src/kit.ts`, runtime): `daiKit.refresh()` defers the same way.
  The rule tells authors to call it on a merge, so every kit application was in
  the shape whether its author knew it or not.
- **The rule:** `SHARED-POINTER-HOLDS-THE-SCREEN` in `src/rules.ts`, anchored
  to the fixture's flag and the kit's, beside SHARED-REDRAW-ON-MERGE.

**Proved, both cases.** The reproduction is kept, labelled, in
`tests/push-e2e.spec.ts` behind switches:

```
D79_PROBE=1 D79_SPLIT=1 npx playwright test tests/push-e2e.spec.ts -g "D79 probe" --project=chromium
D79_PROBE=1 D79_CLOSE=1 npx playwright test tests/push-e2e.spec.ts -g "D79 probe" --project=chromium
```

- **D79_SPLIT** presses, forces one redraw, releases: **5 of 5 dropped before
  the fix, 5 of 5 accepted and shown after.**
- **D79_CLOSE** does the same with a merge that makes the move illegal (the
  creator's close): **refused with a notice, 5 of 5** — "That move wasn't made:
  the match was closed while you were tapping" — with the board and the status
  telling the truth. Two sentences were untrue and were fixed with it: the
  notice blamed the turn, and `drawStatus` never looked at `closed`.
- **The kit's guard** is `kit.spec`, "a refresh that lands mid-tap waits for
  the finger to lift": press, refresh, release, and the row's update survives.
  With the deferral removed it fails on Chromium and WebKit; with it, 6 of 6.
- **In tic-tac-toe the opponent cannot already have moved** — turns alternate —
  so the close is the merge that makes a move illegal there.

**How CI met it, twice.** `push-e2e.spec.ts:696` (Chromium 153), runs
35409533799 and 35450102259, each passing on retry. The click landed 4–6 ms
after the mailbox lane started, which is when its first pull merges and
redraws; Playwright's click takes 54–107 ms from "performing" to "done", which
spans one. Both traces are kept in their runs' `retried-chromium-whole`.
**First recorded here as a badge text mismatch, which was wrong**: both
sightings are this assertion, on B's own board.

**The tests wait for the merge now**, rather than racing it:
`firstMailboxMerge` (`tests/mailbox-wait.ts`), used at the five places a spec
taps an app control right after mount or after pointing at the relay —
`push-e2e` (two), `invite-one-session`, `mailbox-link-e2e` (three sites) and
`session-mailbox-e2e`.

#### D40 — A tier that reports success by running nothing

*Status: open.*

`npm run test:commit` on a clean tree prints

    nothing a spec reaches changed
    test-tier commit: no spec reaches what changed.

and exits 0. Nothing ran, and the exit code says everything passed. It was very
nearly banked tonight as a green after a commit, which is exactly when the tree
is clean and the answer is least meaningful.

**It is the same failure as the probe that could not tell "nothing" from "I
could not look"** (D37's closing rule), wearing the opposite face: there, an
instrument reported absence when it had failed; here, a guard reports success
when it has abstained. Both are safe-looking answers that carry no information,
and both are read as good news by whoever is tired.

**Exit:** a tier that ran no specs says so in a way that cannot be mistaken for
a pass — a distinct exit code, or wording a person and a script both read as
"not checked". The same question applies to the impact map's no-op case, which
prints a stale-map warning and still exits 0 (seen twice tonight).

#### D32 — On Firefox, a reopened document renders and the automation cannot see its frame

*Status: open, **and no longer read as a test problem** (20 September). Rate
measured; the frame read at failure. Fix undecided.*

**Bumped 24 September: `:511` now fails both attempts.** "A turn sent and
answered, with nothing written in between, is taken without a question" failed
both attempts, with D32's signature, in two of the last three Firefox runs:
`36033989571` (96e6d11) and `36059363617` (7d5a3f0); it passed in
`36041107841` (098e187). Not chased in the identity sitting; recorded so the
rate is known when it is.

**It is getting through the retry now (22–23 September).** Counted over every
failed run of `test` in that week, the case that fails both attempts and takes
the whole run red with it — `returning-document.spec.ts:381`, "opening your own
copy after they moved does not make yours look newer" — has now done so **four
times**: `35678368339`, `35679531628`, `35763149723` on 22 September, and
`35807249998` on 23 September (the run for the revert commit `33192a6`). It was
retried and passed in four more on 22 September (`35679064956`, `35680220168`,
`35681323325`, `35682355285`), and in none of the failures before that day. Two sibling cases retried the same
day as well: `:511` twice and `invite-one-session.spec.ts:182` once.

Locally it is the same shape and has been seen on WebKit too, under parallel
load: `ios-merge-relaunch.spec.ts` "is saved before the page reloads" failed
twice in mixed runs with the frame present and empty — `- main: - iframe`, no
`#app` inside it — and passed 12 of 12 run on its own.

Nothing in the relaunch or merge work of 21–22 September touches it: neither
spec sets an iPhone user agent, so none of the iOS paths those commits changed
run in them. What this changes is the cost of leaving it: a red `main` is now
the ordinary outcome of a bad afternoon rather than a retry line in a green
one.

**The rate, by the D28 method** (five fresh CI samples, Firefox 1543, the whole
`returning-document` file at 10 repeats on 4 workers, 70 tests a sample, no
retries; the loop is `.github/workflows/d32-loop.yml`, dispatch only, because
this machine cannot start Firefox):

| Sample | Failed | Of |
|---|---|---|
| 35527268876 | 5 | 70 |
| 35527276608 | 4 | 70 |
| 35527285336 | 7 | 70 |
| 35527936943 | 4 | 70 |
| 35528445493 | 6 | 70 |
| **total** | **26** | **350 (7.4%)** |

Always the reopen path: `:192` (opening your own copy after they moved) and
`:167` (a link older than what this device holds), with `:318` twice.

**The frame, read at the moment it fails.** The kept snapshots are incremental
and cannot be read back for this, so the failing test now asks the browser
directly (`test.afterEach` in `returning-document.spec.ts`). Every failure
reads the same:

- Playwright lists **one frame**, the shell page, while that page reports one
  child in `window.frames`.
- The DOM holds `#cartridge`, the shell's blob frame: `readyState` complete,
  reachable, body "Enter App Mode", one child.
- That child is `#dai-app`, **with its `srcdoc` attribute set and its
  `contentDocument` null**.

**What that null does and does not mean — a correction, same day.** It was
first read here as "the app frame has no document", and that was wrong.
`#dai-app` is created with `sandbox="allow-scripts allow-forms"` and no
`allow-same-origin` (`src/runtime/bootloader.ts`), so its origin is opaque and
its `contentDocument` is null from the parent **whether or not it holds a
document**. The reading says nothing, and the entry said it did.

**What the screen shows at the timeout.** The film kept in the trace runs to
89 s of the 90 s wait, on the context whose last expect is the
`#cartridge → #dai-app` chain: **the document is on screen and correct** —
"move1 move2" with Move and Save now, and Enter App Mode in the corner. So the
frame renders the right text while Playwright lists no such frame.

**Where that leaves it.** The person watching this screen sees their document;
what cannot see it is the automation. That is the original reading again, now
with the person's side established rather than assumed — and it is **not**
established that a real Firefox user is unaffected, because nobody has opened
this path in a Firefox that a person drives. This machine cannot: Windows
refuses to start Firefox here ("spawn UNKNOWN"), which is why the loop runs in
CI at all. **That reading is the next thing, and it needs a machine that can
launch Firefox.**

**The ladder, and where it stopped (20 September). 370 runs, 0 failures.**
`tests/d32-minimal.spec.ts` is the shape and nothing else — a page that makes a
`blob:` frame, whose document makes a sandboxed `srcdoc` frame saying one
word. No service worker, no storage, no runtime, no document. Firefox 155, 4
workers, no retries:

| Rung | What it adds | Runs | Unenterable |
|---|---|---|---|
| one mount | the two frames, once, on a fresh page | 210 | 0 |
| a second mount | `#cartridge` to `about:blank`, then a fresh blob, in the same page | 80 | 0 |
| a navigation between mounts | `goto` the same address again, then mount | 80 | 0 |

The opener fails the same shape about 7 times in 100 on the reopen path, so the
difference is still something the opener does and this page does not. **Not
tried, in the order worth trying:** a service worker controlling the page (the
opener always has one); a blob carrying the runtime and a real document rather
than 120 bytes; and the opener's own sequence — a card, a stored database read,
a reseal — rather than a bare mount.

**So there is no upstream report yet.** "It does not reproduce in isolation" is
not a bug report, and filing one would waste the reader's time and ours. What
is in hand for whoever picks it up: the rate (26 of 350, 7.4%), the three
product-side readings that say the document is well, the fact that a reload
does not recover a page once it is in the state, and this ladder. **The next
reading is a person's hand-driven one in Firefox**, which no automation here
can stand in for, because automation is the thing in question.

**The minimal page does not reproduce it (20 September): 0 of 210.**
`tests/d32-minimal.spec.ts` is the shape and nothing else — a page that makes a
`blob:` frame, whose document makes a sandboxed `srcdoc` frame, which says one
word. No service worker, no storage, no runtime, no document, one mount on a
fresh page. 60 runs then 150 runs on Firefox 155 at 4 workers: every one
entered the inner frame. The opener fails the same shape about 7 times in 100,
so the difference is something the opener does and this page does not.

**What to add next, in this order:** (1) a *second* mount in the same page —
`#cartridge` to `about:blank`, then to a fresh blob — because every sighting is
a **reopen**, not a first open; (2) a navigation between mounts (`goto` the
same URL again), which is what the failing tests do; (3) a service worker
controlling the page, since the opener always has one; (4) size — the opener's
blob carries the runtime and a document, this one carries 120 bytes. Stop at
the first that reproduces; that is the upstream report.

**A reload does not recover it (20 September).** The mitigation agreed after
the third red — wait eight seconds for the app frame, then reload once — fired
in a local Firefox loop and the frame was still unenterable thirty seconds
after the reload. So this is not a registration glitch that settles: once a
`page` is in the state, it stays there. The helper now also asks, once, whether
a *fresh page in the same context* can enter the frame, and logs the answer;
nobody has caught it firing yet. It never masks a failure — after the reload it
only logs, and the test's own wait fails as before.

**Sighting, run 35544450215 (20 Sep, `1870609`, Firefox): both attempts of
"opening your own copy after they moved" timed out at 90 s, and the run before
and after it passed the same code.** The same run shows the cost of the
instrumentation: the afterEach hook asked a wedged page and spent what was left
of the clock, adding "timeout while running afterEach" to the failure. The hook
is bounded to eight seconds now.

**Read on a Firefox this machine can now launch (20 September).** The Windows
failure was never a permission: `firefox.exe` could not resolve its own
private `mozglue` assembly under `%LOCALAPPDATA%` (SideBySide event 33). The
same folder copied to `C:\\pw-firefox-test` ran; under any AppData path it did
not. With `PLAYWRIGHT_BROWSERS_PATH=C:\\pw-browsers` the engine runs here, and
the loop can be driven locally: **1 of 16, then 7 of 20, then 5 of 16** on the
two reopen tests, which is the CI rate and worse under load.

**Three readings at the moment of failure, and all three say the product is
well:**
1. The film kept in the trace, at 89 s of the 90 s wait: the document is on
   screen, correct.
2. The page's own DOM, read in one call: `#cartridge` is connected and has a
   `contentWindow`; the app frame inside it has a window and is laid out
   1280×720.
3. The host's own round trip into the app frame (`__runner.replicaId()`,
   which does not use Playwright's frame tree): **answered in 1–3 ms**. A null
   there means either no window or the frame replying "no replica yet", and
   reading 2 excludes the first — so the frame replied.

**So what fails is Playwright's view.** `page.frames()` lists the main frame
alone while that frame reports a child in `window.frames`, and every locator
that must enter `#cartridge` then `#dai-app` waits for a frame the automation
never registered. The document, the shell and the channel between them are
alive throughout. This is the "tooling" reading again — reached this time from
the product's side rather than assumed, and with the earlier claim of a
documentless frame retracted.

**What is still owed:** a person driving Firefox by hand through the reopen
path. Automation cannot answer it, because automation is the thing in question.

**Not carried forward:** the cause loop over how the frame is created
(`srcdoc` before or after insertion, a tick between, a non-blob parent). It was
designed against the retracted reading, and a variant's rate would measure
Playwright's frame registration, not a defect anybody has seen.


**What happens.** The opener mounts a document by pointing its `#cartridge` frame at a fresh `blob:` URL (`apps/runner/src/main.ts`, `mount`). An eject first resets that frame to `about:blank`. Sometimes, on Firefox under load, Playwright never registers that navigation. For the rest of the test it holds the frame as `about:blank`, so a locator that enters `#cartridge`, then `#dai-app`, then the app finds nothing and times out. The document is fine throughout.

**Three sightings, one signature:**

| Where | Test | What it shows |
|---|---|---|
| CI, run 34907553189 (14 Sep) | `returning-document:164` | After an `#a=` reopen, every snapshot shows the child frame as `about:blank` until the 90 s timeout. The console says the opener resumed its own copy. |
| CI, run 34920744354 (15 Sep) | `mailbox-link-e2e`, forwarded invite (then line 542) | Device B's child frame is `about:blank` for the whole 60 s wait. B's *frame-side* breadcrumbs show the app ran: it adopted its replica and wrote saves 1 and 2. |
| Local, 15 Sep | `returning-document:164` under load (1 in 6) | Same as the first row, and the trace's screenshots show the app on screen 0.7 s into the wait and still there at the timeout. |
| Local, 15 Sep | `mailbox-link-e2e`, forwarded invite, under load (1 in 6; the run took 15.8 min) | Same as the second row, down to the frame-side breadcrumbs: replica adopted and saves 1 and 2 written within 1.5 s of Open. Screenshots show the chess board, with its "Your move" banner, on screen 2 s into the wait and still there at the failure. |
| CI, run 35099758939 (16 Sep, `63e2d1e`) | `returning-document:189`, Firefox, failed and failed its retry | After a reopen, the opener logs "reopen mounted the stored database", and every frame snapshot stops at that moment. Screenshots show the app with "move1" on screen 22 s into the wait and still there at the 90 s timeout. The commit changed no runner or runtime code; the test passed 4 of 4 locally on Firefox, and the next run (`fb4c09f`, same code) was green. |
| CI, run 35106787060 (16 Sep, `9815648`) | `returning-document:166` and `:191`, Firefox, both passed on retry | Read from the traces because the commit changed this file and the save path. The opener made the right choice in both: `:166` logged "copy choice: keep, arriving is this copy's own" and resumed, and `:191` was a plain reopen. The last screenshots show exactly the expected text ("move1 move2", "no moves") on screen while the locator timed out. Three sightings in this one file on Firefox in a day, against none on the other engines: the rate is worth a look on its own. |

| CI, run 34976234780 (15 Sep) | `d22-reopen:132` | After `page.reload()` the child reads `about:blank` for the whole 60 s wait, with a lone `about:srcdoc` at the failure. The breadcrumbs show the reopen right: "reopen mounted the stored database", then "replica kept (own copy): 8e53f4f1… -> 8e53f4f1…". So D22 did not recur, and the frame was lost. |
| CI, run 34976234780 (15 Sep) | `returning-document:189` | The same shape as the first row: after the reopen the child reads `about:blank`, then drops out of view, while "reopen mounted the stored database" is logged. The test timed out at 90 s. |
| CI, run 34992640259 (15 Sep) | `returning-document:164` | After the older-link reopen Playwright holds the main frame and a lone `about:srcdoc`, with no `blob:` frame between them. The screenshot shows "move1 move2", the right answer, on screen. The test timed out at 90 s. |
| CI, run 34994907770 (15 Sep) | `runner.spec:1265`, "ticking something offers to keep it" | Everything the test is named for had already passed: no offer on mount, the tick ran, the offer appeared, and the save was written. It stopped after `page.reload()`, waiting 90 s for `#state` to read "1", while the child frame read `about:blank` and then dropped out of view. The opener "resumed this device's own copy", and both screenshots show "tick 1", the saved state, on screen. It is the first sighting outside the chess and returning-document specs, and the reopen path is the common factor. |

| CI, run 35507468526 (20 Sep, `638a17b`) | `returning-document:192`, Firefox, **failed and failed its retry** | Test timeout at 90 s on both attempts, and `main` red on Firefox alone. The kept snapshot shows the shell with its iframe and nothing inside it, the same shape as the rest of this table. The commit touched a test-only afterEach in another spec, a global-setup guard that cannot fire in CI (nothing is reused there) and the push tier, so it is this family, not the change. Second time this test has failed its retry rather than passing it. |
| CI, run 35361313964 (18 Sep, `28e978d`, a docs-only push) | `returning-document:192`, Firefox, passed on retry | The trace shows the step: line 220, `toHaveText("no moves")` after bob reopens his own copy, never ended. The page's last breadcrumb is "reopen mounted the stored database (16384 bytes)", and its last screenshot shows "no moves", the expected text, on screen. That was checked against the later `toHaveText("move1 move2")`, where the same screenshot would have meant a real failure; the trace places the stall at the earlier step. |
| CI, run 35618925872 (21 Sep, `b9b8232`) | `returning-document:365`, "opening your own copy after they moved does not make yours look newer", Firefox, passed on retry in 10.4 s | Same file, same engine, same reopen path, and the job was otherwise green (701 passed). The commit was test-only — pinning the platform two specs run as — so it is this family and not the change. Filed as a sighting rather than chased: it is the line the rate above already measures. The one worth watching beside it is `session-mailbox-e2e:175` the same day (D84), which is **not** this file and not yet this shape. |
| CI, run 35341691229 (18 Sep, `7afb8c9`) | `mailbox-link-e2e:1287`, crossed invites in the other opening order, Firefox, passed on retry | Page A clicked Open on B's link, and `#app` was never found in 60 s. A's frame-side breadcrumbs show the app ran: "reopen mounted the stored database", "replica kept (own copy)", "pending merge applied (5 rows)", "save 1 written" at 4.2 s. A's last screenshot, 60 s after Open, shows the chess app on screen with its seat prompt. Both halves of the signature, read from the kept trace. |

In each failing trace, the first-level frame is `about:blank` and later a lone `about:srcdoc` frame appears, with the `blob:` frame that should sit between them missing. A healthy mount earlier in the same test shows main, then `blob:`, then `about:srcdoc`. Both specs reproduce it locally at about 1 in 6 on Firefox under load. Each local failure has a screenshot of the app on screen while the locator waits.

**What this is not:**
- **Not D22.** The replica decision is correct in each trace.
- **Not the 14 Sep tap race** in the forwarded-invite test, which was real and fixed in `play()`, and happened at a later step.
- **Not a mount stall.** The screenshots and the frame's own breadcrumbs both show the app running.

The fault is in the test tooling's view of the frame, not in the product. That is proved for both local failures, where the screenshot and the stale frame sit side by side. For the two CI failures it is inferred from the identical signature.

**Probe, 15 September: none of Playwright's other lookups reach the app during a stall.** A temporary probe repeated the older-link reopen 24 times on Firefox under load. One run stalled with the D32 signature, and its screenshot showed the app ("move1 move2") on screen throughout. On that stall:
- the usual nested `frameLocator` timed out;
- walking `page.frames()` timed out: `#app` did not resolve in any frame Playwright held, including the lone `about:srcdoc` frame;
- asking the `#cartridge` element handle for its `contentFrame()` returned, but `querySelector('#dai-app')` inside it never returned, and the test hit its 240 s limit.

So the stale state is the driver's whole view of that frame subtree, not one lookup path. The test-side option of walking `page.frames()` below was chosen on 15 Sep and then disproved by this probe before it was built.

**Tried and disproven, not merely considered:**
- **Walking `page.frames()`.** On the probe's stall, `#app` resolved in no frame Playwright held.
- **The `#cartridge` element handle's `contentFrame()`.** It returned, and the query inside it never came back.

Do not reach for either again without a new driver version and a rerun of the probe.

**Ruling, 15 September: accept it, make it visible, report it upstream.** The product works: Firefox renders the app, the frame navigates, the person sees the board, and it is the driver that loses the frame. Two consequences follow:
- **No product change.** Changing how the opener mounts documents to satisfy a test driver would alter the eject path's deliberate frame reuse for a bug in someone else's code.
- **The retry absorbs it, and it stays visible.** CI's single retry absorbs it, as it has every time. `ci-verdict` now lists the kept trace, and this entry names the signature, so a retry of this kind is recognisable rather than a mystery.

**Rejected: reload on stall.** Recovering by reloading the page and asserting again was rejected by a standing rule, not a one-off judgement: **a recovery step that repeats the thing under test destroys the test.** A reopen that runs twice can pass on the second mount while the first was broken. The rule is in `tests/README.md`.

**Upstream: not filed until it reproduces (ruled 15 September).** A report that
cannot be reproduced buys a closed issue and spends the credibility wanted for
the day it can be demonstrated. D32 stays a known flake that the retry absorbs,
with its signature documented, the test-side workarounds disproven, and the
reproduction's four missing ingredients listed below. The next sighting that
comes with a kept trace is when it is worth someone's time again.

**First attempt, 15 September: it did not reproduce.** A standalone page with no DAI code reset a sandboxed frame to `about:blank`, pointed it at a `blob:` document holding a sandboxed `srcdoc` frame, and did so after a full navigation. On Playwright 1.62.1, 300 rounds on Firefox at four workers all resolved. So the bare pattern is not enough, and an issue claiming a reproduction cannot be filed from it. What the minimal case left out, to add back one at a time:
- **A service worker** controlling the page. The opener's pages are controlled.
- **A `srcdoc` app that runs scripts and does work** as it starts: a module import map, SQLite, and messages to its parent.
- **Several browser contexts at once,** as in the forwarded-invite test's three devices, which is the heaviest failing case.
- **The eject-then-mount order on a page that already mounted once,** without a full navigation in between.

The page, server, config and spec are kept outside the repo, ready to extend.

**The options, as they stood before the ruling:**
- **In the tests:** find the app frame by walking `page.frames()` to the one whose parent's URL is the mounted `blob:`, instead of a `frameLocator` chain. This changes nothing a person meets. But it makes a Firefox tooling fault invisible rather than fixed, so it should carry a note saying why.
- **In the opener:** replace the `#cartridge` element on each mount instead of re-pointing it, so every mount is a fresh frame that no tracker can have stale state for. The eject comment says the element is kept so the next document cannot inherit laxer sandbox attributes. A replacement built from the same attributes keeps that promise, but it is a product change made for a tool's sake.
- **Upstream:** a minimal reproduction for Playwright's Firefox, an iframe reset to `about:blank` and then pointed at a `blob:` URL. This is worth filing whichever of the above is chosen.

#### D28 — A test's browser is sometimes already closed when it starts

*Status: closed, 18 September. A Chromium 151 crash under context churn, gone
in Chromium 153. Never our code.*

**Closed with these numbers.** Chromium 151 (headless shell build 1234) crashes
when a browser context is created after others are closed under load: 21 of 540
tests died across three runs of the `icon-after-wipe` loop at 4 workers (6, 6,
9). Chromium 153 (build 1243), same loop, same load: 0 of 540. It reproduces on
demand and is gone on the upgrade, so it is a finding, not a sample. The fix is
the upgrade to Playwright 1.63 (PR #4, which also carries the WebKit
`loadStored` test fix). Merged 18 September after one fresh run rebased on
`main` (35409533799): green on every engine; its three flaky tests carried no
closed browser. Two were Firefox (D32). The third, Chromium
`push-e2e.spec.ts:657` (a badge text assertion, passed on retry), is new as a
flake and is not D28. The old builds (`chromium-1234`, `webkit-2336`) are no
longer installed.

**The reproduction, to rerun whenever "is it back?" comes up** (about fifteen
minutes for three runs):

```
npx playwright test tests/icon-after-wipe.spec.ts --project=chromium --repeat-each=30 --workers=4 --reporter=line
```

Count the tests whose first `browser.newContext` fails with `Target page,
context or browser has been closed`. On 1234 expect about 4%; on 1243, none.
The record below is how it was found.

**Where the evidence stands (18 September).** On Linux CI it is a crash: every
sighting there with its log kept carries `Received signal 11 SEGV_MAPERR
0000000001b0` at the same headless-shell frames (`+0x4265412`, `+0x754bdf3`,
`+0x6b59199`): on 15 September from two processes, and on 18 September in
`offline-detector`, a spec with nothing in common with the others. So it is not
tied to one test. The Windows sightings, local, have **no dump**: the browser is
alive and logging to its last line, then gone. That they are the same crash is
an inference from the identical symptom, not a confirmation, and the crash site
cannot be compared across platforms without a Windows dump. It is not yet a
*known* upstream bug either: that needs the stack symbolized against headless
shell 1234's Chromium build, or a Playwright upgrade that moves past it, which
is the next step below. Until then it is "a browser crash, one site, not our
code", which is more than "unexplained" and less than "known".

Three sightings, each failing on the first thing the test does, before any of
its own code: `browser.newContext: Target page, context or browser has been
closed`.

- CI, chromium, one worker (13 September, run 34788946898): `runner.spec.ts:507`,
  after runner specs 465 to 498.
- Locally, chromium, seven workers (14 September): `launch-card.spec.ts:187`,
  directly after another test in the same file passed.
- CI, chromium, two workers (14 September, run 34889745158):
  `host-profile.spec.ts:49`, the first test in its stretch to ask for a browser
  context, after four that never open a page.
- CI, chromium (16 September, run 35100278196, `fb4c09f`): `runner.spec.ts:802`
  and `viewport.spec.ts:58`, both on the first thing they do, both passed on
  retry. The run is recorded as green with 2 flaky.
- Locally, chromium, four workers (14 September, a push-tier run):
  `launch-card.spec.ts:211`. The first with any evidence: the error context
  carries the dead browser's own process log (pid 37192), and it was alive and
  logging to its last line — which was a `d22-reopen` run's breadcrumbs, ending
  at "reopen mounted the stored database". No crash, exit or signal line; then
  the next test found it closed. What the browser's last work was is a fact;
  whether it matters is not yet known.
- CI, chromium, two workers (14 September, run 34900932214):
  `runner.spec.ts:498`, the same spec whose neighbour failed on 13 September.
  The first CI sighting with its trace kept (`retried-chromium-whole`, D27).
- CI, chromium, two workers (15 September, run 34964053176, `09ec0ba`):
  `viewport.spec.ts:58` and then `viewport.spec.ts:66`, two tests in a row on
  the same worker, both at their first `browser.newContext`. The first sighting
  that took down more than one test, which fits one browser death taking every
  test after it until the worker got a new browser. Trace kept
  (`retried-chromium-whole`, 22 KB).
- Locally, chromium, four workers (18 September, a push-tier run at `20d18dd`):
  `icon-after-wipe.spec.ts:74`, at its first `browser.newContext`. Kept by the
  evidence keeper (`test-runs/2026-09-18T11-43-58-697Z-20d18dd`), and read
  before anything was rerun. It has the same shape as the 14 September local
  sighting: the dead browser (pid 12848) was alive and logging to its last line,
  with no crash, exit or signal line (Windows writes no dump). Its last work was
  the test before it in the same file, `:63`, a page spoofed as an installed
  app. The last lines are that page's persistence breadcrumbs, ending at
  `(installed): not kept (after the request)`. That test creates and closes
  its own context, never the browser.
- Locally, chromium, four workers (18 September, a push-tier run at `e08d9a5`,
  kept in `test-runs/2026-09-18T21-58-27-764Z-e08d9a5`): **the same test,
  `icon-after-wipe.spec.ts:74`, again**, at its first `browser.newContext`. Again
  the browser was alive and logging to its last line with no crash line, and
  again its last lines were the previous test's (`:63`) installed-app
  breadcrumbs, `(installed): not kept (after the request)`. **The first time D28
  has recurred at one place.** Every other sighting was a different spec. `:63`
  replaces `window.matchMedia` so the page reads as an installed app, opens the
  opener, then closes its own context. That is a lead for "find the trigger",
  not a cause. The next step it suggests: repeat `:63` then `:74` in one worker
  many times, with and without the `matchMedia` replacement, and see which
  kills the browser.
- CI, chromium (18 September, run 35341691229, `7afb8c9`):
  `offline-detector.spec.ts:27`, at its first `browser.newContext`; it passed on
  retry. The log carries the same crash as the 15 September traces, frame for
  frame: `Received signal 11 SEGV_MAPERR 0000000001b0` at
  `chrome-headless-shell+0x4265412`, `+0x754bdf3`, `+0x6b59199`. One crash site,
  hit again, in a spec with nothing in common with the earlier ones. So far the
  trigger is still not any one test.
- CI, chromium (18 September, run 35375122730, `470c909`): `one-sentence.spec.ts:30`
  and `storage-persistence.spec.ts:234`, back to back, both at their first
  `browser.newContext`, both passed on retry. The dumps show the same signal
  and fault address (`SEGV_MAPERR 0000000001b0`), but **different frames**:
  `+0x1e63034`, `+0x1e67d90`, `+0x1e71bf0`, `+0x31cb700`, against
  `+0x4265412`, `+0x754bdf3`, `+0x6b59199` in every earlier dump. Both runs used
  the same build (`chromium_headless_shell-1234`), and the offsets are relative
  to the binary, so this is **a second crash site** in the same build, reading
  the same distance past a null pointer. Two tests in a row fits one browser
  death taking out the tests after it, as on 15 September.

**The upgrade test, 18 September: no crash in three runs on the next build.**
Draft PR #4 (branch `d28-playwright-1.63`, not merged) moved Playwright from
1.62.1 to 1.63.0. That pins `chromium-headless-shell` 1243 (Chromium
153.0.8010.12), Firefox 1543 and WebKit 2359. Full CI ran three times (run
35393599569, attempts 1–3). Chromium passed 1,078 of 1,078 each time, with no
retries, no `newContext … closed`, and no crash signal; the build was confirmed
1243 in every log. Against the history (sightings on 13, 14, 15, 16 and 18
September on build 1234, some runs with two), three clean runs are encouraging
but not a rate. D14's argument applies: this is three samples, not proof.

**The upgrade is not clean, for other reasons, and is not ready to merge.**
- **WebKit, deterministic, all three runs:** `runner.spec.ts:1168`, "two saves
  at once both land". Its OPFS read-back is guarded by "where the harness
  exposes OPFS", and its comment says Playwright's WebKit has no
  `getDirectory`. WebKit 2359 does, so the branch now runs on WebKit and
  `getFileHandle` fails with `UnknownError: The operation failed for an unknown
  transient reason`. The saves themselves reported `saved: true` and released
  their locks. Not established: whether WebKit's OPFS under Playwright is
  unreliable, or the opener fell back to IndexedDB so there is no file to read.
  The latter is D49's inventory question on a real engine. This is an
  environment fact the tests relied on (D49's tests stub the Storage API for
  the same reason), and it changes with the upgrade.
- **Firefox, intermittent:** `returning-document:192` (run 2, failed and failed
  its retry) and `:318` (run 3, passed on retry), both 90 s timeouts, the shape
  D32 has shown in this file. Their traces were not read, so D32-shaped, not
  D32.

**Next:** decide the WebKit test (it now exercises a path that never ran), read
the two Firefox traces, and more runs on 1243 before calling the crash gone.

**Both read, 18 September.**
- **WebKit, `runner.spec.ts:1168`: the opener fell back to IndexedDB, because
  OPFS itself is broken in this WebKit.** A probe on WebKit 2359 (on Windows;
  CI is Linux, and its `UnknownError` matches) saved as the test does, then
  looked. `getDirectory()` exists, but every OPFS operation throws `UnknownError
  … transient reason`, even listing the root, before any file is involved.
  IndexedDB held 4,096 bytes with byte 100 = `0x22`, the later write, which is
  correct. On reload the opener logged `stored database read from IndexedDB` and
  `reopen mounted the stored database`. **A person would have seen nothing
  wrong:** the document reopened with the later save's data. The product is
  right. The test assumes the data is in OPFS whenever `getDirectory` exists.
  The natural fix is for it to read back through the opener's own load, which
  falls back the same way the save does. Not changed, not skipped: a ruling.
- **Firefox, `returning-document:318`: D32, confirmed.** The kept trace stalls
  at line 349, `toHaveText("move1 move2")`. Bob's page logged the correct
  decision (`copy choice … take (arriving …)`), and his last screenshot, taken
  at the 90 s mark, shows "move1 move2", the expected text, on screen.
- **Firefox, `returning-document:192`: unconfirmed, and its evidence is gone.**
  Run 2's Firefox report is not among the run's artifacts; only the latest
  attempt's survive. The three runs were made with `gh run rerun`, **which
  replaces each attempt's artifacts with the next one's.** That is D47's
  lesson one level up: a rerun erased the evidence of the run before it. Next
  time, a fresh run for each sample (an empty commit per run), not a rerun in
  place, or download each attempt's artifacts before the next starts.

**Fresh run after the test fix, 18 September (run 35399985043, `437ecfa`, a new
run from a push, not a rerun; artifacts downloaded as soon as it finished).**
- **WebKit shard 2: 317 of 317.** `runner.spec.ts:1168` now reads back through
  the opener's own load (`__runner.loadStored`, which is `loadDatabaseFromOpfs`),
  which falls back to IndexedDB exactly as the save does. It passed where it had
  failed in all three earlier runs. It is not skipped on any engine.
- **Chromium: 1,078 of 1,078, no crash signal, no `newContext … closed`.** The
  fourth clean run on build 1243. Still a small sample.
- **Firefox: one retry, `returning-document:192`, D32 confirmed.** This time
  its trace was kept. It stalled at line 220, `toHaveText("no moves")`, after
  "reopen mounted the stored database", and the last screenshot shows "no
  moves" on screen. Run 2's lost sighting stays unconfirmed. This test has
  shown D32's signature every time it could be read.

**Reproduced on demand on the old build, gone on the new (18 September).** The
lead was that the crash twice landed at `icon-after-wipe:74`, right after `:63`.
- **The pair alone does not do it.** `:63` then `:74`, 30 times in one worker
  on build 1234 (line filters, 60 tests listed alternating before the run): 60
  passed, no deaths.
- **Under load it does.** The whole `icon-after-wipe` file repeated 30 times
  across 4 workers, which keeps each file's tests in order on one worker. On
  **build 1234** (Chrome 151.0.7922.34): **6, 6 and 9 deaths in three runs of
  180 tests: 21 of 540, 3.9%.** On **build 1243** (Chrome 153.0.8010.12),
  otherwise identical: **0, 0 and 0: 0 of 540.** Every death was the next
  test's first `browser.newContext` finding the browser closed. CI logs on
  1234 carry the `SEGV_MAPERR 0x1b0` dump; this Windows machine writes none.
- **It is not `:63` or its `matchMedia` replacement.** Deaths landed at `:85`
  13 times (after `:74`, iPhone user agent and `matchMedia` replaced), `:74` 5
  times (after `:63`, `matchMedia` replaced) and `:112` 3 times (after `:85`,
  which replaces nothing). What every predecessor shares is that it creates its
  own browser context and closes it (`page.context().close()`). The trigger
  looks like context disposal under load, most often after the iPhone-user-agent
  context. That is read from the pattern, not isolated.
- **Nothing from `:63` reaches the next test.** `:85` follows `:74` and asserts
  the neutral sentence, which needs `standalone()` false. It passed every time
  it was not the crash's victim. A `matchMedia` replaced by `addInitScript`
  lives and dies with its context: no harness finding. And a real page cannot
  close a browser context, so nothing here suggests a page could reach the
  crash.

**This is the merge evidence D28 asked for:** reproducible on the old build at
a measured rate, and not at all on the new one under the same load. The WebKit
test the upgrade broke is fixed on the branch (`437ecfa`), so the upgrade's
known costs are paid. Ruled: merge (18 September).

Side effect to know about: `npx playwright install` on the branch removed
`main`'s browsers (`chromium_headless_shell-1234`, `webkit-2336`) as unused.
Switching back needed a reinstall.

**What the kept trace says (15 September): Chromium crashed.** Each error context
carries the browser's own crash dump: `Received signal 11 SEGV_MAPERR
0000000001b0`, a read near a null pointer. The two dumps come from *two
different processes* (pid 9227 and pid 3508), with the same stack frame for
frame (`chrome-headless-shell+0x4265412`, `+0x754bdf3`, `+0x6b59199`, …;
headless shell build 1234). So:
- **Not one death taking two tests.** It is one crash site in the browser,
  hit twice.
- **Not something the repository closes.** A segfault is the browser's own.
- **The viewport tests are not proven triggers.** Both failed at the `page`
  fixture's `newContext`, before either test ran, so the crash happened during
  whatever that worker's browser ran just before them.

**Next:**
- **Find the trigger.** Map which test ran immediately before each crash on its
  worker (the CI log's worker order), and see whether one test or one API, such
  as `setViewportSize` or a context with a service worker, precedes every
  sighting.
- **Rule out a known bug.** Symbolize the stack against the Chromium build that
  headless shell 1234 corresponds to, or check whether a Playwright upgrade
  moves past it.

Each passed on retry, and 78 repeats of launch-card under the same load never
reproduced it. It is not parallelism: it happened at one worker too. Nothing in
the repository closes or kills a browser. Chromium only, so far.

Until D27 there was nothing to investigate with: the trace of a test that fails
and then passes on retry was discarded with the passed job.

**Exit:** the next sighting's kept trace says what closed the browser — a crash,
a worker's teardown, or something the test before it did — and the fix follows
from that.

#### D39 — A copy's replica id changes during the open of an invite

*Status: open — breadcrumbs added to answer it in one run.*

Seen four times in the D37 probe readings, never explained, written down because
it is not understood rather than because it is known to be wrong.

A copy that already holds the app and opens an invite prints two identities in
one open:

    dai: replica adopted (arrived copy): none -> 3c5ef357d884387f245809beaf8a34cb
    dai: pending merge refused: NO_DOCUMENT_OPEN
    dai: replica kept (own copy): none -> f50268072e5d4b5d1dc4daf323008378

The first is the copy opened from the file; the second is the reopen the merge
path performs through `launchFromLibrary`. Both lines are the runtime saying
what identity the write surface adopted, and they disagree within one open.

**Why it might matter, stated as a question and not a claim.** A watermark is
bound to the replica that issued it (T1-D22's structural fix). If a copy
publishes under one identity and later reads or advances a watermark under
another, a seq counted in the first says nothing about the second. That is the
shape of the corruption the `{replica, seq}` pair exists to prevent, so an
identity that changes mid-open is worth understanding even though the exchange
currently converges.

**Cross-referenced with T1-D22, and deliberately not merged into it.** T1-D22
(`docs/replicated-tables.md`, not backlog D22, which is about zip timestamps) is
a confirmed corruption — a reopened arrived copy came back wearing the sender's
id — and it waits on its next CI sighting with breadcrumbs already in place.
This is an identity changing *within one open*, on a copy that is behaving. They
are close enough that they may turn out to be one thing, and keeping them apart
is what makes that a finding rather than an assumption: if the next trace shows
the same id on both sides of a merge, they merge with evidence. Until then, two
entries.

**Why it is not filed as a bug.** Nothing observed has gone wrong because of it:
all thirteen tests in `tests/mailbox-link-e2e.spec.ts` pass, including the four
that force every order two people can invite in, and the seat and turn tests
pass with it happening. The two ids may simply be two different copies — the
file-opened one and the library's — which is exactly what the two messages say
on their face. **That is the reading to confirm or refute, and the mailbox
breadcrumbs added with this entry are what will answer it**: a watermark line
now names the replica it is bound to at every read and write, so one run shows
whether anything was ever published under an identity that later changed.

**Resolved alongside it, recorded so nobody re-opens it:** the same readings
showed the invited copy's key for a game appearing only *after* the mailbox
started, which is after the merge — a lane built before that point would have
derived from the document key. That one is understood and fixed: the key is
filed when the document it belongs to is identified, before the mount, which is
part of the D37 change.

#### D24 — Five isolation tests skipped in CI on every push, and only arithmetic noticed

*Status: open — the probe is committed; a skip for a missing build step still passes.*

The isolation probe (`conformance/isolation-probe.dai.html`) is built by
`scripts/build-conformance.mjs` and read by three specs — `static-opener`,
`isolation-conformance`, `host-profile`. A broad ignore rule (`*.dai.html`) kept
it out of git, and nothing in CI builds it. So in CI those five tests skipped,
each with a reason ("run `npm run conformance` to build the probe"), on every
push, very likely since they were written. The isolation run against a plain
static host — the check that the opener's claimed boundaries hold with none of
production's headers — has never happened on CI.

A skip with a reason is accepted by the count gate, so nothing failed. It
surfaced only because the floors were re-based from a local run, where the probe
existed, and CI then came in seven short. The gate caught it by an accident of
arithmetic, not by design.

It is the same shape as the jobs that were cancelled and read as flakes, and the
reader that never enforced its bound: a test that cannot run looks exactly like a
test that passes. The probe is committed now (`af4584f`), with an ignore
exception, and `build-conformance --check` reports a built file git does not
track. But the class is still open: any spec that skips on "build this first"
passes in CI when the thing was never built, and the count gate is the only thing
between that and silence.

**Exit:** in CI, a skip whose reason is a missing build step fails the run — a
skip there must be something CI genuinely cannot do (another platform, a
credential it does not hold), never something it did not bother to build.

#### D26 — Webkit has no count floor in CI

*Status: open.*

CI runs webkit in two `--shard` halves, so each finishes inside its budget, and
the count gate skips a sharded run: a shard's count is a fraction of the whole
by intent, and holding it to the whole floor would fail every shard. Chromium
and firefox run whole and are gated. So the floor covers two engines of the
three. Webkit's number in `tests/count-floor.json` (644) comes from local whole
runs and is never compared with anything in CI.

Nothing is broken today: webkit's specs still run in CI and still report
failures. What is missing is the other half of what the gate is for. A webkit
test that stops being collected — or a webkit-only spec that starts skipping for
a reason nobody checks, the way the isolation probe's tests did (D24) — passes
in silence. It is a check that appears to cover three engines and covers two.

**Exit:** gate the sum. Each shard reports its passing count; a step after both
adds them and holds the total to webkit's floor, which is then what CI passes,
like the others.

#### D30 — Locally, a runtime change reaches the opener's tests one run late

*Status: open.*

Found adding the D22 breadcrumbs (14 September): the frame's line was missing
from a traced run's console and present on the next run of the same code.

The opener bundles `dist/dai-runtime.js` into its own build. Playwright starts
the web servers — which build the opener — before global setup runs `npm run
build`. So each local run's opener carries the runtime from the build before it:
the first run after a change to `src/runtime/` tests the old runtime inside the
opener, while the opener's own code is fresh. Nothing says so; the run passes or
fails against code that is no longer there.

CI has no lag: `npm ci` runs `prepare`, which builds `dist/` before the tests. It
matters locally, and it matters most for exactly the tier meant to be trusted
before a push.

**Exit:** build `dist/` inside the opener's web-server command, before the vite
build, so the runtime it bundles is always the one on disk — or have global setup
fail if the opener's bundle does not carry the runtime `dist/` holds.

---

## 5. Not engineering

Only the maintainer can do these, and they get lost between documents.

- **Publish dai-core 0.2.0.**
- **Register the media type.** `application/vnd.dai`, drafted at
  `docs/media-type-registration.md`. Submitted 7 September; IANA asked whether review
  may go to the public media-types list, answered yes; awaiting the expert.
- **Register the trademark and keep it separate from the company.** A form and a
  fee, and cheap enough not to wait for 1.0.

#### 4.4 The wedge

One category where an app is useful enough to send to somebody else. Not
engineering.

**Exit:** ten seed apps in the category, each shared at least once outside
its maker in a pilot.
