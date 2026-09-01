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
| `appEntryPrefix` | `app` | Archive prefix for the compiled app (spec `/app`) |
| `compressionLevel` | `9` | fflate deflate level, 0–9 |
| `templatePath` | bundled `template.html` | Alternative bootloader |

## Archive layout

```
app/index.html
app/assets/*
document.sqlite
```

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
