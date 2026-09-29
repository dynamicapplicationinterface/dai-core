# Signed batches: the bytes a signature covers, and what a merge does with them

This page is batch format version **2**, and it is written for someone
building a reader from it without reading any existing implementation: the
reference readers (`conformance/reference/dai_merge.py`,
`conformance/readers/rust-merge`) are checked against this page, not the
other way round. Where a reader needs a rule to act, the rule is here. Where
this page is silent, that is a gap in the page; the last section lists the
ones known.

The batch format version is not the container's format version, which is
another number. The bytes a signature covers are held byte for byte by
`tests/identity-vectors.spec.ts`, whose vectors are derived outside the
runtime (node:crypto and CBOR assembled by hand), so the encoder is checked
against this page and not against itself. What a merge does is held by the
fixtures in `conformance/merge`. A change to anything here is a format
version, never a refactor (`docs/identity.md`, binding rule 10).

Every rule that version 2 changed or added says why, and the date it was
ruled; "What changed from version 1" collects them. The dates are the dates
of the rulings, and the `D` numbers are the entries in `docs/backlog.md` that
hold the whole argument.

**Conventions.** An id shown as text is lowercase hex unless it says
otherwise; an author id shown to a person is base64url without padding.
"UTF-8 order" is the bytewise order of two strings' UTF-8 encodings. A row's
**id** is its author and its seq, written `<32 hex>:<seq>` (the author's 16
bytes as lowercase hex, a colon, the seq in decimal), which is the spelling
`_r_parents` uses.

## Where the version is declared

A document written at batch format version 2 lists the capability
`authorship` in its signed manifest's `requires`, and every header it holds
carries version 2. A host that does not write version 2 mounts such a
document read-only, and a host that does write it mounts read-only a document
built without `authorship` or holding a header of any other version, saying
"This app needs an update before it can be written to; what's here is kept."
(D108, decided 28 September). A merge treats a header of a version it does
not know as one that does not verify (`BATCH_SIGNATURE_INVALID`, below).

## Author id

SHA-256 of the author's raw public key (P-256, uncompressed, 65 bytes), first
16 bytes. The author id is the replica id: the id a copy writes rows under,
`_r_replica` on every row it writes.

## Session id

SHA-256 of the creator's author id (16 bytes) followed by the seq of the
creator's own seat row as eight bytes, unsigned, big-endian; the first 16
bytes. Held by frozen vectors in `tests/session-id.spec.ts`. The creator's
seat row is exactly the `_dai_seat` row whose own author and seq hash to its
`_r_session`, so the id names one row and nothing else can be it.

**Why the seq (version 2; ruled 27 September, D158).** At version 1 the id
hashed a nonce carried on the creator's seat row, and any row carrying that
nonce counted as the creator's. The creator could sign a second seat row
with the nonce and the open seat's value, take a seat she had already
confirmed someone in, and play that side. A seq is spent once per author per
document, so no second row can carry it. A highest-seq rule was not used
instead: it would refuse honest rows delivered out of order by file.

## A row

A replicated table's row carries the author's columns and these:

| Field | What it is |
| --- | --- |
| `_r_replica` | the author id, 16 bytes |
| `_r_seq` | the author's counter: one counter per author per document, so `(author, seq)` names one row whatever table it is in |
| `_r_lc` | the author's clock, an integer; it orders nothing that decides admission |
| `_r_entity` | 16 bytes: the thing this row is a version of |
| `_r_parents` | the ids of the earlier versions of its entity this row replaces, as text in the one shape (below) |
| `_r_deleted` | 0, or 1 for a delete (a tombstone): still a row, still a version |
| `_r_session` | 16 bytes in a session document, the session the row was written in; absent in a plain one |
| `_r_batch` | the id of one header that covers the row; a cache, filled by the merge (below) |
| `_r_superseded` | a display cache; derived, never carried, never read by any rule on this page (D140) |

**One id, one row.** The same `(author, seq)` in two tables is a collision,
refused as `ROW_REJECTED` (reported in `rejected`), not two rows.

### The one shape of parents

`_r_parents` is text that parses as JSON to an array of at most **256**
strings, each of which is exactly 32 lowercase hex characters, a colon, and a
seq written as a decimal integer from 1 to 2^53 − 1 with no leading zero
(`^[0-9a-f]{32}:[1-9][0-9]{0,15}$` and at most 9007199254740991). An empty
array is the shape. Order and repeats are not checked. Anything else (not
text, not JSON, not an array, a longer array, an element that is not such a
string, a number, a nested array, uppercase hex) is **malformed**.

A malformed row is never taken by a merge, and neither is any row taken
through a header that signed one (`ROW_MALFORMED`, below). A reader that holds
a malformed row of its own (it can only have written it itself) reads its
parents as naming nothing.

**Why (version 2; ruled 27 September, D159; stated as format 29 September,
D171).** Readers disagreed on what parents text means. JavaScript's
`JSON.parse` accepts nesting that SQLite's `json_each` refuses at depth over
1000, so a row that one reader parses and another throws on stops every read
that walks it; one stranger's ask with such parents made a contested seat
impossible to repair. One shape, checked before anything reads a row, means
every reader walks the same parents or refuses the same row. The cap is far
above what an honest row needs: one head per writer who wrote concurrently.

## A batch

One author's rows that left that author's device together, under one
signature. A row is written pending (`_r_batch` NULL) and sealed when it first
leaves: a save or a mailbox publish, in the order floor, seal, send. One batch
per leave; in a session document, one per session, because each session
travels in its own mailbox under its own key.

**Canonical rows.** A CBOR array of the batch's rows, ordered by table name
(UTF-8 order) and then `_r_seq`. Each row is

    [table, [replica, seq, lc, entity, parents, deleted, session or null], [[column, value], ...]]

with `parents` the `_r_parents` text as stored, and the columns ordered by
name (UTF-8 order). `_r_batch` and `_r_superseded` are not in it: the batch is
named after the rows, and supersession is derived.

**Rows digest.** SHA-256 of the canonical rows.

**Canonical header.** `[version, document, author, lc, digest, covers]`, a
CBOR array: the batch format version (2), the document's uuid as text (so a
batch signed for one document means nothing in another), the author id, the
author's clock, the rows digest, and the rows the batch covers as a CBOR
array of `[table, seq]`, ordered by table (UTF-8 order) and then seq. This is
what the signature covers.

**Batch id.** SHA-256 of the canonical header, first 16 bytes.

**Signature.** ES256 over the canonical header: raw `r || s`, 64 bytes.

**What the signature does not cover.** `pub`, the author's raw public key,
travels in the header and is bound by the author id it must fingerprint to.
`att`, an authority's attestation, is reserved and empty, and it sits outside
the signed bytes so that vouching for a key can arrive later without touching
any signature. It must never be "tidied" into the signed part: doing so would
make every past batch unvouchable without re-signing.

**A stored header** (`_dai_batch`) holds `id`, `author`, `lc`, `sig`, `pub`,
`att`, `version`, `digest` and `covers`.

## The rows a header covers

A stored header's `covers` is a JSON array of `[table, seq]` pairs ordered by
table (UTF-8 order) and then seq, in exactly that spelling
(`[["moves",1],["moves",2]]`): non-empty, each seq a positive integer, no pair
twice. Any other spelling is not a list. The author is the header's own; a
batch has one. The stored list is a cache of the signed one. It names the
table as well as the seq so that a row is looked for only where it was signed:
a row of the same number in another table is not one the header covers, and
cannot spoil it.

**Why the list is signed (version 2; ruled 28 September, D161).** Version 1
left `covers` out of the signed bytes, on the reason that the digest commits
to the rows, their tables and their seqs, so a list naming other rows
digests to something else. That holds only where the verifier holds the rows
the list names. A copy forwarding a header could change its list, and the
next copy refused the header as a digest mismatch in its honest author's name
and dropped the rows it really covered. Signed, a changed list no longer
verifies, so it is a forgery, not a mismatch, and a header can be checked as
the author's without holding any of its rows, which is what lets evidence of
an author signing twice travel (D160, below).

**The header lists its rows because saves get lost, not for convenience.** A
row is written first and sealed later, and the seal reaches the disk only in a
later save. A save can be lost between the two: a tab closed, a write the store
refused. Then a copy holds the rows with no batch named, and when they leave
again they are sealed again, under a second header over the same rows. So a
row's own `_r_batch` cannot be what says it was signed. It can be unset on a
row that was signed, and a row can claim a batch it was never part of. The
header, which is signed, is what says which rows it covers, and `_r_batch` is a
cache of one header that covers the row.

## Verifying a header

Two parts, in this order.

**Authentic.** A list of rows makes a canonical header; the header is the
author's when that header hashes to the id, `pub` fingerprints to the author,
the version is 2, and the signature verifies over it for this document. The
stored list is tried first, then the list of that author's rows naming the id
(`_r_batch`), so a relabeled list is recovered from the rows, which still name
their header. A list naming a table the document does not replicate is not
tried. When no list makes it, the header is refused, `BATCH_SIGNATURE_INVALID`,
with the author it names: what any forgery in that name gets, and an
accusation of nobody.

**Complete.** Every listed row found exactly once, as that author's row in
the table listed, and the digest over them the header's. An authentic header
that is not complete is still the author's statement: it is kept, and no row
is taken through it.

The fixtures carry each header's verdict in `verdicts.json` (`ok`,
`incomplete`, or a refusal code), made against the rows of the copy that holds
it, so a reader can do the rest of the merge without its own signature check.

## The merge

A merge takes a sibling copy's headers and rows into a local copy. In this
order:

1. **Headers,** in batch id order. Each header the sibling holds is verified
   against the sibling's rows. One not authentic is refused and not kept. An
   authentic, complete header that lists a malformed row is refused,
   `ROW_MALFORMED`, and not kept, and no row is taken through it. Every other
   authentic header is kept, under the list it signed, whether or not it is
   complete: an authentic header is the author's statement, and the evidence
   of two conflicting ones has to travel with every copy (D160).
2. **Rows,** every row of every replicated table the sibling holds:
   - A malformed row is not taken. It is reported `ROW_MALFORMED` under the
     batch it names (or under no id), in its author's name, unless a header
     that listed it was refused for it already.
   - A row listed by a complete header kept in step 1 (its table, its author,
     its seq) is signed, and taken, whatever the row says. Its `_r_batch` is
     the header it names if that header lists it, else the lowest listed id. A
     row may be covered by more than one header.
   - A row listed only by a header refused as `ROW_MALFORMED` is not taken,
     and not reported again.
   - A row that names a header and is listed by no complete one is refused,
     `BATCH_DIGEST_MISMATCH`, under the header it names, in the name of the
     row's own author, not the header's; unless the sibling held the header
     it names and that header was not authentic (refused already, in its own
     name). A header refused as `ROW_MALFORMED` was authentic, so a row naming
     it that it does not list is reported.
   - A row that names no header and that no header lists is unsigned, and is
     refused, `BATCH_UNSIGNED`, under no id, in the name of the author id it
     carries; unless the local copy already holds a row at that id in that
     table, when the ordinary path decides (a duplicate, or a second row at
     one id, `rejected`).
3. **Placing,** signed rows first, then unsigned ones, so the answer never
   depends on table order. A row the copy already holds, identical, is a
   duplicate. A different row at an id the copy holds is rejected
   (`rejected`), except that **a signed row outranks an unsigned row at the
   same id**, whichever arrived first: the unsigned one is removed and the
   signed one takes its place, the removed id is reported in `rejected`, and
   whatever the removed row superseded is a head again unless something else
   names it. Since no merge takes an unsigned row, the one a copy can hold is
   its own, pending: a save lost after it left reissues its seq, and the
   signed row coming back takes the id.
4. **Reports,** from the row set after placing (below): `SEAT_NOT_HELD`,
   `ENTITY_OTHER_SESSION` and `AUTHOR_EQUIVOCATED`.

A seal nobody verified is never adopted onto a row a copy holds pending. The
counts (`applied`, `duplicate`, `rejected`, `newReplicas`) and the canonical
dump are `docs/replicated-tables.md` T1-D9 and T1-D15.

**Why unsigned rows are refused everywhere (version 2; 28 September).** At
version 1 a merge refused an unsigned row only in the seat and close tables
(D133, 25 September; D147, 26 September), where an unsigned confirm under the
creator's id seated whoever wrote it, and merged it anywhere else as rows did
before signing. Nobody's key vouches for such a row, so it is nobody's.

## Signed twice

Two authentic headers of one author that list the same `(table, seq)` with
different digests are **equivocation**: the author signed two histories. The
id is **equivocated** on every copy that holds both headers, whichever arrived
first. A row at an equivocated id counts for nothing anywhere: it is not
admitted, it hides no row, it seats, confirms and closes nobody. Both headers
are kept and passed on, so every copy that holds either side learns it from a
copy that holds the other.

The comparison is of whole-batch digests, so two headers that list one row
and differ anywhere, even in another row, are equivocation. That is fair only
because an honest author never has two headers that list one row and both
leave the device: a header leaves only in bytes a save has landed; the floor
is the highest seq the device has let leave it for the document; and the host
signs only rows above the floor. A re-seal after a lost save covers rows whose
first header never left. So the accusation is fair while the floor holds, and
a host that let a row leave twice under two headers would be accusing its own
person.

**Why (version 2; ruled 27 September and 28 September, D160).** Picking a
winner between two signed rows at one id trusts arrival order, and two copies
that received them in different orders split on who holds a seat. It waited
for signed lists (D161): the evidence is a header kept without its rows, which
is forgeable until the list is signed.

## What a session document admits

A session document declares the session profile, and its replicated tables
carry `_r_session`. What it admits is computed from the rows and headers it
holds, the same on every copy that holds the same ones, whatever order they
arrived in. Nothing here reads a clock. A reader computes it from the tables
and headers; the only declarations it needs are which tables are seated and
by which column (`_dai_seat_rules`), which author tables carry a role
(`_dai_author_rules`), and the session's close rule (below).

The tables: `_dai_seat` (seats the creator mints), `_dai_binding` (a copy
asking for a seat), `_dai_confirm` (the creator seating a copy: a `seat` and a
`holder`), `_dai_close`, and the author's own tables. Every rule below skips a
row at an equivocated id.

**The creator.** The session's creator is the author of its creator's seat
row: the `_dai_seat` row, not deleted, whose own author and seq hash to its
`_r_session` (Session id, above). Her seat is that row's `seat`, and it is
hers by definition.

**Confirms.** A confirm counts when it is a `_dai_confirm` row authored by the
session's creator, in her session, naming a seat that is not her own; deleted
or not, superseded or not. A confirm is her statement that she seated a copy,
and a hold never moves once made, so a later version or a delete of a confirm
is another confirm naming a holder, and counts as one.

**Why deleted confirms count (version 2; ruled 29 September, D171).** Read
as "only current confirms count", a delete would unseat a confirmed player; read
as "deleted rows do not count", a delete naming a different holder would be a
second confirm nobody sees. Both break the rule that a hold never moves.

**Voided seats.** When the counting confirms of one seat name two or more
different holders, the seat is **void**: held by nobody, on every copy
holding both, whatever their seqs and whichever arrived first. The repair is
a new session.

**Why (version 2; ruled 28 September, D165).** A confirmed seat is never
reseated, so two confirms of one seat are two conflicting claims about one
thing, as two rows at one id are (D160). The rule before it let the lowest
seq's confirm hold, and the creator could sign a confirm at a seq she had
skipped and move a hold.

**Holders.** The creator holds her seat. Every other seat with counting
confirms that is not void is held by the one holder they name. The members of
a session are its holders. A confirm is not checked against the seats the
creator minted: see the last section.

**A session's close.** A `_dai_close` row is a close that counts when it is
not deleted, and its author is permitted by the session's close rule: under
`close=any`, a member of the close's own session; under `close=creator`, the
session's creator. The rule is declared in the signed manifest's session
profile (`-- dai:profile session ... close=any|creator`) and is not in the
database; the fixtures are all `close=any`. A session is **closed** when a
close that counts names it. A close binds only its author: a row is **late**
when its author has a close that counts in the same session at a lower seq.
Only the author's first close matters (later ones are later seqs), and a
delete of a close revokes nothing, since a deleted close row does not count
and the first close still does. A close is one row carrying its session and
no author columns.

**Why the close binds only its author (version 2; ruled 27 September, D151,
D152, D153).** At version 1 a close listed, per author, the highest seq its
author had seen, and every other author's rows past it were late. Signing
proved who wrote a close and could not prove the list, so a member who signed
a close naming only himself erased the other member's moves in every copy. A
close now makes only its author's own later rows late, ordered by that
author's own seq, which the author cannot reorder. The list's columns retired
with version 2. `docs/replicated-tables.md` T1-D31 keeps the old frontier as
the record of what was replaced.

**Admitted rows.** In a session author table a row is admitted when all of
these hold:

- its id is not equivocated;
- **seated table:** its author holds the seat its seat column names, in the
  row's own session (a seat is the pair of session and seat). **Otherwise:**
  its author is a member of the row's session;
- it names as a parent no row of its own entity from another session;
- in a seated table, it names as a parent no row of its own entity, in its
  session, whose seat column differs from its own;
- it is not late;
- where the table carries a role (`author=creator` or `author=joiner`), its
  author is, or is not, the session's creator.

A parent of another entity is not a version of this row: it neither makes a
row cross nor hides anything (T1-D35).

**Heads.** A head is a row no row of its own partition names as a parent,
and a head may be a delete (the tombstone is the head, with its flag):

- **a session author table:** among admitted rows only, partitioned by entity,
  session and (seated) seat. A row not admitted neither shows nor hides.
- **the roster tables and the close** (`_dai_seat`, `_dai_binding`,
  `_dai_confirm`, `_dai_close`): among rows at ids not equivocated,
  partitioned by **session, entity and author**. A seat, an ask, a confirm or
  a close speaks only for its author, so only its author's later row in the
  same session replaces it, never somebody else's.
- **a plain document's tables:** among rows at ids not equivocated,
  partitioned by entity.

**Why roster heads partition by author and session (ruled 29 September,
D171).** A roster row is one author's statement in one session. If another
author's row could replace it, anyone could hide the creator's open seat by
writing a version of it; if a row in another session could, one game's
roster would change another's.

**Waiting.** A row whose author asked for an open seat nobody holds yet, and
which names that seat, is waiting: neither admitted nor reported, and admitted
if the author is later confirmed. A row for a void seat is neither admitted
nor reported.

## What a merge reports

`refusedBatches` is one entry `{author, reason}` per batch id, code and
author, where `author` is base64url. It is emitted ordered by the batch id it
is filed under (lowercase hex, and no id sorts first), then by code, then by
the author id in hex (a third key because one header can refuse rows of
several authors under one code). The order and the filing were ruled 29
September (D171): a report two readers emit in different orders is a report
that cannot be compared.

| Code | In whose name | Filed under |
| --- | --- | --- |
| `BATCH_SIGNATURE_INVALID` | the author the header names | the header's id |
| `ROW_MALFORMED` | the header's author, or the row's | the refused header's id; for a malformed row no refused header listed, the batch the row names, or no id |
| `BATCH_DIGEST_MISMATCH` | the row's author | the header the row names |
| `BATCH_UNSIGNED` | the author id the row carries | no id |
| `SEAT_NOT_HELD` | the row's author | the row's own `_r_batch` after the merge |
| `ENTITY_OTHER_SESSION` | the row's author | the row's own `_r_batch` after the merge |
| `AUTHOR_EQUIVOCATED` | the author who signed twice | the lowest of that author's revealing headers |

**`SEAT_NOT_HELD` and `ENTITY_OTHER_SESSION`** report what this merge made
true. A row this merge took, in a seated table, that names no seat (a seat
column that is not 16 bytes), or a seat someone else holds, or that names a
parent of its entity and session acting for another seat, is `SEAT_NOT_HELD`.
A row in a session author table naming a parent of its entity from another
session is `ENTITY_OTHER_SESSION`. For the two crossings, the report is made
whichever of the two rows this merge took, the child or the parent, and is
the child's. A row waiting on a confirmation, a row for a void seat and a late
row are reported nowhere.

**`AUTHOR_EQUIVOCATED`** is reported once per author per merge, for D160 and
D165 together, when this merge revealed that author signing twice. A
**revealing header** is:

- for two headers at one id (D160): a header this merge kept that the local
  copy did not hold before, which lists a `(table, seq)` of its author that is
  equivocated after the merge and was not before it;
- for two confirms of one seat (D165): the header named (`_r_batch`) by a row
  this merge took that the void rests on, a counting confirm of that seat or
  the session's creator's seat row, for a seat void after the merge and not
  before it.

It is filed under the lowest of that author's revealing headers. A merge that
brings a third conflicting header for an id already equivocated reveals
nothing new and reports nothing. **Why (ruled 29 September, D171):** "the
merge that brings the second header" had two readings, and they differed on a
third conflicting header. A report says what this merge made true, as the
seat reports do, and D165's report already worked that way.

## Published after the save lands

A batch leaves by the mailbox only once a save holding its seal has landed,
meaning the host has confirmed the write to the device's store. A batch
published on a save that was then lost would be on the relay and gone from
the device that signed it.

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

The integer rules were set by the identity sitting's step 3 review (24
September), before version 1 was frozen. No document signed under an earlier
rule exists outside the sitting's own tests.

## What changed from version 1

| Change | Why | Ruled |
| --- | --- | --- |
| The header signs `covers` | a forwarder could relabel an honest header's list | 28 September, D161 |
| The session id hashes the creator's seat row's seq, not a nonce | the creator could sign a second row carrying the nonce and take a confirmed seat | 27 September, D158 |
| Two headers of one author at one id: the id counts nowhere, reported `AUTHOR_EQUIVOCATED` | picking a winner trusts arrival order | 27 and 28 September, D160 |
| Two confirms of one seat naming different copies void it | the lowest seq's confirm let the creator move a hold | 28 September, D165 |
| A close binds only its author and lists nothing | a signed close list could erase another member's moves | 27 September, D151, D152, D153 |
| An unsigned row is refused in every table (`BATCH_UNSIGNED`) | nobody's key vouches for it | 28 September |
| The one shape of parents; `ROW_MALFORMED` | a row readers parse differently stops every read that walks it | 27 September, D159; format 29 September, D171 |
| A document declares `authorship`; a host that does not write its format mounts it read-only | an old host would write unsigned rows into a signed document | 28 September, D108 |
| Deleted and superseded confirms count | a hold never moves once made | 29 September, D171 |
| Roster heads partition by session, entity and author | a roster row is one author's statement in one session | 29 September, D171 |
| `refusedBatches` order, and where `AUTHOR_EQUIVOCATED` is filed | two readers must emit one report | 29 September, D171 |

## Known silences

Not ruled. Each is what the runtime does today, so a reader need not guess,
and each is listed for the review that closes step 6.

- **A confirm naming a seat nobody minted** counts like any other: its holder
  holds that seat. Nothing checks a confirm's seat against the creator's
  `_dai_seat` rows.
- **The rest of the list the independent reader returned** on 29 September
  (backlog D171): which of several conditions a row that is both crossing and
  waiting is reported under, whether a held row that a new confirm unseats is
  reported, what `_r_batch` a row listed by both a complete and an incomplete
  header takes, how the stored `_r_superseded` cache is derived where roster
  heads partition by author, and the others there.

Stated above as rules, and held by no vector yet: a creator's seat row written
with the delete flag set makes nobody the creator ("The creator"), and a close
row written deleted closes nothing ("A session's close", D153).

## Documents built during the sitting's steps 3 and 4 are dead ends

The `_dai_batch` table is created from the document's own schema block with
`CREATE TABLE IF NOT EXISTS`, so a document built before a column was added or
renamed (`seqs` at step 4, then `covers`) keeps the table it was built with,
and sealing fails in it. They are not migrated: none left the sitting's tests
and test devices, and the example apps are rebuilt at step 7.
