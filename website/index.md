---
layout: home

hero:
  name: "DAI Protocol"
  text: "The Open Container Standard for AI-Generated Software"
  tagline: "The PDF for interactive, client-side applications. Air-gapped, tamper-evident, signed, and self-contained with embedded SQLite."
  actions:
    - theme: brand
      text: 5-Minute Quickstart
      link: /docs/quickstart
    - theme: alt
      text: Read the Specification
      link: /docs/specification
    - theme: alt
      text: In-Browser Playground
      link: /playground

features:
  - icon: 🛡️
    title: Air-Gapped Execution
    details: Hardened Content Security Policy with connect-src 'none'. A cartridge cannot phone home, log telemetry, or exfiltrate enterprise data.
  - icon: ✍️
    title: Cryptographic Authenticity
    details: Bidirectional SHA-256 entry hashing and ECDSA P-256 publisher signatures ensure code integrity from build to execution.
  - icon: 💾
    title: Embedded SQLite Engine
    details: Ships with WebAssembly SQLite compiled inside every container. Pinned 4096-byte pages and self-perpetuating in-place document saves.
  - icon: 📦
    title: Zero External Dependencies
    details: A single .dai or .dai.html file contains its runtime, glue, libraries, and state. Double-click to run on desktop or in any web browser.
---

<div class="content-container" style="max-width: 1152px; margin: 0 auto; padding: 0 24px;">

<DownloadCard />

## The Problem: AI Code Has No Distribution Standard

Today, AI models generate thousands of lines of sophisticated interactive software—calculators, simulations, internal enterprise tools, data dashboards, and games. Yet their distribution is broken:

- **Chat Walled Gardens:** Software remains trapped inside ephemeral chat windows.
- **Hosting Friction:** Sharing a tool requires provisioning cloud servers, configuring DNS, and managing database connections.
- **Enterprise Exfiltration Risks:** Running generated code inside corporate environments poses severe data security risks without verifiable network isolation.

## The Mental Model: "The PDF for Software"

Before PDF, distributing formatted text required recipients to have identical operating systems, fonts, and word processors. The PDF standardized documents into an immutable, self-contained container.

**The DAI Protocol (`.dai`) brings this paradigm to interactive client-side applications:**

| Property | Traditional Web App | Desktop Executable (.exe) | DAI Container (.dai) |
| :--- | :--- | :--- | :--- |
| **Network Access** | Always connected | Unrestricted socket access | **Strictly Air-Gapped (`connect-src 'none'`)** |
| **Persistence** | Remote cloud DB | Local OS filesystem | **Embedded SQLite Database** |
| **Tamper Detection**| Server-controlled | Code signing certificates | **Bidirectional SHA-256 + ECDSA P-256** |
| **Portability** | Requires active hosting | Platform-dependent | **Universal Browser & Desktop Runtime** |
| **Lifespan** | Fragile (server shutdown)| OS deprecation risks | **Archival-grade (works offline decades later)** |

```html
<!-- Anatomy of a self-executing .dai.html polyglot container -->
<!doctype html>
<html>
  <head>
    <meta name="dai-integrity" content="required">
    <meta name="dai-public-key" content="MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...">
  </head>
  <body>
    <script id="dai-bootloader">/* Inlined zero-dependency bootloader */</script>
    <script id="dai-payload">
      /* Base64-encoded ZIP containing app/**, sqlite3.wasm, and manifest.json */
    </script>
  </body>
</html>
```

</div>
