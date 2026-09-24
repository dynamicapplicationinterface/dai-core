The host bridge's messages

Generated from `src/bridge.ts`, which owns these names. Do not edit this page:
run `node scripts/build-docs.mjs`. A message added to the code and missing
here fails `build-docs --check`.

A document speaks to exactly one party: the window that framed it, over
`postMessage`. Every message flows one way, so the names are split by
direction — 20 from the document to its host, 12 back.

Everything in these messages is a **claim by the document**. A host that
records `verified: true` because a document said so has recorded nothing: the
host verifies the file itself, and the document's fingerprint is worth having
only because it can be compared with the host's own.

## From the document to its host

| Message | Named | Note |
|---|---|---|
| `DAI_HOST_APPLIED` | `TO_HOST.APPLIED` | — |
| `DAI_HOST_AUTHORED` | `TO_HOST.AUTHORED` | — |
| `DAI_HOST_AUTHORED_BATCH` | `TO_HOST.AUTHORED_BATCH` | — |
| `DAI_HOST_CLOSING` | `TO_HOST.CLOSING` | The document is going away. |
| `DAI_HOST_FLUSHED` | `TO_HOST.FLUSHED` | — |
| `DAI_HOST_GROUND` | `TO_HOST.GROUND` | — |
| `DAI_HOST_HANDSHAKE` | `TO_HOST.HANDSHAKE` | — |
| `dai:isolation-report` | `TO_HOST.ISOLATION_REPORT` | The isolation probe's report, relayed to the host. |
| `DAI_HOST_MERGE_RESULT` | `TO_HOST.MERGE_RESULT` | — |
| `DAI_HOST_REFUSED` | `TO_HOST.REFUSED` | — |
| `DAI_HOST_REPLICA_ID_ANSWER` | `TO_HOST.REPLICA_ID_ANSWER` | The mounted copy's replica id, answering TO_DOCUMENT.REPLICA_ID. |
| `DAI_HOST_REQUEST_SHARE` | `TO_HOST.REQUEST_SHARE` | — |
| `DAI_HOST_SAVE` | `TO_HOST.SAVE` | — |
| `DAI_HOST_SAVE_STATE` | `TO_HOST.SAVE_STATE` | — |
| `DAI_HOST_SESSIONS_ANSWER` | `TO_HOST.SESSIONS_ANSWER` | — |
| `DAI_HOST_SIGN` | `TO_HOST.SIGN` | Sign this batch header with the person key (docs/identity.md, step 3). |
| `DAI_HOST_TIMING` | `TO_HOST.TIMING` | — |
| `DAI_HOST_USED` | `TO_HOST.USED` | — |
| `DAI_HOST_WAITING` | `TO_HOST.WAITING` | — |
| `DAI_HOST_WRITE_RULES_REFUSED` | `TO_HOST.WRITE_RULES_REFUSED` | — |

## From the host to the document

| Message | Named | Note |
|---|---|---|
| `DAI_HOST_APPLY_BATCH` | `TO_DOCUMENT.APPLY_BATCH` | — |
| `DAI_HOST_AUTHORED_SINCE` | `TO_DOCUMENT.AUTHORED_SINCE` | — |
| `DAI_HOST_CANVAS` | `TO_DOCUMENT.CANVAS` | — |
| `DAI_HOST_FLUSH` | `TO_DOCUMENT.FLUSH` | — |
| `DAI_HOST_HANDSHAKE_ACK` | `TO_DOCUMENT.HANDSHAKE_ACK` | — |
| `DAI_HOST_INSETS` | `TO_DOCUMENT.INSETS` | — |
| `DAI_HOST_MERGE` | `TO_DOCUMENT.MERGE` | — |
| `DAI_HOST_REPLICA_ID` | `TO_DOCUMENT.REPLICA_ID` | — |
| `DAI_HOST_SAVE_ACK` | `TO_DOCUMENT.SAVE_ACK` | — |
| `DAI_HOST_SESSIONS` | `TO_DOCUMENT.SESSIONS` | — |
| `DAI_HOST_SIGNED` | `TO_DOCUMENT.SIGNED` | The signature, or why the host would not sign. |
| `DAI_HOST_WRITE_RULES` | `TO_DOCUMENT.WRITE_RULES` | — |
