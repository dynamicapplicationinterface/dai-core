# dai-core

Compiles a finished React/Vite build into a single air-gapped **DAI v0.1 Polyglot
Container** (`[app-name].dai.html`).

## Installation

> **Pre-release.** `dai-core` is not published to npm. `npm install dai-core`
> will not resolve — install it from Git or from a local checkout.

From Git:

```bash
npm install -D github:dynamicapplicationinterface/dai-core
```

From a local checkout (useful while developing the plugin itself):

```bash
git clone https://github.com/dynamicapplicationinterface/dai-core.git
cd dai-core && npm install && npm run build
cd ../your-app && npm install -D ../dai-core
```

The package ships no prebuilt `dist/`, so a Git or local install must be built
once (`npm run build`) before a consuming app can resolve it.

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
changed and stops, leaving no iframe at all. Set `verifyIntegrity: false` to
record digests without enforcing them.

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
