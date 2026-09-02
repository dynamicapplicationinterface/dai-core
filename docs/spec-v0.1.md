# DAI Protocol — v0.1 Core Specification

**Status:** implemented and verified by the suite in `tests/`.

This document describes the container as it actually behaves. Where the original
draft described something that turned out not to work, the draft is corrected
here and the reason is recorded — the earlier text is not preserved.

---

## 1. Architectural constraints

- **Air-gapped.** `connect-src 'none'` is absolute: no fetch, XHR, WebSocket,
  EventSource or beacon can leave a container. There is no networked mode.
- **Immutable application.** No over-the-air logic updates. A changed
  application is a new document with a new UUID and a new signature. Only
  `document.sqlite` changes over a document's life.
- **Bundled engine.** `sqlite3.wasm` (865 KB) and its Emscripten glue (579 KB)
  are embedded in every container. Shared runtime assets are rejected so a file
  stays portable with zero dependencies.
- **Universal persistence.** `showSaveFilePicker` is attempted first, falling
  back to an `<a download>` trigger where it is unavailable.

### Correction: no Service Worker

The v0.1 draft proposed a Service Worker to intercept requests for packaged
assets. **This cannot work.** Service Workers are unavailable on `file://`,
which is the primary way a container is opened — a double-click from a desktop.
No flag or packaging trick changes this.

The runtime uses a **sandboxed iframe with `srcdoc`** instead. See §3.

---

## 2. Content Security Policy

The policy below is what containers ship. It is stored in the shell, and every
directive names only origin-local schemes.

```
default-src 'none';
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:;
style-src 'self' 'unsafe-inline' blob:;
img-src 'self' data: blob:;
font-src 'self' data: blob:;
media-src 'self' data: blob:;
frame-src 'self' blob:;
worker-src blob:;
connect-src 'none';
form-action 'none';
base-uri 'none';
object-src 'none';
```

### Correction: `blob:` is required

The draft's policy was `default-src 'none'; script-src 'self' 'unsafe-inline'
'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none';`.
Under it a container cannot run at all: with `default-src 'none'` there is no
`frame-src`, so the bootloader cannot frame the application, and without `blob:`
on `script-src`/`style-src` it cannot load a single packaged asset.

`blob:` sources are origin-local object URLs minted from the embedded payload.
They cannot reach a remote host, so admitting them does not weaken the air gap.

**`connect-src 'none'` is unchanged and is the invariant.** A test asserts that
opening a container and booting SQLite produces zero non-`blob:`/`data:`/`file:`
requests. Never add a scheme that can reach a network host.

`'unsafe-eval'` is deliberately **not** granted; the runtime is written to avoid
needing it.

---

## 3. Execution model

The bootloader decodes the payload, unzips it in memory, converts assets to
`blob:` URLs, and mounts the application in a sandboxed iframe via `srcdoc`.

Two problems make this more than wrapping bytes in blobs, both found by running
a real Vite + React build:

1. **`import.meta.url` is unusable.** Vite resolves siblings with
   `new URL(dep, import.meta.url)`. Inside a blob module `import.meta.url` is
   `blob:null/<uuid>` — an opaque path that throws when parsed as a base, before
   `dep` is even considered. It is rewritten to a parseable placeholder.
2. **The chunk graph is cyclic.** A lazily imported chunk imports shared code
   back from the entry chunk. A blob's content is frozen at creation, so no
   ordering of blob creation satisfies both directions. Chunk references are
   rewritten to placeholder URLs known before any blob exists, and an **import
   map** in the iframe redirects each placeholder to its blob.

Relative specifiers cannot simply be mapped: they resolve against the importing
module's base URL *before* the import map is consulted, so a blob module throws
first. The specifiers must be rewritten; the import map only breaks the cycle.

The frame is sandboxed `allow-scripts allow-same-origin …`. `allow-same-origin`
is required — blob URLs minted by the host are unreachable from an opaque-origin
frame. **This means the sandbox is not a security boundary**; it exists to scope
the application, not to contain it.

---

## 4. SQLite

The engine is handed to the application as an **`ArrayBuffer`, never a URL**.
`WebAssembly.instantiateStreaming` is defined in terms of a fetched `Response`,
and `connect-src 'none'` neutralizes fetch, so streaming instantiation cannot
work in a container by construction.

`initSqlite()` passes Emscripten an `instantiateWasm` hook that compiles the
embedded bytes directly, so `locateFile()` is never consulted. A `locateFile`
that throws is installed as a backstop, turning any silent fallback into a loud
failure.

Emscripten probes OPFS at startup, which rejects on an opaque origin. Those
rejections are suppressed during boot so they cannot abort it; the in-memory VFS
is used, seeded with `sqlite3_deserialize` and read back with
`sqlite3_js_db_export`.

### Page size

New databases are pinned to **4096-byte pages**. SQLite's default varies by
build — this engine defaults to 8192 — so leaving it implicit makes a document's
geometry an accident of whichever engine first wrote it. `PRAGMA page_size` only
applies while a database is empty, so it runs before anything creates a table.

A seeded database keeps the page size its bytes declare; the pragma cannot alter
an existing file, and silently rewriting a document's geometry would be worse
than honouring it.

One trap worth recording: immediately after `sqlite3_deserialize`,
`PRAGMA page_size` reports the *connection's* default rather than the file's,
until something reads the file. `openDatabase()` touches the schema so the value
is truthful.

---

## 5. Distribution format

```
[app-name].dai.html
├── <meta name="dai-integrity" content="required">
├── <meta name="dai-public-key" content="<base64 SPKI>">
├── <script id="dai-bootloader">   the runtime
└── <script id="dai-payload">      base64 of a ZIP archive:
    ├── app/**                     compiled application
    ├── runtime/sqlite3.wasm       engine
    ├── runtime/sqlite3.mjs        Emscripten glue
    ├── runtime/container.html     this container's own shell
    ├── runtime/manifest.json      identity, digests, signature
    └── document.sqlite            the database
```

### Self-perpetuating saves

`runtime/container.html` is the container's own shell with its bootloader
inlined. A save rebuilds the file from that embedded copy, never from the
installed compiler, so a document keeps the runtime semantics it was compiled
with for its whole life instead of drifting toward a later version.

Saving runs in the top document, not the sandboxed frame: `showSaveFilePicker`
needs a non-sandboxed context and its own user activation.

`saveState` resolves `{saved, method}` where method is `picker`, `download`,
`cancelled` or `unsupported`. A dismissed dialog and an engine with no picker
are both reported rather than resolving silently — either would otherwise look
identical to a successful write and drop the user's data without a word.

---

## 5a. App Mode and desktop launchers

The shell renders an **Enter App Mode** control that takes the container
fullscreen. The control belongs to the shell, and the frame is served
`allow="fullscreen 'none'"`: a same-origin frame inherits the permission by
default, which would let the application seize the viewport on any gesture it
happened to receive. The app observes state through `dai.appMode` and
`dai.onAppModeChange()` but cannot request it. The control stays visible while
fullscreen, because Escape is not a discoverable exit.

Optional `.bat` and `.command` launchers open a container in a chromeless
Chromium app window, locating it relative to themselves so the pair stays
portable. Both fall back to a plain windowed open when no Chromium browser is
present.

The shell also carries the iOS standalone tags, so a container served over
HTTPS is Add to Home Screen ready. They are inert over `file://`.

---

## 6. Cryptographic trust model

Two separate properties, with genuinely different strengths. Conflating them
would overstate what a container proves.

### Integrity — self-contained, and solid

`runtime/manifest.json` holds a SHA-256 digest of every other entry. The
manifest cannot cover itself: a digest cannot include the field that holds it.

Verification is **bidirectional**. Every payload entry must appear in the
manifest with a matching digest, *and* every manifest entry must exist in the
payload. Checking one direction alone would let content be added freely.

The bootloader verifies **before** it blobs, frames or executes anything. A
check that races the mount is worthless. On failure it reports what changed and
stops, creating no iframe at all.

**Enforcement lives in the shell, not the payload.** The compiler writes
`<meta name="dai-integrity" content="required">` into the container itself. A
policy stored inside the archive it governs could be switched off by the same
edit that alters the archive. Editing `verifyIntegrity` in the manifest changes
nothing, and a container whose manifest has been *removed* is refused rather
than treated as unsealed — otherwise stripping the seal would be the easiest
bypass available.

This catches accidental corruption and any modification by someone who does not
re-seal. It does **not** stop someone who recomputes the digests.

### Authenticity — needs something from outside the file

Containers are signed with **ECDSA P-256 / SHA-256**. The private key signs at
compile time and never enters a container; the public key is written into the
shell, because the signature covers the shell's own digest and a key inside the
signed set could not be written before signing.

**The signature covers the application and runtime, not `document.sqlite`.** The
application is immutable (§1) while the database is not, and a container carries
no private key to re-sign with. Signing the whole payload would mean the first
save destroyed the publisher's claim forever. Signing the immutable half keeps
it verifiable for the document's whole life; the database remains covered by
`hashes`.

`signedEntries` is re-checked against `hashes` at verification time, so a
signature can never be validated over digests different from the ones just
integrity-checked. A container that ships a public key must satisfy it: an
unsigned or unverifiable payload refuses to mount rather than running with a
decorative key.

#### The outer shell is not self-verifiable

A container's integrity check runs inside its own bootloader. An attacker who
edits the outer shell — to set `dai-integrity` to `advisory`, or to remove the
check — is audited by the code they just rewrote, so the file mounts and reports
itself as fine.

The payload does contain a sealed copy of the shell at `runtime/container.html`,
which makes the tampering *detectable* — but only by something outside the
container. `apps/runner` performs that comparison before mounting. A container
opened directly from disk cannot.

#### What this does not prove

A container is self-contained, so **an attacker can replace the public key in
the shell and re-sign the payload with their own key.** Nothing inside the file
can detect this — the file would be internally consistent and would mount.

Therefore a signature alone does not establish who published a document. It
proves only that the application and runtime were signed by whoever holds the
key *currently embedded in that file*, and that nothing has changed since.

To establish publisher identity, a reader must compare
`window.dai.publicKeyFingerprint` against a fingerprint obtained **out of
band** — from a website, a package registry, a key server, a printed card.
Publishers should publish their fingerprint somewhere users can check it.

Integrity is self-contained. Authenticity is not, and no amount of in-file
cryptography can make it so.

---

## 7. Verified behaviour

`npm test` drives Chromium, Firefox and WebKit against a real build artifact
over `file://`. Coverage includes: mounting across the cyclic chunk graph with
zero console errors; the zero-network guarantee; SQLite create/insert/select;
every save outcome; a save/reopen round trip; page-size stability; tamper
detection; the shell-policy bypass attempts; and a forgery in which the attacker
swaps the application and recomputes every digest correctly — defeating
integrity entirely, and caught only by the signature.

Planned work on both of these is recorded in [backlog.md](backlog.md).

### Known limits

- In-place overwrite is Chromium-only. Firefox and Safari take the download
  fallback: data persists, file identity does not.
- No key rotation or revocation.
- The sandbox is not a security boundary (§3).
- The manual double-click path is verified by hand, not by CI: the picker's
  success path needs a real user gesture, so automation drives a stand-in.
