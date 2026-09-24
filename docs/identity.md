# DAI identity spec — signed authorship

## The ruling

A person is a keypair made once on their device and held there. Everything they write into a document is signed by that key. Whether that key belongs to a real, named person is a separate layer that is empty for consumers and filled by the firm's identity provider for enterprise.

This replaces the current design, in which identity is a value in a row (`_dai_replica`) and a value can be copied, carried in arriving data, and adopted by the wrong load. From this sitting on, no part of the runtime derives who it is from anything found in a database. Identity comes from the key the host holds; authorship comes from signatures; the merge verifies and refuses what does not check.

One sentence to build against: **a copy on a different device holds a different key, so it cannot produce the creator's signature, whatever rows arrived with it.**

## Why: one bug, several faces

Every identity incident since d22 is the same failure. The runtime trusts a value where only a signature can answer.

| Filed | What was seen | The value trusted |
| --- | --- | --- |
| Relaunch regression (23 Sept) | iOS recipient runs as the creator: no name prompt, creator's seat | the creator's `_dai_replica` row, carried in the data, kept by `ensureReplica` |
| d22 | a reopen kept the sender's id | the arrived file's replica row |
| D80 | a copy running under the creator's id is believed to be the creator | the author column on a seat row |
| D81 | Safari-then-install binds two seats to one person | replica id minted per browser context |
| D82 | a move the screen accepted is erased by a later merge, nothing said | rows with no author the merge can check against |

These cannot be closed at the mount, the relaunch or the merge one at a time. Each patch fixes one load order and the next load order reopens it. The fix is to change the primitive: identity stops being a value and becomes a key; authorship stops being a column and becomes a signature.

The pattern is already in `docs/backlog.md` as "one name, two meanings". Here the name is the replica id and the two meanings are "what the host recorded" and "what a row says".

## Two layers, kept apart

**Authorship** is always on and needs no account. The key is made silently on first use, stored on the device, and signs every change the person makes. It vouches for nothing about who the person is. It only makes each row provably from one key and no other. This is the layer this sitting builds.

**Verification** is optional and starts empty. It answers "whose key is this?" with a signed statement from an authority: "key K belongs to Jane in Legal." For consumers there is no authority and the layer stays empty. For enterprise the authority is the firm's existing identity provider (Okta, Entra, whatever they run). This sitting reserves the space for it and builds none of it.

The two are separable because the bottom one works with the top one absent. Git is the proof: a commit is signed on the machine whether or not GitHub ever sees it; GitHub's "Verified" badge is a later, separate vouching for the key.

**Vouching reaches backward.** An authority vouches for the key, not for documents. Every document the key ever signed becomes attributable the day the key is vouched for, with no re-signing and no format change. This only holds if the person has used one durable key from their first document on. That is why the key primitive is built now, years before anyone verifies a key.

## Definitions

One owner per name. Each of these is defined once, in the file named, and imported everywhere else.

| Term | Meaning | Owner |
| --- | --- | --- |
| Person key | An ES256 (P-256) keypair made once per device on first use. The private key never leaves the host. Same curve as the publisher key already in use, so one verifier serves both. | host, `src/identity.ts` (new) |
| Author id | The fingerprint of a person key's public key: SHA-256 of the raw public key, first 16 bytes, base64url. This **is** the replica id. The two names collapse into one. | `src/identity.ts` |
| Batch | The unit of signing: one change set from one author. Carries document id, author id, the author's clock, the rows changed, and one signature over all of it. A batch is to DAI what a commit is to Git. | `src/batch.ts` (the existing batch encoding) |
| Signature | ES256 over the canonical bytes of a batch. Produced by the host on the frame's request; the frame never holds the private key. | `src/identity.ts` |
| Seat | A row in the app's own seat table whose batch is signed by the person holding the seat. The seat table is owned by the kit; `daiKit.claimSeat` is its only writer and `amCreator` / `mySeat` are kit reads. An app that writes the table directly fails a check. "Am I the creator" means "the creator seat's batch verifies under my key." | app kit, `daiKit` |
| Attestation | A signed statement by an authority that a public key belongs to a named principal. Reserved on the wire; nothing produces or checks one in V1. | `src/identity.ts` (type only) |
| Publisher key | The key that signs a container for the store and the version relay. One key per person, two roles: for a solo author the publisher role is filled by their person key. `publish()` takes a key rather than assuming the person's, so a firm's key can later publish a container whose rows employees sign. | existing, `src/publish.ts` |

## Binding rules

1. **The host owns identity.** The person key lives in the host, non-exportable from the frame. The frame learns its author id from the host on every mount and never from a row. `mountIsOwnCopy` no longer decides identity anywhere.
2. **The `_dai_replica` row is not a source of identity.** It may remain as a display cache. `ensureReplica` writes the host's id over whatever is there. It never keeps a row that differs from what the host handed it. This is the 23 Sept ruling; the key primitive subsumes it.
3. **Every write is a signed batch.** The frame assembles the batch, sends it to the host over the bridge, the host signs, the batch is stored and replicated with its signature. No unsigned batch is written by a runtime at this version or later.
4. **The merge verifies before it applies.** A batch whose signature does not verify under the author id it names is refused, not applied, and reported (this is D82's other half: the merge can now say whose row it refused). A batch from an author id never seen before is accepted as a new author. Restricting new authors is enterprise policy, not V1.
5. **A seat is a signed claim.** `amCreator` and its kin ask "does the creator seat's batch verify under my key", never "does the author column equal my id". A copy holding a different key cannot forge a seat. **A signature answers who wrote a row; a seat answers whether they may.** The signature alone does not close D80: a copy that honestly signs as Bo can still play White's move, and only the seat can refuse it. The kit admits a row only from the author holding the seat that row's action belongs to, inside its merge path, and reports the refusal as `SEAT_NOT_HELD` (step 5; `IDENTITY-SEAT-ADMITS` in `src/rules.ts`).
6. **Arriving rows belong to their signers.** A copy that arrives with data keeps every row as the rows of whoever signed them. It adopts none. Its own author id is whatever key this device holds, minted fresh if there is none.
7. **Different place, different key.** A copy landing on a device with no person key mints one. A second copy on the same device shares the device's key. The runtime never asks "is this my copy"; it asks "what key does this device hold". **One document, one copy per device:** a copy of a document this device already holds never becomes a second copy beside it. On arrival the host merges it into the held copy, takes it in place of the held one, or keeps the held one and sets the arrival aside, because two copies writing under one key would issue the same `(author, seq)` for different rows. A loose file opened twice gets the same treatment. Two tabs on one held copy are not yet covered (backlog D105). Ruled 24 Sept; `IDENTITY-ONE-LIVE-COPY` in `src/rules.ts`. The successor that removes the hazard, row identity by content hash, is V1.1 (backlog D104).
8. **Bridge names go through the naming family.** New host-bridge messages for sign and author id are added to `src/bridge.ts` with their load-time checks and wire tests, per the closed naming/ownership work. No literal message strings.
9. **Signing cost is paid per batch, not per row.** One ES256 signature per change set. A batch of 200 rows signs once.
10. **Canonical bytes are frozen.** The bytes a signature covers are defined once, versioned, and held by a frozen byte-vector test. A change to canonical form is a format version, never a refactor.

## On the wire: built now, reserved for later

The point of reserving is that a document signed today stays readable and verifiable when the enterprise layer arrives. Nothing here breaks a V1 document; everything here is what V1.1 and enterprise will need to find already in place.

| Field | Where | V1 | Later |
| --- | --- | --- | --- |
| `author` (author id) | batch header | required, filled | unchanged |
| `sig` (ES256 over canonical batch) | batch header | required, filled | unchanged |
| `pub` (author's raw public key) | batch header, once per author per document | required, filled; lets a verifier check without a directory | unchanged |
| `att` (attestation) | batch header | present, empty | the authority's signed statement binding `pub` to a principal |
| `issuer` (who vouched) | inside `att` | absent | the identity provider's key id |
| Canonical form version | batch header | `1` | bumps only with a format change |
| Seat secret in the invite fragment (D80 option d) | fragment key | **not reserved: superseded** | signed seats make a per-seat secret unnecessary; "first verified signer takes the joiner seat" is the V1 rule |

The batch encoding already has the slot D80 asked to reserve. This sitting fills it with `author` and `sig` and adds `pub` and the empty `att`. The D80 wire reservation decision is therefore made: yes to the proof field, no to the seat-secret fragment key.

The fingerprint rule (SHA-256, 16 bytes, base64url) and the canonical byte layout are published in `docs/format.md` alongside the existing batch encoding and are held by frozen byte vectors in `format-vectors.spec`.

## Consumer story, enterprise story

**Consumer.** Grace opens a `.dai`. Her phone makes a key; she sees nothing. She writes; every batch is signed. She shares a copy with Dan; Dan's phone makes its own key and Dan's moves are Dan's. Nobody logged in, nothing was uploaded, no server knows either of them. Two years later Grace signs up for a paid account that vouches for her key: every app she ever made becomes provably hers, because they were signed all along.

**Enterprise.** Jane opens the same format at work. Her key is made the same way. The firm's identity provider signs an attestation binding Jane's key to her directory identity, and that attestation rides in `att` on her batches. An auditor verifies the chain: batch → key → attestation → the firm's issuer. Same documents, same signatures, now with a name a regulator accepts. The format did not change; a link was added at the top.

**Policy is the only thing enterprise adds to the runtime.** A firm can say "this document accepts batches only from attested keys under our issuer". That is a rule the merge checks, and it is the one place rule 4's "accept any new author" is overridden. Everything else is the consumer runtime.

The consumer version is the enterprise version with the top link left off. That is the whole reason to build one system, not two.

## Key durability, loss, second device

The key is stored in the host's IndexedDB under a key name owned by `src/keys.ts`, as a WebCrypto key marked extractable. Extractable is required: a non-extractable key can never become a recovery phrase, and a person locked out of their own back catalogue is the enterprise story's failure mode. Persistence is asked under D55's rule, after the first real write, never at boot.

**Loss.** If storage is wiped, the device mints a new key and becomes a new author. Old documents stay readable and mergeable; the person can no longer write as their old author id. This is the accepted V1 behaviour, stated on screen through a one-line kit hook whose default is "This device is a new player here. Your earlier moves are still on the board." Apps may override the wording; none says identity, key or storage. Nothing pretends continuity that does not exist.

**Second device.** Two roads, both later:

- Consumer: the person carries the key. A recovery phrase (the wallet and password-manager pattern) shown from a "Your key" screen, or the key wrapped under a passphrase and moved through the store. Until they do it, phone and laptop are two authors, correctly.
- Enterprise: each device mints its own key; the identity provider attests both to the same principal. No phrase to carry; the firm is the linking authority, exactly as GitHub links two machines' keys to one account.

**Private windows and D81.** A private Safari window has its own storage and therefore its own key. Safari-then-install is two contexts, so two keys, so two seats. That is correct under rule 7. D81 becomes a key-transfer question, not an identity bug, and moves to the second-device road.

## What this closes on the backlog

| Item | Outcome |
| --- | --- |
| Relaunch identity regression (23 Sept) | closed: author id comes from the host's key on every load |
| D80 (copy under creator's id believed creator) | closed by construction: `test.fail` flips to a passing test that a forged seat is refused |
| D82 (merge erases an accepted move, says nothing) | half closed: the merge reports what it refused and whose it was; "reports what it took away" for verified conflicts stays open |
| D81 (Safari-then-install double seat) | reclassified: key transfer, second-device road |
| D80 wire reservation decision | made: proof field yes, seat-secret fragment key no |
| d22 | unchanged and still held: the recorded id surviving a reopen is now the key surviving a reopen |
| Identity primitive (held item) | this document |

## Migration of existing documents

A document written before this version has unsigned batches. The runtime reads them as authored by a fixed `legacy` author id and never applies, merges or writes an unsigned batch at this version or later. Legacy history is visible and read-only. There is no state-dependent rule: whether a batch is verified never depends on what the document already holds.

The example apps (chess, tic-tac-toe, receipts, request, Moon Garden, the coming workout app) are rebuilt on the new runtime rather than migrated. Their pre-identity documents on any test phone are discarded. The walk's V1 control (the workout app) starts life signed, so nothing on the V1 walk ever carries a legacy batch.

## Tests that go red first

Each is written and shown red before any runtime change, per the standing rule. Each names its engine; the iOS ones run on WebKit only.

1. **Recipient is not the creator.** iPhone UA, store link with data, fake store, through the relaunch: recipient's author id ≠ creator's, name prompt shown. Red on `7653c44`. Desktop stays green before and after.
2. **A forged seat is refused.** A copy writes a creator-seat batch under an author id it does not hold the key for: the batch does not verify, is not applied, and the refusal is reported with the author id. This is D80's `test.fail` inverted.
3. **A tampered batch is refused.** One byte of a signed batch changed in transit: refused, reported.
4. **A new author is accepted.** A batch from a never-seen key with a valid signature applies (consumer rule 4).
5. **The key survives a reopen.** `d22-reopen` reworded: the author id after a reopen equals the author id before it, and equals the host's key fingerprint.
6. **A new device is a new author.** Fresh context, same document arriving: different author id, name prompt.
7. **Frozen byte vectors.** Canonical batch bytes, fingerprint of a known public key, a known signature verifying. These are the one exception to "a test imports the constants it asserts on": their subject is the literal.
8. **`inviteNewGame` with `withData`.** Both shapes run through every crossed-invite test; any test that passed only because the copy was blank is named in the report.
9. **No literal bridge strings.** `check-names` fails on a `dai:sign`-style literal outside `src/bridge.ts`.

## Not in this sitting

- Recovery phrase and the "Your key" screen.
- Second-device key transfer, consumer or enterprise.
- Producing or checking attestations; any identity-provider integration.
- Per-document policy ("attested keys only").
- Row-level encryption; the seal stays as it is.
- Naming people to each other beyond the existing name prompt.
- Any change to the version ping, the relay, or the store.

## Rulings (23 Sept)

- [x] Publisher key: one key, two roles; publisher role pluggable (a firm's key may fill it). Ruled 23 Sept.
- [x] Legacy: no unsigned batch applies at this version or later; legacy history read-only. Ruled 23 Sept.
- [x] Loss sentence: kit hook, default "This device is a new player here. Your earlier moves are still on the board." Ruled 23 Sept.
- [x] Seats: table moves into the kit; the kit is the only writer. Ruled 23 Sept.
