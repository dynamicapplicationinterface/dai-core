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
3. **Signature Verification:** If an ECDSA P-256 public key is present, the playground verifies the COSE_Sign1 signature over the signed view — the identity, the descriptive fields and the entry digests, encoded as deterministic CBOR. The exact bytes are written out in [the CDDL](https://github.com/dynamicapplicationinterface/dai-core/blob/main/docs/cddl.md), with frozen vectors beside it.
4. **Expiry Auditing:** Compares `validUntil` against local machine time to verify whether the container is within its active validity window.

It reports what is in the file. What it does not do is tell you whether to trust
the publisher — that depends on what your own device has seen before, and is the
opener's job, not this page's.
