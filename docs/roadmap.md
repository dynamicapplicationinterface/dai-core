# Roadmap


> The phased plan from 0.1 to 1.0, written after an external
> architectural review, is in [roadmap-to-1.0.md](roadmap-to-1.0.md).
> This document remains the reference for the invariant, the tenets and
> the host bridge.

The open-source protocol, its runtime, and the developer tooling around them.

---

## The invariant everything else is built around

`connect-src 'none'`. A cartridge cannot open a network connection, and no
version of this protocol will change that. It is the property that makes a
cartridge safe to open from an email attachment, a USB stick, or a decade-old
backup, and every other feature is negotiable before this one.

This has a consequence worth stating plainly, because it constrains anything
built on top: **a cartridge cannot report on itself.** It cannot phone home, log
that it was opened, check for updates, or tell anyone who read it. Any feature
that needs those things belongs to the *host* — the desktop application, the web
player, whatever program opened the file — and not to the format.

That boundary is not a limitation to work around. It is what makes the two
layers separable at all: the format stays inert and portable, hosts differ in
what they observe and enforce, and a cartridge behaves identically whether it is
opened by a bare browser or by something far more opinionated.

## Two tenets

Both were learned by getting them wrong first, and both are easy to undo by
accident, so they are stated plainly rather than left implicit in the code.

### A cartridge reports claims; a host records findings

A cartridge may report only what it can compute from itself — `DIGEST_MISMATCH`,
`UNVERIFIED_SIGNATURE`, `KEY_EXPIRED`. Those are **claims**, and a host logs them
as such: a hostile cartridge can say anything, so a host that records
`verified: true` because a cartridge said so has recorded nothing.

Anything a cartridge cannot know about itself is a **host finding**, recorded in
the host's own vocabulary — `SHELL_TAMPERED`, `KEY_REVOKED`, and any policy
outcome. A host must not push that knowledge inward so the cartridge can echo it
back: the echo would add a channel, add a way to be wrong, and credit the
detection to the party unable to make it.

The test is simple. If the cartridge would need something outside itself to know
it, the cartridge must not be the one saying it.

### The clock is a guard, not a control

`validUntil` stops an honest host running stale code on a synchronised clock.
It cannot stop someone who sets their clock back, and no offline format can — so
it is an integrity guard, not enforcement.

Perpetual remains the default. A container with no expiry runs forever, which is
what the format promises about an archived document, and an expiry cannot be
renewed without the signing key.

Offline grace periods and revocation lists are **host governance**, external to
the format, and must never become something a cartridge consults or depends on.

## The host bridge

A cartridge speaks to exactly one party: the window that framed it, over
`postMessage`. That is not a network connection — it is same-machine, in-process,
initiated by the cartridge, and reaches only a host that already had the file.
It is how a cartridge can be observed without being able to observe anything
back.

### What exists today

Cartridge to host:

| Message | Payload | When |
|---|---|---|
| `DAI_HOST_HANDSHAKE` | `bridgeVersion`, `documentUuid`, `verified`, `payloadFingerprint` | After the cartridge has verified itself and mounted its application |
| `DAI_HOST_SAVE` | `html`, `databaseBytes`, `documentUuid` | When the application asks to persist |
| `DAI_HOST_REFUSED` | `bridgeVersion`, `reason`, `message`, `detail`, `documentUuid` | The cartridge stopped before mounting. Sent without waiting for a handshake, because a refusal happens before one |
| `DAI_HOST_CLOSING` | `bridgeVersion`, `documentUuid` | The document is going away. Best-effort |

Host to cartridge:

| Message | Payload | Meaning |
|---|---|---|
| `DAI_HOST_HANDSHAKE_ACK` | `bridgeVersion` | A host is present. Until this arrives the cartridge assumes none, and saves through the browser instead |
| `DAI_HOST_SAVE_ACK` | `status`, `error` | Whether the write happened. `status: "ok"` on a save that did not occur is the worst available lie: the application stops offering to save |

The handshake is deliberately an acknowledgement rather than an announcement. A
cartridge that assumed a host merely because it was framed would post into
silence inside an ordinary web page, and hang waiting for a reply.

### What a host may treat as evidence

Everything in these messages is a **claim by the cartridge**, and a hostile
cartridge can say anything. A host that logs `verified: true` because a cartridge
said so has logged nothing.

The host verifies the same file independently, with a separate implementation, so
its own verdict is the one worth recording. The cartridge's `payloadFingerprint`
is useful precisely because it can be *compared* against the host's — agreement
means two independent verifiers saw the same bytes; disagreement means drift and
stops execution. Neither value is evidence alone.

### Refusal reasons

Every path that stops a cartridge before it mounts reports one of these. They are
codes rather than prose so a host can record and count them without parsing
sentences that may be reworded later.

| Reason | Meaning |
|---|---|
| `NO_PAYLOAD` | No payload element. Probably not a cartridge |
| `PAYLOAD_UNREADABLE` | The payload did not decode or unzip |
| `MANIFEST_UNREADABLE` | The manifest is not valid JSON |
| `MANIFEST_MISSING` | Verification is required and there is no manifest |
| `UNSUPPORTED_ALGORITHM` | The manifest names a digest algorithm this runtime does not implement |
| `UNSUPPORTED_CRYPTO` | No WebCrypto. Not a secure context |
| `DIGEST_MISMATCH` | An entry does not match the manifest, or is absent from it |
| `SIGNATURE_UNVERIFIABLE` | A publisher key is present but there is nothing to check it against |
| `UNVERIFIED_SIGNATURE` | The signature does not match the key the cartridge carries |
| `NO_APPLICATION` | Verified, but there is no application entry point |
| `KEY_EXPIRED` | The manifest carries a `validUntil` that has passed |
| `MOUNT_TIMEOUT` | The application never reported that it started |
| `BOOT_FAILED` | The bootloader threw |

Two codes are deliberately absent from this list, for the same reason.

`SHELL_TAMPERED` — a cartridge cannot detect its own bootloader being rewritten,
because that check would run inside the code an attacker replaced.

`KEY_REVOKED` — revocation is knowledge from outside the file. A cartridge
carries no revocation list and cannot fetch one, and a host that told a cartridge
it had been revoked would be pushing outside knowledge inward for no benefit,
when it could simply decline to mount it.

Both are **host findings**, recorded as the host's own observation with its own
vocabulary. A host that logged either as something the cartridge reported would
be crediting a detection to the party unable to make it.

### Expiry

A manifest may carry `validUntil`, a Unix timestamp after which hosts refuse to
run the container. It is optional and omitted by default: a cartridge with no
expiry runs forever, which is what the format promises about an archived
document.

**It is covered by the signature.** No other manifest field is — the manifest is
excluded from its own digests — so an expiry left as a plain field could be
extended, shortened or deleted with a text editor. It is appended to the signed
canonical payload only when present, so containers without one produce exactly
the bytes they always did and existing signatures keep verifying.

`validUntil` is an **instant**, not the whole second it names: the check is
`Date.now() > validUntil * 1000`. A container stamped with the current second is
already past it by however many milliseconds have elapsed within that second.

Two further properties worth being clear about before anyone relies on it:

- **The clock belongs to whoever opens the file.** This stops an honest host
  running a stale container. It does not stop someone determined to run one, who
  can set the clock back — and no offline format can prevent that. It is policy,
  not enforcement.
- **An expiry cannot be renewed without the signing key.** A container that
  outlives its publisher stops working permanently. That is a real cost, and it
  is why perpetual is the default rather than a fallback.

### Reading a container

Three entry points, with different jobs:

| Function | Answers | On a bad container |
|---|---|---|
| `parseContainer(string \| Uint8Array)` | "what does this claim?" | Throws only if it cannot be read at all |
| `auditContainer(parsed)` | "what is true of it?" | Returns a report. Never throws |
| `verifyContainer(string \| Uint8Array)` | "may it run?" | Throws on the first reason it may not |

`verifyContainer` runs `auditContainer` and throws on what it finds, so there is
one implementation of what checking means and two ways of presenting it. A
second verifier written for a tool would drift, and the drift would surface as a
playground passing a container that a host refuses.

Bytes are accepted as well as text because a container is an HTML document
however it was read. There is deliberately **no bare-archive form**: the shell
carries the publisher key and the integrity policy and is itself sealed inside
the payload, so an archive alone has no key to check a signature against and
nothing to compare a seal to. It could be parsed but never verified, and a
parsed-only result is exactly the thing that gets mistaken for a verified one.

### Versioning

Every message carries `bridgeVersion`, and the acknowledgement carries the
host's. A cartridge keeps the runtime it was compiled with, so a host meets
several vintages at once; a host that finds a version it does not understand
says so rather than guessing. This is not hypothetical — an older cartridge once
sent a database with no document, and without a version the host could report
only the symptom.

### What must not flow the other way

A host must not push organisational identity — user, tenant, licence — into a
cartridge. The cartridge cannot transmit, but it can write to its own database,
and that file is portable by design: identity handed in becomes identity carried
out, in a document the user may forward anywhere.

The reason is the same one that keeps the air gap sacred. A cartridge is safe to
open because of what it *cannot* do, and every capability added to the inbound
direction is a capability an attacker inherits along with everyone else.

---

## Near-term: execution runtime

Ordered by how much they hurt today.

1. **Back up before an in-place save.** **Done.** Both save paths copy a
   document to `name.dai.bak` before the first write of a session, staged and
   renamed so a crash cannot replace a good backup with half of one. Once per
   session rather than per save, because this format expects large files and the
   copy worth having is of the state the window opened.

   The sectioned path needed it because an in-place write is not atomic and the
   previous database is gone the moment the new one starts. The viewer path
   needed it for a different reason: its rename *is* atomic, so the file is
   never half-written, and the version it replaced is gone regardless.

   `save_cartridge_data`, the sectioned path, makes this more pressing rather
   than less: it writes over the database in place, so there is no moment at
   which the previous version exists anywhere. The ordering it guarantees means
   a crash is *reported* rather than silent, which is not the same as
   recoverable. Whatever is done here has to avoid copying the whole file on
   every save, since not copying it is the reason the sectioned form exists.
2. **Trust pinning in the runner.** The desktop host refuses a document re-signed
   by a different key; the web player has the same exposure and no registry.
   `checkTrust` already takes its storage as a parameter, so the decision logic
   moves unchanged and only the backend differs (IndexedDB).
3. **Windows per document.** Single-instance closed the registry race by making
   a second cartridge replace the first. For a document application that is the
   wrong shape; the right one is a window per cartridge with a single owner for
   the registry.
4. **Cross-engine database compatibility.** Page size is pinned at 4096 for new
   databases, but a document written by one engine build and opened by another
   is unverified. Worth a matrix test before anyone keeps years of data in one.
5. **Real Safari and real iOS.** Playwright's WebKit is not Safari; the offline
   path and the download-based save are both unverified on a device.

## Near-term: self-deployment

6. **A command-line compiler.** `buildContainer` is pure and hosted at
   `dai-core/core`, but the only way to drive it is a Vite plugin. A `dai build`
   that takes a directory and emits a cartridge removes the framework from the
   critical path and makes the format usable from any toolchain.
7. **Reproducible builds by default.** `documentUuid` and `now` are already
   injectable, and an unsigned container built twice from identical inputs is
   byte-identical.

   A **signed** container is not, and cannot be made so: ECDSA draws a fresh
   nonce for every signature, so signing the same bytes twice yields two
   different signatures, which changes the manifest, which changes the payload,
   which changes the file. Byte comparison is therefore the wrong test for a
   signed cartridge. The right one compares the *payload fingerprint* — the
   document UUID and the entry digests — which is stable across builds and is
   already computed by `payloadFingerprint`. A CLI should surface that rather
   than inviting a comparison that will always fail.
8. **Publish the runner.** The player is the answer for platforms that cannot
   execute a cartridge from the filesystem. It is written and tested and has no
   home.

## Documented limits, not yet scheduled

Recorded in `backlog.md` and `docs/spec-v0.1.md`:

- Publisher identity is not established by a signature alone; trust-on-first-use
  covers revisions of a known document and nothing else.
- The outer shell is not self-verifiable; only a separate reader can check it.
- The iframe sandbox scopes the application, it does not contain it.
- In-place overwrite is Chromium-only; other engines take a download fallback.
