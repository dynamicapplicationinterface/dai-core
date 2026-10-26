# The owner's store — an open contract

What any store must do for a host to say "Kept" (R-Z, R-B, R-C, R-D, R-G in
[backlog.md](backlog.md)). Written 26 October, with R-Z; the store and a
local test store that meets this contract are built in Build 2b-2. The
contract names no service. Any store that meets it works with any host
that does.

The application never reaches a store. The container's `connect-src 'none'`
is unchanged: the host reaches the store, on the person's behalf, and the
application learns only the status word.

## Trust

The store is trusted for liveness, never for content (R-B).

- **It cannot read.** Everything it holds is ciphertext, digests, public
  keys and identifiers. No record value, history, title or alternative is
  ever sent to it in the clear, and no key that opens them.
- **It cannot forge.** Every checkpoint is signed by an author key the host
  verifies after decrypting (R-C). A checkpoint the store altered, invented
  or attributed to an author not enrolled under the owner is refused, not
  restored.
- **It can withhold.** After a total wipe a store can serve an older valid
  checkpoint, or nothing. The host cannot tell this alone; a surviving client
  remembers the newest head it saw and reports a stale recovery (R-G). The
  limitations box says so.

## Names

| Name | What it is | Who mints it |
| --- | --- | --- |
| Owner id | A random 16-byte identifier, base64url, made at enrollment. It is the passkey's user handle and the keychain credential's user name. | the host, at enrollment |
| Working document id | The document a working copy belongs to (R-K). | the host |
| Author id | The fingerprint of an author's public key ([identity.md](identity.md), "Definitions"). | the host, per context |
| Envelope digest | SHA-256 of an envelope's bytes as stored. The name the store and the host use for a revision. | the host |

## Keys

R-D's three jobs, with one layer between the owner's secrets and each
document.

- **The owner key** is a random AES-256 key, made at enrollment. It is
  wrapped twice: under a key derived from the passkey's PRF output, and
  under a key derived from the keychain secret. The store holds both wraps.
  Either secret alone unwraps it. In each enrolled context it is held
  unwrapped as a non-extractable key.
- **A document's data key** is a random AES-256 key per working document,
  wrapped under the owner key. A new document needs no ceremony: the passkey
  is used at enrollment and recovery only, never on a save (R-D).
- **The author key** signs checkpoints. It is non-extractable, one per
  context (ruling 4, D195), and never sent anywhere; its public key is.
- **A replaced passkey** re-wraps the owner key. Nothing else changes.

R-D says the data key is wrapped twice; here the owner key is, and the data
key once under it. Either path still recovers every document, and a document
made after enrollment needs no passkey ceremony to be kept.

## What the store holds

Per owner:

- the passkey credential's id and public key, to verify an assertion;
- the keychain path's verifier: the public half of a signing key the host
  derives from the keychain secret, so that path authenticates without the
  passkey;
- the two wraps of the owner key;
- the enrolled authors: author id and public key, each with the assertion or
  keychain proof that admitted it.

Per working document:

- the data key, wrapped under the owner key;
- the log: every envelope it accepted, and which are heads.

## The envelope

What a save sends. Its parts:

- **Clear:** owner id, working document id, author id, the envelope digests
  of its parents, and the author's signature over all of it with the
  ciphertext's digest.
- **Sealed:** AES-GCM under the document's data key, with the clear part as
  associated data. Inside: the signed checkpoint (R-C: release digest,
  document id, revision, database digest, parent checkpoint digests), the
  database, and the document's title for the library.

The store compares and links envelopes by their digests, which reveal
nothing: a fresh nonce makes two identical databases two unrelated
envelopes. The host verifies, after opening, that the checkpoint's parents
are the checkpoints sealed in the envelopes the clear part names. Save a
copy and Send this copy carry the opened checkpoints, never envelopes, so
any host verifies them without a store (R-C).

## Operations

Each is a request the host makes and an answer the store gives. Transport is
not part of the contract; the local test store answers them over HTTP on
`localhost`.

| Operation | Authenticated by | Answer |
| --- | --- | --- |
| **Enroll** an owner: credential, verifier, both wraps, the first author | the passkey's registration | the owner id accepted, or refused |
| **Admit** an author: its id and public key | a passkey assertion, or a keychain proof | the author enrolled, and the owner key's two wraps |
| **Put** a document's wrapped data key | an enrolled author's signature | accepted |
| **Append** an envelope | an enrolled author's signature (in the envelope) | `head` or `branch`, with the envelope digest it stored; or refused |
| **Heads** of a document | an enrolled author, or a recovery proof | the head envelope digests |
| **Get** an envelope | as Heads | the envelope's bytes |
| **Library** of an owner | as Heads | the working document ids the owner holds |

- **Append is compare-and-swap on the parent.** An envelope whose parents
  are the current head becomes the head. One whose parents are an older
  envelope is kept as a branch. An older device never overwrites a newer
  head, and nothing accepted is dropped (R-B). A parent the store does not
  hold is refused: send the parent first.
- **The acknowledgment is the only source of "Kept".** The host shows
  "Kept" for a revision only after an Append answer names that revision's
  envelope digest, `head` or `branch`. A timeout, a refusal or a connection
  that only came back is not one (R-H, R-Z item 4).
- **Recovery** is Admit under the passkey or the keychain proof, then
  Library, Heads and Get, then opening each envelope with the data key the
  owner key unwraps. A context recovered this way is a new author under the
  same owner (R-E).
- **Branches reconcile at the host.** The host opens every head and merges
  their change logs (R-F as R-Z amends it); the merged state is a new
  envelope whose parents are those heads.

## Failure

- **Unavailable:** the host keeps saving in this browser, the status says
  so with the last kept time, and new revisions wait to be appended. The
  last kept revision does not advance (R-Z item 4).
- **Refused:** the revision stays saved in this browser and is not called
  kept. A refusal the host cannot correct by retrying is said in one host
  sentence, with Save a copy offered (P3).
- **Recovery unavailable:** the host says so, and never presents an empty
  document as recovered (R-Z item 5).

## The local test store

A process the tests start on `localhost`, meeting this contract, holding
everything in memory. It can write out everything it holds and every
request it received, so a test can search them for planted values (R-Z,
"The store cannot read the records"), and it can be told to go
unavailable, refuse, or serve an older head, so the failure paths run.

## Not in 2b

- Removing a document or an author from a store.
- Compaction of the log (Build 3).
- A store shared between owners, or one owner's document in another's
  library.
- Moving an owner from one store to another.
