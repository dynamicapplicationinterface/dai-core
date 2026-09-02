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

## Extension points a host may build on

The protocol deliberately exposes what a sophisticated host needs, without
requiring any of it:

- **`documentUuid`** — stable across saves, distinct per application version.
  The identifier for anything that tracks documents over time.
- **`payloadFingerprint`** — one value standing for the whole verified payload.
  Comparable between parties without exchanging a digest table.
- **Publisher key and signature** — proof the application and runtime were signed
  by whoever holds a given key.
- **The host bridge** (`DAI_HOST_HANDSHAKE`, `DAI_HOST_SAVE`) — a host learns
  when a cartridge mounts and when it wants to persist, and can refuse either.
- **Trust pinning** — the desktop host records the key a document was first seen
  with, and refuses a later copy signed by another. See `backlog.md` §2.

A host that adds directory-backed key distribution, richer logging, or policy
enforcement does so entirely on its own side of that boundary. Cartridges do not
change, and a cartridge built today keeps working under a host built later —
which is the point of sealing the runtime into the document.

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
