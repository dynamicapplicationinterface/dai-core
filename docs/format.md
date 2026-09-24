# Signed batches: the bytes a signature covers

The canonical form behind signed authorship (`docs/identity.md`). Format
version **1**, held byte for byte by `tests/identity-vectors.spec.ts`, whose
vectors are derived outside `src` (node:crypto and CBOR assembled by hand), so
the encoder is checked against this page and not against itself. A change to
anything here is a format version, never a refactor (binding rule 10).

## Author id

SHA-256 of the author's raw public key (P-256, uncompressed, 65 bytes), first
16 bytes. Shown as base64url without padding (22 characters). The author id is
the replica id: the id a copy writes rows under.

## A batch

One author's rows that left that author's device together, under one
signature. A row is written pending (`_r_batch` NULL) and sealed when it first
leaves: a save or a mailbox publish, in the order floor, seal, send. One batch
per leave; in a session document, one per session, because each session
travels in its own mailbox under its own key.

**Canonical rows.** A CBOR array of the batch's rows, ordered by table name
(UTF-8 bytes) and then `_r_seq`. Each row is

    [table, [replica, seq, lc, entity, parents, deleted, session or null], [[column, value], ...]]

with the columns ordered by name (UTF-8 bytes). `_r_batch` and
`_r_superseded` are not in it: the batch is named after the rows, and
supersession is derived.

**Rows digest.** SHA-256 of the canonical rows.

**Canonical header.** `[version, document, author, lc, digest]`, a CBOR array:
the format version, the document's uuid (so a batch signed for one document
means nothing in another), the author id, the author's clock, the rows digest.
This is what the signature covers.

**Batch id.** SHA-256 of the canonical header, first 16 bytes.

**Signature.** ES256 over the canonical header: raw `r || s`, 64 bytes.

**What the signature does not cover.** `pub`, the author's raw public key,
travels in the header and is bound by the author id it must fingerprint to.
`att`, an authority's attestation, is reserved and empty in version 1, and it
sits outside the signed bytes so that vouching for a key can arrive later
without touching any signature. It must never be "tidied" into the signed
part: doing so would make every past batch unvouchable without re-signing,
which is the enterprise story's failure mode.

## The rows a header covers

A stored header (`_dai_batch`) lists the rows it covers: `seqs`, the JSON array
of the author's seqs, distinct and ascending, in exactly that spelling (`[1,2,3]`).
The author is the header's own; a batch has one. `seqs` is not in the signed
bytes and does not need to be: the digest commits to the rows, and so to their
seqs, and a list that names other rows digests to something else.

**The header lists its rows because saves get lost, not for convenience.** A
row is written first and sealed later, and the seal reaches the disk only in a
later save. A save can be lost between the two: a tab closed, a write the store
refused. Then a copy holds the rows with no batch named, and when they leave
again they are sealed again, under a second header over the same rows. So a
row's own `_r_batch` cannot be what says it was signed. It can be unset on a
row that was signed, and a row can claim a batch it was never part of. The
header, which is signed, is what says which rows it covers, and `_r_batch` is a
cache of one header that covers the row.

**Verifying a batch** is: find the rows the header lists (the author's rows at
those seqs, each found exactly once), digest them as above, and check the
signature over the canonical header that digest makes, for this document, under
a `pub` that fingerprints to the author. Then check that the id is that header's.
A rows or id failure is `BATCH_DIGEST_MISMATCH`; a key or signature failure is
`BATCH_SIGNATURE_INVALID`.

**A merge** verifies every header the other copy holds before it takes
anything. It keeps the headers that verify and refuses the rest. It takes a row
when a verified header lists it, whatever the row says, and fills the row's
`_r_batch` with the header it names if that one lists it, else the lowest listed
id. A row may be covered by more than one header. A row that names a header and
is listed by none is refused, `BATCH_DIGEST_MISMATCH` against the header it
names. A seal nobody verified is never adopted onto a row a copy holds pending.
A row that names no header and that no header lists is unsigned; until the
legacy rule changes (`BATCH_UNSIGNED`, step 6 of the sitting), it merges as
rows did before signing. The merge reports refused batches as `refusedBatches`,
one `{author, reason}` per batch and reason, ordered by batch id.

**Published after the save lands.** A batch leaves by the mailbox only once a
save holding its seal has landed, meaning the host has confirmed the write to
the device's store. A batch published on a save that was then lost would be on
the relay and gone from the device that signed it.

## Values in canonical CBOR

Deterministic CBOR (RFC 8949 §4.2.1), in the project's own encoder
(`src/cbor.ts`), with these rules for what a row's columns can hold:

- **Integers** are CBOR integers, in the shortest form that holds them, to
  ±2^64. A value past 2^53 is a BigInt (sqlite-wasm returns one) and is written
  in eight bytes: 2^63 is `1b 8000000000000000`, held by a frozen vector.
- **A whole JS number past 2^53 is refused**, never written as a float. It has
  already lost its low bits, and encoding it would sign a value nobody wrote.
- **A number with a fraction** is a float64 (`fb` and eight bytes, big-endian),
  never a shorter float: one width keeps it deterministic. NaN is refused.
- Text is UTF-8; bytes are a byte string; NULL is CBOR null.

**Changed while unfrozen.** The integer rules above (eight-byte integers,
BigInt, and refusing a whole number past 2^53 rather than floating it) were set
by the identity sitting's step 3 review, before version 1 was frozen for
release. No document signed under an earlier rule exists outside the sitting's
own tests.
