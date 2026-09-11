# Collaborative play — onboarding, turns, and ownership (design note)

Internal working note. **Not** the recipe, not the site. Captures the decisions
from the first two-player test so nothing is re-derived, and holds the running
list of things to fix. Nothing here is deployed until it is deliberately moved
into `website/docs/the-recipe` (the AI recipe) or the host.

## The reframe

There is no separate "onboarding". **The invite link is the first sync — move
zero.** The link carries a snapshot of the game as it is at share time, plus the
key and the mailbox address; every move after is a delta over the mailbox. One
delivery by link, every delivery after by mailbox. "He doesn't have it yet" is
not a special case — it is the first delivery, done by link instead of mailbox.

## Onboarding sequence (Chris's ruling)

Inviter:
1. Tap **Invite**.
2. App asks **your name**.
3. **New game** is created.
4. Colour is **auto-assigned** (white/black), not chosen — fairer, and no
   decision to make. The inviter authors the assignment into the shared state;
   the opener takes the complement.
5. App makes the **link** (sealed to the store, key in the fragment) and shares
   it.

Opener:
1. Tap the link → opens into the snapshot (same document id + key + mailbox).
2. App asks **their name**.
3. They are seated in the **other** colour.
4. Play.

## Turns

- **Save points.** Turn ping-pong requires each move to be a durable, synced
  checkpoint. The mailbox already does this: publish-on-write, watermark
  advances on ack. Each move is a save point by construction.
- **Turn-gated authorship.** Only the seat whose turn it is may author the next
  move; the control is disabled otherwise. This is what stops both players
  authoring the same ply and the merge keeping both.
- **"Your turn" notification, no close button (Chris's ruling).** A passive,
  persistent indicator — never a modal with a dismiss. Two layers:
  - *In-app, buildable now:* on foreground/refresh, if it is your turn, show a
    standing "Your move" banner that clears itself when you move. No dismiss.
  - *Out-of-app (phone notification when you are not looking):* this is **push**,
    which is Track 5 **slice two**. Until then you only learn it is your turn by
    opening the app. So "your turn notification" is the concrete motivation for
    slice two — write that down as the reason it exists.

## Game end (Chris's ruling)

When the game ends (checkmate / resign / draw): the final state syncs (last move
published so both land on the same result), then offer a **link for a new game**.
A new game is a new invite — see ownership below; a rematch is just a new game
with the same person.

## Sessions are the unit of play (Chris's ruling — supersedes the below)

The document is the wrong level to pair people at. **Pull Track 3's session
profile forward and build it now, chess as its first user, on the live relay.**

- **One document is the app** ("Chess"). It holds **many games**. Each game is a
  **session**: its own roster of two, its own mailbox.
- The app's **games list is the list of sessions this copy is party to.** No
  document is ever shown to the user. The opener's chooser and library **stay as
  they are, hidden behind the document** (`#u=` launch) — never removed; the
  dynamic statement needs the library. (This corrects the earlier "remove the
  library" note: it is hidden, not removed.)
- **Start a game** = create a session + export an invite carrying **only that
  session** (profiles D4). A recipient without the app gets the app with that one
  game; a recipient who has the app gets a **sibling merge** that adds the game
  and touches nothing else.
- **Another opponent = another session.** Old games remain. **No unlink, no
  destructive path** as the price of a second game. (This reverses the earlier
  "unlink loses match history" model.) A separate, deliberate *Delete this match*
  is fine later — never the same button.
- **Forwarded invite:** the roster closes at `max_parties: 2`; a third party's
  rows are **dropped, not conflicted**.
- **Session close** is a replicated row. Once seen, the session is finite: later
  rows for it are dropped like non-roster rows, and compaction may retire it.
  Compaction stays deferred (profiles D6); its first job, when it comes, is
  *retire closed sessions to a file*.

Host's job stays as built (link → snapshot → key → mailbox); what changes is that
rows, the mailbox, and the invite export are all **scoped to a session**, and the
roster — not the app — is what admits a party.

## Update prompt on the version number (Chris's ruling)

The version stamp in the app menu (`<build> · <date>`) should, when the live
opener is newer than the running one, become **"New version — update"** with a
one-tap update. The check runs **on menu open, never on load** (Chris). It is the
user-facing form of the cache self-heal — compare the running build to the live
`version.json`, tap → cache-bust + reload — and the clean fix for the
stale-opener / merge-mismatch class of bug.

## What is the host's job vs the app's (recipe's) job

- **Host / infrastructure (built):** link → snapshot → key → mailbox; every move
  after by mailbox; publish-on-write, pull-on-foreground.
- **App / recipe (must be taught):** seats bound to replica ids; turn-gated
  authorship; validate against the *merged* state; auto-assign colour; the
  standing "your move" indicator; the invite / new-game / end-game flow; saying
  out loud whose turn it is and whether the opponent has joined.

## Decisions (settled)

1. Colour: auto-assign at invite. Inviter authors it; opener takes the complement.
2. **Sessions, not documents, are the unit of play** (Track 3 session profile,
   pulled forward). One document = the app = many sessions; games list =
   sessions; no document ever shown; library hidden behind the `#u=` launch, not
   removed.
3. New opponent = new session. No unlink, no destructive path. *Delete this
   match* is a separate, deliberate button, later.
4. Version number becomes an "update" prompt when the live opener is newer —
   checked on menu open, never on load.
5. Order across everything queued (Chris): (a) file-fallback fix first — it is
   breaking the friend test; (b) the session slice; (c) version-number update
   prompt; (d) push (Track 5 slice two).

## The session slice — build in order (Chris's spec)

1. **Session id on replicated rows.** Every row carries the session it belongs
   to; roster and close rows are replicated rows in the same tables, signed by
   replica key where Track 2 exists, claimed at Level 1.
2. **Export filtered to one session** — the invite carrier. Vector:
   `session-export-carries-only-that-session`, plus the same-session-parents rule
   (profiles D4).
3. **Roster** — declared `session, max_parties: 2`; closes when full; non-roster
   rows dropped at merge. Vectors: `roster-closes-at-max-parties`,
   `forwarded-copy-cannot-enter-session`. Retires (inverts) the chess suite's
   "third copy can enter the game" test.
4. **Mailbox per session** — key and mailbox id derived from the document key
   plus session id; relay unchanged (it never knew what a document was).
   Watermark stays `{replica, seq}`; add the session to the batch scope.
5. **Session close row** — merge drops rows for a closed session; add
   `session-closed-drops-late-rows`.
6. **Chess adopts it** — `-- dai:profile session max_parties=2` in the schema
   (not a comment); "New game" = create session + share invite; games list =
   sessions; no unlink; no seat/turn *enforcement* beyond UI convenience. Recipe
   updated: sessions are the roster, and apps must not enforce what only the
   roster can.

Not in this slice: compaction (deferred; session close is what makes it possible
later), media/blob (different mechanism, not a rows problem), push (slice two,
after). The same slice is the client–firm session in the dynamic statement, so it
is not a detour.

## Running list — fix after testing (do NOT deploy yet)

- [ ] **File-fallback is wrong for a replicated app.** When the invite link can't
  be made (presign rate limit, store hiccup, oversize), the share exports the
  *file* — a keyless copy that can never join the mailbox. For a replicated
  document the host should say "couldn't make the invite link, try again", not
  hand over a dead copy. (This is what stranded the first friend test.)
- [ ] **Presign rate limit too tight for testing.** `DAI_PRESIGN_PER_HOUR`
  defaults to 20/IP/hour; heavy testing trips it and forces the file fallback.
  Fine for production; raise it (env) during testing, or accept the reset.
- [ ] **iOS home-screen launch of a link-received doc loses the key.** The
  `start_url` fragment (which carries the key) did not survive a PWA launch on
  one device; the launched app fell to "open your document from your files",
  wrong guidance for a link recipient. This is the "sixteenth" — device-gated.
- [ ] Turn/seat model is not yet in the chess app or the recipe — it is the next
  real build once the flow is agreed.
- [ ] **Automatic in-app refresh (polling) — the missing middle.** Slice one is
  pull-on-foreground (manual); push is slice two (out-of-app notification). The
  gap is the app updating itself *while open*, without a manual refresh — which
  is what made the live test feel broken. Small: while the tab is visible, poll
  `head()` every few seconds (cheap — the relay's counter), pull when it moves
  past the cursor, pause while hidden. Slots before or alongside D22; it is the
  thing that makes the two-phone experience feel live.
- [ ] "Your move" standing indicator (in-app) — buildable now.
- [ ] Push ("your turn" when not in the app) = slice two; motivated by this test.
- [ ] **Version-number update prompt** — app menu compares running build to live
  `version.json`; if newer, "New version — update" one-tap (cache-bust + reload).
  Also the user-facing fix for stale-opener / merge-mismatch. Buildable now.
- [ ] **No opener chooser on mobile (v1)** — keep people out of the bare opener;
  the app is the entry point. How links/icons land straight in the app without
  ever showing "Open a document somebody sent you".
- [ ] **P0 — the mailbox key path was never wired; the mechanism was proven
  with a fixed key.** The e2e injects one key into both copies via
  `__runner.useRelay(base, key)`, so the two sides trivially shared a key. Real
  sharing has no such thing: (a) the store seal key is a *fresh random key per
  share* (`src/store.ts` ~301), so two shares carry two keys and the parties
  never converge; (b) the creator's copy never persists a mailbox key —
  `saveMailbox` is never called from `main.ts`, and `arrivedKey` is set only by
  *opening* a link, so a creator who shares runs no mailbox session at all. Net:
  on two real phones nothing ever crosses, which is exactly the observed
  failure. Fix = the decision already on record but not built: **one stable
  document key, generated once, kept in the library entry, carried in every link
  (same key each share), used for both the store seal and the mailbox** — so both
  parties converge and the creator has a mailbox. This is ahead of the D22 fix
  and the session slice: without it the mailbox does not function for real
  sharing at all. Named test must exercise the REAL key path (no injected key):
  two copies, one shares a link, the other opens it, a move crosses.
- [x] **The key path works on real hardware.** First genuine two-device run
  after the stable-key fix + deploy (`01bb9e5`): a move crossed the mailbox
  between a phone and a PC, key carried by the link, no injection. The thing
  Track 5 slice one set out to do.
- [ ] **Refreshing a link re-merges instead of pulling.** On PC the friend
  refreshed the `/d/` URL; that re-runs open-from-link (re-fetch the store
  snapshot, sibling-merge against the held copy), so he got a merge prompt on
  every new move — redundant with the mailbox, which was already syncing
  silently. Fix: refreshing a link for a document already held opens the held
  copy and pulls the mailbox, not re-merges the link's older snapshot. The link
  is a first-delivery carrier; once held, the mailbox is the channel. Mostly
  retired by the session slice (an invite adds a game once, not a snapshot
  re-merged each refresh). Workaround meanwhile: foreground the tab or reopen
  from the library, don't refresh the `/d/` URL.
- [ ] **The familiarity card flashes Get → merge on first receipt.** The card
  resolves in two passes — "new app" then "sibling, merge" — and the transition
  shows. Settle the state before painting.
- [ ] **File ping-pong when the mailbox doesn't engage.** First real 2-player
  test: the invite went out as a *file* (rate limit → file fallback), so no key,
  no mailbox — every move required re-sending the file. The keyed link is the
  fix. Priority: raise `DAI_PRESIGN_PER_HOUR`, Share→Send. (The file carrier is
  NOT being retired — it is the no-relay fallback, the enterprise self-host path,
  and the offline path. It stays first-class.)
- [ ] **P1 — `ROW_REJECTED` "A different row already exists": a D22 invariant
  violation, on any carrier.** Two copies allocated the same `(replica, seq)` for
  different moves — which means two copies shared one replica identity. That is
  exactly the case D22 forbids on *every* carrier, and the one the decision
  called worse than a compatibility gap: two honest moves, one refused as
  tampering. The mailbox sidesteps the *symptom* (settleReplica + e2e); it does
  not fix the *bug*. Two Safari tabs on one held document is a normal user, not
  a test artifact. Candidate causes, both host bugs: (a) the new tab mounted a
  second working copy under the same library entry and the two raced on `seq`;
  (b) the "own copy returning" check treated a sibling as itself, so it never
  adopted a fresh replica. Fix, same shape as before: **one document, one replica
  per host**, plus a cross-tab lock or a single shared connection so a second tab
  cannot allocate. Named test: **two tabs on one held document never allocate the
  same `seq`.** Order: fix **after** the link run, **before** the session slice —
  the slice multiplies documents, and a per-host identity bug scales with them.
- [ ] **Document handoffs and user sessions in the SDK / recipe, with use
  cases.** How a session is created, invited, joined, closed; how a handoff
  works (build-and-hand-over, link, sibling merge); worked examples an app
  builder can follow — chess (two-player game), the client–firm session (the
  dynamic statement), a shared list. The recipe must show, not just state, how
  sessions and handoffs are meant to be used.
