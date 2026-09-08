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

- Register the media type; serve `.dai` as it. Independent of everything.
- The desktop window shows the document's own icon, not the host's.
- The example apps: the packing list's date is editable or gone.
- Publish dai-core 0.2.0. Not made here.

---

## Known red, and not from anything here

Nine tests fail on this machine on every run — eight in webkit and firefox,
and one in chromium.
They were failing before any of the September work and they fail on a clean
checkout with everything stashed — checked, rather than assumed, because
"pre-existing" is what somebody says about a failure they caused.

    chromium sender.spec             Make one offers a link, and the link opens it
    firefox  identity.spec           a held root puts the identity on the card
    firefox  sender.spec             Make one offers a link, and the link opens it
    webkit   identity.spec           a held root puts the identity on the card
    webkit   inline-link.spec        a real app opens from a link, network off
    webkit   offline-second-open     comes back on its own, engine and all
    webkit   opener-thin.spec        a host with no engine refuses it
    webkit   runner.spec             two saves at once both land
    webkit   sender.spec             Make one offers a link, and the link opens it

The chromium `Make one` failure is a shell-elision mismatch: the inline link
leaves out `runtime/container.html` expecting the opener to rebuild the same
one, and the opener's differs. Checked against a clean stash — it fails there
too, so it is not from the September work — but unlike the rest of this list it
is a real disagreement between two of our own builds rather than a browser
capability, and it is the one here worth an afternoon first.

The rest: two of them — both `Make one` on other browsers — are
`grantPermissions(["clipboard-read"])`, which only chromium implements, so
those are the harness rather than the code. The other six are worth an
afternoon with a webkit build; none is a claim this project makes on the
platform anybody has been asked to use it on.

Recorded here so the next session does not spend an hour rediscovering it.

---

## Not doing

- Native phone apps as a prerequisite for first use.
- OS file association or share target as the first-use foundation.
- A smart relay. The moment the store does more than hold bytes, the format
  has a dependency and cannot be self-hosted in an afternoon.
- A marketplace as the distribution model.
- Real-time sync or two-person editing. Succession plus export, never a CRDT.

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
