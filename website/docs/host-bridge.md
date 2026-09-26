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
| `PAYLOAD_TOO_LARGE` | no | The archive declares, or inflates to, more than this reader will hold. |
| `MANIFEST_MISSING` | no | No manifest, so nothing can be verified. |
| `MANIFEST_UNREADABLE` | no | The manifest is not valid JSON. |
| `UNSUPPORTED_ALGORITHM` | no | A digest algorithm this reader does not implement. |
| `UNSUPPORTED_CRYPTO` | no | No WebCrypto: not a secure context. |
| `SECTION_MISSING` | no | A required section is absent; the file is incomplete. |
| `UNSUPPORTED_MANIFEST_VERSION` | no | A manifestVersion this reader does not know. The file is not damaged; the host needs updating. |
| `UNSUPPORTED_CAPABILITY` | no | The document names a capability this reader does not implement. The file is not damaged; the host needs updating. Never opened without the capability: for rosters, sessions and confidentiality that is the hole the capability closes. |
| `RUNTIME_UNAVAILABLE` | no | Published without its engine, for a host that already holds those exact bytes. This one does not. |
| `MALFORMED_SESSION_PROFILE` | no | A session block without requires:[session], the requirement without the block, or a max_parties that is not a positive integer. The two are one declaration; half of it is malformed, not a plain replicated document to open. |
| `SESSION_EXPORT_INCOMPLETE` | no | Exporting an invite for one session, a kept row named a parent in another session: the source document is malformed, an entity's history having crossed sessions. Refused rather than shipping an invite with a parent that never arrives. |
| `SEAT_ALREADY_BOUND` | no | An open seat two or more copies asked for before the creator's copy seated anyone — two parties opened the same invite. Nobody holds it; the creator can replace it and issue a new invite. A seat the creator's copy has seated someone in is theirs for good. |
| `SEAT_NOT_HELD` | no | A row that names a seat someone else holds, or names no seat, in a table whose rows act for a seat: signed by who it says, and not theirs to write. Stored and never admitted; reported per batch in `refusedBatches` with its author. A row for a seat its author asked for and is waiting to be seated in is not this: it is pending, neither admitted nor reported. The rest of the merge runs. |
| `ENTITY_OTHER_SESSION` | no | A row that names as its earlier version a row of another session: an entity belongs to the session it was written in, so nobody replaces or removes a row of one game from a session of their own. Stored and never admitted; reported per batch in `refusedBatches` with its author. The rest of the merge runs. |
| `SEATS_EXCEED_CAP` | no | A session declares more seats than its signed max_parties allows. The cap is the creator's signed statement of how many may join, so more seats than the cap is malformed. |
| `MERGE_COVERAGE` | no | A replicated table is neither an author table nor a named system table, so a merge would converge some tables and silently diverge on it. Refused rather than merged incompletely — a system table added without wiring it into the merge set. |
| `CLOSE_NOT_PERMITTED` | no | A session declares close=creator, and a replica that is not the creator tried to close it. Only the creator may end this session; the close is refused rather than written as a row that closes nothing. |
| `ROLE_NOT_PERMITTED` | no | A write named a table that only one party in a session may author, and the other party made it: the creator wrote a joiner-only table, or the joiner a creator-only one. The message names which, and the table. Refused at the write rather than written as a row every copy would drop. |
| `CANNOT_RESEAT` | no | A reseat was asked for on a session with no contested seat. Reseating replaces a seat's value, dropping every binding to the old one — a repair for a seat two parties opened, and damage to a healthy one. Refused unless an open seat nobody has been seated in is asked for by more than one copy. |
| `CANNOT_CONFIRM` | no | The creator's copy was asked to seat someone in a seat that is not a current open seat, or that someone already holds. A hold, once confirmed, never moves. |
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

### While a document is open

These are refused after the document has mounted — by the shared tables, the
write rules, a merge with another copy, the mailbox — or when the document is
built. They are what an application's author meets, so an application should
show the name, not only the sentence.

| Reason | Recoverable | Meaning |
|---|---|---|
| `REPLICATED_TABLE_IMMUTABLE` | no | A write tried to change or delete a row of a shared table in place. Shared tables are append-only: a change is a new row and a removal a tombstone, both through `window.dai.replicated`. What SQLite says when an application writes one with plain SQL. |
| `ROW_REJECTED` | no | A row that breaks the replication rules: a second, different row under an id already used (a replica issues each sequence number once), a row with no session in a session document, a superseded row made current again, or a write before this copy has a replica. |
| `WRITE_SURFACE_UNAVAILABLE` | no | `window.dai.replicated` is not in place, so a shared table cannot be written. The reason follows in parentheses: the write rules were refused, never arrived, or the host did not say the document is replicated. The document is still readable. |
| `WRITE_RULES_NOT_DELIVERED` | no | The host said this document has shared tables and then sent no write rules within the wait, so the document opens read-only rather than writing shared rows it cannot check. |
| `NO_SOURCE` | no | The host sent write rules with no module in them. |
| `MERGE_MODULE_MISMATCH` | no | The write-rules and merge module the host supplied is not the one this runtime is pinned to, by digest. Refused rather than run: it is the code that decides which rows are kept. |
| `MERGE_MODULE_UNUSABLE` | no | The module matched its digest and could not be loaded — a policy the frame runs under refused it. Reported as itself, because it reads nothing like a mismatch. |
| `NO_DOCUMENT_OPEN` | no | A write, a merge or a mailbox batch arrived while no database was open to take it. |
| `NOT_SEAT_CREATOR` | no | A seat change only a session's creator may make was asked for by another replica. |
| `MERGE_UNAVAILABLE` | no | A merge was asked for and the host supplied no merge module to run it. |
| `NOT_A_DATABASE` | no | The other copy's data section is empty or is not a SQLite database. |
| `NOT_REPLICATED` | no | Neither copy declares shared tables, so there is nothing a merge could combine — refused as an answer rather than reported as a merge that changed nothing. |
| `SCHEMA_MISMATCH` | no | The other copy's shared tables are not the same tables with the same columns as this one's, so its rows cannot be merged in. |
| `UNSUPPORTED_LEVEL` | no | The other copy asks for a replication level this runtime does not implement. Refused rather than merged as though it were the level this one knows — checks it expected would not have run. |
| `MERGE_FAILED` | no | A merge failed for a reason with no name of its own; the message says what. |
| `APPLY_FAILED` | no | A batch from the mailbox failed to apply for a reason with no name of its own; the message says what. |
| `BATCH_SIGNATURE_INVALID` | no | A batch whose signature does not verify, or whose public key does not fingerprint to the author it names: not written by who it says. Its rows are refused; the rest of the merge runs. Reported per batch in `refusedBatches`. |
| `BATCH_DIGEST_MISMATCH` | no | A batch whose rows are not the rows it signed: a row changed after signing, a row it lists is missing, or a row claims the batch and is not among the rows it lists. Those rows are refused; the rest of the merge runs. Reported per batch in `refusedBatches`. |
| `BATCH_UNSIGNED` | no | A row no valid batch covers, in a table whose rows must be signed: today the seat tables (`_dai_seat`, `_dai_binding`, `_dai_confirm`), where an unsigned row under someone else's id would decide a seat. Refused and reported per batch in `refusedBatches` with the author it names; the rest of the merge runs. |
| `MAILBOX_KEY_INVALID` | no | A mailbox key that is not 32 bytes: the key in the link was cut or edited. |
| `MAILBOX_BATCH_TRUNCATED` | no | A sealed batch shorter than its own header, so it cannot be opened. Dropped; the next one is read. |
| `MAILBOX_BATCH_MALFORMED` | no | A batch that opened under its key and is not the shape a batch has. Dropped; the next one is read. |
| `MAILBOX_BATCH_UNKNOWN_TABLE` | no | A batch carries rows for a table this document does not have as a shared table — from a copy with a different schema. Refused rather than guessing where its rows belong; the message names the table. |
| `MAILBOX_APPEND_FAILED` | yes | The relay did not accept a batch after every retry. The move is kept on this device and sent when the connection returns. |
| `REPLICATION_SCHEMA_INVALID` | no | The schema's shared tables break a rule the build enforces — a column with the reserved `_r_` prefix, a `PRIMARY KEY` or `AUTOINCREMENT` of the author's own, a session profile with nothing to scope, or an append-only trigger that does not name every column. Refused at build, where the author is. |

### Codes Deliberately Excluded from Cartridges

The following two codes are **host findings** and are never emitted by a cartridge:

1. **`SHELL_TAMPERED`**: A cartridge cannot detect its own bootloader being modified because that check would run inside the modified code. Detection belongs solely to an external runner comparing the shell against `runtime/container.html`.
2. **`KEY_REVOKED`**: Revocation requires knowledge from outside the container file. A cartridge carries no revocation list and has no network capability to retrieve one.
