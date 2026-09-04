# Backlog

The live list. Ordered by what it costs to be wrong, not by what is
interesting. Each item has an exit a machine can check. When an item is done
it moves to the bottom with the commit that closed it, so the record of why
stays with the record of what.

Written 4 September 2026 after three independent architectural reviews of the
code at `a9e6b27`. Where the reviews agreed, the item is here. Where they
disagreed, it is in the last section, undecided on purpose.

---

## Security — undisputed, in order

### 1. The signed set is closed

`checkSignature` walks `signedEntries` and checks each against `hashes`. Nothing
checks the reverse: that every entry in the archive — and every entry in
`hashes`, which is itself outside the signature — is *in* `signedEntries`. An
entry added alongside a matching digest passes integrity and passes signature.
One such entry is executed by the host: `runtime/schema.json`, whose migration
SQL runs against the person's data, under the badge of the pinned publisher.

**Exit:** two conformance cases, `signed-extra-entry` and
`signed-schema-injected`, verdict `mount: false, signature: invalid`, refused
with `SIGNED_SET_MISMATCH` by all three readers — `container.ts`, the
bootloader, and the Python reader. `signedEntries` is the sole authority at
mount; `hashes` is not consulted at verify time.

### 2. What runs is what was signed

The frame loader rewrites asset-name spellings across JavaScript source so
that references resolve at an opaque origin. If that rewrite touches strings,
comments or regexes, the bytes that execute are not the bytes that were
digested and signed.

**Exit:** verified first — a test that builds an application whose own file
names appear as string literals and asserts the script text the frame executes
is byte-identical to the sealed entry. If it fails, resolution moves to an
import map and `src`/`href` rewriting only, and the test stays.

### 3. A link does not mount without consent

`?open=<url>` fetches and mounts with no click. Any page can put a full-screen
application — one that asks for a password, say — in front of somebody who
followed a link. The handoff path guards its origin; the URL path guards
nothing.

**Exit:** the opener shows the host it is about to fetch from and mounts on a
click; a test asserts no mount before the click.

### 4. Every bridge reply is bound to its request

The handshake and save messages are bound to the frame's `event.source` and
the session nonce. Replies are not bound to a request, so a stale or duplicated
acknowledgement cannot be told from the one that was asked for. And when
`crypto` is absent the nonce falls back rather than refusing.

**Exit:** save request and response carry a cryptographically random request
id; a spoofed acknowledgement, a duplicate response and a stale nonce are each
rejected by a test; an absent `crypto` throws rather than degrading.

### 5. The desktop host's policy matches the specification

`tauri.conf.json` still carries `'unsafe-inline'` and disables asset CSP
modification; both hosts' *outer* frame still allows same-origin and popups.
The inner frame is the real boundary, so this is defence in depth rather than
a hole — but it is not the policy §4 of the specification says a host applies.

**Exit:** the desktop shell's policy has no `'unsafe-inline'`; the outer frame's
flags are either tightened or written into the specification as the shell
layer, with the reason.

### 6. The README points at the current specification

It links v0.1, which is superseded and was what one review read first.

**Exit:** README links `spec-v0.2.md`; a test greps for the old link.

---

## Engineering — undisputed, in order

### 7. Real locks, with the generation check inside them

The generation counter detects a lost update; it does not prevent one. Two
windows or two processes on one file can still race.

**Exit:** browser editors take a Web Lock on the document identity around the
save critical section; the desktop host takes an OS advisory lock for the
duration of a save; the generation check stays inside the lock as the
backstop; new refusals `GENERATION_CONFLICT` and `LOCK_UNAVAILABLE`. A
two-writer test with a stale generation refuses and never overwrites.

### 8. Refusals have names

Hosts refuse in prose. A second implementation needs codes it can compare.

**Exit:** a registry in the specification — structure, section digest, entry
digest, unsigned, signature invalid, signature unsupported, publisher
mismatch, expired, `DATA_DAMAGED`, `SECTION_MISMATCH`, `SCHEMA_AHEAD`,
`GENERATION_CONFLICT`, `LOCK_UNAVAILABLE`, `SIGNED_SET_MISMATCH` — each
carrying code, message, recoverable, and the document id and generation when
known. All three readers emit the same code for the same conformance case.

### 9. Two host classes, and the site says which is which

The browser cannot honestly write in place outside Chromium; the desktop
host can. Decided: the browser is a **viewer** — verify, mount, keep a local
copy, export — and the desktop host is an **editor** — in-place save, lock,
generation check. The landing page and `introduction.md` currently claim
universal in-place save.

**Exit:** the handshake carries the host's class; a viewer never claims an
in-place save; the site's copy is corrected and a test greps out the old
sentence.

### 10. The recipe teaches the schema, and the kit survives a colon

The schema gate exists to stop a model's v2 destroying a person's v1 data —
and the recipe never mentions `schema.sql` or migrations, so no model ever
declares one and the gate never runs for exactly the population it is for. And
the kit's parameter matcher, `/:([a-zA-Z_]\w*)/g`, reads `strftime('%H:%M')`
as two bindings; the one real sample we have is a medicine log.

**Exit:** the recipe requires `schema.sql` and a migration on revision; the MCP
`create` refuses to rebuild an existing document whose schema moved without
one; the kit skips string literals and `::`; a container using
`strftime('%H:%M')` builds and interacts with no phantom binding.

### 11. The host says what it applied, and the probe checks

A misconfigured host is silently insecure. The specification should name the
flags a host applies, the handshake should carry them, and the isolation probe
should be what proves the claim rather than the host's own word.

**Exit:** a host profile in the handshake; the probe reaches "blocked" on every
§4 clause under both hosts in CI; a host that claims a flag it did not apply
fails CI.

### 12. The evaluation measures the things that actually fail

Four stages score checked, built, mounted, usable. What breaks at scale is
after that.

**Exit:** three more stages — first interaction survives (click every control,
nothing throws), data round-trips (write, export, reopen, row present), and
regeneration is safe (v1 seeded, v2 built from a new prompt, data survives or
is refused loudly). Then a run of several hundred prompts across several
models, reporting pass@1 usable-and-persistent. The run is a decision about
spend and is not made here.

### 13. The specification can be implemented from the specification

The signed payload's field list, its empty-string-for-absent rule and its key
order live in code and one paragraph; the Python reader rediscovered one of
them as a "gap". The spec's example says `manifestVersion: 1`; the code says 2.

**Exit:** CDDL for the signed payload, the footer and the bridge envelope;
frozen byte vectors for a known-good signed payload; the example corrected;
the Python reader finished to a full reader and verifier with no dai-core
source reuse, agreeing with the reference on every conformance case.

### 14. One tool contract, two transports

The three MCP tools exist over stdio and write to disk. A remote server should
serve the same tools and return a link the opener can open.

**Exit:** the tools and their result shape — `{ ok, diagnostics, document? }`
plus a locator that is a path or a URL — in one module both servers mount; a
store interface of `put`, `get`, `link`; a filesystem store in the open repo so
anyone can run their own; and one sentence in the specification: a served
container MUST be readable cross-origin by the opener. Everything about an
operated instance stays out.

### 15. Small, undisputed, cheap

- Register the media type; serve `.dai` as it. Independent of everything.
- The desktop window shows the document's own icon, not the host's.
- The example apps: the packing list's date is editable or gone; times are
  shown as people read them.
- Publish dai-core 0.2.0. Not made here.

---

## Disagreements — deliberately undecided

Each has at least two reviews on opposite sides. None blocks anything above.

- **`strict-dynamic`.** One review says add it; two say it stops an attack we
  do not have and would make a nonce-authorised script a trust root for
  anything it inserts. The two that read the loader say don't.
- **What a model should emit.** Keep the kit and harden it; or a
  grammar-constrained bundle for the envelope with the kit as a versioned UI
  profile beneath it; or a JSON payload for the tool path, which has none of
  the chat-rendering problems the bundle was shaped around. These are about
  different layers and may all be right.
- **The first capability.** `dai.print`, `document.save`, or `fs:export`. A
  question that does not need an answer until something needs a capability.
- **What TOFU pins.** The document's UUID, as now; or a publisher key id in the
  signed set, pinned across documents, with the first-ever publisher still
  uncloseable offline.
- **Whether an RFC is worth it.** Media type early, Community Group after a
  second implementation — agreed. An IETF Independent Submission afterwards,
  or never, because an RFC for a format nobody uses is a tombstone.

---

## Closed

Kept so the reasoning stays with the record.

- **The five gates from the first review** — honest CI, opaque-origin frame,
  no `'unsafe-inline'`, the whole manifest signed, saves that write only the
  data section. See `roadmap-to-1.0.md`.
- **The desktop shell verifies less than the runner.** The reader moved to
  `src/container.ts`; both hosts verify before mounting.
- **One app instance per cartridge.** `tauri-plugin-single-instance`.
- **Trust pinning in the opener.** The decision moved to `src/trust.ts` and is
  shared by both hosts.
- **A private key in the repository root.** `a9e6b27`. Signed nothing.
