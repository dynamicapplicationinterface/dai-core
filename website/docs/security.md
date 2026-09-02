---
title: Security & Threat Model
description: Threat model, cryptographic assurances, offline clock limitations, and isolation guarantees.
---

# Security & Threat Model

The DAI protocol establishes a predictable, hardened security model for executing untrusted, AI-authored code.

## Cryptographic Guarantees

DAI distinguishes clearly between **Integrity** and **Authenticity**:

### 1. Integrity (Self-Contained Assurance)
- **Bidirectional Digest Auditing:** Every entry in the archive is checked against `manifest.hashes`, and every hash in the manifest must exist in the archive.
- **Detection Scope:** Protects against accidental byte corruption and casual tampering by someone who does not re-seal the container.
- **Enforcement in the Shell:** The policy `<meta name="dai-integrity" content="required">` lives in the HTML shell outside the archive.

### 2. Authenticity (External Assurance)
- **ECDSA P-256 / SHA-256:** Application bytecode, static assets, runtime glue, and the sealed shell are signed at compile time.
- **Limitations of In-File Cryptography:** A container is fully self-contained. An attacker can replace the public key in the shell and re-sign the payload with their own private key. Therefore, **a signature alone does not prove publisher identity**.
- **Trust Anchors:** Authenticity is only established when the host compares `publicKeyFingerprint` against an **out-of-band trust anchor** (e.g., enterprise directory, package registry, or published fingerprint).

---

## The Clock Tenet: A Guard, Not a Control

<div class="custom-block tenet">
  <p class="custom-block-title">The Clock is an Integrity Guard, Not an Enforcement Control</p>
  <p>
    The <code>validUntil</code> timestamp stops an honest host operating on a synchronized clock from running stale or deprecated code. However, no offline format can prevent an adversary from rolling back their local machine clock. Expiry is policy, not DRM.
  </p>
</div>

- **Perpetual by Default:** By default, containers omit `validUntil` and execute indefinitely. This fulfills the format's core promise of archival longevity.
- **Irrevocable Expiry:** An expired container cannot be renewed without the original publisher's private signing key.

---

## Why Organizational Identity Must Never Flow Inward

In enterprise environments, hosts often manage user credentials, tenant IDs, employee badges, and organization licenses.

**Architectural Rule:** A host must never transmit organizational identity inward to a cartridge over the host bridge.

### Rationale:
1. **Air-Gap Preservation:** While a cartridge cannot make outbound network requests, it has full write access to its own embedded SQLite database.
2. **Data Portability Risks:** DAI containers are portable files intended to be emailed, backed up, or shared. Any identity handed into a cartridge becomes persistent identity embedded in the exported `document.sqlite`, creating silent data leakage.
