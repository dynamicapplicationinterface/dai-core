# Backlog

The live list. Ordered by what it costs to be wrong, and gated rather than
dated. Each item has an exit a machine can check. When an item is done it
moves to the bottom with the commit that closed it, so the record of why stays
with the record of what.

Reshaped 4 September 2026 around one sentence: **someone sends you a DAI app,
and you can use it immediately.** On a phone the only pre-installed executor
is the browser, and a browser executes URLs, not files. So the file stays
canonical and the link is how a document is met on first contact: **send a
link, keep a file.** `.dai.html` is the zero-install path on a desktop; on a
phone a tapped attachment is a static preview at best.

Phase 0 is serial and nothing below it ships first. Phases 1 and 2 run in
parallel after it; 3 follows 2; 4 and 5 follow 1. Critical path:

    0.2 → 0.3 → { 1.1, 1.3 } ‖ { 2.1 → 2.2, 2.3 → 2.5 } → 3.1 → 3.3 → 3.5 → 4.1 → 4.3

## Scoreboard

One line per item. `[ ]` open, `[~]` in progress, `[x]` done with its commit.

| | Item | State |
|---|---|---|
| 0.1 | Signed set closed | [x] `f60466d` |
| 0.2 | The host owns the runtime | [x] `7f6ec7c` — bootloader; the engine follows with 2.1 |
| 0.3 | The shell binds its frame's messages | [x] `870c1e5` — **Phase 0 closed** |
| 1.1 | Launch card with backed claims | [x] `f625dcc` |
| 1.2 | One card for every carrier | [x] `7fec986` — `/d/<id>` joins when 2.3 lands |
| 1.3 | Install after use | [x] `a7df929` |
| 1.4 | One sentence everywhere | [x] `0f9f72d` — the unfurl inherits it with 3.3 |
| 1.5 | Look inside | [x] the card hands the same bytes to the playground |
| 2.1 | Thin profile | [x] `ba5a8e1` format, `1b31ea1` opener |
| 2.2 | Inline link | [x] `8b66364` grammar, `6c23954` compact carrier — a chore chart is 2.8 kB |
| 2.3 | Reference link and dumb store | [x] `bca1061` — interface, two adapters, opener; the bucket is yours |
| 2.4 | Carriers in the specification | [x] `5606a87` `6c23954` `1a33b86` |
| 2.5 | The sender's last line is the link | [x] `8ce30f3` — link done; QR is its own item |
| 2.6 | Every share path carries the link | [x] `abc0a59` |
| 3.1 | Engine once, offline forever | [x] `1b31ea1` `8b66364` `fd2723f` |
| 3.2 | Mirrorable static opener | [x] `c9a6789` |
| 3.3 | Unfurl without the blob | [x] `a7a0be8` + this — static half and edge half |
| 3.4 | Stripped fragment degrades to a sentence | [x] `c4be316` sentence; no-key variant is a store policy |
| 3.5 | iOS solved by the link | [~] one way only: an icon launches into the link, but a link cannot reach an installed icon — see Phase 6 |
| 3.6 | Second-use integrations only | [x] the rule is a test now |
| 4.1 | Succession | [x] `c31a68b` — opener adopts under the same key; desktop and the scripted eval stage open |
| 4.2 | "Modify this app" | [x] clipboard bundle, `get_dai_source`, header carries identity |
| 4.3 | A publisher who is somebody | [x] `6ae143b` — known / new / conflict on the card; QR deferred |
| 4.4 | The wedge | [ ] not engineering |
| 4.5 | Attachments in the document | [x] `<dai-attach>`, blob columns, downscale, a budget |
| 5.1 | The north star, measured | [x] `npm run measure` locally; one real phone per release |
| 5.2 | Propagation without a beacon | [~] the opener's half is a test; the dashboard is the relay's |
| v3 | manifestVersion 3: spec | [x] `9adbfb8` |
| v3 | readers accept 3, refuse others by name | [x] `00af8e6` — opener, website and desktop v0.2.0 |
| v3 | countersignature slot | [x] `35cf65e` |
| v3 | confusables, two rules, two stores, root lists | [x] `5fcd4b0` |
| v3 | identity: Sigstore bundle, offline | [x] `6925a25` |
| v3 | compiler default flips to 3 | [x] `f8b8f8e` — after desktop v0.2.0 shipped the reader |
| — | Media type registered | [~] submitted 7 Sep; IANA asked whether review may go to the public media-types list, answered yes; awaiting the expert |
| — | Desktop window shows the document's icon | [ ] |
| — | Packing list date editable | [x] `30a83aa` |
| — | dai-core 0.2.0 published | [ ] yours |
| — | QR for a reference link | [ ] only useful once a store is ordinary; see 2.5 |
| — | Desktop signs with a key it keeps | [ ] it builds unsigned today; the page says so |
| — | Trusted Types | [x] `eec29fe` — on for kit-only apps; advice for the rest |
| L3 | Documentation overhaul (the recipe is behind) | [x] `f3887da` constraints + model file, `08bfd70` pages, `64eb2b2` session eval — a model run against it is still to do |
| D1 | Kit writes shared tables; kit redraws on merge | [ ] documented as local-only meanwhile |
| D2 | Refusal registry lacks the app-facing codes | [~] 22 codes registered; a test reads them out of `src/` and fails on a missing one |
| D3 | Specification v0.3, normative for version 4 | [ ] scope when asked; its one wrong sentence is D19 |
| D4 | An invite carries every session | [x] `requestShare(session)` → host filters with `filterToSession` |
| D5 | Comment after a shared table's last column breaks the rewrite | [x] rewrite fixed, and the Node build loads the rewritten schema; the in-browser compiler does not |
| D6 | A session seats two, whatever max_parties says | [ ] documented as a two-person limit meanwhile |
| D7 | examples/tasks shows its forms before start-up | [ ] breaks NO-INPUT-LOST-WHILE-OPENING |
| D8 | The host runs one mailbox per document | [x] one mailbox per session, wired and proven end to end (`de2be4f`); older session documents are D10 |
| D9 | A tested building block with no caller is not done | [x] check in `npm run typecheck`, definition of done in `CONTRIBUTING.md`; found tic-tac-toe's trigger hole on its first run; every finding decided |
| D10 | Session documents built before per-session mailboxes stay readable by any link holder | [x] decided: cannot be repaired in place; re-create — the app says so |
| D11 | A large document crashes Safari on iPhone | [ ] measured 14 Sep: a phone fails near 34 MB; first fix (no giant decode string) built 15 Sep: −20% heap at 25 MB and −7 to −22% at 50 MB on desktop; 5 MB rose, unexplained; device ceiling not re-measured; next fixes wait for a ruling |
| D12 | A relay deploy has a window where a post lands in old code | [~] rule in the relay README; one junk item in the bucket |
| D13 | The in-browser compiler skips the build-time schema check | [ ] the open half of D5 |
| D14 | Two blind runs is not a rate | [ ] both passed, both found real defects |
| D15 | Asymmetric roles inside a session | [ ] the enterprise demo needs it; parked on the dynamic statement |
| D16 | A native iOS host: App Clip and Messages extension | [ ] parked until after the enterprise demo |
| D17 | Mailbox batches are deleted at 90 days — silent data loss, first on ~8 Dec | [~] scoped rule written in `infra/r2-lifecycle.json`; Chris applies it; retention then decided on purpose |
| D18 | Nothing can tell a hole in a mailbox history from an empty stretch | [ ] the property that makes D17 silent; the relay is the one place that can |
| D19 | The published spec says a reader must refuse version 4 | [ ] one sentence; goes with the next docs change |
| D20 | A table constraint in a shared table rewrites to SQL that will not load | [ ] refused at build with SQLite's message, not by name; the in-browser compiler would ship it |
| D21 | A new confusable table leaves untouched publisher pins on the old one | [ ] a pin is re-indexed only when it is saved again |
| D22 | The runtime's own save zips without the fixed timestamp | [ ] the one place of its kind; nothing compares its bytes yet |
| D23 | The inline dictionary is frozen, and the corpus it was built from has moved | [ ] replacing it strands every link made since 5 September; needs an opener that holds two |
| D24 | Five isolation tests skipped in CI on every push, and only arithmetic noticed | [~] the probe is committed (`af4584f`); a skip for a missing build step still passes in CI |
| D25 | `website/public/demo.dai.html`: tracked, written by nothing, read by nothing | [ ] identify before deciding; do not delete on "nothing references it" |
| D26 | Webkit has no count floor in CI: its runs are sharded, and the gate skips a shard | [ ] its tests run and report failures; one that stops being collected goes unseen |
| D27 | CI discarded the trace of every test that failed and passed on retry | [x] `5d71345` — a passed job now keeps each retried test's trace |
| D28 | A test's browser is sometimes already closed when it starts | [ ] three sightings, at 1, 2 and 7 workers; passes on retry; traces now kept (D27) |
| D29 | An offline reopen sometimes fetches the document's icon from the network | [ ] a real leak in the offline promise; intermittent |
| D30 | Locally, a runtime change reaches the opener's tests one run late | [ ] the runner bundles the previous build; CI has no lag |
| D31 | A document the opener has verified is verified again when it mounts | [ ] a trust ruling, not a performance fix; undecided |
| D36 | An untouched copy's first save can make it "newer" than a real move, and the move is dropped | [ ] seen once (push tier, 15 Sep); pre-existing; savedAt stamped by a save that changed nothing |
| D35 | The same document held on two installs is correct but illegible | [ ] the relay reconciles them; nothing says which icon is which |
| D34 | Badge the home-screen icon on an incoming move | [ ] unblocked 16 Sep: push confirmed working on a phone (banner arrives, no badge — nothing calls `setAppBadge`); the count is ruled (the app reports it); the two lines are unwritten |
| D33 | Other host-to-frame messages can still arrive before the bridge listens | [x] every message is held by default until the bridge listens; the payload is the one named exception; proven both ways |
| D37 | Two people who both invite cannot reach each other, in silence | [x] a key belongs to the game, not the document; four orders forced by test; migration decided (old games restart); 13/13 on chromium, CI across engines still to run |
| D38 | A rematch has to be sent as a link, which is absurd between two people already playing | [ ] the mechanism is decided and deliberately not built; trigger below |
| D39 | A copy's replica id changes during the open of an invite | [ ] seen four times, unexplained, nothing observed going wrong; mailbox breadcrumbs added to answer it in one run; cross-referenced with T1-D22 (replicated-tables), not backlog D22 |
| D40 | `test:commit` reports success by running nothing | [ ] a clean tree prints "nothing a spec reaches changed" and exits 0; a guard that passes by doing nothing is the same failure as a probe that cannot tell "nothing" from "I could not look" |
| D41 | A library write outside the save lock can rewind the save counter | [x] found in the CI trace of `push-e2e:212` (37 refused saves, a push subscription never released); one lock, one spelling, every `revision` writer inside it; guarded by `library-record.spec`; the race itself inferred, not reproduced |
| D32 | On Firefox, a test loses the opener's frame when it is pointed at the document | [ ] the app mounts and shows; Playwright waits in a frame it still believes is blank; two CI sightings, both reproduced locally about 1 in 6 with screenshots; fix undecided |

---

## manifestVersion 3

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
is read and stays in the suite as a regression. **Left:** `hostLabel` UI beyond
a prompt; a QR for the safety number; CDDL and byte vectors for 2.4; a real
Sigstore signing flow at build time.

## Phase 6 — Correspondence: the document that comes back

Everything above is distribution — one person makes a document, others
receive it. A document that returns is a different lifecycle, found by two
people playing a game of correspondence chess by link, and half of it is
missing.

### 6.1 Ordering — closed

An arriving copy wins only when it is demonstrably later. `savedAt` is stamped
into the manifest by every reseal, outside the signed set; label 14 carries it
through the inline carrier (`c2e8c6c`); the library keeps this device's own
stamp across opens, and only a save sets a new one. Later mounts, equal or
older leaves what is here alone and says so, so an old link scrolled back to
in a message thread cannot roll a game backwards. `698ad97`, `c2e8c6c`.
`tests/returning-document.spec.ts` plays all three sequences.

Two limits, written down rather than fixed: ordering is by wall clock across
two devices, which is enough for correspondence and is not a causal clock; and
a library record written before this carries no stamp, so that device's copy
wins by default until it is saved once.

### 6.2 A data-only carrier — open

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

### 6.3 iOS: a link cannot reach an installed icon — open

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

### 6.4 The post-merge relaunch to `#u=` hangs at a document address — open

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

## Later — device capabilities (health, notifications, and the rest)

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

## Later — transferable ownership

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

**The customer it is actually for** is not abstract: the character-file product.
A collectible character is a file its holder owns; its habitat works offline in
the file, its game runs on a server, and holders trade characters with each
other. Trading is transfer — the one party who holds a character must stop being
able to after they trade it — so this is the product that pulls transferable
ownership, and the enterprise instrument is the second customer. **So the
un-park sentence reads: when the character-file product is being built, or an
enterprise use case needs a transferable instrument — whichever comes first, and
only after Track 4.**

## Later — three surfaces to finish

Not urgent, and in the order to take them. None is a new capability; each is a
shipped surface that behaves wrong in a way a person meets, and each has the
same shape underneath — a state that is real but not drawn, so the screen lies
about what happened.

### L1 — The card must not hand over a container that isn't ready

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

### L2 — The make-one page's step 3 has four states and one layout

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

### L3 — The recipe is behind the opener, and there is no worked-examples page

*Done (13 September): `f3887da`, `08bfd70`, `64eb2b2`. The success test has run
once: a fresh model given only the model file wrote a Connect Four session
application that linted clean, built, and played a whole game across devices
in the real host — see `eval/candidates/claude-opus-5-blind/README.md` for
what it did and did not cover (chiefly: it followed the tic-tac-toe example
closely, so a prompt unlike any example is the stronger next test). The
documentation overhaul: The recipe is replaced
by `src/rules.ts` — constraints with stable IDs, from which the model file, the
MCP text and the human reference pages are generated, and each constraint is
tied to its code anchor by a test. What it found that is not documentation is
the section below.*

The recipe is what a model receives through MCP, so a stale recipe means every
generated app is built against yesterday's format — the damage is upstream of
every door. It is materially behind what the opener does. Gaps, in order of how
much each costs:

- **How to read a replicated table is never stated.** The rewrite adds three
  views and the recipe never names them, so an author queries the base table and
  gets superseded rows, tombstones and non-member rows mixed together. Reads come
  from `_current`.
- **Conflicts are absent entirely** — `_conflicts`, `_r_conflicted`, two people
  acting at the same point. The recipe implies conflicts exist (it explains why
  UNIQUE is wrong) and never tells the author to surface them, so a generated app
  silently shows one of two conflicting rows.
- **Sessions are absent** — the profile declaration, seats, bindings, invites,
  close, the contested-seat state.
- **Updates arriving are absent** — the merge event and its source tag, so a
  generated app draws once and never redraws when the other party's row lands.
- **The shape decision is missing from the top.** Solo, passable, session,
  broadcast — chosen before a single table is written. That is the question
  nobody asked the model that wrote the first chess app, which is why it stored
  the board.

Then a worked-examples page: one app per shape, with the decision that led to it
stated first, and a section on what each shape costs — no UPDATE, no DELETE, no
PRIMARY KEY, no UNIQUE, no CHECK, no stored derived state, reads from `_current`.
The best teaching artifact available is the first chess app beside the second:
the diff is the lesson.

**Recipe before examples** — a model with a stale recipe writes a broken app
however good the examples page is.

**Exit:** the recipe names the three views and says reads come from `_current`;
it covers conflicts, sessions, arriving updates, and opens with the shape
decision; a worked-examples page ships one app per shape with its decision and
its costs stated; a test greps the recipe for `_current`, `_conflicts` and the
shape question so it cannot silently fall behind again.

## Later — what the documentation overhaul found in the code

Found while verifying every documented claim against `main`. Each is a code or
specification change, not a documentation one, so the documentation states the
behavior as it is today and these are where it changes.

### D1 — The kit writes shared tables with raw SQL, and never redraws on a merge

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

### D2 — The refusal registry omits the codes an app author actually meets

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

### D3 — The specification is behind the code to the point of contradiction

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

### D4 — An invite carries every session in the document, not only the one

**Done (13 September).** `window.dai.requestShare(session)` names the session;
the shell passes it through only when well-formed; the host's share sheet, in
invite mode, filters a scratch copy of the database with `filterToSession`
(`apps/runner/src/invite.ts`, on the engine the opener already stages) and
reseals it around the same signature. The host's own menu share still sends the
whole document — it cannot know which game is meant — and says so on the sheet.
Because an invite now carries none of the sender's local rows, the join rule
changed with it: a copy joins the session it can join (an open seat it did not
create), preferring the one showing. `tests/invite-one-session.spec.ts` shares
one game from a document holding two, through the game's own Invite, and finds
nothing of the other in any table of the copy that arrives; a whole-document
share opened on a third device is the control.

T1-D28 decides that an invite is the document filtered to one session, and
**the filter is built, reviewed and tested — and unused.** `exportSession`
(`src/replicated-export.ts`) over `filterToSession` (`src/replicated-rows.ts`)
does the whole job, including refusing a malformed source with
`SESSION_EXPORT_INCOMPLETE`, and `tests/session-export.spec.ts` covers it. Both
halves were needed and only one landed: nothing on the invite path calls it.
**Do not rebuild the filter** — wire it. The runner's share sheet packages the whole
document (`currentHtml(withData)`, `apps/runner/src/main.ts`), so a person who
invites someone into one game sends every game the file holds, and 2.1.1 §5.2
rule 4 ("export is one session") does not hold in the shipped host.

The documentation says what happens today — the share sheet sends the document
— and does not promise per-session invites.

**Exit:** sharing from inside a session document produces the filtered invite
through `exportSession`; an end-to-end test opens the invite and finds only
that session's rows.

### D36 — An untouched copy's first save can make it "newer" than a real move, and the move is dropped

**Seen once, in the push tier (15 September, chromium):**
`returning-document.spec.ts:129`, "arrives, instead of being replaced by what
this device already had". Bob's app showed "no moves" for the whole 60 s wait;
Alice's move never arrived. The frames were healthy throughout, so this is not
D32. The timeline from the trace:

| Time | What happened |
|---|---|
| 176.5 s | Alice's move is saved |
| 178.0 s | Alice shares. Her link carries the `savedAt` of that moment |
| 183.8 s | Bob opens the document. He makes no move |
| 186.1 s | Bob's copy logs `dai: save 1 written`: a save from the open itself, not from anything Bob did |
| 186.1 s | Bob follows Alice's link: "resumed this device's own copy from the stored database". Her move is dropped |

**The cause, confirmed in the code.** Every save reseals the container, which
stamps `savedAt` with the time of the save (`apps/runner/src/main.ts`, the save
handler: `loaded = await resealCartridge(loaded, bytes)`). That stamp is then
written into the library record as when this copy was last written
(`savedAt: savedAtOf(loaded)`). So a save that changed nothing a person did,
such as the first one after opening, moves the copy's clock past a real move
made elsewhere earlier. The arriving copy then reads as "older", and "newer
wins" keeps the empty copy. The open path already warns against exactly this
(the comment beside `savedAt` in `ingest`: opening reseals and must not move the
clock forward), but the save path does it on every save.

**How often.** Rare: a rerun passed 6 of 6. It depends on whether an open-time
save lands before the link does. It is pre-existing and unrelated to the
15 September changes, which touched only replicated documents and tests. It is
a silent loss on the path for documents without replicated tables (the
`savedAt` rule), which is the path `returning-document` exists to hold.

**Ruled, 15 September: record "arrived" and "written" separately, and refuse
what cannot be ordered.**

**Why not "stamp only when the data really changed".** It sounds narrower and
cheaper, but it cannot be made right. "The person's data changed" is a judgement
about content, a reseal is genuinely a write, and the code would end up keeping
a definition of "real change" that drifts. Two facts, when this copy last took in
another copy and when it last wrote, should never have been one field.

**What separating them buys, stated plainly, because it is less than it looks.**
The underlying problem is that `savedAt` is a wall clock used as a causality
signal. Bob's copy and Alice's move never saw each other. They are concurrent,
and no timestamp can order them correctly, because there is no correct order.
Separating the fields does not fix that. It only stops a copy that saw nothing
from outranking a copy that saw a move, which is the specific wrong seen here.

**So the fix that matters is the refusal, not the ordering.** When two copies
are genuinely concurrent, and neither has seen the other, the opener must not
silently pick one. It says so: "these two copies diverged", with what each
holds, so the person can act. It is the same shape as the second-invite mount
guard: the harm was never that the wrong copy won, it was that nothing said
anything. A person told the copies diverged can act; a person shown an empty
board cannot.

**The boundary.** Documents with replicated tables already solve this properly,
by merging. D36 is the non-replicated path, where merge is not available and the
honest answer is refuse-and-explain. Do not try to make timestamps correct: they
cannot be, and a cleverer clock only moves where the silent pick happens.

**The test forces the losing order; it does not wait for it.** Seen once in
seven runs, a bug that cannot be provoked on demand costs a day to find again.
The test drives an open-time save on the recipient between the share and the
link, deterministically, and asserts the refusal: never an empty board, never a
silent pick. It also asserts the ordinary case still works, a link that really
is newer arriving at a copy that saw nothing since, and the old case still
holds, an older link not rolling a copy back.

### D35 — The same document held on two installs is correct but illegible

Two invites to the same game can end up on two home-screen icons: two storage
containers, two databases, reconciled only through the relay. The mailbox makes
the result right, but nothing tells the person which icon is which, or that they
are the same game. It is the same family as the tab-versus-installed-app note
already on the roadmap.

**Trigger:** somebody other than the developer holds one document on two icons.
Until then it is recorded, not built.

### D34 — Badge the home-screen icon on an incoming move

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

So the blocker is gone and the decision is made; what is left is the two lines
in the push handler, the `window.dai` surface for the app to report its count,
and the five tests above — including the guard-both-ways one, which is what
ruled out counting moved mailboxes.

### D33 — Other host-to-frame messages can still arrive before the bridge listens

Found fixing the second-invite bug (15 September). The shell forwarded the
host's merge request straight into the application's frame, and on WebKit that
frame sometimes had no listener yet. The message was dropped, the host waited
out its thirty seconds, and a person was left on their old copy. It was 2 runs
in 6. The merge is now held until the bridge announces itself (`dai:insets?`),
exactly as the write rules already were.

The same shape applies, in principle, to every other message the shell
forwards from host to frame on arrival: the mailbox's authored-since and apply
requests, and the replica-id and sessions questions. Those are re-sent by the
mailbox loop on its next poll, so a drop costs a delay, not a game. That is why
they were left alone in that fix. But "a later poll will cover it" is an
argument, not a test.

**Exit:** either hold every host-to-frame message behind the same announcement,
in one place in the shell, so no message type can be added that skips it; or
show, with a forced early message per type, that a drop is recovered. The
general rule is in the 9 September trap: gate on the receiver announcing
itself, and never rely on arrival order.

**Built, 15 September: the hold is the default.** Every message the shell sends
into the application's frame, and what a drop before the bridge listens cost:

| Message | Sent | If dropped before the bridge listens |
|---|---|---|
| `dai:write-rules` | at mount | the first write refused on a phone (already held, since 9 Sep) |
| `dai:merge` | at the handshake, cold launch | the merge timed out after 30 s and the old copy stayed on screen (held earlier today) |
| `dai:flush` | at share time | the host gave up after 2.5 s and **shared the last autosave, silently stale** |
| `dai:authored-since` | mailbox start | the host's ask timed out and the next poll re-asked: a delay |
| `dai:sessions` | mailbox start | "keep the lanes and ask again next time": a delay |
| `dai:apply-batch` | a pulled batch | no `DAI_HOST_APPLIED`, so the cursor held and the batch was re-pulled: a delay |
| `dai:replica-id` | a diagnostic ask | the host read null |
| `dai:insets` | at the handshake and on resize | the bridge asks for them itself, so they were recovered |
| App Mode state | at install | the frame missed the initial state (false): harmless |
| the payload | in answer to `dai:frame-hello` | **not held, by design**: it is what brings the bridge up |

**The position: hold by default, not a list.** A list of held types relies on
someone remembering the next type, which is how the rules and then the merge
each raced before being fixed alone. So every send goes through one function,
`toFrame`. It posts at once if the bridge has announced itself (`dai:insets?`),
otherwise queues, and the announcement releases the queue in order. The write
rules keep their single slot, where the latest wins, released by the same
announcement. The payload is the one named exception, because holding it behind
the bridge would wait forever.

**Considered and rejected: an explicit list of held types.** It looks cheaper,
because most types recover on the next poll and only a few seem to need the
hold. But the list is what failed here. The queue before this fix covered two
of nine types, `dai:write-rules` and `dai:merge`, each added after its own race
was found. Meanwhile `dai:flush` shared a stale autosave with no signal to
anyone, the same class of harm as the second-invite bug. A list is right only
until the next type is added, and the omission is silent. Do not narrow the
hold back to a list to save a queue push. The source scan exists so this stays
true.

**Proven** (`tests/frame-hold.spec.ts`, chromium, Firefox and WebKit):
- A question posted before the bridge exists, from the host's handshake handler,
  is answered.
- The same question after the app is up is answered in well under a second, so
  the hold releases and does not delay.
- A source scan fails if a second direct send into the frame appears.

### D37 — Two people who both invite cannot reach each other, and nothing says so

Reported from a phone, 15 September: two people invited each other, twice each,
and the app behaved as though they were in two different games. Both boards
looked healthy. Neither person could tell which game they were in.

**What was measured, against production, not read from the code:**

- The ordinary order works. A invites, B opens it in a browser that already
  holds the app: B is asked to name themselves, A sees B join in 2 s, moves
  cross both ways in about 4 s, and B inviting A back works too.
- **Both inviting first splits them.** Each device minted its own key for the
  same document (`SATY…` and `V6Q…` in the run). Every mailbox address is
  derived from that key, so each published moves to an address the other never
  read.
- **Opening an invite stranded the opener's own game.** An arriving key replaced
  the document key whatever game it was for, so games already running moved to
  addresses derived from the new key while their partners kept reading the old.
- Nothing reported any of it. No refusal, no console line, nothing on screen.

**The cause, in one sentence: one stored value carried two facts.** A key meant
"this document" and "this game" at once, so a key minted for one game re-keyed
every other game the copy held. That is the same shape as D36, where `savedAt`
means both "when this was written" and "what it had seen" — and the same
symptom both times: **silent divergence.** Worth stating as a pattern, because
it is now twice in one week: *when one stored value carries two meanings, the
failure is silent and what a person sees is two copies that disagree.*

**The ruling (Chris, 15 September): a key belongs to the game.** Option B of
`decision-where-does-a-key-live`. Rejected: keeping one key per document and
merely refusing to overwrite it — that fixes the stranding and leaves the
mutual-invite case broken, which ships a fix while two people still stare at
healthy boards that cannot reach each other.

**Built:** a key per game (session hex → base64url) in the library entry,
minted by whoever invites into that game, carried in the invite's fragment
beside the hash (`s=<session>`), filed by the receiver against that game alone,
and used to derive that game's mailbox address and seal. A game with no key of
its own falls back to the document key, which is every game made before this. A
lane is re-keyed when *its own* key changes and not when some other key for the
same document does.

**The test forces all four orders on purpose** — A invites first; B invites
first; both invite before either opens; each opens the other's. Deterministic,
no waiting on a race. The finding here is not only the bug: *nothing in the
suite ever had two people act at all*, which is why two people acting in the
wrong order was reachable at all. All thirteen tests in
`tests/mailbox-link-e2e.spec.ts` pass on chromium; CI across three engines is
the authority and has not run yet.

**What it cost to get there, because the shape is worth keeping.** Five product
changes, three of which were corrections of regressions introduced by the two
before them, and every step forward came from a throwaway probe rather than from
reading the code:

- **The key was filed too late.** A copy that already holds the app takes the
  merge path, which runs through `launchFromLibrary` — and `eject` clears the
  arriving key. So the key was gone before anything wrote it down. It is filed
  now at the moment the document it belongs to is identified.
- **Two library writes rebuilt the record from a pre-merge snapshot** and wrote
  the new field back out of existence — the keep-step save and the
  standing-consent save. Both re-read now. This is a real defect of its own,
  the same shape the note in that code already described for standing consent
  and issued shares; it simply did not cover a field that did not exist yet.
- **Per-game keys stopped a document key ever being minted**, and
  `startMailboxIfPossible` gives up when there is none — so a copy that had
  invited somebody ran *no mailbox at all*: no lanes, no polling, nothing
  published or pulled, while both copies held matching game keys they never
  used. Then the mirror of it on the receiving side: a copy that only ever
  *receives* invites never minted one either. Both sides ensure one now.
- **Three of my own readings were wrong** — that the inviter was not filing its
  key (the expected and received arrays were the other way round), that no
  lanes existed (the probe could not open the database and returned an empty
  list for it), and that no session existed (the probe was pointed at a dead
  relay). Each was caught only because the next probe was made to report its own
  failures instead of returning something that looked like data.

**The rule this leaves behind: a probe must not be able to say "nothing" when it
means "I could not look."** Every wrong turn tonight had that shape.
- **The migration, decided rather than discovered (15 September): old games
  break and are restarted.** No legacy-address fallback. There were two users
  and their games were already split across mailboxes neither could read, so
  there was nothing working to carry over — and a fallback path is code that
  lives for ever to serve a week of history. The two of them start a new game on
  the new build.

  Two things this is *not*. It is not succession: `planSuccession` refuses
  adoption unless the arriving copy is signed by the key this device pinned for
  the document it replaces, and chess is unsigned, so `--upgrade-of` would only
  produce a card reading "this copy is not signed". And it is not solved by
  pinning the same `documentUuid` either: a sibling merge carries data, never
  code, so the copy already on the phone would keep its old application and
  never show the new screen. A changed application is a new document until
  chess is signed, which is its own decision.

  **The document-key fallback stays, and is not migration debt.** A share of the
  whole document from the opener's menu carries no game and is keyed by the
  document; only an invite into a game carries a game's own key. The fallback is
  that live path, not a bridge for old data.

### D38 — A rematch has to be sent as a link, which is absurd between two people already playing

Two people playing each other share a private channel already: the game's
mailbox, sealed under a key only they hold. A rematch could mint a new game and
deliver its key **in-band** through that channel, so playing again needs no link
at all — and "play somebody else" stays the same operation with the key
delivered by link instead. One mechanism, two deliveries.

**Deliberately not built (Chris, 15 September), for two reasons:**

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

## The shape that keeps recurring — one thing carrying two identities

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

### D41 — A library write outside the save lock can rewind the save counter

Found reading the trace of the one CI failure on `907eea6` (chromium,
`push-e2e:212`). Firefox and both WebKit shards were green.

**What was measured, from the kept trace:**
- The lane breadcrumbs print **one stable address** on both copies, in the
  original run and the retry: `lane for game d5744081 of cb634325 ->
  12f3e6acf5f0, from that game's own key`. Per-game keying (D37) derived one
  address and never moved it, so it is not the cause.
- Three `/subscribe` and two `/unsubscribe` on that address. Both unsubscribes
  came from the inviting copy's reopened page. **The invited copy never released
  its subscription** — the 1 the assertion found where it wanted 0.
- The invited copy refused **37 consecutive saves**, from save 2 to save 38,
  every one "This document was saved from another tab since it was opened here",
  beginning the instant its lanes were built and never recovering.
- Two of the four extracted network files were byte-identical; an ordering read
  taken before deduplicating them suggested a re-subscribe that does not exist.

**The chain, and the inferred part is named as inferred.** A refused save means
`persist` does not confirm; `pullLane` then returns at its persist check, which
sits *above* `retireIfDone`; the lane never retires, `onLaneClosed` never fires,
and the push subscription stands. That much is code, not conjecture. **What
caused the refusals is inferred and has not been reproduced**: the save path
holds a per-document lock across its read-modify-write and moves `revision` on,
while every other library write read the record and wrote it back *outside* that
lock. A read straddling a save's commit writes `revision` back to its earlier
value; the saving tab has already advanced its own `knownRevision`, so from then
on its every save reads as another tab's work and is refused, with no recovery
short of a reopen. The inviting copy never shows it because it reopens, and each
reopen re-runs `learnRevision`.

**Fixed:** one `withLibraryLock(documentUuid, …)` helper, and every writer that
carries `revision` takes it and reads the record inside it — the library-open
path, the ingest keep-step, the key writers, and the save path, which had its own
one-line alias for the same lock. **One lock, one spelling**: two names for one
lock is what let a source-shape guard report the save path as unlocked.

**Guarded:** `library-record.spec` now fails if a write carrying `revision` sits
outside a lock. It is a source-shape test because the symptom needs contention to
appear, and the two existing tests in that file are the same shape.

**Not proven:** the race. Reproducing it needs a save committing inside another
writer's read-write window, which did not occur in three local runs or in a
repeat-each run. The guard is what makes the inference safe to live with.

### D40 — A tier that reports success by running nothing

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

### D39 — A copy's replica id changes during the open of an invite

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

### D32 — On Firefox, a test loses the opener's frame when it is pointed at the document

**What happens.** The opener mounts a document by pointing its `#cartridge` frame at a fresh `blob:` URL (`apps/runner/src/main.ts`, `mount`). An eject first resets that frame to `about:blank`. Sometimes, on Firefox under load, Playwright never registers that navigation. For the rest of the test it holds the frame as `about:blank`, so a locator that enters `#cartridge`, then `#dai-app`, then the app finds nothing and times out. The document is fine throughout.

**Three sightings, one signature:**

| Where | Test | What it shows |
|---|---|---|
| CI, run 34907553189 (14 Sep) | `returning-document:164` | After an `#a=` reopen, every snapshot shows the child frame as `about:blank` until the 90 s timeout. The console says the opener resumed its own copy. |
| CI, run 34920744354 (15 Sep) | `mailbox-link-e2e`, forwarded invite (then line 542) | Device B's child frame is `about:blank` for the whole 60 s wait. B's *frame-side* breadcrumbs show the app ran: it adopted its replica and wrote saves 1 and 2. |
| Local, 15 Sep | `returning-document:164` under load (1 in 6) | Same as the first row, and the trace's screenshots show the app on screen 0.7 s into the wait and still there at the timeout. |
| Local, 15 Sep | `mailbox-link-e2e`, forwarded invite, under load (1 in 6; the run took 15.8 min) | Same as the second row, down to the frame-side breadcrumbs: replica adopted and saves 1 and 2 written within 1.5 s of Open. Screenshots show the chess board, with its "Your move" banner, on screen 2 s into the wait and still there at the failure. |

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

### D31 — A document the opener has verified is verified again when it mounts

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

### D30 — Locally, a runtime change reaches the opener's tests one run late

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

### D29 — An offline reopen sometimes fetches the document's icon from the network

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

### D28 — A test's browser is sometimes already closed when it starts

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

### D27 — CI discarded the trace of every test that failed and passed on retry (fixed)

The workflow uploaded the report and traces only when a job failed, and a job
whose failures all pass on retry is a passed job. So every flake's evidence went
with it. The run for `41528e1` needed four retries and left nothing to examine:
a timeout in `returning-document`, a spec changed that morning, could neither be
cleared nor blamed, and the third sighting of D28 had no more to go on than the
first two.

`trace: "retain-on-failure"` already kept the failed attempt's trace, including
one that then passed; it was just never uploaded. `5d71345` adds an upload on a
passed job, of only what a failed attempt leaves — each `trace.zip` and
`error-context.md` — so a clean run uploads nothing.

Fixed first, before D28 and D29, because it is what makes them solvable: a flake
whose evidence is thrown away is investigated again and again and never solved.

### D26 — Webkit has no count floor in CI

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

### D25 — `website/public/demo.dai.html`: tracked, written by nothing, read by nothing

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

### D24 — Five isolation tests skipped in CI on every push, and only arithmetic noticed

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

### D23 — The inline dictionary is frozen, and the corpus it was built from has moved

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

### D22 — The runtime's own save zips without the fixed timestamp

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

### D21 — A new confusable table leaves untouched publisher pins on the old one

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

### D20 — A table constraint in a shared table rewrites to SQL that will not load

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

### D19 — The published specification says a reader must refuse version 4

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

### D18 — Nothing can tell a hole in a mailbox history from an empty stretch

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

### D17 — Mailbox batches are deleted at 90 days: silent data loss on a fuse

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
their age but no longer match a rule. **Chris applies it** — it is production
bucket configuration:

    cd apps/relay
    npx wrangler r2 bucket lifecycle set dai-store --file ../../infra/r2-lifecycle.json
    npx wrangler r2 bucket lifecycle list dai-store

— and the list should show sixteen `shared-documents-90-days-<digit>` rules and
no rule with an empty prefix.

**What stays open: retention must be decided deliberately.** Keeping every batch
for ever is safe while the question is open and is not an answer. The decision
is how long a mailbox keeps its history, and what a copy that arrives after that
is told — which needs D18's relay that can say "these numbers are gone".
Retention was deferred by the ruling; this rule decided it by accident, and the
scoped rule un-decides it.

**Un-parks before 8 December if the scoped rule is not applied — and otherwise
before any game is expected to outlive a retention limit, or a device can join a
long-running game from the mailbox rather than by an invite.**

### D16 — A native iOS host: App Clip and Messages extension

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

**Un-parks after the enterprise demo, or when onboarding friction is what blocks
a pilot.**

### D15 — Asymmetric roles inside a session

An advisor writes and a client answers, and neither can write the other's rows.
Today a roster member can write any table in the session, so an app can only
fake a role in its interface — which the rules themselves forbid (an app must not
enforce what only the roster can). The enterprise demo's "firm and client" beat
depends on the real thing: a client's copy that cannot author a firm's advice
row, refused at the merge rather than hidden by the screen.

Why it matters: without it, a two-party document is two peers, and any document
whose value is *who said it* — advice, an instruction, a signed-off figure —
carries only the app's word for it.

The cheaper alternative, recorded so it is weighed rather than forgotten: a
firm's server in the path that admits rows by role. It needs no format change and
holds exactly where that server is in the path — a copy exchanged directly, or a
mailbox the server does not front, bypasses it. That is a deployment choice, not
a property of the document.

A hub with many private spokes (one firm, many clients, each unable to see the
others) may fold into this entry rather than being its own shape; see *Not
doing*.

**Un-parks when the dynamic statement needs enforced roles.**

### D14 — Two blind runs is not a rate

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

### D13 — The in-browser compiler skips the build-time schema check

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

### D12 — A relay deploy has a window where a post lands in old code

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
36-byte object nothing reads. Deleting it is Chris's (`npx wrangler r2 object
delete dai-store/mailbox/subscribe/1`), and nothing depends on it.

Why it matters: the window is short, but it is exactly when somebody verifies a
deploy, and a relay write is somebody's mailbox.

**Un-parks as a code change if a deploy ever needs a new route used by clients
the moment it ships** — then the worker must refuse a route its objects do not
yet know, or the object must reject a path segment that is a verb.

### D11 — A large document crashes Safari on iPhone

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
  that matter, which is a hypothesis for the next phone sitting, not a result.

**Before the next fix, two cheap checks on the 5 MB number** (ruled 15 Sep):
- Force a GC before sampling (`HeapProfiler.collectGarbage` over CDP). If
  the rise is collection timing, it vanishes.
- Check whether the new path allocates in proportion to the payload rather
  than a constant. Suspects to run, not assume: the pre-sizing count pass in
  `fromBase64`, and the shell's `clean` copy when the payload has line breaks.

If the rise does not vanish, it says something about the new path.

**The measurement that decides the rest: the phone.** Desktop cuts do not say
whether the iPhone's ~34 MB ceiling moved, and that is the ceiling that stops a
person. At the next phone sitting, open one document at one size through the
opener on the spare phone, before and after, and read the heap. That is not
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

**Un-parks now, as a measurement** — it is the next thing on the phone after the
Wednesday sitting, and the ladder above needs nothing built first. The fix
un-parks from what the profile names.

### D10 — Session documents built before per-session mailboxes stay readable by any link holder

D8 gives each game its own mailbox only for documents built with a runtime
that can scope a batch to one session (it says so in its handshake,
`sessionLanes`). A document carries its runtime inside the signed file, so a
session document built earlier can never do that: it keeps the single
per-document mailbox, sealed under a key derived from the document root. Anyone
holding any link to it can read every game in it — history and future moves —
and its batches name every game's id, from which the per-session keys and
addresses of those games follow too. The relay has no delete, and a delete would
not unread what was already read.

**Decided:** such a document cannot be repaired in place. The remedy is to
re-create it and play in a copy built with the current version; the opener tells
anyone who opens one ("Every game in this copy shares one mailbox…"). Nothing is
changed about how those documents sync: they already use that mailbox, and
cutting it off would break live games without unexposing anything.

### D9 — A tested building block with no caller is not done

Three times in one pass: `filterToSession` and `exportSession` (the invite
filter, D4) and `deriveSessionMailbox` (the per-session mailbox, D8). Each was
correct, reviewed and tested, and shipped without anything on the real path
calling it — and each gap was invisible for the same reason: the tests exercised
the block, not the path a person takes. One layer down, the same thing again:
the filter's tests built their own databases, so its first run against a
document an application had opened met `_dai_meta` and refused.

Two ways to stop the fourth, cheapest first:

1. **A slice is not done until "what calls this?" has an answer on the real
   path** — a host, an application, the compiler — and a carrier-first test goes
   through that caller. Written into the definition of done, not left to review.
2. **A check** that every export of `src/` has a caller outside its own file and
   its own tests, with an explicit allow-list for the package's public API
   (what `src/index.ts` re-exports). It would have flagged all three.

**Exit:** the definition of done says (1); the check in (2) runs in CI and fails
on an uncalled export that is not on the public list.

**Landed (15 September).** `CONTRIBUTING.md` holds the definition of done, with
(1) as its first line. `scripts/check-callers.mjs` is (2), run by `npm run
typecheck`: every exported function and class of `src/` needs a caller that is
not its own file and not a test, with the published API — every module
`package.json` exports, and every name `src/index.ts` re-exports — read from the
package rather than listed. A block its own module calls counts as on the path;
constants, types and error classes are left out. An allow-list entry must carry
its reason, and the check fails on an entry that is no longer needed.

The first run found **a fourth instance, and the only one with a live
consequence.** `checkTriggerCoverage` — the guard that holds each shared table's
immutability trigger against the columns SQLite reports, so a column the parser
misses is a refused build — was written and tested and never called. Wired into
the build, it refused tic-tac-toe at once: `marks.turn` and `marks.cell` were
missing from the trigger. The column parser kept comment text in each item, so a
comment written after a column's comma — tic-tac-toe's own style — began the next
item and hid that column. In every tic-tac-toe built before this, those two
columns of an append-only table could be edited in place. The parser is fixed and
the build now refuses any recurrence.

Dead code it found, removed: `rowsOf`, `batchReplicaHex`, `constraintsFor`.
`fsMailbox` is allowed, with its reason (the tests' file-backed relay).

**Verdicts, 15 September — nothing left pending.** The check first read only
`.ts`, `.js` and `.html`, and the website's Vue components and VitePress pages
import code too — so two of its seven "orphans" were live, and it has read
`.vue` and `.md` since. What each was, what was meant to call it, and what
happened:

- `exportSession` — the invite carrier. D4 wired the runner to `filterToSession`
  directly and left this orphaned, the bug this entry describes. **Wired:**
  reshaped around the form an invite leaves in (the opened document, its
  database, the session, an injected engine; resealed with `resealContainer`),
  and the runner's share sheet makes every invite through it, supplying only the
  wasm engine. Its test builds invites from the signed fixture: the invite
  verifies under the same publisher key, every application file is identical,
  only the chosen session remains.
- `rosterOf` — **no longer exported.** Membership is enforced by the
  `_dai_member` view; this is the rule's plain statement, kept beside it. Its
  tests now write seats and bindings the way the runtime does, in each party's
  own copy, merge the copies, and read the view — convergence tested as "merged
  in any order, the same members". One property had no SQL counterpart: more
  seats than `max_parties`. Nothing enforces it (D6).
- `fsMailbox` — **allowed**: the tests' file-backed relay and the reference
  adapter; its callers are tests by design.
- `verifyClaim` — the judge of a host's claimed isolation clauses against the
  isolation probe's results. Meant to be called wherever the probe runs; it is,
  by `host-profile.spec`, which mounts the probe in the real runner and holds the
  runner's own handshake claim against it. **Allowed**, with that reason.
- `handOffToOpener` — hands a freshly built document to an opener tab. **Live**:
  the website's `MakeYourOwn.vue` and `MakerWalkthrough.vue` call it, and the
  runner receives on `#handoff`. Not an orphan; the check could not see `.vue`.
- `appNameFrom` — names an app from a dropped file or folder. **Live**:
  `MakeYourOwn.vue` calls it. Same blind spot.
- `storePreview` — made the `/p/` card for a document carried in its link. Its
  caller went on 7 September, when every share moved to the store. **Deleted.**
  The edge still reads and serves `/p/` cards already sent, and its test now
  writes one the way they were written.
- `refreshed` — was to bring one publisher pin's lookalike data up to a new
  confusable table, "lazily, one pin at a time". No host called it, and it could
  not have done the job: every save already recomputes a pin's skeletons, and a
  pin never touched again is never found by the lookup that would refresh it.
  **Deleted**; the real gap is D21.

The list as it was, for the record:
`exportSession` (the invite path filters and reseals in the runner instead),
`rosterOf` (membership is enforced by SQL views; this is the rule's pure
statement, used only as a test oracle), `verifyClaim` (a host's claims against
the probe's results), `handOffToOpener` (a handoff into an opener tab no page
makes), `appNameFrom` (the in-browser compiler's naming helper), `storePreview`
(the `/p/` preview-only card, unused since every share moved to the store) and
`refreshed` (brings a publisher pin's lookalike data up to a new confusable
table — no host calls it, so a changed table leaves pins on the old one).

### D8 — The host runs one mailbox per document; the per-session mailbox is unused

T1-D30 decides a mailbox per session: its key and its relay address both
derived from the document's root key and the session id, so the document key
alone opens nothing and a relay cannot correlate a session across documents.
The derivation is built and tested — `deriveSessionMailbox` (`src/mailbox.ts`),
`tests/session-mailbox.spec.ts`, and `authoredBatchAbove` can already scope a
batch to one session. Nothing in the host calls it. `apps/runner/src/mailbox-session.ts`
addresses the relay by the document's uuid (`publishSealed(mailbox, documentUuid, …)`,
`mailbox.head(documentUuid)`) and derives its key from a fixed label
(`"dai:mailbox:v1"`, whose comment says it "becomes the session id when Track 3
lands"). So today every session in a document shares one mailbox, the relay sees
one stable address per document, and every copy holding the document key can
read every session's batches. The same shape as D4: both halves were needed and
one landed.

Found while scoping push delivery (Track 5 slice two), which attaches a push
subscription to a mailbox — so which mailbox is decided here, first.

**Exit:** a session document's host runs one mailbox per session, addressed and
keyed by `deriveSessionMailbox`, publishing only that session's rows; a plain
replicated document keeps its single mailbox; an end-to-end test shows two
sessions in one document using two relay addresses, neither of them the
document's uuid, and a copy that holds the document key but not a session's id
unable to read that session's batches.

### D7 — The walkthrough's example shows its forms before it has started

`examples/tasks` — the application the make-one walkthrough compiles — puts two
`<form>`s on screen (`index.html`, the new-project and compose forms) while
`app.js` is still waiting on its top-level `await dai.openDatabase()`. That is
the window NO-INPUT-LOST-WHILE-OPENING closes: whatever a person types there is
lost, by a replaced page or a reset form depending on the browser. Out of the
change that added the rule, which fixed the receipts and tic-tac-toe examples.

**Exit:** `examples/tasks` keeps its page hidden and inert until start-up has
finished, shows what went wrong if it fails, and the walkthrough still builds
and opens it.

### D6 — A session seats two people, whatever max_parties says

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

### D5 — A comment after a shared table's last column builds, then will not open

Run, not read (13 September): when the last column of a `-- dai:replicated`
table ends with a line comment, the rewrite emits invalid SQL. It trims the
body (`authorBody = body.replace(/[\s,]+$/, "")`, `src/replicated.ts`) and
appends `,\n` and its own columns directly after it, so the comma lands inside
the comment — `b TEXT NOT NULL -- note,`. The build does not execute the
rewritten schema, so it succeeds; the document then fails to open with SQLite's
unnamed `near "_r_replica": syntax error`. Found because two of the new shared
examples commented their last column, the style the chess fixture teaches.

Two changes:

1. **The rewrite puts the comma before a trailing line comment** (or on its own
   line). Every schema that works today has no such comment, so its rewritten
   text — and therefore every existing document's schema digest — is unchanged;
   only schemas that cannot open today change.
2. **The build executes the rewritten schema** in SQLite, so a rewrite that
   produces invalid SQL is refused at build with its reason rather than at open.

**Change 1 is done** (13 September): the comma goes on its own line when the
author's last line ends in a comment, and only then, so every schema that
opened before rewrites to the same text. The stopgap constraint
`SHARED-NO-TRAILING-COMMENT` and its lint check came out in the same change;
`tests/rules.spec.ts` now asserts such a table opens, in a session document too,
and that a schema without the comment rewrites byte for byte as before.

**Change 2 is done** (13 September): `compileDirectory` loads the rewritten
schema of any document with shared tables into `node:sqlite`, twice (as every
open does), and refuses the build with SQLite's reason when it does not load
(`tests/build-loads-schema.spec.ts`). That covers the command line, the MCP
server and every test. **One door is not covered:** the website's in-browser
compiler (`compileInBrowser`) has no engine at build time, so a rewrite defect
there would still fail at open. On a Node older than 22.5 the check is skipped
with a warning rather than failing the build.

---

## Phase 0 — Make "open from a stranger" true

### 0.2 The host owns the runtime

Both hosts mount the container's *sealed shell* — the bootloader the
publisher shipped — in a frame with `allow-same-origin` at the host's own
origin. That shell is verified only against its own sealed copy; a hostile
publisher's shell runs at `opendai.app`'s origin and can reach the library,
the pinned keys and OPFS. The launch card of Phase 1 promises "no filesystem,
data stays here", and that promise is false until this lands.

The opener and the desktop host supply the bootloader and the engine
themselves and mount only `app/*`, the manifest and the data. The sealed
shell is used on the `file://` double-click path only, where there is no host
to protect.

**Exit:** a container built with a custom `--template` runs in the opener
under the opener's bootloader; a hostile-shell probe container gets no access
to the host origin, OPFS, IndexedDB or Tauri IPC, and a test asserts each.

---

## Phase 1 — The launch surface

### 1.2 One card for every carrier and both hosts

Link, file, share attachment and assistant hand-off all land on the same
screen.

The card exists (1.1) and the link and share paths land on it. What is left
is the rest of the carriers — the file picker, `launchQueue`, and the two the
links in Phase 2 add — and holding the screen identical across all of them.

**Decided 5 September:** the card is keyed on familiarity, not carrier.

- First sighting of a document (UUID and pinned publisher key not in the
  library): launch card, however it arrived — link, share, `launchQueue`, or a
  file the person picked themselves.
- Document already in the library under the same publisher key: no card. It
  opens directly. That is what "third time behaves like an app" (1.3) means.
- Same UUID with a different key, a verification failure, a schema refusal, or
  a superseding document (4.1): the card returns, showing what changed. Those
  are trust-state changes and deserve the screen.

Done in `7fec986`. One rule in one place: a document is familiar when its key
was seen before *and* it is in this device's library; anything else gets the
card, however it arrived — file picker, link, share and the website's handoff
included. The mismatch case still refuses outright rather than returning on
the card; that becomes the Conflict state in 4.3. `/d/<id>` joins when 2.3
exists.

**Exit:** snapshot tests show an identical card from `?open=`, `#a=`,
`/d/<id>`, the file picker and `launchQueue` on first sighting; a second open
of a library document from any carrier renders no card.

### 1.4 One sentence everywhere

"Send an app like you send a document." On the card, the unfurl, `/open` and
the share text the opener already emits.

Done in `0f9f72d`. Written once, in `apps/runner/src/main.ts`, and carried to
the card, the share message and `/open`. The three words that are ours rather
than the reader's — "runtime", "PWA", "opener" — are gone from `/open`, and a
test holds them out. The unfurl does not exist yet and inherits the line when
3.3 lands.

**Exit:** a site test greps the card and unfurl for the line and for the
absence of "runtime", "PWA" and "opener".

### 1.5 Look inside — closed

The card says what a document claims about itself and what this host will not
let any document do. Neither is what is actually in the archive, and somebody
who wanted to know that had exactly one option: believe the card.

"Look inside first" opens the playground and posts it the same bytes — tab to
tab, no upload, no server, nothing on the network, the same handshake a freshly
built document takes to the opener, in the other direction. The playground
unpacks the archive, recomputes every digest and checks the signature itself,
and never mounts anything, which is why it stayed a separate page.

The receiving side takes documents only from origins it is willing to, for the
same reason the opener does: not because handed-over bytes are dangerous —
nothing there runs them — but because otherwise any page could open it and put
a container in front of somebody who believes they arrived themselves.

**Exit met:** `tests/look-inside.spec.ts` — the card's control opens the
playground, the playground reads the same document, mounts nothing, and the
card in the first tab is still waiting, because looking inside decided nothing.

---

## Phase 2 — Carriers: link and file are one object

### 2.1 The thin profile

The format half is done in `ba5a8e1`: spec §6.2 is a format rather than an
intention, the compiler emits it (`--thin`), `thinned` and `refatten` are
inverses over a signed build, a reader takes a supplier keyed on digest, and a
host that cannot supply refuses with `RUNTIME_UNAVAILABLE` rather than calling
it damage. "One build, two forms" means derived, not rebuilt: ECDSA draws a
fresh nonce, so nothing signed twice is the same file.

The opener half is done in `1b31ea1`: the engine is staged onto the opener's
own origin, offered by digest the first time a document arrives without one,
and put back when somebody saves a copy — so a copy leaves complete, on a
machine that has never seen the site.

**Exit:** a thin container opened in the opener runs, and the copy it exports
is byte-identical to the complete build. Both asserted in
`tests/opener-thin.spec.ts`, the first by reading a row back out of SQLite
rather than by watching a page paint.

### 2.2 The inline link

`https://<opener>/#a=<base64url thin container>`, capped near 32 KB; the
sender falls back to a reference link above it.

Done in `8b66364`. `src/link.ts` is the carrier — gzip through the browser's
own compression streams, base64url over the core's base64 — and the opener
opens one before it reads anything else in the address, including when a link
is pasted into a tab it is already open in.

**Exit:** a chore-chart-sized app opens from the link with the network
disabled, once the opener is cached. It does, thin, with the engine served
from the opener's own cache.

**Open, and yours:** the cap does not fit a real app. A thin chore chart is
86 kB and 64 kB compressed into a link — twice the 32 KB the sender stops at,
and the same is true of all three examples we ship. So the receiving half is
built and there is no sender UI, because a link cut in transit arrives as a
document that will not open and nothing to say why. Three ways out, and the
choice is not the code's to make:

- Raise the cap. Browsers take far more; what truncates a long link is chat
  clients, mail wrapping, and QR codes. Somebody has to decide how much of
  that we are willing to lose.
- Elide the sealed shell as well as the engine. It is 48 kB of the 86 kB, and
  a host never runs it — but it is signed, so this is a format change and a
  spec change, not a setting.
- Build 2.3, and let anything too big become a reference link.

**Decided 5 September:** keep 32 KB. Do not raise it — Slack truncates at
40,000 characters, WhatsApp at 65,536, Safari near 80,000. Make apps fit by
taking the non-app bytes out of the carrier; the app is about 9 kB and the
link is 115 KB because it carries the runtime.

1. Elide the sealed shell without a signed-format change. The opener rebuilds
   the shell from (template version, bootloader version, UUID, appName,
   favicon), hashes it, checks it against the signed digest, then discards it
   and runs its own host-owned runtime. Exact-digest rule (§6.1), compatible
   with existing containers. The shell leaves the signed set at the next
   `manifestVersion` bump, not before.
2. Elide `app/dai-kit.js` the same way: listed by digest, bytes omitted; the
   opener substitutes from a table of kit versions keyed by digest. Unknown
   digest: refuse cleanly and fall back to the reference link.
3. Inline carrier payload is the COSE signed payload (CBOR) + signature (64 B)
   + compressed P-256 point (33 B) + the carried file bytes. The JSON manifest
   and `hashes` do not travel; carried entries' digests are recomputed, the
   manifest rebuilt, then verified. Only elided entries' digests travel (32 B
   each, binary).
4. Carried files concatenated in the bundle format and deflated as one stream.
   No zip framing.
5. DEFLATE with a preset dictionary (RFC 1950 FDICT): about 32 kB built from
   the kit source, the recipe's canonical app and common CSS/SQL, versioned by
   digest, shipped in the opener. Carrier header:
   `#a=<1-byte carrier version><4-byte dictionary id><base64url>`. Unknown
   dictionary id: refuse cleanly, never garble.
6. Then measure the chore chart. Expected 3–4 KB as a link. Above 32 KB the
   sender falls back to the reference link. Per-channel caps in the sender
   when the channel is known (QR ~2.5 KB, Slack 35 KB, WhatsApp 60 KB).

Done in `6c23954`, with two departures from the list above, both said here.
The carried files travel inside the CBOR map as byte strings rather than in
the text bundle format, because a database is not text; the effect — one
DEFLATE stream, no zip framing — is the same. And the shell is elided under the
exact-digest rule with no format change at all: the sender rebuilds it from its
own template and bootloader and elides only when the digest matches, so a link
is never made that the same software could not open, and the signed set is
untouched. Measured: chore chart 2.8 kB signed, packing list and meal plan
1.5 kB, all three unpacking to the byte-identical build. Per-channel caps are
not built; the 32 KB cap stands and the opener has Copy a link.

### 2.3 The reference link, and a dumb store

`https://<opener>/d/<id>#h=<sha256>&k=<key>` — content-addressed, encrypted
end to end, the key in the fragment; an any-host variant `#h=&u=&k=`; a store
interface of `put`, `get`, `head` and nothing more, so the relay is a
commodity and an enterprise hosts its own in an afternoon. Subsumes the
earlier "one tool contract, two transports": the store is this store.

**Decided 5 September:** store-agnostic interface first, R2 as the first host
through its S3-compatible API. No Worker, no proprietary client SDK.

1. A `Store` interface in dai-core with exactly three calls:
   `put(hash, ciphertext, sidecar) -> href`, `get(href) -> bytes`,
   `head(href) -> { exists, size }`. Content-addressed by SHA-256 of the
   ciphertext. Ciphertext only; the key never leaves the URL fragment.
2. Two adapters: a filesystem adapter (local MCP and tests, no account) and a
   generic S3-compatible adapter, pointed at a Cloudflare R2 bucket for
   production. That adapter is also the enterprise self-host reference —
   MinIO, S3, B2 and GCS all speak it.
3. Browser uploads use presigned PUT URLs from the S3 adapter. No serverless
   body-size limit.
4. The opener knows nothing about the store: it fetches a CORS-readable URL,
   verifies the hash, then decrypts. The bucket serves
   `Access-Control-Allow-Origin: *`, `Cache-Control: immutable` and the
   correct `Content-Type`; the conformance suite asserts those production
   headers as it already does the opener's.
5. The sidecar (size, clear flag, and a preview only with consent) is a
   separate object under the same hash. `put()` checks the blob hashes to its
   name and matches the declared size — a DAI relay, not a general file host.
   Size cap 5 MB, TTL on unopened blobs. (It once carried the manifest too;
   the review of 6 September found that at a public URL and it was dropped.)
6. The unfurl route (`/d/<id>` → OG name and icon from the sidecar, never the
   blob) lives on Vercel beside the opener; it is off the runtime path.

A Vercel Blob adapter, if ever wanted, is a third adapter behind the same
interface and never the reference one. `@vercel/blob` is not imported in
dai-core.

Done in `bca1061`, to the extent it can be without a bucket. `src/store.ts` is
the interface, the sealing (AES-256-GCM, thin form, fresh key per seal), the
link grammar and `admit()` — the one place a store decides what it will hold.
`store-fs.ts` and `store-s3.ts` are the two adapters; the S3 one signs SigV4
itself and has `presignPut` for a browser. The opener opens both link forms and
checks the hash before it imports the key. `dai publish` is the sender. Spec
§1.1 has the grammar.

The bucket exists: `dai-store` on R2, public reads at `store.opendai.app`,
CORS from `infra/r2-cors.json`, and `check-store.mjs` says ready. `STORE_BASE`
points at it, so `/d/<id>` links resolve — by a redirect to `/?d=<id>`, which keeps the opener's relative assets and single worker scope; the fragment survives a redirect, so the key still never leaves the browser. Still open: S3 API
credentials for the bucket so `dai publish` and a presigning route can write
to it, and a lifecycle rule for unopened blobs. Uploads today go through
`wrangler r2 object put`.

**Exit:** the same link resolves from two different hosts; a tampered blob is
refused by hash before the signature is checked; the store's logs contain no
fragment.

### 2.4 Carriers in the specification

"Carrier" defined beside "form": file, reference link, inline link. The
fragment grammar frozen so any opener honours it. Carries the earlier item on
implementability: CDDL and frozen byte vectors for the signed payload, the
footer, the bridge envelope and the fragment; the Python reader finished to a
full verifier that opens all three carriers with no dai-core source reuse.

Half done in `5606a87`. Spec §1.1 defines carrier beside form — file, inline
link, reference link reserved — and freezes the inline fragment grammar:
base64url without padding over gzip, in the fragment and nowhere else. The
Python reader, which shares no code with ours, opens that carrier from the
specification alone and reaches the identical verdict on all 17 conformance
cases sent through a link, and refuses one cut in transit.

The reference link's grammar was frozen with 2.3, and `1a33b86` adds the rest:
`docs/cddl.md` is CDDL for every structure in the format that is not plain
JSON — the signed payload, the COSE envelope and its countersignature slot,
the inline carrier map, the sectioned header and footer, and the bridge
envelope — with `conformance/vectors.json` giving the bytes for each. Both
readers check the vectors, so two encoders have to agree on bytes rather than
on prose, and a change to an encoder that nobody meant is a diff rather than a
signature that stops verifying months later.

**Exit:** CDDL and vectors published; the Python reader opens all three
carriers and agrees with the reference on every conformance case.

### 2.5 The sender's last line is the link

MCP `create_dai_app` returns `{ file, link, qr }`; the assistant's last line
is the link.

Done in `8ce30f3`, without the QR. `src/sender.ts` is the one decision: inline
whenever the document fits, because that link depends on nothing; a store only
for what does not; and where neither is possible, a sentence about this
document rather than a link that will be cut in transit. Both doors end with
it — `dai build` (with `--no-link` and `--opener`) and `create_dai_app`, which
takes a store from `DAI_STORE_DIR` and `DAI_STORE_BASE`.

**The QR is a separate item, and smaller than it sounds.** A QR holds 2,953
bytes at the very limit of version 40, and an inline link for a real app is
2.8 kB — a code that large is 177 modules square and phones do not reliably
scan it. So a QR is for reference links, which are about 120 characters, and
is worth building only once a store is the ordinary path.

**Exit:** the MCP test sees an inline link for a small app and a reference
link when a store is configured.

### 2.6 Every share path carries the link to this document

The `handOff` share text points at the opener; it should point at *this*
document.

Done in `abc0a59`. The message a shared document travels in carries a link to
the document, and the file travels beside it for whoever would rather keep
one. Above the cap there is no link and the sentence falls back to the
address, which is what it always was. Copy a link and the share sheet now go
through the same `linkFor`, so this host, the command line and the MCP server
answer the same way — the opener holds no store credentials, so its answer is
inline or nothing.

**Exit:** exported share text contains a link that opens the exported bytes.
Asserted by decoding the fragment out of the shared message and comparing it
with the document that was opened.

---

## Phase 3 — The opener as the pre-installed viewer

### 3.1 Engine once, offline forever

Brotli, content-hashed URL, `immutable`, service-worker precache on first
visit; mount-before-engine kept.

Done across `1b31ea1` (the opener holds an engine, so it precaches one),
`8b66364` (two worker bugs that made offline not actually work) and
`fd2723f` (the proof).

**Exit:** the second open of any app makes zero network requests. Proven by
switching the network off rather than by counting fetches: a request served
from the worker's cache and a request that reached a server look alike from
outside, and a count would pass on a machine with a warm HTTP cache.

**Left as polish, not blocking:** brotli and a content-hashed `immutable` URL
for the engine. Both only touch the *first* visit now; the second needs no
network at all. A hashed name is what would make `immutable` safe on it, since
the bytes change when the dependency does.

### 3.2 A mirrorable static opener

No server logic on the runtime path. Largely true today; unproven.

Proven in `c9a6789`. The build is served by a server with no logic in it —
path to file, a content type, and none of the headers production sends — and
the isolation probe finds every claimed clause blocked there, with nothing
404ing. So none of the isolation is being done by a header, and a mirror is a
copy of the directory.

**Exit:** the opener's build output served from a plain static host passes
the full conformance and probe suites.

### 3.3 Unfurl without the blob — closed

Two halves, and the first is the one that matters.

**Static.** `/d/<id>` is the opener, served where the link points. One rewrite
to `/`, a `<base href="/">` so relative URLs still resolve, and the opener
reads the id from `location.pathname`. No forwarding page, no UA sniffing, no
function. A mirror on a plain static host serves the same build and the link
opens — tested, in `tests/static-opener.spec.ts`.

**Edge.** `apps/runner/middleware.ts` reads the sidecar — never the blob —
and fills a `<!--DAI_PREVIEW-->` placeholder with the name, publisher and icon
the sender consented to. Absent or expired: the generic tags stand, status
200, `no-store`. Present: `immutable`, because a content-addressed id names
bytes that cannot change. The key is in the fragment and a fragment is never
sent to a server, so there is nothing at the edge to leak.

**Consent, decided where intent is visible.** The sidecar is split so that
"off" is real — no preview object, nothing to serve. `dai publish` is off
unless `--unfurl`, because a script has no one to ask. MCP `create_dai_app`
takes `preview`, default on, and a server sets `DAI_PREVIEW_DEFAULT=off` to
invert that for an organisation. The interactive share sheet — on by default,
with the preview rendered beside the toggle — waits on the browser sender.

Worth knowing, and worth saying in the docs: iMessage and WhatsApp build
previews on the sender's device; Slack, Teams and Discord fetch server-side
and cache. "Off" therefore means off before the first send, not after.

**Exit met:** `tests/unfurl.spec.ts` — four crawler user agents get the tags,
no ciphertext, 200; a browser open of `/d/<id>#h=&k=` mounts with the fragment
intact; a plain static host serves it with no preview and no error; an id the
store never held is 200, generic, `no-store`.

**Verified on the deployed opener.** Vercel does bundle a middleware that
imports from outside its project root, so no workspace-package rearrangement
was needed. Checked the way the item said to check it — a crawler user agent
against a real `/d/<id>`:

    $ curl -A 'Slackbot-LinkExpanding 1.0' https://opendai.app/d/<64 hex>
    200, cache-control: no-store
    placeholder consumed, og:title injected

An id the store has never held comes back 200 with the generic tags and
`no-store`, which is the absent branch doing exactly what it should. The named
branch is covered by `tests/unfurl.spec.ts`; confirming it against the live R2
store needs a document published there, which needs the store credentials.

### 3.4 A stripped fragment degrades to a sentence

**Done.** `strippedReference()` tells a link that names a document and cannot
open one apart from a URL that was never a reference at all, and the opener
says which half is missing. The key travels after the `#` and never reaches a
server, so nothing here can recover it — the only honest sentence points at
the person who sent the link. Both halves are covered: a path or `?d=` with no
key, and a key with nothing to open. Tested at the unit level and in the
browser, in `tests/reference-link.spec.ts`.

**Exit met:** a link with the fragment removed renders the recovery message,
not the empty chooser.

**Decided, and built: the no-key variant is a store policy.** Off everywhere
by default and off on the public relay permanently; allowed on a store whose
operator turns it on. It is a real weakening and is not dressed up as anything
else — encrypted, a store *cannot* read a document; in the clear, it is
*trusted not to*, and so is every proxy, log and backup between.

Three things carry it:

- **The store decides, once.** `admit()` refuses a clear document unless the
  store was configured with `allowClear`. The choice belongs to whoever runs
  the store, not to whoever happens to be uploading.
- **The link says so.** Clear carriage is `c=1`, not an absent `k`. If absence
  meant plaintext, a link that lost its fragment would become a link claiming
  plaintext, and the opener would fetch it — turning §3.4's recoverable
  mistake into a network request and a wrong sentence. A link with neither is
  damaged, and still gets the sentence.
- **The card says so.** "Shared without encryption. The store this came from
  could read it, and so could anything that carried it. What it is has still
  been checked." Not styled as damage: the document is verified byte for byte
  and a perimeter store is a legitimate deployment. What is gone is
  confidentiality, and only that is what it says. An ordinary document says
  nothing, because a notice on every card is a notice nobody reads.

Four tests in `tests/reference-link.spec.ts` cover the refusal, the grammar,
the card, and the silence of the ordinary case.

### 3.5 iOS, solved by the link

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

### 3.6 Second-use integrations only — closed

`share_target`, `file_handlers` and the desktop file association exist and
stay. None of them is how anybody gets in. A person who was sent a document
and is told to install something before they can read it has been handed a
chore, and the whole claim of the format is that the thing you were sent
already works.

The rule is about ordering, and ordering is exactly what drifts — one helpful
sentence at a time, each reasonable on its own. So it is a test:
`tests/second-use.spec.ts` holds that the integrations are still offered, that
nothing on the first screen or on the card asks anybody to install anything,
and that on the page somebody lands on holding a file they cannot read, the
instruction that needs nothing comes before every offer to install something.

**Exit met.**

---

## Phase 4 — Propagation

### 4.1 Succession

`supersedes: <uuid>` in the signed set, valid only under the same publisher
key. A host adopts v1's data into v2 through the migration chain (closed, 10),
keeps v1 as backup, and refuses loudly if no chain reaches. Carries the
earlier evaluation item: the three added stages — first interaction survives,
data round-trips, regeneration is safe — and then the run at scale, which is a
decision about spend and is not made here.

Done in `c31a68b`, in the opener. `supersedes` is in the signed set, present
only when given, and the compiler fills it from `--upgrade-of` so a build that
declared what it upgrades also says so under the signature; `--supersedes`
names it by hand. The opener adopts the previous document's data by copy,
before mounting, only when the successor is signed by the key pinned for the
document it names; the previous document and its data are untouched. The
adopted data then meets the successor's schema gate like its own would, and —
new here — a refusal from the shell now reaches the screen: the opener never
displayed `DAI_HOST_REFUSED` before, so a schema refusal was a blank pane.
Spec §5.1 has the rules. The Python reader agrees on a signed case.

Three tests, one per outcome: data forward through a migration with the old
one kept; a different key refused on the card with nothing crossing over; no
chain reaching, refused loudly, nothing lost.

**Open:** the desktop, whose data lives in the file rather than a store the
host owns, has no adoption path yet; and the scripted evaluation stage — the
Playwright test is that stage today, and `scripts/evaluate.mjs` does not yet
build a v2 per prompt.

**Exit:** an evaluation stage builds v1, seeds it, builds v2 with
`supersedes`, opens v2 — data present or loud refusal, never silent loss.

### 4.2 "Modify this app"

An affordance on the card that hands the bundle back to an assistant with
`upgradeOf` set (closed, 10), so the improved version is a successor rather
than a stranger.

**Exit, both halves met.** MCP `create` with `upgradeOf` refuses a schema move
with no migration (`c1b04b8`), and its output now names what the build
replaces, in the words the host will act on: *"replaces &lt;uuid&gt; — a host
that has it brings its data across, under the same key, and keeps the old one
as it was."* The CLI says the same, shorter. This is not cosmetic: an
assistant reporting "made a new app" when it made a successor is the one
sentence that makes somebody expect their data to be gone. Tested in
`tests/mcp.spec.ts` — a successor says it, a first version does not.

**Decided, and built: the clipboard, plus a tool for the assistant that has
the file.** Two routes, because there are two situations and they need
different answers.

**From the document, for a person.** "Modify this app…" in the sheet puts the
sealed source on the clipboard in bundle form, with a sentence addressed to
the assistant above it — they are going to paste the whole thing into a
conversation, and the first reader is a model. The clipboard rather than a
file because the assistant is in another tab, and a paste is the one transport
every one of them accepts.

**From the file, for an assistant.** `get_dai_source` reads the application
back out of a container: the app's own files, never the host's engine, plus
the identity. `create_dai_app` now takes `supersedes` as well as `upgradeOf`,
so a rebuild works whether or not the original file is on that disk.

**The header is what makes it a successor.** A bundle carries `document:` and
`schema:`. Without them, an assistant asked to change an app it cannot read
describes one from scratch and produces a *different* document — new identity,
no succession, empty database — which looks right until somebody opens it and
last month's entries are gone. That is the failure this closes, and it is why
both routes say the uuid in words as well as in the header: a header nobody is
told about is a header nobody uses.

Tested end to end in `tests/mcp.spec.ts` (source out, bundle parsed, successor
built from it with no path to the original) and `tests/look-inside.spec.ts`
(the clipboard text parses and carries the identity).

### 4.3 A publisher who is somebody

Publisher display name and `publisherKeyId` in the signed view; TOFU pins the
publisher key across documents, not only the document UUID. This was on the
undecided list; the loop decides it.

**Decided 5 September:** pin the publisher *key* across documents (SPKI →
name, first seen, document count). `publisherName` travels in the signed set.
The card shows the name in one of three states — never a bare fingerprint,
never the word "verified":

- **Known:** key pinned, name matches. "Acme Finance · you've opened 3 of
  their apps." The only state with positive styling.
- **New:** key unknown and the name collides with no pinned name. "Acme
  Finance · first time you've seen this publisher." Neutral, with a Verify
  affordance showing a short safety number and QR to compare with the sender
  over another channel.
- **Conflict:** key unknown, but the name — NFKC, case-folded, whitespace and
  punctuation stripped, basic confusables mapped — matches a name pinned
  under a different key. "Claims to be Acme Finance, but the Acme Finance you
  know uses a different key. Treat as a stranger." Red, and no install offer
  on this open.

Same key with a changed name is Known with "renamed from X"; the pinned name
updates after the person proceeds.

Done in `6ae143b`. `publisherName` is in the signed set, present only when
given, so every container signed before names existed verifies unchanged —
and the Python reader agrees on two new conformance cases, one signed under a
name and one with the name edited afterwards. `src/publisher.ts` is the one
decision: the key is pinned across documents with the name it signs under and
the documents opened under it; names are folded (NFKC, case, punctuation,
lookalikes) before a collision is looked for. The opener shows the three
states on the card with the Verify affordance revealing a safety number; the
desktop says the same in its status line. A conflict gets no install offer on
that open. A fourth state, `anonymous` — signed, under no name, key never
seen — exists because the fixture and every pre-4.3 signed document are that.

**Not built:** the QR. The safety number is the same number both sides see
and is what a QR would carry; rendering one needs an encoder this project
does not have, and the number is readable over a call today.

**Exit:** three snapshot tests, one per state; the Conflict test uses a
confusable-character variant of a pinned name and must render red.

### 4.4 The wedge

One category where an app is useful enough to send to somebody else. Not
engineering.

**Exit:** ten seed apps in the category, each shared at least once outside
its maker in a pilot.

### 4.5 Attachments in the document — closed

A fifth kit element, and the rule it enforces:

    <dai-attach run="UPDATE entries SET photo = :file WHERE id = :id" data-id="1">
      Add a photo
    </dai-attach>
    <img data-blob="photo" alt="">

`:file` binds the picture; every other parameter comes from the row it was
drawn in, exactly as `data-run` does. The bytes go into a BLOB column, which
is to say into the document — not into a folder beside it and not to a server.
That is the whole claim: a photograph attached on one device is in the file
that arrives on the other.

**The budget is enforced, not advised.** A phone camera produces four
megabytes without being asked, and a document is a thing people mail. Every
attachment is scaled to fit 1280 pixels and re-encoded as JPEG before it goes
near the database; anything still over 512 kB after that is refused out loud
rather than quietly making a document nobody can send. A file that is not a
picture is refused in the element itself, in words, and the document is
unchanged.

Rendering goes through an object URL rather than a data URL — a data URL of a
photograph is a megabyte of string in the DOM — and the URL is revoked when
the row redraws, so a list that refreshes does not leak one per redraw.

**Exit met:** `tests/attachments.spec.ts` walks it — attach on device A,
export through the container's own save, open on a browser context that has
never seen the document, and the photograph decodes there.

---

## Phase 5 — Measurement

### 5.1 The north star, measured

Tap → first successful `data-run`, cold and warm, on a mid-range Android over
cellular. Targets: warm under 1 s, cold under 3 s, inline-link cold under
1.5 s.

**The walk is measured.** `npm run measure` opens every carrier — inline cold
and warm, reference cold and warm, and a file for comparison — with a fresh
browser profile for each cold open, and stops the clock when the application
inside the container says it is interactive rather than when this app has
handed it over. The numbers and what they already say are in
`docs/performance.md`; the short version is that the reference link beats the
inline one, and warm barely beats cold, so the wait is work and not transfer.

**Decided: no cloud devices in CI.** Renting a device farm is a recurring cost
for a number that changes a few times a year, and a rented mid-range Android
is a worse proxy for the thing being measured than one phone somebody actually
holds.

So the number is taken by hand, once per release, on one real mid-range
Android over cellular, and recorded in that release's notes. The procedure is
written out in `docs/performance.md` — device named, storage cleared between
cold runs, wi-fi off, five runs, median reported — because a measurement
nobody can repeat is an anecdote. `npm run measure` stays the fast local
signal that says whether a change moved anything before the phone is picked
up.

A release that misses the targets ships anyway, with the number in the notes.
A target that quietly blocks a release is a target somebody stops measuring.

### 5.2 Propagation without a beacon

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

## Small, undisputed, cheap

- Copy is US English, and some of it is not. The audience is American and so
  is the person whose product this is; British spelling in shipped strings
  reads as somebody else's writing. Three tiers, and only the first two are
  copy:

  1. **User-visible strings.** `apps/runner/src/card.ts` says "trusted by your
     organisation" on the launch card. Sweep for the rest.
  2. **Author-facing text.** `src/recipe.ts` is the published instruction sheet
     and says "background colour" and "colour blocks". It is read by whoever
     builds an app, so it is copy.
  3. **Not copy, and must not be swept.** `colour` is a field name in the
     host-to-app message `DAI_HOST_CANVAS`, and the CSS custom properties use
     the same spelling. Renaming those is a breaking protocol change wearing a
     spelling fix's clothes. Comments are not copy either; leave them or change
     them on their own time, but never in the same commit as strings.

  A blanket find-and-replace is exactly the wrong tool here. The counts say
  eighty-odd matches, and almost all of them are tier 3.


- The desktop window builds unsigned, because `compileInBrowser` no longer
  mints a key. It is the one host that *could* keep one — it has a filesystem
  and a config directory — so it should offer to, and to reuse the same key
  next time, which is what makes a publisher pinnable across documents. Until
  then `/desktop` says plainly that it does not.

- **Firefox loads the thin engine network-first.** A thin link carries no engine,
  so the opener supplies `runtime/sqlite3.wasm` and `.mjs` from its own cache.
  Chromium serves them cache-first; Firefox requests them from the network first
  and falls back to cache, so a thin document opened offline still runs but makes
  two failed engine requests on the way (found by the strict offline assertion in
  `tests/offline.ts`, which is why `inline-link` asserts only that it opens, while
  the full-document offline tests assert nothing reached the network). Minor —
  the app works offline on both — but it is a real difference on the primary
  carrier, so worth a look at how the engine is loaded on the thin path (WASM /
  module fetch versus a cache-first fetch the worker answers).

- Register the media type; serve `.dai` as it. Independent of everything.
- The desktop window shows the document's own icon, not the host's.
- The example apps: the packing list's date is editable or gone.
- Publish dai-core 0.2.0. Not made here.

---

## The engine week — all three engines green (closed 13 September)

This section recorded nine long-standing reds across chromium, firefox and
webkit. They are cleared: CI is green on all three engines (chromium, firefox,
and webkit sharded 1/2 + 2/2), with one firefox test occasionally flaky on retry
(see the flaky-cluster note above). What the week found and did, worst-mattering
first, so the reasoning stays with the record:

- **A false CI verdict, three times over.** The project had acted on CI readings
  that did not hold (a count gate, a cancellation, a "chromium green" that never
  was). Fixed the reading first: `scripts/ci-verdict.mjs` reports each browser
  job's own pass/fail tally and flags a no-verdict job, used every commit since.

- **The dominant cause was the service worker versus `page.route`.** A same-origin
  request the worker serves cache-first never reaches a page route, so a mock is
  bypassed non-deterministically — green on one machine, red on another. It had
  cost the project three separate times. Now a rule in `tests/README.md` and a
  lint (`scripts/check-routes.mjs`, run by `npm run typecheck`) that fails the
  build on a same-origin `page.route` without `serviceWorkers: "block"`.

- **The session slice's own e2e is verified on WebKit.** `mailbox-link-e2e` mocked
  the store with `context.route`, which the worker bypassed on WebKit (the "store
  refused this upload" 404). Restructured to a real local store server on its own
  origin (`window.__daiStore`, the scenery move `useRelay` already uses) — the six
  reds cleared, and the feature is now proven on the engine iPhone users run.

- **Offline done faithfully, gated where the driver cannot.** The offline tests
  cut the network with `setOffline` and assert (via `requestfailed`) nothing
  escaped the cache; WebKit cannot drive a navigation while offline
  (playwright#34450), so those four are skipped on WebKit by name, verified on
  Chromium and Firefox.

- **The rest were Playwright-engine limits, restructured or named.** sender reads
  the copied link by capturing the page's clipboard write (no Chromium-only
  permission); runner guards the OPFS read WebKit's context lacks; reference-head
  is Chromium-only (it tests a request the worker itself makes, which only
  Chromium's `context.route` intercepts); version-update skips WebKit (its
  no-store `version.json` fetch is not intercepted there).

- **One genuine cross-engine finding, filed not asserted away:** Firefox loads the
  thin-link engine network-first (see "Small, undisputed, cheap").

- **No product security bug.** Two tests looked like a forged-message bypass on
  Firefox/WebKit; instrumentation showed the guards hold on all three engines and
  the tests waited for the wrong signal (`loaded` before the handshake) — fixed as
  test-timing bugs, with the pre-handshake window named in `early-refusal`.

---

## Flaky on Firefox CI, watched — one of them guards the game-killer

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

**`mailbox-link-e2e`'s forwarded-invite test was treated that way, and it was
the test.** It retried once on Firefox in CI (14 Sep), the day a mailbox change
landed, so it was reproduced under load (three copies at once) before anything
else: 1 failure in 6, always the joiner's first move. Switching the new mailbox
change off did not help (3 in 12), so it was not that. The chess app replays the
last move on the frame after it starts and ignores a tap while the replay runs;
the test tapped as soon as the history showed the move and, under load, into the
replay. Its `play()` now taps the piece until the board shows it picked up.

## Not doing

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

## Decided, 5 September (the four that were undecided)

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

## Trusted Types

The control the `strict-dynamic` decision names. `require-trusted-types-for
'script'` in the shell's policy, with named policies for the two sinks the
runtime itself uses (the shell's `srcdoc`, the frame's `document.write`),
enabled by the compiler for kit-only applications and surfaced by `dai check`
as a warning on any app JavaScript that touches a sink.

**Exit:** a kit-only app mounts and runs under the directive; an app that
assigns `innerHTML` is warned by `dai check`, and refused at runtime when built
with the directive on.

## Closed

Kept so the reasoning stays with the record.

- **0.1 / 1. The signed set is closed** — `f60466d`. Both directions, all
  three readers, two conformance cases, the bootloader proven in a page.
- **2. What runs is what was signed** — `7cd469c`. Only module specifiers
  are rewritten.
- **3. A link does not mount without consent** — `7cd469c`. Half of 0.3.
- **4. Every bridge reply is bound to its request** — `7cd469c`. The host
  side of 0.3; the shell side is open above.
- **5. The desktop host's policy matches the specification** — `7cd469c`.
- **6. The README points at the current specification** — `f60466d`.
- **7. Real locks, with the generation check inside them** — `589fd26`.
- **8. Refusals have names** — `159827f`.
- **9. Two host classes, and the site says which is which** — `834e504`.
- **10. The recipe teaches the schema, every door declares it, the kit
  survives a colon** — `c1b04b8`. `upgradeOf` is the plumbing 4.2 needs.
- **Reproducible builds** — `841beb6`. Every zip a container is made of
  carries a fixed timestamp, so the same inputs make the same file. A
  prerequisite for 2.1's byte-identity, and `roadmap.md` had claimed it since
  the beginning while it was false.
- **1.1 A launch card, with claims the host can back** — `f625dcc`. Name,
  icon, publisher and four ticks, drawn after verification; each tick names
  the §4 clauses behind it and vanishes with any of them. The claims table is
  in `src/host-profile.ts`; the link and share paths land on it.
- **1.3 Install after use, not on open** — `a7df929`. `dai:used` from the
  kit and from a save, relayed once as `DAI_HOST_USED`; `describe` at mount,
  `offer` on first use; asked at most twice. The shell marks `used` in its
  timing table, which is the number 5.1 needs.
- **0.3 The shell binds its frame's messages** — `870c1e5`. One guard over
  the shell's listener; the frame's three listeners bound to the parent; the
  rule in spec §4.4. **Phase 0 is closed.**
- **11. The host says what it applied, and the probe checks** — `5f0c68c`.
  What 1.1's ✓ claims are backed by.
- **The five gates from the first review** — see `roadmap-to-1.0.md`.
- **A private key in the repository root** — `a9e6b27`. Signed nothing.
- **The desktop shell verifies less than the runner; one app instance per
  cartridge; trust pinning in the opener** — earlier, see git history.
