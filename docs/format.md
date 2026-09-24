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
