# dai-core

Compiles a web application into a single air-gapped file (`my-app.dai.html`)
that holds the app, a SQLite engine and its data. It opens by double-clicking
in any browser with nothing installed, works offline, cannot reach the network,
and refuses to run if it has been altered.

The protocol is specified in [docs/spec-v0.2.md](docs/spec-v0.2.md), which
documents the container as it actually behaves. v0.1 is superseded and kept
only as the record of what an earlier review read.

## Installation

```bash
npm install dai-core
```

Two commands come with it:

```bash
npx dai build ./dist -n "My App"    # compile a folder into one file
npx dai verify my-app.dai.html      # check one that already exists
```


Or from a checkout, while working on the compiler itself:

```bash
git clone https://github.com/dynamicapplicationinterface/dai-core
cd dai-core && npm install && npm run build
```

There is also an MCP server, so an assistant can produce a container directly,
and a [desktop app](apps/desktop) and [website](https://dynamicapplicationinterface.io/make-your-own)
for people who would rather not use a terminal at all. See
[docs/making-files](website/docs/making-files.md) for all of them.

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dai from "dai-core";

export default defineConfig({
  // Required: the container runs from file://, so asset URLs must be relative.
  base: "./",
  plugins: [react(), dai({ appName: "my-doc", sqlitePath: "document.sqlite" })],
});
```

`vite build` writes `dist/` as usual, then emits `my-doc.dai.html` in the project
root.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `appName` | `package.json#name`, else dir name | Container base name and `<title>` |
| `outDir` | project root | Where the `.dai.html` is written |
| `sqlitePath` | – | Seed SQLite document; absent ⇒ zero-byte entry |
| `sqliteEntryName` | `document.sqlite` | Archive path for the document |
| `sqliteWasmPath` | auto-detected | SQLite engine to embed; falls back to `@sqlite.org/sqlite-wasm` in node_modules |
| `wasmEntryName` | `runtime/sqlite3.wasm` | Archive path for the engine |
| `appEntryPrefix` | `app` | Archive prefix for the compiled app (spec `/app`) |
| `compressionLevel` | `9` | fflate deflate level, 0–9 |
| `templatePath` | bundled `template.html` | Alternative bootloader |
| `favicon` | default DAI SVG icon | Custom Base64 PNG or SVG Data URL for title bar / tab icon |
| `emitLaunchers` | `false` | Also write `.bat` and `.command` App Mode launchers |

## Archive layout

```
app/index.html
app/assets/*
runtime/sqlite3.wasm     (when an engine is found)
runtime/sqlite3.mjs      (the Emscripten glue)
runtime/container.html   (this container's own shell)
runtime/manifest.json    (identity + digests)
document.sqlite
```

## Integrity and identity

`runtime/manifest.json` carries a v4 `documentUuid` minted at compile time and a
SHA-256 digest of every other entry:

```json
{
  "manifestVersion": 1,
  "documentUuid": "ff251284-e266-4a8f-802c-65ba3aa28337",
  "algorithm": "SHA-256",
  "verifyIntegrity": true,
  "hashes": { "app/index.html": "…", "runtime/sqlite3.wasm": "…" }
}
```

The manifest cannot cover itself — a digest cannot include the field holding it
— so it is excluded and everything else is checked. An entry present in the
payload but absent from the manifest counts as tampering just as much as a
mismatched digest, otherwise content could be added freely.

The bootloader verifies before it blobs, frames or executes anything: a
verification that races the mount is worthless. On failure it reports what
changed and stops, leaving no iframe at all.

Enforcement is decided by the **shell**, not the payload — the compiler writes
`<meta name="dai-integrity" content="required">` into the container itself. A
policy stored inside the archive it governs could be switched off by the same
edit that alters the archive, so the manifest has no say: editing it to
`verifyIntegrity: false` changes nothing, and a container whose manifest has
been *removed* is refused rather than treated as unsealed. `verifyIntegrity:
false` at compile time emits `content="advisory"` instead.

## Publisher signatures

```bash
node scripts/generate-key.mjs        # ECDSA P-256 key pair
```

```ts
dai({ signingKey: "dai-signing-key.pem" })
```

The private key signs at compile time and never enters a container; the matching
public key is written into the shell as `<meta name="dai-public-key">`. It lives
in the shell because the signature covers the shell's own digest — a key inside
the signed set could not be written before signing.

**The signature covers the app and runtime, not `document.sqlite`.** Per spec §1
the application is immutable while its database is not, and a container carries
no private key to re-sign with after a save. Signing the immutable half keeps the
publisher's claim verifiable for the document's whole life; the database stays
covered by `hashes`. `signedEntries` is re-checked against `hashes` at verify
time, so a signature can never be validated over digests that differ from the
ones just integrity-checked.

The app sees `window.dai.signature` (`"valid"` or `"unsigned"`) and
`window.dai.publicKeyFingerprint`.

### What this does and does not prove

It proves the app and runtime were signed by whoever holds the private key, and
detects any later modification by anyone who does not. It does **not** by itself
prove who that is: a container is self-contained, so an attacker can replace the
public key in the shell and re-sign with their own. Establishing that a
fingerprint belongs to a particular publisher requires comparing it against a
value obtained out of band — publish your fingerprint somewhere users can check
it. Integrity is self-contained; authenticity is not.

A save reseals the manifest over the new payload and **keeps the document
UUID** — a save is a new revision of the same document. Pass `documentUuid` to
recompile in place; per spec §1 a changed application is a new document and
should get a new UUID.

## Runtime

The container mounts the app in a sandboxed iframe via `srcdoc`. Service
Workers are not used — they do not run on `file://`, which is how a container
is normally opened.

Inside the app, the bootloader exposes `window.dai`:

| Member | Type | Notes |
| --- | --- | --- |
| `version` | `string` | Container format version |
| `hasSqliteEngine` | `boolean` | Whether an engine was packaged |
| `sqliteWasm` | `ArrayBuffer \| null` | The engine bytes |
| `document` | `Uint8Array` | The seed SQLite document |
| `hasSqliteGlue` | `boolean` | Whether the Emscripten glue was packaged |
| `initSqlite()` | `Promise<sqlite3>` | Boots the engine from memory |
| `openDatabase()` | `Promise<DB>` | Deserializes the packaged document |
| `exportDatabase(db)` | `Uint8Array` | Serializes the live database |
| `saveDatabase(db, opts?)` | `Promise<SaveResult>` | Export + rewrite the container |
| `compileSqlite()` | `Promise<WebAssembly.Module>` | Validates the engine; needs no imports |
| `instantiateSqlite(imports)` | `Promise<WebAssemblyInstantiatedSource>` | Compiles from memory |
| `saveState(bytes?, opts?)` | `Promise<SaveResult>` | Rewrites the container around a new database |

`SaveResult` is
`{saved: boolean, method: "picker" | "download" | "cancelled" | "unsupported"}`.
A dismissed dialog resolves as `cancelled` rather than resolving silently, so a
caller can tell a real write from a cancel. `opts.method` is `"auto"` (default),
`"picker"`, or `"download"`; an explicit `"picker"` on an engine without the
File System Access API reports `unsupported` instead of quietly downloading a
copy the user may believe overwrote the original.

`window.daiSaveState(bytes)` is an alias for `saveState`.

### App Mode

The shell renders an **Enter App Mode** control that puts the container
fullscreen via `requestFullscreen()`, hiding browser chrome. The control lives in
the shell rather than the app, and the frame is served `allow="fullscreen 'none'"`
— a same-origin frame inherits the permission by default, which would let a
document seize the whole viewport on any gesture it happened to receive.

The app observes but cannot request: `window.dai.appMode` and
`window.dai.onAppModeChange(listener)`. The control stays visible (fainter) while
fullscreen, because Escape is not a discoverable exit.

### Desktop launchers

Double-clicking a container opens it in a normal tab. The launchers open it in a
chromeless Chromium app window instead:

```ts
dai({ emitLaunchers: true })   // writes name.bat and name.command
```

```ts
import { buildLaunchers } from "dai-core";
const { bat, command } = buildLaunchers("notes.dai.html");
```

Both locate the container relative to themselves (`%~dp0`, `$(dirname "$0")`),
so the pair stays portable. Both check the container exists and fall back to a
plain windowed open when no Chromium browser is installed, rather than failing
silently.

Escaping is context-specific and not interchangeable. In batch, `%` must be
doubled or a name like `100% notes` expands to nothing. In the `.command` file
the name is interpolated into a *double*-quoted string, so `$`, `` ` ``, `"` and
`\` are escaped while apostrophes are left alone — the close-escape-reopen form
that single-quoted strings need would corrupt the name here. The `file://` URL is
percent-encoded at run time, because the launcher cannot know what directory it
will end up in.

A `.command` file needs the executable bit. The plugin sets it; a browser
download cannot, so the Studio tells the user to run `chmod +x` once.

### Native Desktop Shell (`apps/desktop` - Tauri v2)

Phase 4 introduces `apps/desktop`, a standalone native shell built with **Tauri v2** that transitions containers from legacy shell scripts (`.bat` / `.command`) to true OS-native executables (`.exe` / `.dmg`):

- **OS File Associations**: Registers `.dai` and `.dai.html` extensions in `tauri.conf.json` so double-clicking any cartridge opens it directly inside the native shell.
- **Custom Branding Icons**: Bundles high-resolution icon assets (`icon.ico`, `icon.png`, `icon.icns`) so Explorer, Finder, and Taskbars display DAI branding instead of generic browser icons.
- **Silent In-Place Saves**: Implements Rust IPC commands (`read_cartridge`, `save_cartridge`) over the Host-Bridge protocol, allowing containers to rewrite themselves directly to disk without browser download prompts.

```bash
# Build the native desktop app
npx vite build apps/desktop
```

### Mobile

The shell carries the tags an iOS home-screen launch needs —
`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
`viewport-fit=cover`, and a title taken from the document — so a container
**served over HTTPS** is Add to Home Screen ready with no extra work. They are
inert over `file://` and cost nothing there. The App Mode control is inset with
`env(safe-area-inset-*)` so it clears the notch.

### Page size

New databases are pinned to 4096-byte pages; this engine would otherwise default
to 8192, making a document's geometry an accident of whichever engine first
wrote it. A seeded database keeps the page size its own bytes declare.
`dai.pageSizeOf(bytes)` reads the declared size from a serialized database.

### Booting SQLite

```ts
const db = await window.dai.openDatabase()
db.exec('CREATE TABLE IF NOT EXISTS notes(body TEXT)')
await window.dai.saveDatabase(db)   // rewrites the container in place
```

`initSqlite()` passes Emscripten an `instantiateWasm` hook that compiles the
embedded bytes directly, so `locateFile()` is never consulted and no fetch is
ever attempted — the only way to boot under `connect-src 'none'`. Emscripten's
OPFS probe rejects on an opaque origin, so those rejections are suppressed
during startup and the in-memory VFS is used; the packaged document is mapped in
with `sqlite3_deserialize` and read back out with `sqlite3_js_db_export`.

`instantiateSqlite` requires an import object: the engine declares ~36 imports
(`env`, `wasi_snapshot_preview1`). Satisfying them is the Emscripten glue's job,
not the bootloader's — call `compileSqlite()` if you only want to verify the
engine is intact.

The engine is handed over as an **ArrayBuffer, never a URL**.
`WebAssembly.instantiateStreaming` is defined in terms of a fetched `Response`,
and `connect-src 'none'` neutralizes fetch entirely — so streaming
instantiation cannot work in a container by construction.
`WebAssembly.instantiate(buffer)` compiles from memory and touches no network
layer; `'wasm-unsafe-eval'` in the CSP is what permits it.

### Self-perpetuating saves

The archive carries `runtime/container.html`: this container's own shell, with
its bootloader already inlined and only `<!--DAI_PAYLOAD-->` left open. A save
rebuilds the file from *that* copy, never from the installed `dai-core`, so a
document keeps the runtime semantics it was compiled with for its whole life
instead of drifting toward whatever version is installed later.

Saving runs in the top document, not the sandboxed frame — `showSaveFilePicker`
needs a non-sandboxed context and its own user activation. The frame posts a
request; the host writes the file, falling back to an `<a download>` when the
File System Access API is unavailable (Safari, Firefox) or the picker is
dismissed.

### How the app is executed

Blob URLs alone are not enough to run a Vite bundle from `file://`:

- `new URL(dep, import.meta.url)` throws before it looks at `dep`, because
  `blob:null/<uuid>` is an opaque path and cannot be parsed as a base.
  `import.meta.url` is rewritten to a parseable placeholder.
- Vite's chunk graph is cyclic — a lazy chunk imports shared code back from the
  entry chunk — and a blob's content is frozen at creation, so no ordering of
  blob creation satisfies both directions. Chunk references are rewritten to
  placeholder URLs known ahead of time, and an import map in the iframe
  redirects each placeholder to its blob.

Relative specifiers cannot be mapped directly: they are resolved against the
importing module's base URL *before* the import map is consulted, so a blob
module throws first.

## Using the compiler directly

The plugin is a filesystem wrapper around a pure core. `buildContainer` takes
bytes and strings, returns bytes and strings, and imports nothing from Node — so
the same compiler runs in a CLI, a build server, or a browser.

```ts
import { buildContainer } from "dai-core/core";

const { html, manifest, documentUuid } = await buildContainer({
  files: { "index.html": bytes, "assets/app.js": bytes },
  template,          // the shell, as a string
  runtime,           // the bootloader bundle, as a string
  appName: "my-doc",
  sqlite, wasm, glue, // optional Uint8Arrays
  signingKey: pem,    // optional PKCS#8 PEM text, never a path
  documentUuid,       // optional: reuse an identity
  now: () => date,    // optional: build reproducibly
});
```

The shell template and bootloader are published as string constants, so a
browser-hosted compiler needs neither disk access nor `fetch()`:

```ts
import { CONTAINER_TEMPLATE, RUNTIME_SOURCE } from "dai-core/templates";
```

Base64 is implemented inside the core rather than through `btoa`/`atob`, so
there are no remaining platform globals to depend on. Crypto goes through
WebCrypto rather than `node:crypto`, which is what keeps the
core usable in a browser; its ECDSA output is already the IEEE P1363 form the
bootloader verifies. Passing a fixed `documentUuid` and `now` makes a build
byte-for-byte reproducible.

## Web Studio

`examples/web-studio` is a working in-browser compiler: TSX and a SQL schema go
in, `esbuild-wasm` transpiles, `buildContainer` seals, and a `.dai.html` Blob
comes out — with no server compiling anything.

```bash
npx vite --config examples/web-studio/vite.config.ts examples/web-studio
```

The Studio is an ordinary online web app; the air-gap rules govern the artifacts
it produces, not the tool producing them, so it fetches the SQLite engine and
the esbuild binary from its own origin at startup.

**Signing happens in the browser, with no server.** The Studio mints an ECDSA
P-256 pair with `crypto.subtle.generateKey()` and stores the `CryptoKey` objects
in this origin's IndexedDB. Nothing is uploaded; there is no signing endpoint.
Private keys can be exported and imported as PEM so an identity can be backed up
or moved, and `buildContainer` accepts the key pair directly, so the private key
never has to exist as a string for ordinary use.

The key is generated **extractable** so it can be backed up. That is a
deliberate trade: a non-extractable key resists script access, but an identity
that cannot be exported is one the developer loses with their browser profile —
and with it the ability to publish under the same fingerprint.

The 14 MB esbuild binary and the SQLite engine are content-hashed and served
`max-age=31536000, immutable` in dev and preview. **A deployment must set the
same policy at its own CDN or origin** — Vite's config cannot do that for you.

## Runner (mobile PWA)

`apps/runner` is an installable player for containers. A `.dai.html` cannot make
itself installable on a phone — `file://` forbids service workers and manifest
registration, so there is nothing for the OS to install. The runner inverts
that: the **player** is the PWA, and containers are opened from the user's own
files. A console, and cartridges.

```bash
npx vite build --config apps/runner/vite.config.ts apps/runner
npx vite preview --config apps/runner/vite.config.ts apps/runner
```

It precaches its own shell with a cache-first service worker, so it starts with
no network. It never caches a container: those come from the user's filesystem
and are never fetched.

### What the runner checks that a container cannot

A container verifies itself when it boots — but that check runs *inside the
container's own bootloader*. Anyone who rewrites the shell also rewrites the
code that would have caught them: flipping `dai-integrity` to `advisory`, or
deleting the check outright, leaves a file that is internally consistent and
mounts happily.

The runner holds the sealed copy of the shell (`runtime/container.html`) and
compares the outer document against it, with the payload region masked. A
container whose bootloader was rewritten is refused. **This is a check only a
separate player can make**; it is not available to a file opened directly from
disk.

## Task Manager Example (`examples/tasks`)

`examples/tasks/build-tasks-cartridge.js` demonstrates an end-to-end relational SQLite task and project management application built targeting the DAI platform:

- **Relational Schema**: Models `projects`, `tasks`, `tags`, and `task_tags` join tables with foreign key cascades and seed data.
- **Cryptographic Signing**: Mints a WebCrypto ECDSA P-256 key pair, signs immutable code assets, and embeds custom task clipboard SVG favicon branding.
- **Artifact Generation**: Emits `tasks.dai.html` alongside `tasks-launcher.bat`.

```bash
# Mint the task app cartridge
node examples/tasks/build-tasks-cartridge.js
```

## Reading a container

`buildContainer` seals; `verifyContainer` checks the seal. Both are in the core,
so every host reaches the same verdict on the same file — a cartridge refused by
the mobile runner must not open in the desktop shell.

```ts
import { verifyContainer, ContainerError } from "dai-core/container";

try {
  const container = await verifyContainer(html);   // text, never a File
  mount(container.html);                            // verbatim, never a rebuild
} catch (error) {
  if (error instanceof ContainerError) show(error.message);
}
```

It performs four checks, in order: every payload entry matches its digest;
every manifest entry exists in the payload (without which content could simply
be appended); the outer shell matches the sealed copy at
`runtime/container.html`; and the publisher signature verifies when a key is
carried. A `ContainerError` names what is wrong with the file and is meant to be
shown to the person holding it.

`resealContainer(container, database)` rebuilds around a new database, carrying
the document UUID forward. The signature survives, because `document.sqlite` was
never in the signed set.

## Tests

```bash
npm test
```

Playwright drives headless Chromium against a real build artifact: the suite
compiles `tests/fixture` with the plugin, opens the emitted `.dai.html` over
`file://`, and asserts against the running container — the app mounts across the
cyclic chunk graph with no console errors, nothing loads over the network, the
engine arrives as this frame's ArrayBuffer, SQLite boots and runs
create/insert/select, and a save emits a valid container whose database reopens
and reads back.

The suite runs on Chromium, Firefox and WebKit. Save-boundary behaviour differs
per engine — Chromium exposes `showSaveFilePicker` but auto-dismisses it
headlessly, while WebKit and Firefox have no picker at all — so the picker's
success, cancellation and unsupported paths are driven by stand-ins injected
with `page.addInitScript()`, making them deterministic everywhere. The
`<a download>` path is exercised for real on every engine.

## Deploying

```bash
npm run deploys   # which commit each site is actually serving
```

Production is promoted by hand, so a push is not a release. [The deploy
notes](docs/deploying.md) cover that and the one file staging trap that has
caught us before.

## Conformance

```bash
npm run conformance   # rebuild the suite
```

[`conformance/`](conformance/README.md) is fifteen containers with their verdicts
written down: what any reader must conclude about each, and why. It exists so a
second implementation can be checked against the format instead of against this
one — and so this one can be checked too. The generator refuses to publish the
suite when this reader disagrees with an expectation, which is the only thing
that stops a suite from quietly becoming a recording of whatever we already do.

`conformance/isolation-probe.dai.html` is the other half. §4 describes a host
rather than a file, so the probe is a container that attacks the host running it
and reports what got through — nine boundaries, each of which must read
*blocked*. Open it in yours.

## v0.1 scope

Implemented: build packaging, ZIP + Base64 payload, template injection.
Not implemented (v0.2): Service Worker routing, sqlite3.wasm mounting,
`window.daiSaveState()`, signing.

## Air-gap invariant

`src/template.html` hardcodes the spec CSP:

```
default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none';
```

`connect-src 'none'` is the air gap. The compiler adds no polyfills, no network
fetches, and no external asset references — every byte the container needs is
inside the payload.
