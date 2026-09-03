# What was built

77 commits, 1–3 September 2026. This is the arc, not a changelog: what each
stretch was for, and what it left behind.

---

## 1 September — the format

**The compiler.** A Vite plugin that took a finished build, zipped it with a
SQLite database, base64'd the archive and injected it into an HTML shell. One
file out. No server anywhere in the process.

**Making it run.** The hard part was never packaging — it was execution from
`file://`, where a Service Worker cannot register and `import.meta.url` resolves
to an unparseable blob URL. The answer was a sandboxed iframe driven by
`srcdoc`, with an import map to resolve the module graph and the runtime
rewriting `import.meta.url` to something parseable. Service Workers were
abandoned early and deliberately.

**SQLite inside the file.** The engine is handed to the app as an `ArrayBuffer`
rather than a URL, because `connect-src 'none'` means nothing can be fetched —
including by the engine's own loader. Emscripten's `instantiateWasm` hook was
the way past that. The page size is pinned at 4096 so documents stay readable
as engines change.

**Saves that perpetuate.** A container carries a copy of its own shell, so
saving rebuilds from that copy rather than from whatever is running. Runtime
semantics are fixed at compile time — which turned out to matter, because it
also means old files keep their old runtime, and three separate incidents later
traced back to exactly that.

**A test suite before more features.** Playwright driving real containers in
Chromium, Firefox and WebKit, with CI. Every subsequent bug in this document
was found by that suite or by extending it.

**Sealing.** `runtime/manifest.json` with a document UUID and a SHA-256 digest
for every entry, checked in both directions — an unlisted entry fails as loudly
as a modified one, or content could simply be appended. The integrity policy
lives in the shell rather than the payload, so the payload cannot weaken it.

**Signing.** ECDSA P-256 over a canonical payload, verified before anything
mounts.

**One core, no I/O.** `buildContainer` was pulled out of the plugin and rewritten
against WebCrypto instead of `node:crypto`, so the same code could run in a
browser. That decision paid for itself repeatedly: it is why the website, the
desktop app and the command line all compile with the identical implementation
today.

**Hosts.** A PWA runner with OPFS persistence, then a Tauri desktop shell with
file associations, an atomic in-place save (stage, `fsync`, rename), and
trust-on-first-use key pinning.

## 2 September — the boundary, then the product

**The host bridge as an observation boundary.** A container reports mounts,
refusals, saves and closings to the host. The host does the recording, because
a party attesting to its own correctness proves nothing — a theme that ran
through every security decision here.

**Optional signed expiry**, folded into the signed payload so it cannot be
extended, shortened or deleted without invalidating the signature.

**The documentation site**, then a turn from protocol to product.

The insight that reframed the work: **anyone can write a single HTML file.**
The format's value is not that it is one file — it is that the file keeps its
own data, cannot reach the network, and cannot be altered without that showing.
Everything after this point followed from that.

**The maker path.** A landing page that forks between someone whose assistant
just wrote them an app and someone deciding whether their staff may run one,
because those readers need opposite things.

**Tamper detection, demonstrated.** You edit the file in the page and watch the
digest move away from what the manifest recorded — while the signature stays
valid, which is the point: the signature attests to what was claimed, the
digests to whether the file still matches.

**Four more ways to make one**, all wrappers over the same compiler: a command
line, an MCP server so an assistant can produce a file directly, an in-browser
builder that uploads nothing, and the desktop app.

**`tests/one-engine.spec.ts`** makes that structural rather than aspirational:
nothing outside the compiler may zip, hash or sign, and every front end must
come through one of two doors. It failed the moment it was written, on code
committed hours earlier.

**An example application worth showing** — projects, priorities, tags,
filtering and sorting, all in SQL, saved back into its own file. Every
screenshot on the site is a photograph of it running.

## 3 September

**Published.** `dai-core@0.1.0` is on npm, verified by installing it into an
empty project and compiling a working application from the registry copy.

---

## Where it stands

| | Status |
|---|---|
| Format and compiler | Working, 506 tests across three browser engines |
| Command line (`dai build`, `dai verify`) | Published and verified from npm |
| MCP server (`dai-mcp`) | Published, speaks stdio JSON-RPC |
| In-browser builder | Live, takes folders and zips, uploads nothing |
| Desktop app | Builds and runs; installers compile locally |
| Vite plugin | Working, the original route |
| Website | Deployed |
| Release workflow | Written, never run |
| Installers | Built locally, unsigned, not distributed |
| Standards submissions | Drafted, not submitted |

### Known gaps

- **Key revocation** is reserved in the protocol and unimplemented.
- **Version migration** — carrying a user's data into a rebuilt app — is a
  documented principle with no implementation.
- **Bundling** — React and other frameworks work only through the Vite plugin;
  the browser and MCP routes take plain files.
- **The `prepare` script** added for Git installs is unverified.
- **Installers are unsigned**, so both operating systems will warn on first run.

### What the tests are actually for

Several classes of bug here could not fail locally and could not be undone
once released: the SQLite engine being a devDependency, so an installed copy
would have built containers with no database; `bin` paths that npm silently
strips at publish time, leaving a package with no executables; a favicon data
URI that terminated an attribute and disabled every container's CSP. Each is
now covered by a test that exists specifically because reasoning about it was
not enough.
