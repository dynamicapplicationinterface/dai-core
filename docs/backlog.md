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
| 1.5 | Look inside | [ ] |
| 2.1 | Thin profile | [x] `ba5a8e1` format, `1b31ea1` opener |
| 2.2 | Inline link | [x] `8b66364` grammar, `6c23954` compact carrier — a chore chart is 2.8 kB |
| 2.3 | Reference link and dumb store | [ ] decided: R2 behind a three-call Store |
| 2.4 | Carriers in the specification | [~] `5606a87` `6c23954` — the Python reader verifies signed links; CDDL and vectors open |
| 2.5 | The sender's last line is the link | [ ] |
| 2.6 | Every share path carries the link | [ ] |
| 3.1 | Engine once, offline forever | [x] `1b31ea1` `8b66364` `fd2723f` |
| 3.2 | Mirrorable static opener | [x] `c9a6789` |
| 3.3 | Unfurl without the blob | [ ] |
| 3.4 | Stripped fragment degrades to a sentence | [ ] |
| 3.5 | iOS solved by the link | [ ] |
| 3.6 | Second-use integrations only | [ ] integrations exist; the rule is open |
| 4.1 | Succession | [ ] |
| 4.2 | "Modify this app" | [ ] `upgradeOf` half done `c1b04b8` |
| 4.3 | A publisher who is somebody | [ ] decided: three states, key pinned across documents |
| 4.4 | The wedge | [ ] not engineering |
| 4.5 | Attachments in the document | [ ] |
| 5.1 | The north star, measured | [ ] |
| 5.2 | Propagation without a beacon | [ ] relay side |
| — | Media type registered | [ ] |
| — | Desktop window shows the document's icon | [ ] |
| — | Packing list date editable | [x] `30a83aa` |
| — | dai-core 0.2.0 published | [ ] yours |

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

### 1.5 Look inside

A link from the card to the playground, which reads the same bytes and never
mounts.

**Exit:** the card links to the playground with the same bytes; the playground
never mounts.

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
5. The sidecar (manifest in the clear, name, icon) is a separate object under
   the same hash. `put()` validates the manifest signature and that the
   ciphertext length matches the declared size — a DAI relay, not a general
   file host. Size cap 5 MB, TTL on unopened blobs.
6. The unfurl route (`/d/<id>` → OG name and icon from the sidecar, never the
   blob) lives on Vercel beside the opener; it is off the runtime path.

A Vercel Blob adapter, if ever wanted, is a third adapter behind the same
interface and never the reference one. `@vercel/blob` is not imported in
dai-core.

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

What is left is the part that needs 2.3: the reference link's grammar, which
is not frozen because the store is not decided. And the part that is simply
work: CDDL and frozen byte vectors for the signed payload, the footer and the
bridge envelope.

**Exit:** CDDL and vectors published; the Python reader opens all three
carriers and agrees with the reference on every conformance case.

### 2.5 The sender's last line is the link

MCP `create_dai_app` returns `{ file, link, qr }`; the assistant's last line
is the link.

**Exit:** the MCP test sees an inline link for a small app and a reference
link when a store is configured.

### 2.6 Every share path carries the link to this document

The `handOff` share text points at the opener; it should point at *this*
document.

**Exit:** exported share text contains a link that opens the exported bytes.

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

### 3.3 Unfurl without the blob

`/d/<id>` serves name, icon and the standard line from a sender-consented
sidecar; never the ciphertext.

**Exit:** a chat preview shows name and icon; a GET on the unfurl route never
returns ciphertext.

### 3.4 A stripped fragment degrades to a sentence

"Ask the sender for the key", never a blank page; an enterprise-internal
no-key variant.

**Exit:** a test with the fragment removed renders the recovery message.

### 3.5 iOS, solved by the link

The per-document install manifest (closed, in `edd236c`) uses the reference
link as `start_url`; the home-screen app fetches on first launch, then runs
offline. Replaces the one-time hand-in.

**Exit:** an iOS device test: the home-screen icon opens the document with no
manual step.

### 3.6 Second-use integrations only

`share_target`, `file_handlers` and the desktop file association exist and
stay; none is the first-use path.

**Exit:** the docs and the card never reference an install step before first
run.

---

## Phase 4 — Propagation

### 4.1 Succession

`supersedes: <uuid>` in the signed set, valid only under the same publisher
key. A host adopts v1's data into v2 through the migration chain (closed, 10),
keeps v1 as backup, and refuses loudly if no chain reaches. Carries the
earlier evaluation item: the three added stages — first interaction survives,
data round-trips, regeneration is safe — and then the run at scale, which is a
decision about spend and is not made here.

**Exit:** an evaluation stage builds v1, seeds it, builds v2 with
`supersedes`, opens v2 — data present or loud refusal, never silent loss.

### 4.2 "Modify this app"

An affordance on the card that hands the bundle back to an assistant with
`upgradeOf` set (closed, 10), so the improved version is a successor rather
than a stranger.

**Exit:** MCP `create` with `upgradeOf` refuses a schema move without a
migration (done); its output carries `supersedes`.

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

**Exit:** three snapshot tests, one per state; the Conflict test uses a
confusable-character variant of a pinned name and must render red.

### 4.4 The wedge

One category where an app is useful enough to send to somebody else. Not
engineering.

**Exit:** ten seed apps in the category, each shared at least once outside
its maker in a pilot.

### 4.5 Attachments in the document

`<dai-attach>`, blob columns, client-side downscale, a size budget.

**Exit:** an evaluation case: a photo attached on device A survives export
and open on device B.

---

## Phase 5 — Measurement

### 5.1 The north star, measured

Tap → first successful `data-run`, cold and warm, on a mid-range Android over
cellular, from the opener's existing timing table (`?timing`,
`performance.md`). Targets: warm under 1 s, cold under 3 s, inline-link cold
under 1.5 s.

**Exit:** CI publishes the number per release from a real device.

### 5.2 Propagation without a beacon

Distinct fetches per `/d/<id>` at the relay, which sees the request and never
the content. The opener sends nothing. The dashboard belongs to whoever runs
a relay, not to this repository.

---

## Small, undisputed, cheap

- Register the media type; serve `.dai` as it. Independent of everything.
- The desktop window shows the document's own icon, not the host's.
- The example apps: the packing list's date is editable or gone.
- Publish dai-core 0.2.0. Not made here.

---

## Not doing

- Native phone apps as a prerequisite for first use.
- OS file association or share target as the first-use foundation.
- A smart relay. The moment the store does more than hold bytes, the format
  has a dependency and cannot be self-hosted in an afternoon.
- A marketplace as the distribution model.
- Real-time sync or two-person editing. Succession plus export, never a CRDT.

## Disagreements — still undecided

- **`strict-dynamic`.** Two of three reviews say it stops an attack we do
  not have. Unchanged by the loop.
- **What a model should emit.** Kit, grammar-constrained bundle, or JSON tool
  payload. Different layers; may all be right. Unchanged.
- **The first capability.** Unchanged; nothing needs one yet.
- **Whether an RFC is worth it.** Media type early, Community Group after a
  second implementation — agreed. The RFC afterwards, or never.

Decided by the loop and moved above: what TOFU pins (4.3).

---

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
