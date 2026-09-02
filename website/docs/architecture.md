---
title: Architecture & Boundaries
description: Architectural separation between inert cartridges, the host bridge, and outer runners.
---

# Architecture & Boundaries

The DAI protocol is built around strict physical and boundary separations. A clear demarcation between what the container does and what the host does ensures security, immutability, and longevity.

```
+-------------------------------------------------------------------------+
|                              OUTER HOST                                 |
| (Desktop Shell / Web Runner / Security Audit Proxy)                     |
|                                                                         |
|  - Manages OS File System & OPFS Storage                                |
|  - Audits Outer Shell Integrity (SHELL_TAMPERED detection)              |
|  - Enforces External Governance (KEY_REVOKED detection)                 |
+------------------------------------+------------------------------------+
                                     |
                         postMessage | Handshake & Saves
                                     v
+-------------------------------------------------------------------------+
|                           DAI HOST BRIDGE                               |
|                                                                         |
|  - Typed Messaging: DAI_HOST_HANDSHAKE, DAI_HOST_SAVE, DAI_HOST_REFUSED |
|  - Version negotiation: bridgeVersion: 1                                |
|  - Asynchronous ACK handshakes                                          |
+------------------------------------+------------------------------------+
                                     |
                        srcdoc frame | Sandboxed Blob URLs
                                     v
+-------------------------------------------------------------------------+
|                           INERT CARTRIDGE                               |
|                                                                         |
|  - CSP: connect-src 'none' (Absolute Air Gap)                           |
|  - Embedded sqlite3.wasm (4096-byte page size)                          |
|  - Bidirectional SHA-256 Digest Verification                            |
|  - Optional ECDSA P-256 Publisher Signature                             |
+-------------------------------------------------------------------------+
```

---

## The Air-Gap Invariant

```http
connect-src 'none'
```

A cartridge cannot open a network connection, and no future version of the protocol will change that. 

This invariant has a crucial architectural consequence: **a cartridge cannot report on itself.** It cannot phone home, log telemetry to an analytics server, check for remote updates, or transmit user identities. Any capability requiring outbound telemetry belongs exclusively to the **host**, not to the cartridge format.

---

## Three Architectural Layers

### 1. The Inert Cartridge
The cartridge is a self-contained archive containing:
- Application bytecode and static assets (`app/**`)
- Embedded SQLite engine (`runtime/sqlite3.wasm`, `runtime/sqlite3.mjs`)
- Manifest and digests (`runtime/manifest.json`)
- The container's own shell (`runtime/container.html`)
- The active database (`document.sqlite`)

The cartridge executes inside a sandboxed iframe with `srcdoc`. It operates purely on origin-local `blob:` URLs minted in memory from its uncompressed payload.

### 2. The Host Bridge
The cartridge speaks to exactly one external entity: the window that framed it, over the browser `postMessage` API. This communication is:
- **Same-machine and in-process.**
- Reaches only the parent host that explicitly framed the file.
- Carries structured messages: `DAI_HOST_HANDSHAKE`, `DAI_HOST_SAVE`, `DAI_HOST_REFUSED`, `DAI_HOST_CLOSING`.

### 3. The Outer Host Runner
The host runner (such as `apps/runner` or the desktop Tauri host) provides:
- File system access via `showSaveFilePicker` or native file APIs.
- Secondary independent verification: the host validates the container using its own separate verifier before mounting.
- Key revocation lists and trust registries.

---

## Self-Perpetuating Saves

When an application persists its state via `dai.saveState()`, the cartridge must not compile using an externally updated compiler library. 

Instead, every container embeds a sealed copy of its own shell at `runtime/container.html`. When saving:
1. The new SQLite database bytes are swapped in for `document.sqlite`.
2. The manifest hashes are updated.
3. The container document is reassembled using the **embedded copy of its own shell**.

This ensures that a document compiled in 2026 keeps its exact runtime semantics and bootloader indefinitely, rather than drifting or breaking as external tools evolve.
