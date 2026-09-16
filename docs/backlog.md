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

Three defects this week, filed separately because they were found separately,
are one shape. Recorded here as a pattern rather than split across three
entries, because the codebase clearly has a habit and the next instance will
not announce itself as a member of the family.

- **D36 — `savedAt` means both "when this was written" and "what it has seen".**
  A copy that only opened and saved outranks a real move made elsewhere.
- **D37 — a key means both "this document" and "this game".** Two people who
  each invited first derived different mailbox addresses and published moves
  the other never read.
- **D41 — a lock spelled two ways is two identities for one lock.** The save
  path took `dai:<uuid>` under a local alias, so a guard reading the source
  reported it as unlocked and every writer that should have held it looked
  unprotected.

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

### The other shape that keeps recurring — a check that passes for a reason unrelated to what it claims

Five instances in one week, found in five different kinds of check. Recorded as
one pattern because each looked like a different accident and none of them was.

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

*Status: waiting on the next sighting's trace.*

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

**Exit not met, and cannot be met here:** an iOS device test needs an iOS
device. Everything above is the mechanism it would exercise; what is left is
somebody holding a phone, or a device lab — the same decision 5.1 is waiting
on.

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

#### D44 — A burst of shared writes becomes one notification

*Status: ruled — not built.*

Ruled, not built.

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

### Trust, verification and offline

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

#### Identity: what manifestVersion 3 left

*Status: open.* `hostLabel` UI beyond a prompt; a QR for the safety number; a real
Sigstore signing flow at build time.

### Protocol changes

#### D48 — Getting a player back into a game they are already in

*Status: open — findings and a proposal; nothing ruled, nothing built.*

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

### Test and CI integrity

None of this is product. Each entry is about whether the suite's verdict can be
trusted.

#### D47 — `static-opener` fails in full local runs, and nobody has read why

*Status: open.*

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

#### D32 — On Firefox, a test loses the opener's frame when it is pointed at the document

*Status: open — fix undecided.*

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

*Status: open — watched; traces kept.*

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
