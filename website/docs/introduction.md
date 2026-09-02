---
title: Introduction
description: The motivation and core concepts of the Dynamic Application Interface protocol.
---

# Introduction

The **Dynamic Application Interface (DAI)** protocol defines an open, verifiable, air-gapped container format (`.dai` / `.dai.html`) designed specifically for AI-generated and client-side interactive software.

## The Problem

### 1. The Chat-Window Walled Garden
Language models routinely author complete, functional web applications—from complex financial models and statistical simulations to interactive clinical calculators and bespoke internal dashboards. However, these applications typically live and die within the chat window where they were conceived. Moving them into production requires web hosting, cloud infrastructure, domain names, and continuous maintenance.

### 2. Deployment Friction
For small or bespoke tools, the operational overhead of software deployment often exceeds the value of the software itself. A team needing a simple internal loan amortization tool should not need to provision a Kubernetes pod, manage SSL certificates, or maintain an RDS database instance.

### 3. Enterprise Exfiltration & Supply-Chain Risk
When an organization runs AI-generated code, security teams face critical risks:
- Does the code send corporate data to unauthorized third-party servers?
- Will an automated update or prompt injection alter the logic after deployment?
- Can user data be exfiltrated via background beacons, WebSockets, or hidden images?

Traditional web security models are perimeter-focused; once a web app executes in a browser, it possesses extensive network privileges.

---

## The Solution: Air-Gapped Portable Software

DAI introduces a container format with architectural guarantees enforced directly by web primitives:

### Invariant: `connect-src 'none'`
Every DAI container is governed by an absolute Content Security Policy directive:
```http
connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none';
```
A DAI container cannot issue an HTTP `fetch`, open a `WebSocket`, initiate an `EventSource`, or send a `navigator.sendBeacon`. There is no "networked mode." The file is inert and safe to open from an email attachment, a flash drive, or a decades-old archive.

### Self-Contained SQLite State
Instead of calling a backend API, DAI containers bundle a WebAssembly compilation of SQLite (`sqlite3.wasm`). All data queries, inserts, and mutations occur entirely in local browser memory. When the user saves their work, the container rebuilds its internal payload and persists back to the local file system.

### Cryptographic Authenticity & Integrity
Every asset within the container is cataloged in `runtime/manifest.json` with its SHA-256 digest. Bidirectional verification guarantees that no file can be added, modified, or omitted without invalidating the container. Furthermore, containers can be signed using ECDSA P-256, allowing users to verify publisher identity against an out-of-band trust anchor.

---

## Core Pillars at a Glance

1. **Air-Gapped by Design:** Zero outbound network traffic. Absolute protection against exfiltration.
2. **Immutable Logic:** Application code is sealed at compile time. Only state (`document.sqlite`) evolves across saves.
3. **Bundled Runtime:** Contains its own database engine and bootloader. No external CDN or package manager required.
4. **Self-Perpetuating:** Saves rebuild the document from an embedded copy of its own shell, preventing runtime drift.
