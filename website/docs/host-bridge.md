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

#### `DAI_HOST_USED`

Sent once, the first time somebody uses the document — a statement the kit ran
on their behalf, or a save. A host that offers to install a document should
wait for this: before it, an offer stands in front of a person who has not yet
seen the thing work.

```typescript
{
  type: "DAI_HOST_USED",
  sessionNonce: "…",
  payload: { bridgeVersion: 1, documentUuid: "…", timings: [ … ] }
}
```

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

Every name a conforming implementation may refuse with, from the registry in
`src/refusals.ts` — which is the source, and which a test holds this table
against, so the two cannot drift. *Recoverable* says whether the person's work
is still in hand, as with a lost race or a busy lock, rather than a file that is
not what it claims.

| Reason Code | Recoverable | Meaning |
| :--- | :--- | :--- |
| `NO_PAYLOAD` | no | No payload: probably not a container at all. |
| `PAYLOAD_UNREADABLE` | no | The payload did not decode or unzip. |
| `MANIFEST_MISSING` | no | No manifest, so nothing can be verified. |
| `MANIFEST_UNREADABLE` | no | The manifest is not valid JSON. |
| `UNSUPPORTED_ALGORITHM` | no | A digest algorithm this reader does not implement. |
| `UNSUPPORTED_CRYPTO` | no | No WebCrypto: not a secure context. |
| `SECTION_MISSING` | no | A required section is absent; the file is incomplete. |
| `UNSUPPORTED_MANIFEST_VERSION` | no | A manifestVersion this reader does not know. The file is not damaged; the host needs updating. |
| `UNSUPPORTED_CAPABILITY` | no | The document names a capability this reader does not implement. The file is not damaged; the host needs updating. Never opened without the capability: for rosters, sessions and confidentiality that is the hole the capability closes. |
| `RUNTIME_UNAVAILABLE` | no | Published without its engine, for a host that already holds those exact bytes. This one does not. |
| `LINK_DAMAGED` | no | The link does not decode: probably cut or wrapped in transit. |
| `LINK_UNSUPPORTED` | no | The link names a carrier version or dictionary this reader does not have. |
| `LINK_UNRECONSTRUCTABLE` | no | The link leaves out an entry expecting this host's copy to match the sealed digest, and it does not. |
| `BLOB_MISMATCH` | no | The store returned bytes that do not hash to what the link names. |
| `BLOB_UNDECRYPTABLE` | no | The link's key does not open the blob: the link was cut or edited. |
| `STORE_REFUSED` | no | A store declined to hold this: not a DAI document, too large, or the sidecar disagrees. |
| `DIGEST_MISMATCH` | no | An entry does not match its digest, is missing, or is unlisted. |
| `SECTION_MISMATCH` | no | The manifest or application section does not match its digest. |
| `DATA_DAMAGED` | no | Only the database disagrees with its record: an interrupted save. The application is intact. |
| `SHELL_MISSING` | no | No sealed copy of the shell, so the bootloader cannot be checked. |
| `SHELL_MISMATCH` | no | The shell does not match the sealed copy inside it. |
| `SIGNATURE_UNVERIFIABLE` | no | A publisher key is present but there is nothing usable to check. |
| `SIGNATURE_UNSUPPORTED` | no | A signature format this reader does not implement. |
| `SIGNED_SET_MISMATCH` | no | The signed list and the digest list disagree, in either direction. |
| `UNVERIFIED_SIGNATURE` | no | The signature does not verify against the key the file carries. |
| `KEY_EXPIRED` | no | The container's expiry has passed. |
| `PUBLISHER_MISMATCH` | no | Signed by a different key than this host pinned for the document. |
| `NO_APPLICATION` | no | Verified, but there is no index.html to run. |
| `SCHEMA_INCOMPATIBLE` | no | The data's shape is not one the application declared, and no migration reaches it. |
| `SCHEMA_AHEAD` | yes | The data is newer than the application. Do not migrate backwards; offer read-only or an update. |
| `GENERATION_CONFLICT` | yes | Another window saved first. The work in hand is still in hand. |
| `LOCK_UNAVAILABLE` | yes | Another program is saving this document right now. |
| `MOUNT_TIMEOUT` | no | The application never reported that it started. |
| `BOOT_FAILED` | no | The bootloader threw. |
| `HOST_REFUSED` | no | The host declined for a reason of its own; see the message. |

### Codes Deliberately Excluded from Cartridges

The following two codes are **host findings** and are never emitted by a cartridge:

1. **`SHELL_TAMPERED`**: A cartridge cannot detect its own bootloader being modified because that check would run inside the modified code. Detection belongs solely to an external runner comparing the shell against `runtime/container.html`.
2. **`KEY_REVOKED`**: Revocation requires knowledge from outside the container file. A cartridge carries no revocation list and has no network capability to retrieve one.
