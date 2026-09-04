# Backlog

The live list. Ordered by what it costs to be wrong, not by what is
interesting. Each item has an exit a machine can check. When an item is done
it moves to the bottom with the commit that closed it, so the record of why
stays with the record of what.

Written 4 September 2026 after three independent architectural reviews of the
code at `a9e6b27`. Where the reviews agreed, the item is here. Where they
disagreed, it is in the last section, undecided on purpose.

---

## Engineering — undisputed, in order

Numbering continues from the security items, which are closed below.

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

- **1. The signed set is closed** — `f60466d`. The signature check reconciled
  `signedEntries` against `hashes` in one direction; an entry added beside a
  matching digest passed as signed, including `runtime/schema.json`, whose
  migration SQL a host runs. Both directions now, in all three readers; two
  conformance cases; the bootloader proven in a page.
- **2. What runs is what was signed** — `7cd469c`. The loader rewrote every
  spelling of every asset name across whole script texts. Only module
  specifiers now; a test says its file names every other way.
- **3. A link does not mount without consent** — `7cd469c`. `?open=` shows
  the host and fetches on a click.
- **4. Every bridge reply is bound to its request** — `7cd469c`. Random
  request id, echoed by the host, accepted only from the parent; no random
  source throws.
- **5. The desktop host's policy matches the specification** — `7cd469c`.
  No `'unsafe-inline'`; outer frames lose popups and modals; the spec
  describes the shell frame as its own layer.
- **6. The README points at the current specification** — `f60466d`.

- **The five gates from the first review** — honest CI, opaque-origin frame,
  no `'unsafe-inline'`, the whole manifest signed, saves that write only the
  data section. See `roadmap-to-1.0.md`.
- **The desktop shell verifies less than the runner.** The reader moved to
  `src/container.ts`; both hosts verify before mounting.
- **One app instance per cartridge.** `tauri-plugin-single-instance`.
- **Trust pinning in the opener.** The decision moved to `src/trust.ts` and is
  shared by both hosts.
- **A private key in the repository root.** `a9e6b27`. Signed nothing.
