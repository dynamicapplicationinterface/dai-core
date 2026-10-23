# Recipient-bound ownership — a spec for issue #1

Status: draft. Written against `spec-v0.2.md` (current), `docs/capabilities.md`,
`docs/replicated-tables.md`, and `docs/collaborative-play.md`. Nothing here is
implemented; nothing here changes those documents. Where this spec proposes a
new capability row or a new refusal code, that addition is not made until a
compiler emits it, per capabilities.md's own rule ("registered before
emitted").

The key words MUST, MUST NOT, SHOULD and MAY follow RFC 2119, as in
spec-v0.2.md.

## 0. What this closes, and what it does not

Issue #1 asks for two things that are related but not the same size:

1. **`recipient-bound`** — a document that opens only for a named recipient,
   on a key that recipient holds. This is already a registered capability
   name (`docs/capabilities.md`) with a one-sentence contract and no
   implementation (`IMPLEMENTED_CAPABILITIES` in `src/container.ts` is
   `["replicated"]`). This is a bounded, mostly-cryptographic feature: wrap a
   content key to a recipient's public key instead of carrying it in a URL
   fragment (as `src/store.ts` does today) or not encrypting it at all.

2. **Transferable ownership** — a document whose recognized owner can change,
   account-free, without the file itself being able to prove finality on its
   own (two device filesystems and a network authority do not form one
   atomic transaction, and this spec does not pretend otherwise). This is a
   protocol with a trust model, a state machine, and real open questions
   about what "final" can mean without a server everyone must trust.

Bundling them into one `requires` name would be exactly the mistake
capabilities.md warns against: "if the sentence needs a paragraph, the
capability is more than one capability." This spec keeps `recipient-bound`
as issue #1 found it — opening gated on a recipient key, nothing about
transfer — and proposes a second name, **`transferable-ownership`**, for
everything about succession of ownership. A reader may implement one without
the other; a document may declare one without the other. §1 gives both rows.

**In scope for this spec:**
- The `recipient-bound` capability: content encrypted to a recipient's key,
  opening gated on holding it, refusal semantics per carrier.
- Local owner key generation, storage (host-only, never in the sandboxed
  frame), and an encrypted backup/recovery format.
- The ownership envelope: a versioned, authenticated structure carried
  **in the database**, not the signed manifest (§2 explains why), recording
  who currently owns the object and the chain of transfers that produced
  that state.
- A Level 1 (offline, file-carried) transfer mechanism with an honestly
  stated trust model: no finality, no double-transfer prevention, and that
  limitation stated in the protocol rather than glossed over — the same
  posture `docs/replicated-tables.md` §10 takes for Level 1 replica claims.
- A sketch of a Level 2 (online, account-free) finality authority, with its
  open questions named rather than resolved.
- Opener/host bridge surface: new bounded operations, modeled on
  `DAI_HOST_MERGE` (`docs/replicated-tables.md` §10a) and the capability
  `MessagePort` model (spec-v0.2.md §4.7).

**Out of scope for this spec (named, not silently dropped):**
- Multi-file atomic exchange (issue §4, "commit all or none" across several
  documents). Flagged in §8 as a later phase once single-object transfer
  ships and is exercised.
- A concrete choice of Level 2 authority implementation, its hosting model,
  or its cost. §7 gives the interface shape a reader would need; who runs
  one is not decided here, the same way `docs/replicated-tables.md` "Track 5"
  leaves running a relay to whoever wants one.
- Argon2id or any KDF requiring a WASM dependency for recovery-phrase-based
  backup. §3 recommends a WebCrypto-only baseline and names the better KDF
  as a follow-up, because adding a cryptography dependency is its own
  decision this issue does not need to force.
- Mobile home-screen / PWA storage-partition behavior for owner keys. This
  is the same open problem `docs/backlog.md` §6.3 already tracks for
  documents in general ("a link cannot reach an installed icon"); an owner
  key is subject to the identical browser-storage-partition limits and gets
  no special exemption here.
- Notifications ("your object was reclaimed") — out of scope for the same
  reason `docs/backlog.md`'s device-capabilities section gives: a
  notification is the document reaching out while not open, which is a
  different property than anything this format claims today.

## 1. Capability registry rows (proposal)

Two rows added to the table in `docs/capabilities.md`, and to
`CAPABILITY_REGISTRY` in `src/container.ts` and `dai_read.py`:

| Name | What a reader must do to claim it |
|---|---|
| `recipient-bound` | *(already registered)* Open only for a named recipient, on a key that recipient holds. |
| `transferable-ownership` | Maintain the ownership envelope of §4, refuse to treat a document as owned by any party but the one the envelope's highest valid transfer names, and refuse a transfer that does not chain from the envelope's current state. |

A reader implementing `transferable-ownership` MUST also implement
`recipient-bound` — an object that can change hands but that anyone can read
regardless of who holds it is not what this issue asks for — but the reverse
is not required: a document can be recipient-bound and never transfer.

Per capabilities.md's per-carrier rule, both names get one case per carrier,
stated in §5.4.

## 2. Where the ownership envelope lives, and why (OD-1)

This is the load-bearing decision in this spec, so it comes before the
envelope's fields.

The manifest's signed set (spec-v0.2.md §3.1) is the publisher's word about
the *application* — code, assets, schema — and it is immutable for the life
of the document (`document.sqlite` is deliberately excluded from
`signedEntries` because "a container carries no private key and cannot
re-sign after a save"). Ownership is not a publisher fact. It changes every
time the object changes hands, the publisher is very often offline or gone
by then, and requiring the publisher's signature on every transfer would
make every transfer depend on a party with no reason to be involved.

So the ownership envelope is **not** a manifest field and is **not** part of
`signedEntries`. It lives where `document.sqlite` already lives: in the
mutable data section, as rows in a reserved table the runtime creates and
the application never writes to, exactly as `_dai_replica` and
`_dai_replicas` already work for replicated tables
(`docs/replicated-tables.md` §4). Call it `_dai_ownership`.

This buys three things for free, because the mechanism already exists and
is already trusted:

1. **A transfer is an ordinary save.** Spec §5's save rule — rewrite the
   data section and the footer, leave the manifest and signature untouched —
   already covers writing a new ownership envelope row. No new save path,
   no new signature to compute, no schema version bump per transfer.
2. **Verification is layered the way §7 already layers it.** The publisher
   signature (when present) still proves the application has not changed.
   The ownership envelope is checked by its *own* rule (§4), against the
   *owner's* key chain, independently — the same separation `_r_*` columns
   already have from application data in replicated tables (T1-D11: "not
   signed... not compared... not exported as fact" for `_r_superseded`,
   because it answers a different question than the row content does).
3. **It travels with every carrier the database already travels with.**
   `recipient-bound` documents are not expected to fit in the 32 KB inline
   link (§5.4 says so explicitly), but nothing about this placement invents
   a fourth carrier or a new wire format.

The cost, named rather than hidden: a reader that does not implement
`transferable-ownership` and opens the raw database directly (bypassing the
container reader) sees an SQL table it does not understand and — per
`docs/replicated-tables.md` §6.3's declared-schema mechanism — a
`runtime/schema.json` migration gate already refuses to hand such a database
to an application that does not declare it, so this is not a new hole. It is
the same hole every declared-schema table already has and closes the same
way.

**OD-2 — the ownership envelope is bound to the document's identity, not to
a separate object id.** The issue asks for "a stable issuer-scoped object
identifier." This spec sets that identifier equal to the container's own
`documentUuid` (spec-v0.2.md §3) rather than minting a second one. A
container is already one identity; giving ownership its own would let the
two disagree about what "this document" means, which is exactly the kind of
two-sources-of-truth bug §3.1's bidirectional `signedEntries`/`hashes`
reconciliation exists to prevent, applied to a different pair of fields.
`supersedes` (§5.1) already changes what document an identity points to
without touching ownership; the two mechanisms are independent and a
successor document (built with `supersedes`) MUST start a **new** ownership
chain rather than inherit one, because succession is a publisher act under
the publisher's key and transfer is an owner act under the owner's key —
conflating them would let a publisher's rebuild silently reset who owns an
object, or let an ownership transfer silently swap out the application.

## 3. Local owner keys

**Two key pairs per identity-on-a-device**, generated and held by the
trusted host (the opener, the desktop shell — never the sandboxed
application frame, per spec-v0.2.md §4.7: "never anything the application
can reach without the host choosing to hand it over"):

- **Owner signing key** — ECDSA P-256, the same curve and algorithm the
  publisher key already uses (spec-v0.2.md §3, `src/p256.ts`), so a host
  already holding a P-256 signer needs no second crypto stack. Used to
  authorize a transfer (§5) and to sign issuance/acceptance.
- **Owner encryption key** — P-256 ECDH (WebCrypto `deriveKey`/`deriveBits`
  with `{ name: "ECDH", namedCurve: "P-256" }`), used to unwrap the content
  key of §4. A second key rather than reusing the signing key for both
  purposes, because a key used for both signing and key-agreement is a
  well-known way to leak the signing key through a key-agreement oracle;
  the two purposes MUST use distinct key pairs.

**Storage.** Private key material MUST NOT leave the trusted host process,
MUST NOT be placed in the sandboxed iframe (spec-v0.2.md §4.1), MUST NOT be
written into any document, and MUST NOT be exposed to the application
except as a capability the application cannot itself invoke (spec-v0.2.md
§4.7 — a `MessagePort` for "unwrap this content key" and "sign this
transfer authorization," never the key itself). A browser host keeps it in
IndexedDB scoped to its own origin; a native host keeps it in its own
config directory or OS keychain. Neither is assumed to survive an origin
change, a reinstall, or storage eviction — see the explicit non-goal below.

**Recovery.** An encrypted export: the two private keys, CBOR-encoded
(deterministic encoding, as §3.1 already requires for anything a
verification depends on byte-for-byte), sealed with AES-256-GCM under a key
derived from a passphrase via PBKDF2-SHA256 (WebCrypto-native, no added
dependency) at a minimum of 600,000 iterations — OWASP's 2024 floor for
PBKDF2-SHA256, chosen as the buildable baseline rather than the best
possible one. **Open, flagged rather than decided**: Argon2id is the better
KDF for this threat model and needs a WASM dependency this project does not
currently carry; adopting it is a follow-up, not blocking, and a host MAY
support importing a backup made under a stronger KDF in the future without
this format changing, because the backup's header names its own KDF and
parameters.

**Migration vs. transfer, distinguished operationally.** Restoring a backup
onto a new device for the *same* owner recreates the same key pair; the
ownership envelope's `transferVersion` (§4) is unaffected because the key
did not change. A transfer changes which key pair the envelope names as
current owner. **OD-3**: a host that restores a backup MUST check the
restored key against the current owner key recorded in every
`_dai_ownership` row it already holds copies of (its own held documents);
where the restored key is no longer the envelope's current owner (a
transfer happened after the backup was taken), the host MUST show the
document as **not owned by this device** rather than silently offering the
stale key as though it still worked. This is Level 1's honest limit (§6):
a Level 1 host has no online authority to consult, so "no longer current"
can only be known from a *later* copy of the same document this host has
independently seen — an old backup restored on an isolated device, with no
newer copy ever received, cannot know it has been superseded, and this spec
does not claim otherwise (see §6's stated limitation and the issue's own
"open protocol decisions" list, item 3, offline guarantees).

**All keys and recovery material lost.** Stated plainly, per this issue's
own requirement: the object becomes unrecoverable by this protocol. Nothing
here invents a recovery-of-last-resort, because any such mechanism is
itself a second way to become the owner and undermines every guarantee
above it. A host MAY let a publisher define its own out-of-band recovery
(e.g., a licensing server unrelated to this spec) but that is not part of
`transferable-ownership`.

## 4. The ownership envelope

One logical record per document, stored as rows in `_dai_ownership`
(created `IF NOT EXISTS` by the runtime on every open of a document
declaring `transferable-ownership`, exactly as replicated tables'
document-level tables are — `docs/replicated-tables.md` §4):

```sql
CREATE TABLE _dai_ownership (
  transfer_version   INTEGER PRIMARY KEY,       -- 0 at issuance, +1 per transfer
  document_uuid       BLOB NOT NULL CHECK (length(document_uuid) = 16),
  publisher_binding   TEXT NOT NULL,             -- see below
  owner_sign_key      BLOB NOT NULL,             -- SPKI, the current owner's signing key
  owner_ecdh_key      BLOB NOT NULL,             -- SPKI, the current owner's encryption key
  prior_receipt_hash  BLOB,                      -- SHA-256 of the previous row's canonical bytes; NULL at version 0
  content_key_wrapped BLOB NOT NULL,             -- the data-section content key, ECDH-wrapped to owner_ecdh_key
  transaction_id      BLOB NOT NULL CHECK (length(transaction_id) = 16),
  issued_at           INTEGER NOT NULL,          -- Unix seconds, informational only (see T1-D1's reasoning: never authoritative for ordering)
  authorization_sig   BLOB,                      -- the PRIOR owner's signature over this row's canonical form; NULL at version 0 (self-issued)
  acceptance_sig       BLOB,                      -- the NEW owner's signature accepting this row; NULL until accepted
  finality_evidence    BLOB                       -- opaque, authority-specific (§7); NULL at Level 1
) WITHOUT ROWID;

CREATE TRIGGER _dai_ownership__no_update BEFORE UPDATE ON _dai_ownership
  BEGIN SELECT RAISE(ABORT, 'OWNERSHIP_ENVELOPE_IMMUTABLE'); END;
CREATE TRIGGER _dai_ownership__no_delete BEFORE DELETE ON _dai_ownership
  BEGIN SELECT RAISE(ABORT, 'OWNERSHIP_ENVELOPE_IMMUTABLE'); END;
```

Append-only, like a replicated table, but **not** union-merged: ownership
has exactly one head by construction (the highest `transfer_version` this
copy has ever accepted), never a set of concurrent heads. Two copies
disagreeing about the current owner is not a conflict to display and
resolve in the UI the way `T_current` shows a replicated conflict — it is
the double-transfer problem, and Level 1 (§6) states plainly that it cannot
fully solve it.

**`publisher_binding`** ties an ownership chain to one specific signed
application, so an ownership envelope cannot be replayed onto a document
whose application content differs: `documentUuid` + the publisher's
`publicKeyFingerprint` + (when the container is signed) the digest of
`signedEntries`, joined and hashed. A reader MUST refuse an envelope whose
`publisher_binding` does not match the container it is found in
(`OWNERSHIP_ENVELOPE_INVALID`), which stops an ownership chain built for one
document from being copied wholesale into a different one that happens to
share a UUID (succession's own case, §5.1) or a re-signed rebuild.

**Canonical encoding.** Every field a signature covers (`authorization_sig`,
`acceptance_sig`) is computed over a deterministic CBOR map of this row —
same discipline as spec-v0.2.md §3.1: sorted keys by encoded bytes,
shortest-form lengths, no indefinite lengths, optional fields (only
`prior_receipt_hash` at version 0, and `finality_evidence` absent at Level
1) omitted entirely rather than encoded null. Two encoders that agree on
values and disagree on bytes produce signatures that do not verify, and
this project has already paid for that lesson once (spec-v0.2.md §3.1's own
framing). A follow-up to this spec MUST add the CDDL for this structure to
`docs/cddl.md` and frozen vectors to `conformance/vectors.json`, the same
way every other signed structure in this format is pinned, before a second
implementation is attempted.

**Signed fields, explicitly:**

`authorization_sig` — the outgoing owner's ECDSA-P256-SHA256 signature over
the canonical bytes of this row with `authorization_sig` and
`acceptance_sig` themselves excluded from what is signed (a signature
cannot cover its own bytes, the same reasoning spec-v0.2.md §3.1 gives for
excluding `signature` from its own payload). Absent (`NULL`) only at
`transfer_version = 0`, where the object is self-issued by its first owner
with no predecessor to authorize it.

`acceptance_sig` — the incoming owner's signature over the same canonical
bytes plus `authorization_sig`, once present. This is what makes a transfer
require the recipient's participation rather than letting an outgoing owner
unilaterally reassign an object to a key they also control and call it
accepted; see §6 for why this still is not finality.

## 5. Opening a `recipient-bound` document

**What is encrypted.** The container's data section (§2 of spec-v0.2.md —
the SQLite database) is sealed with AES-256-GCM under a per-document content
key, using the identical primitive `sealForStore`/`openFromStore` in
`src/store.ts` already implement for the reference-link carrier. What
changes from that existing mechanism is only how the key is delivered: a
reference link puts the raw key in a URL fragment a server never sees; a
`recipient-bound` document instead wraps the same 32-byte key to the current
owner's ECDH public key (`content_key_wrapped` in §4) and never carries the
raw key anywhere. **This is the whole of what `recipient-bound` adds over
what the reference-link carrier already does**: a different answer to "who
may derive the content key," not a new encryption primitive.

The application (`app/*`, the runtime, the shell) is unaffected and stays
unencrypted and publisher-signed exactly as today, because the application
is not the confidential part — the recipient's data is. A publisher building
a `recipient-bound` template ships an ordinary signed application; the
runtime encrypts the data section at first save under the initial owner's
wrapped key.

**Opening sequence, host-side:**

1. Parse and verify the container exactly as `verifyContainer`
   (`src/container.ts`) already does — publisher signature, entries, shell.
   This step is unchanged and unaware of ownership.
2. `checkRequires` (already implemented) refuses `UNSUPPORTED_CAPABILITY`
   if this reader lacks `recipient-bound`.
3. Read the `_dai_ownership` head row (highest `transfer_version`) from the
   data section **before** decrypting it — the envelope's non-key fields
   (owner keys, transfer version, publisher binding) MUST be stored
   unencrypted, alongside the encrypted content, precisely so a host can
   find the wrapped key without first having the key. (This mirrors
   `Sidecar` in `src/store.ts`: metadata a party without the key still
   needs sits beside the ciphertext, never inside it — see that file's own
   comment on why a sidecar was pruned to exactly what a stranger needs and
   no more.) Concretely: the data section itself is not the thing
   encrypted; a `_dai_ownership_ciphertext` companion blob (IV ‖ ciphertext
   ‖ tag, holding everything else in the schema) is, with `_dai_ownership`
   left in the clear as the one table every reader may see regardless of
   who holds the key. A reader MUST refuse an envelope whose
   `publisher_binding` does not check out, per §4, before attempting
   anything else.
4. Check `publisher_binding` (§4).
5. Ask the trusted host's key store whether it holds the private key
   matching `owner_ecdh_key` for this row. If not: `OWNERSHIP_KEY_UNAVAILABLE`
   (recoverable — the right device or a restored backup fixes it; see §3).
6. Unwrap the content key, decrypt the data section, and only then hand the
   application a database handle — exactly as `docs/replicated-tables.md`
   §10a's `WRITE_SURFACE_UNAVAILABLE` model already withholds a handle until
   its own preconditions settle. An application never sees ciphertext and
   never sees an unwrapped key; it sees a database or it sees nothing.

## 5.4 Per-carrier refusal (capabilities.md's rule)

A reader lacking `recipient-bound` MUST refuse identically across all three
carriers of spec-v0.2.md §1.1, by name (`UNSUPPORTED_CAPABILITY`), before
attempting to interpret anything encryption-shaped:

- **File.** Refused at `checkRequires`, as any capability is today.
- **Inline link.** The inline carrier already omits large or elidable parts
  (§1.1); a `recipient-bound` document's data section cannot be inlined at
  all, because §1.1's inline map has no field for "data section, encrypted,
  key wrapped to a recipient" and adding one would blow well past the 32 KB
  cap for anything but a trivially small object. **This spec states, rather
  than leaves implicit: a `recipient-bound` document MUST be carried only
  as a file or a reference link, and a compiler MUST refuse to emit an
  inline link for one.** This is a real restriction and is named as such,
  the same way spec-v0.2.md §9.5 names that the inline carrier omits
  `identity` and countersignatures rather than pretending it carries
  everything a file does.
- **Reference link.** The existing `Store`/`Sealed` machinery in
  `src/store.ts` already transports encrypted blobs by hash with the key
  out of the store's reach; a `recipient-bound` object stored this way
  simply omits `k` from the link (§1.1's grammar already supports a
  reference link with no key of its own — `openFromStore`'s existing
  `BLOB_MISMATCH`/`BLOB_UNDECRYPTABLE` refusals already fire correctly on
  a store that cannot supply the wrapped-to-nobody-here content) and the
  recipient's local owner key is what stands in for the fragment key. A
  reader that reaches this carrier without `recipient-bound` implemented
  refuses at `checkRequires` before ever calling `openFromStore`, exactly
  as the file case does.

## 6. Level 1 — offline transfer, honestly bounded

A transfer is: the current owner's trusted host builds a new
`_dai_ownership` row (`transfer_version + 1`), generates a fresh content
key, re-encrypts the data section under it, wraps that key to the
recipient's `owner_ecdh_key`, signs `authorization_sig`, and hands the
**whole updated file** to the recipient (by any carrier §5.4 allows). The
recipient's host verifies the new row (§4's checks plus that
`prior_receipt_hash` matches the SHA-256 of the row it is replacing),
signs `acceptance_sig`, and the transfer is what this copy of the file now
says it is.

**What this is not, stated the way `docs/replicated-tables.md` §10 states
Level 1's limits for replica claims:** nothing here stops the outgoing
owner from doing this twice, to two different recipients, from the same
prior state. Each recipient's copy is internally consistent — a valid
chain, a valid signature, a `transfer_version` one higher than what it
replaced — and the two copies disagree about who owns the object, forever,
with no way for either recipient's device alone to discover this. **The
honest description of a Level 1 transfer is: this copy's owner is whoever
holds the highest `transfer_version` you have seen for this document,
signed by a chain you can verify back to issuance, and nothing stops the
previous owner from signing a second, equally valid successor.** This is
not a gap to be papered over in the UI, for the same reason
`docs/replicated-tables.md` §10 gives for the identical limitation in
Level 1 replica claims: it is closed by an online authority (§7) or not at
all, and pretending otherwise here would be worse than saying so.

**What Level 1 *does* give**, and it is not nothing: a chain a device can
verify entirely offline, back to issuance, with every link's signatures
checked; a host that has seen two conflicting chains for one
`documentUuid` (matching `publisher_binding`, differing at some
`transfer_version`) can and MUST detect and report the fork
(`OWNERSHIP_TRANSFER_CONFLICT`) rather than silently picking one, the same
"never omit, always surface" posture `T_current` takes for replicated-row
conflicts (`docs/replicated-tables.md` §4). What it cannot do is prevent
the fork from being created in the first place, or tell a device that has
only ever seen one branch that a second exists.

**Recoverable exchange (issue §4), scoped to what Level 1 can support:**
a transfer offer names the exact `transaction_id`, the exact prior
`transfer_version`, and an expiry; the recipient's host stages the
incoming file (verifies §4's chain, does not yet treat it as the working
copy) before signing `acceptance_sig` and only then adopts it as the
document of record, mirroring the store-then-verify-then-decrypt order
`openFromStore` already uses for reference links. An interrupted exchange
before `acceptance_sig` leaves the outgoing owner's copy untouched and the
incoming party with nothing adopted — recoverable by resending the same
staged file, since nothing about it has changed. An interrupted exchange
**after** `acceptance_sig` but before the outgoing owner learns of it is
Level 1's uncertainty: the outgoing owner cannot know, without an online
authority, whether the recipient accepted. This is named directly in
open question 3 (offline guarantees) and not resolved by this level.

## 7. Level 2 — an online finality authority (design sketch, not decided)

Presented as the issue itself presents it: "a design option, not a selected
dependency." What follows is the interface shape this project's existing
taste would produce — three bounded calls, the same discipline
`src/mailbox.ts` and `src/store.ts` already hold to — not a commitment to
build or host one.

```ts
interface OwnershipAuthority {
  /**
   * Atomically consumes (documentUuid, publisherBinding, fromVersion) and
   * records exactly one successor, or reports the current state if it does
   * not match. Idempotent by transactionId, the same shape as Mailbox.append's
   * idempotence by digest (src/mailbox.ts) — a retry of the identical request
   * returns the original receipt rather than minting a second one.
   */
  reserve(
    documentUuid: string,
    publisherBinding: string,
    fromVersion: number,
    transactionId: string,
    envelope: OwnershipRow, // the proposed new row, signed
  ): Promise<{ granted: true; receipt: SignedReceipt } | { granted: false; currentVersion: number }>;

  /** The authority's own signed statement of the current head, for offline verification later. */
  status(documentUuid: string, publisherBinding: string): Promise<{ version: number; receipt: SignedReceipt }>;
}
```

Authenticated by signed key possession (the request is itself signed by the
outgoing owner's signing key) rather than an account, matching the issue's
requirement. **What this spec does not decide, and names as open rather
than guessing:**

- **Trust model.** Whether a `SignedReceipt` from one authority is portable
  to a device that does not already trust that authority's key, and how
  such a key would be pinned or rotated. `docs/replicated-tables.md`'s own
  root-list mechanism (spec-v0.2.md §9.6) is a plausible template — an
  authority's key distributed the way a countersigner's key is — but this
  is a decision for whoever stands up the first authority, not this spec.
- **Offline guarantees.** A `status()` receipt proves "as of this
  authority, at this time, the head was N" — it is a freshness claim with
  an expiry, not a permanent proof of non-existence of a later transfer.
  Exactly how stale a receipt a host will accept before requiring a fresh
  check is a policy this spec leaves to the host, the same way
  `validUntil` policy is a host's clock to enforce (spec-v0.2.md §8: "clock
  rollback" is a named, unclosed limit there too).
- **Multi-device / recovery interaction.** §3's OD-3 already states that a
  restored backup cannot know it is stale without a newer copy or an
  authority check; Level 2 is what would let it ask. Whether that ask is
  mandatory before any local use of a restored key is a product decision,
  not a protocol one, and is left open.
- **Cryptographic suite for the authority's own signature and any transport
  to it.** ECDSA P-256 for consistency with the rest of this format is the
  default assumption; this is not pinned here because no interoperability
  vector exists yet to pin it against (contrast spec-v0.2.md §9.7, where
  every claim ships with vectors).

A reader MUST NOT report a document as having a finalized owner on the
strength of Level 1 chain verification alone once it also implements Level
2 — that is exactly the "unverifiable and unsigned are different answers"
discipline spec-v0.2.md §3 already applies to publisher keys, applied here
to ownership: a host that can check with an authority and has not yet done
so reports "not yet confirmed," never "owned," for a transfer past the last
version it can confirm.

## 8. Multi-file exchange — explicitly deferred

Issue §4 asks that a multi-file exchange commit all its ownership
transitions or none. This spec does not attempt that here, for the reason
the issue itself names: two device filesystems and a network authority do
not form one atomic transaction. A batched extension of `reserve()` above
(taking an array of `(documentUuid, fromVersion, envelope)` triples and
granting or refusing the whole array) is the shape a follow-up would take,
once Level 2 exists to batch against; specifying it before a single-object
transfer has shipped and been exercised would be designing against no
evidence, which is the trap `docs/backlog.md`'s "Phase 4.4 — not
engineering" and its capability-deferral rule (spec-v0.2.md §4.7: "built
when applications exist that are unusable without it") both warn against
directly.

## 9. Opener and host bridge integration

New bridge messages, bounded exactly like `DAI_HOST_MERGE`
(`docs/replicated-tables.md` §10a) — a fixed, small verb set rather than a
general RPC surface, per spec-v0.2.md §4.7's capability model:

| Message | Direction | Purpose |
|---|---|---|
| `DAI_HOST_OWNERSHIP_STATE` | host → frame | The current owner's public identity and `transfer_version`, so the application may render it. Never the private key. |
| `DAI_HOST_OWNERSHIP_TRANSFER` | frame → host | A request, initiated by an in-app "give this to…" affordance, naming a recipient's public keys (received out of band — QR, paste, a contact picker — never invented by this spec). The host builds and signs the new row; the frame never touches key material. |
| `dai:ownership-changed` | host → frame | Fired after a transfer is authorized or accepted, carrying the new `transfer_version` and owner identity — the ownership analogue of `dai:merged`. |

Every message is bound to the window it can only have come from, per
spec-v0.2.md §4.4's general rule ("every message either side acts on MUST
be bound to the window it can only have come from"); no new exception is
introduced here. The host validates bridge session/origin exactly as it
already does for every other message class before this feature adds a
verb to the set.

Idle capability declaration: a document declares
`requires: ["recipient-bound"]` and, where transfer is meant to be
possible, `requires: ["recipient-bound", "transferable-ownership"]`, in the
signed manifest exactly as `replicated` already is
(`docs/replicated-tables.md` §3). A host lacking either name in
`IMPLEMENTED_CAPABILITIES` refuses by name before any bridge message is
even relevant.

## 10. New refusal codes

Added to `src/refusals.ts`'s `REFUSALS`, following its existing shape
(`recoverable`, `means`):

| Code | Recoverable | Means |
|---|---|---|
| `OWNERSHIP_ENVELOPE_MISSING` | no | The document declares `transferable-ownership` and carries no `_dai_ownership` row. |
| `OWNERSHIP_ENVELOPE_INVALID` | no | The envelope is malformed, its `publisher_binding` does not match this container, or its chain does not verify back to issuance. |
| `OWNERSHIP_KEY_UNAVAILABLE` | yes | This host does not hold the private key the current owner row names. The right device, or a restored backup, resolves it. |
| `OWNERSHIP_TRANSFER_STALE` | yes | A transfer was authorized against a `fromVersion` that is no longer current; the sender should retry against the current head. |
| `OWNERSHIP_TRANSFER_CONFLICT` | no | Two verified chains exist for the same document and publisher binding, diverging at some `transfer_version` (§6). Recorded and shown; never silently resolved. |
| `OWNERSHIP_AUTHORITY_UNAVAILABLE` | yes | A Level 2 check was required by policy and no authority could be reached. |

Consistent with capabilities.md's stated reason for every refusal having a
name: "this could not be opened" sends somebody looking for file damage
that is not there, when the actual answer is "you are not (yet, or
verifiably) the owner" or "this file forked."

## 11. Exit criteria

Each phase below is meant to land and be reviewable on its own, per this
issue's own framing that the work may be staged.

**Phase A — `recipient-bound` alone (§1, §3, §5, §5.4).**
- `IMPLEMENTED_CAPABILITIES` in `src/container.ts` and `dai_read.py` gains
  `"recipient-bound"`.
- A conformance vector `recipient-bound-minimal`: a document encrypted to
  one owner key opens for that key and refuses
  (`OWNERSHIP_KEY_UNAVAILABLE`) for any other, on all readers.
- A vector per carrier per §5.4: file, reference link — inline explicitly
  **absent** from this list, with a compiler-level test asserting a build
  attempt for an inline link of a `recipient-bound` document is refused at
  build time, not silently truncated.
- A reader lacking the capability refuses identically (`UNSUPPORTED_CAPABILITY`)
  across file and reference-link carriers of the same fixture document —
  the "case per carrier" capabilities.md requires, made concrete as a test
  rather than left as a sentence.

**Phase B — the envelope and local keys, opening only, no transfer (§2, §3, §4).**
- `_dai_ownership` created `IF NOT EXISTS` on every open of a document
  declaring `transferable-ownership`, never written by the application
  (a test that an app-authored `INSERT`/`UPDATE`/`DELETE` against it is
  refused by the immutability triggers, mirroring
  `tests/*replicated*immutable*` in spirit).
- Key generation, host-only storage, and the encrypted-backup round trip
  (export, wipe, import, decrypt data section again) as an end-to-end test,
  analogous to `tests/attachments.spec.ts`'s device-A/device-B shape.
- OD-3's stale-restore behavior: a vector with two chains, an old backup
  restored after a transfer it does not know about, asserting the host
  reports not-owned rather than offering the stale key.

**Phase C — Level 1 transfer (§6).**
- `transfer-chain-verifies`: a three-hop chain (issue → transfer →
  transfer), each link's `authorization_sig`/`acceptance_sig` checked, the
  final holder opens and the two earlier holders' now-superseded keys
  refuse with the document still opening for the current one.
- `transfer-fork-detected`: the double-transfer case named in §6 — two
  valid chains diverging at one `transfer_version` — asserting
  `OWNERSHIP_TRANSFER_CONFLICT` is raised when a host is shown both,
  rather than either being silently preferred.
- `transfer-staged-not-adopted`: an interrupted exchange before
  `acceptance_sig` leaves the outgoing owner's copy openable and unchanged.

**Phase D — Level 2 (§7).** Not exit-criteria-bearing in this spec, because
§7 is explicitly a sketch pending the open questions it lists. A follow-up
spec is the right vehicle once those are answered, per this issue's own
"open protocol decisions" section — restated, not resolved, in §12.

Every phase's vectors are added to `conformance/vectors.json` and the CDDL
of §4 to `docs/cddl.md`, per spec-v0.2.md §2.4's own standard for any new
signed structure, and the Python reader (`dai_read.py`) implements Phase A
and B's checks from this text alone before this spec is considered
stable — the same "readers before writers," independent-implementation
discipline `docs/replicated-tables.md` used for Track 1.

## 12. Open protocol decisions carried forward

The issue's own list, restated with this spec's position on each:

1. **Envelope placement and capability decomposition** — resolved by this
   spec: in the database (§2, OD-1), as `_dai_ownership` (§4), under two
   capability names (§1). Not yet resolved: whether a future capability
   needs decomposing further once a second implementer exists, per
   capabilities.md's own "adding one" process.
2. **Finality mechanism and trust assumptions** — explicitly open (§7).
   This spec gives an interface shape and refuses to pick a hosting or
   trust model without evidence, per spec-v0.2.md §4.7's deferral
   principle for capabilities generally.
3. **Offline access guarantees and freshness policy** — explicitly open
   (§3 OD-3, §7). This spec states what Level 1 can and cannot know
   offline; it does not set a policy for how stale a Level 2 receipt a
   host may accept.
4. **Recovery, multiple authorized devices, and key migration** — partially
   resolved: §3 gives a concrete backup format and the migration/transfer
   distinction (OD-3). Multiple simultaneously-authorized devices for one
   owner (as opposed to one device recovering another's backup) is not
   addressed and is flagged as a gap: today, two devices holding the same
   restored key pair would both sign as "the owner" with no coordination
   between them, which is a different and unaddressed failure mode from
   the two-recipients-transfer fork of §6.
5. **Cryptographic suites and interoperability vectors** — resolved for
   Level 1: ECDSA P-256 and ECDH P-256, matching the rest of the format,
   with PBKDF2-SHA256 for backup encryption as a stated-suboptimal
   baseline (§3). Explicitly open for Level 2 (§7).
