# The owner's store — an open contract

What any store must do for a host to say "Kept" (R-Z, R-B, R-C, R-D, R-G in
[backlog.md](backlog.md)). Written 26 October, with R-Z. The store, and a
local test store that meets this contract, were built in Build 2b-2; the
store is deployed, and the keychain path and verification on restore are
built, in Build 2b-2b. The contract names no service. Any store that meets
it works with any host that does.

The application never reaches a store. The container's `connect-src 'none'`
is unchanged: the host reaches the store, on the person's behalf, and the
application learns only the status word.

## What is settled, and what is open

**Settled: built, and tested red against its own weakening.** Each item
names where.

- The seven operations, as "The wire" gives them: the store
  (`apps/owner-store/`), its local test store, and the same suite against
  the deployed one (`tests/owner-store.spec.ts`).
- Append's two modes: `head` is a compare-and-swap, `branch` is kept on
  purpose (Build 2b-2 item 1).
- The receipt, held to what was sent, as the only source of "Kept"
  (`tests/checkpoints.spec.ts`, `tests/kept.spec.ts`).
- Envelopes in a blob store, the chain in the objects (Build 2b-2b item 7).
- Recovery by either path alone, each with the other broken
  (`tests/recovery.spec.ts`, `tests/keychain.spec.ts`).
- Verification on restore: a forged signature, an author the store does not
  list under the owner, and a broken parent link are each refused
  (`tests/restore-verify.spec.ts`).

**Open.**

- **Branches reconcile at the host** (R-F as R-Z amends it): not built. A
  host keeps a branch, and restores the newest head; nothing yet merges two
  heads into one.
- **A stale recovery** (R-G): a surviving client's memory of the newest head
  it saw, and the report when a store serves an older one, is not built.
- **The keychain path on a device** (D298): whether Safari and a Home Screen
  app offer to save the secret from the form, and fill it at recovery, is a
  device reading still owed.
- **Production** (`dai-store`) is configured and not deployed.

## Trust

The store is trusted for liveness, never for content (R-B).

- **It cannot read.** Everything it holds is ciphertext, digests, public
  keys and identifiers. No record value, history, title or alternative is
  ever sent to it in the clear, and no key that opens them.
- **It cannot forge.** Every checkpoint is signed by an author key the host
  verifies after decrypting (R-C). A checkpoint the store altered, invented
  or attributed to an author not enrolled under the owner is refused, not
  restored, and the person is told "A kept copy could not be verified, so it
  was not restored."
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

The derivations, so another host derives the same keys:

- The PRF extension evaluates the UTF-8 bytes of `dai owner prf v1`, at
  registration and at every assertion.
- Each wrapping key is HKDF-SHA-256 over the secret, with salt the UTF-8
  bytes of `dai owner key v1` and info `prf` or `keychain`, to AES-KW-256. The
  PRF secret is the PRF output; the keychain secret is the UTF-8 bytes of the
  password the keychain holds, 32 random bytes in base64url.
- The owner key is AES-KW-256, wrapped by AES-KW (`raw`) under each wrapping
  key. A data key is AES-GCM-256, wrapped by AES-KW (`raw`) under the owner
  key.

How the keychain secret reaches a keychain (D298):

- Where the browser has the Credential Management API, the host stores it as
  a password credential whose id is the owner id.
- Where it has none (Safari), the host fills a form, the owner id as the
  user name and the secret as a new password, and submits it: a password
  manager offers to save a secret only as a form submits. The submission
  navigates, so the enrollment is kept before it; the host's own service
  worker answers it with the page it came from, so the secret never leaves
  the browser, and with no worker controlling the page the form is not
  submitted.
- Whether a keychain kept its secret cannot be known by the page that
  offered it: the keychain wrap is made whenever an owner enrolls, and the
  keychain path is proven by a device reading (R-Z).
- At recovery the person fills the user name and the password from the
  keychain; the host signs the keychain proof with the secret and opens the
  owner key's keychain wrap, with no passkey.

This is R-D as amended 26 October: the owner key is wrapped twice, and each
data key once under it. Either path still recovers every document, and a
document made after enrollment needs no passkey ceremony to be kept.

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
- the log: every envelope it accepted, with its parents, author and the
  time the store acknowledged it, and which are heads;
- each envelope's bytes. An envelope carries a release's container, about
  1 MB, so a store built from `apps/owner-store/` keeps the bytes in a blob
  store (R2), keyed by owner, document and digest, and its objects hold
  only the log and each envelope's key. The bytes are written before the
  log entry that names them, so no entry names bytes the store lacks.

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
| **Heads** of a document | an enrolled author (a recovering context is one, once admitted) | the head envelope digests, each with its acknowledgment time, and the wrapped data key |
| **Get** an envelope | as Heads | the envelope's bytes |
| **Library** of an owner | as Heads | the working document ids the owner holds, and the enrolled authors' public keys |

- **Append is compare-and-swap on the parent.** An append says what it is.
  As `head`, its parents must be every current head: it becomes the head,
  and a second append on the same parent is refused (`stale`, naming the
  heads), since that parent no longer is one. As `branch`, its parents need
  only be held: it is kept beside the heads. So an older device never
  overwrites a newer head, the store never turns a failed swap into a branch
  on its own, and nothing accepted is dropped (R-B): a host told `stale`
  appends the same envelope as a branch, and reconciles. A parent the store
  does not hold is refused: send the parent first. An envelope the store
  holds already is answered as it was the first time. A store that awaits
  anything outside itself while appending (its blob store) reads the heads
  for the swap after that wait, not before.
- **The acknowledgment is the receipt, and the only source of "Kept".** The
  host shows "Kept" for a revision only after an Append answer names that
  revision's envelope digest, as the mode it was sent, for that owner and
  document. An answer naming any other digest, a replayed one included,
  acknowledges nothing and advances nothing. A timeout, a refusal or a
  connection that only came back is not one (R-H, R-Z item 4).
- **Recovery** is Admit under the passkey or the keychain proof, then
  Library, Heads and Get, then opening each envelope with the data key the
  owner key unwraps. A context recovered this way is a new author under the
  same owner (R-E). Each envelope back to the root is fetched, its digest
  checked, opened and verified before anything of the document is written:
  its envelope signature and checkpoint signature under the key the store
  lists for its author under this owner, which must be the key sealed inside
  and the one the author id names; its database digest; its document; and
  its checkpoint's parents, which must be the checkpoints of the envelopes
  its clear part names. A document whose chain fails any of these is
  refused, not restored, never listed and never called kept.
- **Branches reconcile at the host.** The host opens every head and merges
  their change logs (R-F as R-Z amends it); the merged state is a new
  envelope whose parents are those heads. *Open: not built. A host restores
  the newest head, and keeps a line told `stale` as a branch.*

## The wire

How the host and a store built from `apps/owner-store/` speak these
operations; another store may speak them otherwise. The modules are
`apps/owner-store/src/envelope.ts` (the envelope, the checkpoint, the
signatures) and `client.ts` (the requests), shared by the host and the store.

- **Requests.** `POST /o/<owner>/enroll`, `POST /o/<owner>/admit`,
  `GET /o/<owner>/library`, `PUT /d/<owner>/<document>/key`,
  `POST /d/<owner>/<document>/append?as=head|branch`,
  `GET /d/<owner>/<document>/heads`, `GET /d/<owner>/<document>/e/<digest>`.
  One object per owner, and one per working document.
- **Every request is signed** by an author key: `x-dai-author`,
  `x-dai-time` (milliseconds) and `x-dai-signature`, ES256 over
  `["dai store request v1", method, path, time, SHA-256 of the body]` as
  JSON. The store refuses a time more than five minutes from its own, and an
  author not enrolled under the owner the path names. Enroll and Admit carry
  the new author's public key, and are signed by it.
- **Enroll** carries the passkey's credential id and public key (SPKI, ES256
  only), the registration's client data (whose origin later assertions must
  match; with attestation "none" a registration proves no more than the key
  it carries), the keychain verifier, both wraps, and the first author. An
  owner id is enrolled once.
- **Admit** carries the new author and one proof. A passkey proof is an
  assertion, user present and verified, from the registered origin, over the
  challenge `dai admit v1:<ms>:<16 random bytes, base64url>`, made in the tap
  itself. A keychain proof is an Ed25519 signature over that challenge with
  `:<author id>` appended, by the key whose seed is HKDF-SHA-256 over the
  keychain secret, salt `dai owner key v1`, info `keychain verifier`. A
  challenge outside the window, or seen before, is refused. The answer is
  the two wraps and the passkey's credential id.
- **Library** answers the documents with a key, and every enrolled author's
  public key: what the host verifies a checkpoint's author against.
- **Heads** answers the wrapped data key and each head's digest with the
  time the store acknowledged it. **Get** answers the envelope's bytes, with
  that time in `x-dai-at`; an envelope the log names whose bytes the blob
  store cannot give is answered 503, unavailable, never as absent.
- **The envelope** is JSON: `v`, `owner`, `document`, `author`, `parents`,
  `sealed` (nonce ‖ AES-GCM ciphertext, base64url) and `signature`, ES256
  over `["dai envelope v1", owner, document, author, parents, SHA-256 of
  sealed]`. The associated data is the same array without the digest. The
  sealed plaintext is a JSON header, a newline, and the database. The header
  holds the checkpoint, its signature, the author's public key, the title,
  and the release's container when the parent's release differs or there is
  no parent.
- **The checkpoint** is signed and named as the array `["dai checkpoint v1",
  release, document, revision, database digest, parent checkpoint digests]`;
  its digest is SHA-256 of that array's JSON.
- **The acknowledgment** is `{result, digest, at, owner, document}`. The host
  holds it to what it sent: `result` must be the mode it appended as, and
  `digest`, `owner` and `document` the ones it computed for the revision it
  appended, and `at` a time, or it acknowledges nothing.

## Failure

- **Unavailable:** the host keeps saving in this browser, the status says
  so with the last kept time ("Saved here · kept 10:42 AM", R-Z's sentence
  as its name, D300), and the newest revision waits to be appended; a store
  that answers again is sent that revision, never a backlog. The last kept
  revision does not advance (R-Z item 4).
- **An answer lost:** an envelope sent and not answered may be held by the
  store all the same. The host keeps its bytes until an answer comes and
  sends them again as they are, before anything newer is sealed; the store
  answers an envelope it holds as it did the first time, so the resend is
  kept on the line it was sent for and nothing branches. At most that one
  envelope goes before the newest revision.
- **Refused:** the revision stays saved in this browser and is not called
  kept. A refusal the host cannot correct by retrying is said in one host
  sentence, with Save a copy offered (P3).
- **Recovery unavailable:** the host says so, and never presents an empty
  document as recovered (R-Z item 5).
- **Recovery cut short:** each document is restored whole, its data key
  and kept record before the library record that lists it, and the owner is
  signed in before the first is written, so a restored document never
  refuses its own owner. A store that stops answering partway leaves the
  documents restored listed, and the sentence names them and says the rest
  could not be reached. Recover stays offered to that owner, and a second
  recovery restores the rest, passing over what is held here already.
- **A kept copy that does not verify:** refused, not restored, and said in
  one sentence (R-C, above).

## The deployed store

`apps/owner-store/wrangler.toml`, under the account that runs the relay.

- **`dai-store-dev`**, the file's top level: one Durable Object class for
  the owner's and each document's objects, and the R2 bucket
  `dai-store-dev` for the envelopes. A preview of the opener with no
  `DAI_STORE_BASE` points at it, and CI's node job runs the store suite
  against it with the test owners the suite makes. Tests write here.
- **`dai-store`**, `--env production`, with its own bucket: deployed by
  hand once a commit has run green against dev, and never written by a test
  or a job. [deploy.md](deploy.md) has the commands.

## The local test store

A process the tests start on `localhost`, meeting this contract, running the
deployed store's own Worker and objects with their storage and the bucket in
memory (`tests/owner-store-memory.ts`). It can write out everything it holds,
in the objects and the bucket, and every request it received, so a test can
search them for planted values (R-Z, "The store cannot read the records");
it says what each object value holds, so a test can hold the objects to the
chain; it can be told to go unavailable; and it can answer any route its own
way, so a test can make it serve a forged envelope, name other heads, or
leave an author out of a library, and the failure paths run.

## Not in 2b

- Removing a document or an author from a store.
- Compaction of the log (Build 3).
- A store shared between owners, or one owner's document in another's
  library.
- Moving an owner from one store to another.
