---
title: Host Bridge Protocol
description: Specification of the postMessage communication protocol and error codes.
---

# Host Bridge Protocol

A DAI cartridge communicates with the outside world through a single interface: the `postMessage` host bridge.

## Core Architectural Tenet

<div class="custom-block tenet">
  <p class="custom-block-title">A Cartridge Reports Claims; A Host Records Findings</p>
  <p>
    A cartridge may report only what it can compute from its own internal state—such as <code>DIGEST_MISMATCH</code>, <code>UNVERIFIED_SIGNATURE</code>, or <code>KEY_EXPIRED</code>. These are <strong>claims</strong>. A host logs them as claims, because a compromised cartridge can claim anything.
  </p>
  <p>
    Anything requiring external knowledge—such as whether the outer shell was rewritten (<code>SHELL_TAMPERED</code>) or whether a key was placed on a revocation list (<code>KEY_REVOKED</code>)—is a <strong>host finding</strong>. A host must never push external findings inward for the cartridge to repeat.
  </p>
</div>

---

## Message Specifications (`bridgeVersion: 1`)

### Cartridge to Host Messages

#### 1. `DAI_HOST_HANDSHAKE`
Dispatched immediately after the cartridge has verified its own digests and mounted the application:
```typescript
{
  type: "DAI_HOST_HANDSHAKE",
  payload: {
    bridgeVersion: 1,
    documentUuid: "e2b34208-8f81-4ba2-bf01-cb8dbfbb7a8a",
    verified: true,
    payloadFingerprint: "a948e2bb6174..." // SHA-256 over documentUuid and sorted hashes
  }
}
```

#### 2. `DAI_HOST_SAVE`
Dispatched when the application requests state persistence:
```typescript
{
  type: "DAI_HOST_SAVE",
  payload: {
    html: "<!doctype html>...",      // Full container document
    databaseBytes: Uint8Array,       // Raw SQLite database bytes
    documentUuid: "e2b34208..."
  }
}
```

#### 3. `DAI_HOST_REFUSED`
Dispatched when verification fails and the container halts execution before mounting. Sent unconditionally without waiting for a handshake:
```typescript
{
  type: "DAI_HOST_REFUSED",
  payload: {
    bridgeVersion: 1,
    reason: "DIGEST_MISMATCH",
    message: "This container has been modified and will not be run.",
    detail: "app/index.js does not match its digest",
    documentUuid: "e2b34208..." // Optional if manifest unreadable
  }
}
```

#### 4. `DAI_HOST_CLOSING`
Dispatched during the `pagehide` lifecycle event when the container document is being torn down:
```typescript
{
  type: "DAI_HOST_CLOSING",
  payload: {
    bridgeVersion: 1,
    documentUuid: "e2b34208..."
  }
}
```

---

### Host to Cartridge Messages

#### 1. `DAI_HOST_HANDSHAKE_ACK`
Informs the cartridge that an active host runner is present:
```typescript
{
  type: "DAI_HOST_HANDSHAKE_ACK",
  payload: {
    bridgeVersion: 1,
    sessionNonce: "…",        // the value the container sent, echoed
    hostClass: "viewer",      // or "editor"; see the specification §4
    applied: ["origin", "shell", "popup", "network", "socket",
              "evaluation", "inline", "handler", "storage"]
  }
}
```

`applied` is the host's claim about which §4 clauses it holds, named by the
isolation probe's check ids. A container never acts on it. It is there to be
checked: mount the probe in the host, and every claimed clause must come back
blocked.

`hostClass` says what a save through this host does. A **viewer** keeps a
copy of the database on the device and can export a file; it never claims to
have written the file it was given. An **editor** writes the document in
place. A host that omits it is treated as a viewer. The container reports the
answer to the application on every save as `inPlace`.

#### 2. `DAI_HOST_SAVE_ACK`
Reports whether the host successfully persisted the container:
```typescript
{
  type: "DAI_HOST_SAVE_ACK",
  payload: {
    status: "ok" | "error",
    error?: string
  }
}
```

---

## Refusal Reasons Glossary

When a cartridge halts before mounting, it emits one of the following standard refusal reason codes:

| Reason Code | Category | Meaning |
| :--- | :--- | :--- |
| `NO_PAYLOAD` | Packaging | No `#dai-payload` element found. File is not a DAI container. |
| `PAYLOAD_UNREADABLE` | Archive | The payload base64 string failed to decode or unzip. |
| `MANIFEST_UNREADABLE` | Schema | The `runtime/manifest.json` entry is not valid JSON. |
| `MANIFEST_MISSING` | Integrity | Verification is required but no manifest is present in archive. |
| `UNSUPPORTED_ALGORITHM` | Crypto | The manifest specifies a hashing algorithm other than SHA-256. |
| `UNSUPPORTED_CRYPTO` | Environment | Browser `crypto.subtle` is unavailable (insecure context). |
| `DIGEST_MISMATCH` | Integrity | One or more entry SHA-256 digests do not match the manifest. |
| `SIGNATURE_UNVERIFIABLE` | Authenticity | A publisher key is present but no signature block was provided. |
| `UNVERIFIED_SIGNATURE` | Authenticity | The ECDSA signature does not verify against the embedded key. |
| `NO_APPLICATION` | Runtime | Verification passed, but the entry point (`app/index.html`) is missing. |
| `KEY_EXPIRED` | Expiration | The manifest carries a `validUntil` timestamp that has elapsed. |
| `MOUNT_TIMEOUT` | Lifecycle | The inner sandboxed application failed to report ready within 5000ms. |
| `BOOT_FAILED` | Runtime | An unhandled exception occurred in the bootloader. |

### Codes Deliberately Excluded from Cartridges

The following two codes are **host findings** and are never emitted by a cartridge:

1. **`SHELL_TAMPERED`**: A cartridge cannot detect its own bootloader being modified because that check would run inside the modified code. Detection belongs solely to an external runner comparing the shell against `runtime/container.html`.
2. **`KEY_REVOKED`**: Revocation requires knowledge from outside the container file. A cartridge carries no revocation list and has no network capability to retrieve one.
