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
- **ECDSA P-256 / SHA-256:** Application bytecode, static assets and runtime glue are signed at compile time, in a COSE_Sign1 envelope over a deterministic CBOR view of the manifest. From `manifestVersion` 3 the sealed shell is deliberately *outside* the signed set — it is checked against its own digest and against the live document, so a host that supplies its own shell can still verify a signature — and `signedEntries` is the sole authority for what the archive may contain.
- **Limitations of In-File Cryptography:** A container is fully self-contained. An attacker can replace the public key in the shell and re-sign the payload with their own private key. Therefore, **a signature alone does not prove publisher identity**.
- **Trust Anchors:** Authenticity is only established from outside the file. A conforming host has three sources, and must distinguish three states — *known*, *new* and *conflict* — while never presenting any of them as "verified":
  1. **What the device has seen.** The publisher's key is pinned across documents, with the name it signs under and a count of its documents. A key the device knows is *known*; one it does not is *new*, with a safety number the two parties can compare out of band.
  2. **A name collision.** A name that matches one already pinned under a different key is *conflict*, compared on the UTS #39 confusable skeleton and by a mixed-script rule, so a look-alike spelling does not pass as a familiar name.
  3. **A third party vouching.** An optional Sigstore bundle binds the signing key to an OpenID identity, verified entirely offline against roots the host already holds. A host that holds no matching root treats the binding as absent — never as verified, and never as a reason to refuse.
- **Provisioned trust.** An organisation may ship a root list naming publisher keys to treat as known, its own Fulcio and Rekor roots, and countersigner keys.

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
