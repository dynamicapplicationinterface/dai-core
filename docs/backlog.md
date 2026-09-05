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
| 1.2 | One card for every carrier | [ ] |
| 1.3 | Install after use | [x] `a7df929` |
| 1.4 | One sentence everywhere | [ ] |
| 1.5 | Look inside | [ ] |
| 2.1 | Thin profile | [x] `ba5a8e1` format, `1b31ea1` opener |
| 2.2 | Inline link | [x] `8b66364` — the cap is a decision, see below |
| 2.3 | Reference link and dumb store | [ ] |
| 2.4 | Carriers in the specification | [ ] |
| 2.5 | The sender's last line is the link | [ ] |
| 2.6 | Every share path carries the link | [ ] |
| 3.1 | Engine once, offline forever | [x] `1b31ea1` `8b66364` `PENDING` |
| 3.2 | Mirrorable static opener | [ ] |
| 3.3 | Unfurl without the blob | [ ] |
| 3.4 | Stripped fragment degrades to a sentence | [ ] |
| 3.5 | iOS solved by the link | [ ] |
| 3.6 | Second-use integrations only | [ ] integrations exist; the rule is open |
| 4.1 | Succession | [ ] |
| 4.2 | "Modify this app" | [ ] `upgradeOf` half done `c1b04b8` |
| 4.3 | A publisher who is somebody | [ ] |
| 4.4 | The wedge | [ ] not engineering |
| 4.5 | Attachments in the document | [ ] |
| 5.1 | The north star, measured | [ ] |
| 5.2 | Propagation without a beacon | [ ] relay side |
| — | Media type registered | [ ] |
| — | Desktop window shows the document's icon | [ ] |
| — | Packing list date editable | [ ] |
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

**Exit:** snapshot tests show an identical card from `?open=`, `#a=`,
`/d/<id>`, the file picker and `launchQueue`.

### 1.4 One sentence everywhere

"Send an app like you send a document." On the card, the unfurl, `/open` and
the share text the opener already emits.

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

### 2.3 The reference link, and a dumb store

`https://<opener>/d/<id>#h=<sha256>&k=<key>` — content-addressed, encrypted
end to end, the key in the fragment; an any-host variant `#h=&u=&k=`; a store
interface of `put`, `get`, `head` and nothing more, so the relay is a
commodity and an enterprise hosts its own in an afternoon. Subsumes the
earlier "one tool contract, two transports": the store is this store.

**Exit:** the same link resolves from two different hosts; a tampered blob is
refused by hash before the signature is checked; the store's logs contain no
fragment.

### 2.4 Carriers in the specification

"Carrier" defined beside "form": file, reference link, inline link. The
fragment grammar frozen so any opener honours it. Carries the earlier item on
implementability: CDDL and frozen byte vectors for the signed payload, the
footer, the bridge envelope and the fragment; the Python reader finished to a
full verifier that opens all three carriers with no dai-core source reuse.

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
`PENDING` (the proof).

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

**Exit:** a second document from a pinned publisher shows "known publisher";
a new key under a known name is a mismatch.

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
