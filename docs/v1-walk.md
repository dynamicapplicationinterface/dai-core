# The V1 walk

V1 is a daily single-user app with author updates, shared friend to friend. The
control is Chris's workout PWA (Vercel + Supabase). **V1 is done when the `.dai`
version, on the same phone with the same person, is indistinguishable from it —
and every place it isn't is the V1 list.** Chess and everything peer-shaped is
V1.1.

Nothing is built from now on unless it is a step on this walk or blocks one.
Findings are still filed. The naming family is closed. D80 stays proven and
held; its sitting happens with Chris and returns as a ruling on wire shape only.

This page is the board, not a plan. Each step says what exists today by name,
what blocks it, whether a test can see it or only a phone can, and the sentence
the person actually reads — quoted from the code, not from an intention.

Read once, 21 September. Where a step says **does not exist**, that was
established by reading the code, and how it was established is recorded with it.

---

## 1. Open the link on iOS, install, launch from the icon

**Exists.** `install.ts` end to end: `launchAddress()` (`install.ts:137`) builds
the `start_url` with the document's id in the fragment (`#u=`, never a query
param), `describeDocument()` (`install.ts:350`) writes the per-document manifest
and icon to `/doc-manifests/<uuid>.webmanifest` and `/doc-icons/<uuid>.png`, and
`describeNext()` (`install.ts:510`) tells the worker which document the next load
is for, because the worker cannot read a fragment. The keep control is raised by
`watchForInstall()` (`install.ts:637`).

**Blocked by:** clear. iOS has no `beforeinstallprompt`, so the sheet is
instructions rather than a button, which is the platform and not a defect.

**Seen by:** tests for the parts (`hint-and-install`, `document-icon`,
`probe-icon-manifest`, `icon-after-wipe`); **only a phone** for the act itself —
Share → Add to Home Screen, and whether the icon launches into its own storage.

**The person reads** (`install.ts:549-560`):

> **Add Velvet Chess to your Home Screen**
> It opens like an app, works without a connection, and stays on this device.
> 1. Tap the Share button
> 2. Tap Add to Home Screen

and, only when the document has no link to fetch itself from, a third step:
*"Open the new icon once and choose Velvet Chess from Files"*.

---

## 2. Log a workout; close; reopen tomorrow, history intact

**Exists.** The save path is `saveDatabaseToOpfs()` with an IndexedDB fallback
(`opfs.ts`), and the reopen is `launchFromLibrary()` → `loadDatabaseFromOpfs()`
→ `resealCartridge()` (`main.ts:838-850`). A reopen that finds the stored
database mounts it and keeps the replica id it has been writing under
(`main.ts:1838-1849`).

**Blocked by:** clear for the mechanism. What is *not* clear is the app: there is
no workout example in `examples/` (chore-chart, meal-plan, packing-list,
receipts, request, tasks, tic-tac-toe, chess-foil, web-studio). The walk needs
one, and writing it is step 2's real work.

**Seen by:** tests — `runner.spec` ("persists imported cartridges…"),
`returning-document`, `d22-reopen`, `empty-reopen`, `second-use`.

**The person reads** nothing at all on a healthy reopen, which is correct: the
app is simply there. The only sentence is the breadcrumb behind it
(`main.ts:846-850`), `dai: reopen mounted the stored database (N bytes)`. Where
the database is gone but the library row is not, they read (`main.ts:854-870`):

> Velvet Chess opened empty: what this device had saved for it isn't here any
> more. If you have a link to it, or another copy, open that here and the data
> comes back with it.

---

## 3. Be asked to keep it (persistence), at the right moment

**Exists, at the wrong moment.** `askToPersist()` (`opfs.ts:92`) runs
**unconditionally at page boot** (`main.ts:182-192`), before any document is
open, with no engagement and no install signal — the request least likely to be
granted, made at the only moment the code makes it. `readPersistence()`
(`opfs.ts:56`) reads the answer and tags it `installed` or `tab`.

**Blocked by:** **D55**, open, its candidates unruled. This is the first V1 step
with a decision in front of it rather than work.

**Seen by:** tests for the reading and the line (`storage-persistence`, nine
cases); **only a phone** for whether iOS grants it, and when.

**The person reads** a status line, not a question (`main.ts:4603-4616`):

> kept on this device · installed

or `not kept · tab`, and nothing at all when the browser will not answer. There
is no sentence asking them anything, because nothing asks them: the request goes
to the browser, not to the person.

---

## 4. The author ships a new exercise database; the copy learns of it, shows the card, updates, history intact

**Learning of it: does not exist.** No code path asks anywhere whether the author
has shipped a newer build of a document. Established by reading every `fetch` in
the runner: shell and runtime assets, a link the person followed, relay and push
traffic — nothing else. `src/store.ts` and `src/link.ts` contain no notion of
`latest` or `version`. The one update check that exists, `checkForUpdate()`
(`main.ts:4637`, `/version.json`), is **the opener shell's own** and says so in
its comment; `applyUpdate()` (`main.ts:4668`) clears caches and reloads, and
touches nothing in OPFS. The service worker caches the shell only and
deliberately never caches `/m/` manifests (`sw.js:713`), because "the document
behind an id can be replaced". **New author code arrives only because a person
opens a file or a link.**

**Carrying the rows forward: exists, under a different name.** Succession —
a *new* `documentUuid` with a signed `supersedes` (`core.ts:225-232`), adopted
only when the successor is signed by the same key this device pinned for the old
one (`main.ts:3605-3618`), applied once on first open (`main.ts:1721-1725`),
copying the whole old database across while the old document keeps everything it
had. `tests/succession.spec.ts` already proves the three cases the update
contract names, including "refuses loudly when no migration reaches, and loses
nothing".

**What happens to the rows if the author reships under the *same* uuid: this is
the V1 hazard.** Same id means the same document, so the arrival is a data
contest, not an update. `chooseCopy()` (`copy-choice.ts:113`) decides, and where
it returns `take`, `main.ts:1861-1866` writes the arriving database over the
stored one **with no sentence shown**. For a document whose rows are the point,
an author's rebuild carrying an empty database is exactly the shape that either
silently replaces a person's history or lands in `diverged` and opens nothing.
Filed as **D85**.

**Blocked by:** D85, and the absence of any learning path. Decision 1 in the
backlog is the contract this step has to meet; succession is most of the
machinery and none of the delivery.

**Seen by:** tests for succession and copy-choice; **only a phone** for the
round trip on an installed icon.

**The person reads** today, before opening a successor (`card.ts:470-475`):

> Replaces Velvet Chess. What you saved there comes along; the old one is kept
> as it was.

or, when it cannot be adopted:

> Claims to replace Velvet Chess, but this copy is not signed. Your data stays
> where it is.

and when a migration does not reach, the runtime refuses and the refusal reaches
the screen rather than being swallowed inside the frame
(`bootloader.ts:3420-3423`, `SCHEMA_INCOMPATIBLE`):

> This document's data does not match this version of the application.

There is **no card for "the author shipped an update"**, because nothing can
know that yet.

---

## 5. Share the link to a friend; the friend gets their own copy with their own history; the author's count goes up by one

**The share exists.** `sendDocument()` (`main.ts:3267`) → `linkToSend()`
(`main.ts:3147`) → `publish()` (`src/store.ts`), sealed with a key that lives
only in the fragment, or the whole app inline in the link where there is no
store. The recipient opens a launch card (`card.ts`) and gets their own copy.

**The count does not exist.** The relay stores a per-mailbox batch counter, a
dedupe index, up to eight push subscriptions and the sealed bytes
(`mailbox-do.ts`); its endpoints are append, head, since, subscribe,
unsubscribe. Nothing counts copies, versions or check-ins, and the worker says
so in its own comment: *"this door asks nobody who they are and trims nothing"*
(`worker.ts:10-12`). Decision 2 in the backlog is what would be built here, and
it is not built.

**Blocked by:** the count (no entry yet — this walk is where it is recorded).
And one thing to settle before step 5 is walked: **the data toggle defaults to
on** (`withData.checked = true`, `main.ts:3319`), so the default share carries
the sender's entries. For chess that is right — the invite is the game. For a
workout app, "here is the app I use" should hand over the app and not the
sender's log, and V1's default is the other one.

**Seen by:** tests for the link and the card (`send`, `sender`, `reference-link`,
`launch-card`, `card-familiarity`); **only a phone** for the share sheet.

**The person reads**, sending (`main.ts:3317-3332`):

> **Share Velvet Chess**
> Sealed with a key that only the link holds, then put in the store, which
> cannot read it.
> Anyone with the link can open it, with what is in it now.

That third line is the default, with the data toggle on. Turned off, it reads
*"Anyone with the link gets the app as it arrived, with none of your entries."*
— which is the sentence V1's walk wants to be the default one. After sending:
*"Shared. The store holds a sealed copy only the link can open."*

The friend reads, under the Open button (`main.ts:4034`, where the store's own
name is filled in):

> From \<store\>, sealed so it could not be read there. Nothing is uploaded — it
> runs on this device.

---

## 6. Lose the phone / reinstall from the link: whatever survives is what the screen said would

**Exists, and the honest answer is "the link is the backup".** An icon whose
document is not here says so (`documentNotHere()`, `main.ts:1290`), and where the
icon carries a link the copy is fetched again and the card says it happened
(`main.ts:1653-1656`). For a single-user document with no store link, **nothing
survives**: the key lives in the library row that went with the storage, and the
relay's ciphertext is unreadable forever (D53).

**Blocked by:** D53 as a statement nobody has been told, and D50's iOS boundary —
a first launch and a wipe are indistinguishable on an icon with its own storage,
which is a boundary and not a gap. D59's Mac reading is open but off this walk.

**Seen by:** tests — `icon-after-wipe` (both platforms' wordings, the store-link
refetch, the notification tap), `empty-reopen`; **only a phone** for a real wipe
and a real reinstall.

**The person reads** (`main.ts:1309-1312`, and the card at `card.ts:236`):

> Velvet Chess isn't on this device any more. If you still have the file, open
> it here and this icon will open it again.

> Velvet Chess wasn't on this device any more, so it was fetched again from its
> link.

---

## 7. The same on Android

**Exists.** `platform()` (`platform.ts:12`) splits the three, Android fires
`beforeinstallprompt` so the keep control is a real button (`install.ts:24`), and
the share target takes a file by POST, which the worker parks and redirects
(`sw.js`, `SHARED`; `main.ts:4084`).

**Blocked by:** clear for install and open. Known differences, not defects: the
icon badge is a dot on most launchers, so the count is best effort (D34), and
Android's storage eviction is its own behaviour.

**Seen by:** tests run Chromium, which is the engine but not the platform;
**only a phone** for the share target, the install prompt and the launcher.

**The person reads** (`install.ts:564-573`):

> **Add Velvet Chess to your home screen**
> It opens like an app, works without a connection, and stays on this device.

with the two steps — *"Tap ⋮ in your browser"*, *"Tap Add to Home screen"* —
shown only where the browser gives no prompt, and the button reading **Install**
where it does.

---

## What this walk says about V1

Three steps are clear mechanically and need an app to walk them (1, 2, 7). One
is blocked on a decision that exists and is unruled (3, D55). One is blocked on
a statement nobody has been told (6, D53). **Two do not exist at all: an
installed copy cannot learn its author shipped something (4), and nothing counts
copies (5).** Those two are V1's real work, and both now have a decision in the
backlog saying what they must be before either is built.
