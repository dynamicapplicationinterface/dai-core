# Roadmap

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
| `DAI_HOST_HANDSHAKE` | `documentUuid`, `verified`, `payloadFingerprint` | After the cartridge has verified itself and mounted its application |
| `DAI_HOST_SAVE` | `html`, `databaseBytes`, `documentUuid` | When the application asks to persist |

Host to cartridge:

| Message | Payload | Meaning |
|---|---|---|
| `DAI_HOST_HANDSHAKE_ACK` | — | A host is present. Until this arrives the cartridge assumes none, and saves through the browser instead |
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

### Hooks needed for observation

Three gaps, none of which require the cartridge to reach anything:

1. **Refusal reporting.** The bootloader has thirteen paths that stop before
   mounting — failed digests, a rewritten shell, an unverifiable signature, no
   WebCrypto — and none tells the host. It writes into its own DOM and stops,
   leaving the host to guess from silence. Refusals are the entries an audit
   trail most needs, so the cartridge should post `DAI_HOST_REFUSED` with a
   reason code before it gives up. A host still records its own verdict; this
   turns "nothing happened" into "it stopped, and here is what it objected to".

2. **Lifecycle.** There is no message for a cartridge being closed or replaced,
   so a host can log an open with no matching close. `DAI_HOST_CLOSING` on
   unload, best-effort, makes session duration reportable.

3. **Protocol version.** The handshake carries no version, so a host cannot tell
   which bridge a cartridge speaks. This has already caused a live failure: an
   older cartridge sent `databaseBytes` with no `html`, and the host could only
   report the symptom. A `bridgeVersion` in the handshake turns that into a
   precise message, and lets a host support several vintages deliberately.

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

1. **Back up before an in-place save.** `save_cartridge` renames over the
   original. The database has no copy anywhere else, so a bad save is
   unrecoverable — as is a delete, which we have already seen happen. Writing
   `name.dai.bak` alongside before the rename costs one file and covers the
   overwrite case.
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
   injectable. Surfacing them through the CLI lets a third party rebuild a
   cartridge and compare it byte for byte against a published one — the strongest
   answer available to "is this really built from that source".
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
