# Roadmap: 0.1 → 1.0

Written 3 September 2026, after an external architectural review. The review's
mechanical claims were checked against the code rather than taken on trust;
what follows records what was confirmed, what was not, and the order I would do
the work in given that this is a very small team.

---

## What was verified

| Claim | Status in our code |
|---|---|
| The iframe sandbox includes `allow-same-origin` | **Confirmed.** `src/runtime/bootloader.ts` sets `allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads` |
| `allow-popups` leaves an exfiltration channel open | **Confirmed.** Present in the same attribute |
| CSP uses `'unsafe-inline'` and `'self'` | **Confirmed.** `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:` |
| `connect-src 'none'` does not close navigation, `window.open`, DNS prefetch or WebRTC | **Confirmed** by reading the policy; none of those are governed by it |
| Meta-CSP must precede `<title>` | **Already true.** Only `<meta charset>` precedes it |
| The model seals the file | **Copy is wrong, architecture is right.** The MCP server compiles and seals; the model only emits source. The landing card says "the model writes and seals it", which is the sentence to fix, not the design |
| `documentUuid` is unsigned | **Not true.** It is the second line of `canonicalPayload` and has been signed since signing existed. The real gap is narrower and worth stating exactly: *nothing else* in the manifest is. `appName`, `favicon`, `createdAt`, `algorithm` and `integrityPolicy` can all be edited without invalidating a signature |

### The finding that matters most

`allow-same-origin` means the application is same-origin with the shell. It can
read and rewrite the bootloader, read the public key out of the DOM, and forge
anything the bridge reports. Integrity is checked *before* mount, so a hostile
application cannot un-fail its own check — but saves are self-perpetuating, so
it can rewrite the bootloader that gets baked into the copy the next person
opens.

The bootloader says why, in a comment: blob URLs minted by the shell are only
reachable from the frame when the frame shares its origin. That is true, and it
is the real work item. Every part of the mount path — the import map, the chunk
graph, the SQLite engine and its glue — currently travels as a parent-minted
`blob:` URL. Dropping `allow-same-origin` means the frame must mint its own
blobs from bytes handed over by structured clone. That is not a flag change; it
is a rewrite of the loader, and it sits on the critical path for everything
else.

---

## The decision that changes the product, not just the code

The review's most consequential paragraph is not in the security section. It is
this: **the browser runner cannot honestly offer in-place, incremental,
multi-tab-safe persistence.** OPFS needs a real origin and, for the fast VFS,
cross-origin isolation we cannot set from `file://`. The File System Access API
is Chromium-only. Everywhere else, "save" means "download a new copy".

That points at a split we have not made and the site currently denies:

- **The browser is a viewer with export.** It opens anything, anywhere, with
  nothing installed. That is the reach, and it is worth keeping exactly as it is.
- **The desktop app is the editor.** In-place saves, a stable origin, a real
  lock, per-document isolation.

This is the PDF arrangement — every browser renders one, Acrobat edits one —
and it resolves a tension we have been papering over. It also contradicts the
landing page, which promises editing everywhere. **This is a positioning
decision, not an engineering one, and it should be made deliberately before
0.2 is designed around it.**

---

## Phases

Gated, not dated. I have kept the review's structure where it was right and
resequenced where being a two-person operation changes the answer.

### 0.1.1 — Stop claiming what isn't true (days)

Not in the original review as a phase, because a reviewer reads the spec while
we have a live site. Three sentences are currently false or overstated, and
they are the sentences a security-minded reader will test first.

- "An altered file refuses to open" → true only against an attacker who does
  not re-seal. Say what is actually guaranteed: alteration is *detectable*, and
  a conforming host refuses.
- "It cannot phone home" → narrow it to what CSP enforces, and name the
  residual channels in the security page rather than letting a reader find them.
- "The model writes and seals it" → the model writes; the compiler seals.

Nothing here needs code. It needs us to describe the property we have instead
of the one we want, which is the standard this project has otherwise held to.

### 0.2 — An honest sandbox (breaking)

- **Loader rewrite** so the frame mints its own blob URLs, then drop
  `allow-same-origin`, `allow-popups`, `allow-downloads` and `allow-modals`.
  This is the largest single piece of work in the roadmap and everything
  security-related depends on it.
- **CSP rewritten**: per-boot nonce with `strict-dynamic`, no `'unsafe-inline'`,
  no `'self'` (ill-defined in an opaque origin anyway). The compiler knows every
  byte, so inline script in app HTML gets rewritten to blob modules at build.
- **Normative sandbox flags in the spec**, and the host asserts in the handshake
  which flags it applied — so a mis-configured runner is detectable rather than
  silently insecure.
- **Handshake nonce**: the host sends a nonce in the ACK, the container echoes
  it on every message. A container embedded in a page that is not a conforming
  runner never receives one and refuses to mount.
- **Compiler lint** rejecting `<link rel=prefetch|preconnect|dns-prefetch>`,
  `http-equiv=refresh`, and `target=_blank`.
- **Native shells** disable WebRTC and DNS prefetch at the webview layer; the
  browser runner documents them as residual, because it cannot.

Exit criterion, and I would hold to it: an external red-team finds no
exfiltration path from a conforming browser runner beyond the documented
residuals.

### 0.3 — Container v2 and capabilities (breaking)

- Sectioned binary layout, so a save rewrites the data section instead of the
  whole file, and a runner can validate a large file by reading a footer.
- COSE_Sign1 over a CBOR manifest, replacing our hand-rolled canonical string.
  Standard canonical form, algorithm agility, existing verifiers everywhere.
- The whole manifest comes under the signature. `documentUuid` already is, but
  `appName`, `favicon` and `integrityPolicy` are not, so a container can be
  renamed or re-iconed without breaking its signature — which is most of what
  an impersonation attempt needs.
- Capabilities as unforgeable `MessagePort` handles rather than permission
  strings: declared in the signed manifest, granted by the host, exercised only
  over a transferred port. `net.fetch` never exists.
- Generation chain in a host-computed footer. A digest computed by the thing
  being measured is not a measurement.

Doing this while the installed base is approximately zero is the whole
argument for doing it now. Every month it waits, it gets more expensive.

### 0.4 — Persistence you can defend

- Migration model: `_dai_meta`, migrations signed with the code, forward-only,
  and a read-compat rule that opens read-only rather than silently downgrading.
- **A schema-diff gate in the compiler.** If the schema changed and no migration
  bumps the version, the build fails. This is the only reliable defence against
  a model-authored v2 destroying a user's v1 data, and it is the failure mode
  most likely to actually hurt somebody.
- Corruption detection and recovery, with distinct refusal codes for recovered
  and unrecoverable.
- Locking: Web Locks in the desktop shell, an advisory lock file across
  processes.
- Chunked saves over transferable buffers, replacing the current five copies.

### 0.5 — A synthesis profile

Can start immediately and in parallel; it depends on none of the above.

- A source bundle format — one plain-text file with fenced sections — as the
  thing a model emits, with a published grammar so the parts that break can be
  grammar-constrained.
- A small kit (about a dozen primitives) with declarative SQL-bound elements,
  so a model emits HTML and SQL rather than a state machine.
- `dai check --json` for machine-readable diagnostics, and fixtures so agents
  can run an app headless and assert on database state.
- A public evaluation: several hundred prompts, build-success rate, run against
  the major models, results published. That is the credibility artifact for
  this whole line of work.

### 0.6–0.8 — A second implementation

Spec frozen and rewritten in RFC style with CDDL for the CBOR structures. An
independent runner built by someone outside this project. A conformance suite
in the Web Platform Tests style. A W3C Community Group, and an IETF Independent
Submission for the container format.

### 1.0

Two interoperable implementations, conformance suite passed by both, published
security review, registered media types, and the spec and trademark moved to a
foundation. The certification mark stays with the foundation; the commercial
product competes on service rather than on control of the format, which is the
only arrangement enterprises accept.

---

## Where I would diverge from the review

**Synthesis should start now, not at 0.5.** The review sequences it fifth. It
depends on nothing else — it is a new front end over the same compiler — and it
is where the product value is. Starting it in parallel costs nothing and the
grammar work informs the manifest design.

**The viewer/editor split should be decided before 0.2, not discovered during
0.4.** It changes what the site says and what the desktop app is for.

**Trademark separation is cheap and should not wait for 1.0.** Moving the spec
to a foundation is a 1.0-sized undertaking; registering the mark and keeping it
separate from the company is a form and a fee.

**The review is scoped for a funded team.** Taken literally it is roughly a
year of full-time work for several people. That is the right shape for a
standards-track format and the wrong shape for what exists today, which is one
person and an assistant.

---

## If only a fifth of this gets done

In order, stopping whenever time runs out:

1. **Fix the three claims** (0.1.1). Hours. Removes the only dishonesty on the
   site.
2. **Drop `allow-same-origin` and the other sandbox flags** (0.2, partial).
   This is the loader rewrite and it is the difference between a real isolation
   boundary and a decorative one.
3. **The schema-diff gate** (0.4, partial). Cheap to build, and it prevents the
   failure that would cost a real user real data.
4. **Bring the whole manifest under the signature** (0.3, partial). Today only
   the UUID, the entry digests and the expiry are covered, so a container can
   be renamed and re-iconed without breaking its signature. Closing that does
   not require the full container rewrite.

Everything else — the sectioned container, COSE, capabilities, the second
implementation, the standards track — is what you do once something is being
used enough that breaking it is expensive. None of it is wrong. All of it is
premature until the first four are done.


---

## The five things that have to be true before approaching the industry

Asked directly: what stands between here and being taken seriously as a
standard rather than as one company's file format. These are ordered, and the
order is load-bearing — each one is a precondition for the next being
believable.

### 1. The isolation boundary has to be real, and reviewed by someone else

Everything else is moot. The first competent reviewer opens the bootloader,
reads the sandbox attribute, and stops. `allow-same-origin` means the
application shares an origin with the shell that is meant to contain it; a
format whose central claim is containment cannot ship that.

The work is the loader rewrite described under 0.2 — the frame minting its own
blob URLs from transferred bytes — followed by dropping the flags. Then an
external red-team engagement, and the report published whatever it says.

**Done when:** a paid external review finds no exfiltration path from a
conforming runner beyond residuals that are documented in the spec.

### 2. Standard crypto framing, and a manifest that is signed in full

`"dai-v1
" + uuid + digests` is the kind of construction standards reviewers
reject on sight, not because it is broken but because it is unnecessary — COSE
(RFC 9052) exists, is canonical, carries algorithm and key identifiers, and has
verifiers in every language. Ours has one implementation and no reviewers.

The substantive half is that only the UUID, entry digests and expiry are signed
today. A CBOR manifest signed whole closes that, and it is a precondition for
capabilities: a capability declared in an unsigned field is not a declaration,
it is a suggestion.

**Done when:** a container verifies with an off-the-shelf COSE library nobody
here wrote.

### 3. The container layout is frozen — after the change that makes it last

You cannot standardize a format you intend to break, and the current one has a
break coming: every save rewrites the entire file, base64 and all, which has no
future past a few tens of megabytes and no story for two windows on one
document.

Do the sectioned layout, then freeze. Doing it in the other order means asking
early adopters to migrate, which is exactly how a format loses the people who
took a chance on it.

**Done when:** a save touches only the data section, and a runner can validate
a two-gigabyte file by reading its footer.

### 4. A specification that prescribes rather than describes

Ours documents how the implementation behaves. A standard states what an
implementation MUST do, in the vocabulary reviewers expect: RFC 2119 keywords,
CDDL for the CBOR structures, the exact sandbox flag set, the exact CSP, and a
registry of refusal codes with their meanings.

The test of whether a spec is finished is not whether it reads well. It is
whether somebody can implement from it **without reading our code** — which is
what the next item measures.

**Done when:** every normative requirement has a MUST/SHOULD/MAY, and every
structure has a formal grammar.

### 5. A conformance suite, and a second implementation written only from the spec

This is the bar every standards body applies, and it is the one that cannot be
faked. A suite of a few hundred cases across packaging, crypto, sandbox,
persistence and the bridge — as data, not as our test framework, so anybody can
run it against anything.

Then a second implementation. The value is not the second implementation; it is
that writing one from the spec alone is the only reliable way to discover the
spec is wrong. Every ambiguity surfaces as a disagreement between the two.

**Done when:** two implementations that share no code pass the same suite, and
a file written by either opens in the other.

---

### What not to do first

Not approach a standards body before these exist. A W3C Community Group or an
IETF submission will ask for precisely these artifacts, and arriving without
them spends the only first impression available. The sequence is: make it true,
write it down, prove it twice, then go.
