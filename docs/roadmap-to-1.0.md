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

## The five engineering jobs before we approach anyone

The review read the published specification and the site, not the source —
which is why three of its claims did not survive contact with the code. Taken
as a reading of our documents it is sharp and largely right. Taken as a list of
work, it is weighted toward writing things down, and the problem is not that
our documents are unconvincing. It is that two of the properties they describe
are not yet enforced by the implementation.

So these are jobs, in dependency order, each with a condition that a machine
can check.

### 1. Get the test suite passing where it runs — **done**

I described this as "every run in this repository's history is red", which was
wrong: 36 of 60 had passed, and the suite had recovered from two earlier breaks
on its own. Querying the Actions API instead of reading a screenshot of recent
runs gives the real story, and it is less flattering.

It broke at `86a2cd6` — the commit that added the MCP server's tests — and
stayed broken for thirteen commits, during which "506 passing" was reported
each time from a local run. Three tests asserted a lower-case filename the
compiler never produces: with no `outputPath`, the name comes from the appName
as `sanitizeFileName` leaves it, so `"Notes"` yields `Notes.dai.html`.
`existsSync` is case-insensitive on Windows and case-sensitive on Linux.

One of the three could not fail on Linux at all — it asserted the *absence* of
a file under a name the compiler would never write, so it would have passed
however wrong the code became. A test that cannot fail is worse than no test,
because it is counted.

Underneath sat a flake: two specs waited on an `<h1>` and then asserted on a
row with the default five-second timeout. The heading is static markup and
renders even when the application never ran, while the row cannot exist until
SQLite has booted, which takes longer than five seconds on a cold runner.

**The lesson worth keeping** is not about case sensitivity. A green local run
is evidence about one machine. The Actions API answers "did it pass where it
matters" without authentication — the jobs endpoint names the failing step and
the check-run annotations name the failing assertion — so there is no excuse
for reporting local results as if they settled the question.

### 2. Rewrite the loader so the frame can lose `allow-same-origin`

The isolation boundary is the central claim and it is not currently enforced.
The obstacle is concrete: the import map, the chunk graph, the SQLite engine
and its Emscripten glue all reach the frame as `blob:` URLs minted by the
shell, and those only resolve when the origins match. The frame has to mint its
own from bytes handed over by structured clone.

Then `allow-popups`, `allow-downloads` and `allow-modals` go too — the first is
an exfiltration channel that no CSP directive governs.

**Done when:** the frame runs at an opaque origin, cannot reach
`parent.document`, and a test asserts both.

### 3. Remove `'unsafe-inline'` from the shell's CSP

The compiler knows every byte it packages, which is exactly the condition under
which a nonce is straightforward: rewrite inline script in the application's
HTML to blob modules at build time, generate a nonce per boot, and drop both
`'unsafe-inline'` and `'self'` — the latter being ill-defined at an opaque
origin anyway.

This closes injected-script attacks through content stored in the database,
which is a live path today: an application that renders a task title as HTML
executes whatever the title contains.

**Done when:** the policy is `script-src 'nonce-…' 'strict-dynamic'
'wasm-unsafe-eval'`, and a container whose database contains a `<script>` tag
cannot execute it.

### 4. Sign the whole manifest, using an envelope somebody else wrote

Only the UUID, the entry digests and the expiry are covered today. `appName`,
`favicon` and `integrityPolicy` are not, so a container can be renamed and
re-iconed while its signature still verifies — most of what impersonating a
publisher requires.

Fixing the coverage and adopting COSE_Sign1 over a CBOR manifest is the same
piece of work, and the second half has an engineering payoff rather than a
diplomatic one: correctness becomes checkable against an implementation we did
not write.

**Done when:** a container verifies with an off-the-shelf COSE library, and
altering any manifest field breaks it.

### 5. Make a save stop rewriting the entire file

Today every save exports the database, deflates it, base64-encodes it, splices
it into a string of HTML and structured-clones the result: five copies and time
proportional to the whole document, for a change of one row. It stalls
perceptibly around twenty megabytes and has no answer for a second window.

The sectioned layout fixes it, and it is the last change that breaks the format.
Everything after it is additive, which is the precondition for freezing
anything.

**Done when:** saving a one-row change to a hundred-megabyte document writes
only the changed section, and two windows on one document cannot corrupt it.

---

### Then, and only then

A conformance suite as data, and a second implementation written from the
specification without reading ours — which is the only reliable way to find out
the specification is wrong. Both are wasted effort before the format stops
moving, and the format cannot stop moving until item 5 lands.

Approaching a standards body earlier spends the one first impression available
on a format that still has a breaking change queued.


---

## Runner strategy

A second round of review argues that the outcome is decided by runners rather
than by the format: one file and a family of runners — a phone app that owns
the `.dai` type, a desktop app that saves in place, a web opener at an HTTPS
origin, one engine underneath, and the trust and fleet layer as the thing you
charge for.

As a destination that is right, and it matches where the commercial thinking
had already landed. Three points of sequencing are worth arguing, because the
difference between them is months of work by one person.

**The web opener already exists, and is unshipped.** `apps/runner` is a PWA
with OPFS persistence and a service worker, carrying its own deployment
config, described in its own manifest as being for "a device that cannot
execute them from the filesystem". It was built for phones and never deployed.
It now also declares `file_handlers` and a `share_target`, which is what
offers it when a container is tapped and what puts it in an Android share
sheet.

That makes it the cheapest way to find out whether anybody wants this on a
phone: days, no review queue, and it works on iOS today through the file
picker. Writing two native applications first is the expensive way to learn
the same thing.

**The App Store risk is asserted away.** "Apple will never let a `.dai.html`
execute from Files; it will happily let your app register the `.dai` type" is
confident in both directions. Running JavaScript in a WebView is ordinary and
permitted; an application whose stated purpose is executing arbitrary code a
user received in a message is a review conversation, not a formality. One
TestFlight build settles it. Discovering it after building for two platforms
does not.

**A Rust core is the right engine at the wrong moment.** There is one
implementation today, in TypeScript, driving five front ends and covered by
the suite. A second implementation is genuinely valuable — writing one from
the specification is how you find out the specification is wrong — but the
format still has a breaking change queued in container v2. Writing it before
the format freezes means writing it twice.

**`.dai` as canonical is right, and follows the container work rather than
leading it.** The binary form is what mail gateways pass and what a phone app
claims. Demoting `.dai.html` before a runner exists on the platforms where
`.dai` needs a handler would cost the zero-install demonstration and buy
nothing.

So the order I would take it: deploy the opener that already exists, let it
declare the type, and find out whether files actually get opened on phones. If
they do, that is the evidence that justifies a native runner and the traffic
that justifies the Rust core. If they do not, two app-store applications would
not have changed it.
