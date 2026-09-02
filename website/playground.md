---
title: In-Browser Playground
description: Inspect, unpack, and verify DAI containers client-side using browser WebCrypto.
---

# In-Browser Container Playground

Drop any `.dai` or `.dai.html` container below to audit its cryptographic integrity, inspect its sealed manifest, and test signature validation in real time.

<div class="playground-wrapper">
  <Playground />
</div>

---

## How It Works

1. **Client-Side Execution:** The file is parsed completely inside your browser using `fflate` and the standard WebCrypto API. **Zero bytes leave your machine.**
2. **Bidirectional SHA-256 Verification:** The playground iterates over every entry in the container archive and computes its cryptographic digest to detect modifications.
3. **Signature Verification:** If an ECDSA P-256 public key is present, the playground verifies the digital signature against the canonical payload string (`canonicalPayload`).
4. **Expiry Auditing:** Compares `validUntil` against local machine time to verify whether the container is within its active validity window.
