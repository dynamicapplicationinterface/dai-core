# Batch format

This page is normative. The reasons for its rules, and the alternatives
rejected, are in [format-design.md](format-design.md); a reader can be built
without it.

## Overview

A batch is one author's rows that left that author's device together, under
one signature. The signature covers a canonical header that names the
document, the author, the author's clock, a digest of the rows, and the list
of rows the batch covers. A document holds its rows in replicated tables and
the headers of the batches that carried them. This page describes batch
format version 2.

A reader verifies each header it is given, takes through a merge only the
rows a verified header covers, reports each thing it refuses and in whose
name, and, in a session document, computes from the rows and headers alone
which rows the document admits.
<a id="arriving-sibling"></a>A reader treats bytes that arrive, a file or a
batch, as a sibling copy and merges them into its own. It never opens them as
its own copy, and never adopts a header they hold without verifying it.

## Identifiers

<a id="conv-hex"></a>An id shown as text is lowercase hex unless it says
otherwise; an author id shown to a person is base64url without padding.
<a id="conv-utf8-order"></a>"UTF-8 order" is the bytewise order of two
strings' UTF-8 encodings.

### Author id

<a id="author-id"></a>SHA-256 of the author's raw public key (P-256,
uncompressed, 65 bytes), first 16 bytes.

<a id="author-id-replica"></a>The author id is the replica id: the id a copy
writes rows under, `_r_replica` on every row it writes.

### Session id

<a id="session-id"></a>SHA-256 of the creator's author id (16 bytes) followed
by the seq of the creator's own seat row as eight bytes, unsigned,
big-endian; the first 16 bytes.

<a id="session-id-creator-row"></a>The creator's seat row is exactly the
`_dai_seat` row whose own author and seq hash to its `_r_session`, so the id
names one row and nothing else can be it.

### Row id

<a id="conv-row-id"></a>A row's **id** is its author and its seq, written
`<32 hex>:<seq>`: the author's 16 bytes as lowercase hex, a colon, the seq in
decimal. This is the spelling `_r_parents` uses.

### Batch id

<a id="batch-id"></a>SHA-256 of the canonical header, first 16 bytes.

## The row

<a id="row-columns"></a>A replicated table's row carries the author's columns
and these:

| Field | What it is |
| --- | --- |
| <a id="row-replica"></a>`_r_replica` | the author id, 16 bytes |
| <a id="row-seq"></a>`_r_seq` | the author's counter: one counter per author per document, so `(author, seq)` names one row whatever table it is in |
| <a id="row-lc"></a>`_r_lc` | the author's clock, an integer; it orders nothing that decides admission |
| <a id="row-entity"></a>`_r_entity` | 16 bytes: the thing this row is a version of |
| <a id="row-parents"></a>`_r_parents` | the ids of the earlier versions of its entity this row replaces, as text in the one shape (below) |
| <a id="row-deleted"></a>`_r_deleted` | 0, or 1 for a delete (a tombstone): still a row, still a version |
| <a id="row-session"></a>`_r_session` | 16 bytes in a session document, the session the row was written in; absent in a plain one |
| <a id="row-batch"></a>`_r_batch` | the id of one header that covers the row; a cache, filled by the merge (below) |
| <a id="row-superseded"></a>`_r_superseded` | a display cache; derived, never carried, never read by any rule on this page |

<a id="row-one-id"></a>An unsigned row at an `(author, seq)` that another table
holds is not a second row: a merge refuses it `BATCH_UNSIGNED` before placing,
as it refuses every unsigned row ([merge-row-unsigned](#merge-row-unsigned)),
unless the copy holds that id in the row's own table too, when placing rejects
it ([merge-place-rejected](#merge-place-rejected)). Signed rows are one id per
`(author, seq)` across tables: two signed rows at one `(author, seq)` in two
tables are both taken, and under two headers with different digests they are
[equivocation](#equivocation-any-table).

### Parents

<a id="parents-shape"></a>`_r_parents` is text that parses as JSON to an
array of at most **256** strings, each of which is exactly 32 lowercase hex
characters, a colon, and a seq written as a decimal integer from 1 to
2^53 − 1 with no leading zero (`^[0-9a-f]{32}:[1-9][0-9]{0,15}$` and at most
9007199254740991). <a id="parents-empty"></a>An empty array is the shape.
<a id="parents-order-unchecked"></a>Order and repeats are not part of the
shape; a reader MUST NOT refuse parents for either.
<a id="parents-malformed"></a>Anything else (not text, not JSON, not an
array, a longer array, an element that is not such a string, a number, a
nested array, uppercase hex) is **malformed**. A reader MUST check the shape
before it reads a row's parents for any purpose, not only in a merge.

<a id="parents-not-taken"></a>A merge never takes a malformed row, nor any row
through a header that signed one (`ROW_MALFORMED`, below).
<a id="parents-own-malformed"></a>A reader that holds a malformed row of its
own (it can only have written it itself) reads its parents as naming
nothing.

## The batch

<a id="batch"></a>A batch is one author's rows that left that author's device
together, under one signature. <a id="batch-seal"></a>A row is written
pending (`_r_batch` NULL) and sealed when it first leaves: a save or a
mailbox publish, in the order floor, seal, send.
<a id="batch-per-leave"></a>One batch per leave; in a session document, one
per session.

<a id="floor"></a>A header leaves only in bytes a save has landed. The
**floor** is the highest seq the device has let leave it for the document,
and the host signs only rows above the floor. A re-seal after a lost save
covers rows whose first header never left.
<a id="floor-honest-reseal"></a>Two seals list seqs the device issued before
and are not equivocation, since no header listing them has left: a seal of
rows a save held pending while a signature was on its way, and a re-seal after
a lost save.

<a id="publish-after-save"></a>A batch MUST NOT leave by the mailbox until a
save holding its seal has landed, meaning the host has confirmed the write to
the device's store.

### Canonical rows

<a id="canonical-rows"></a>A CBOR array of the batch's rows, ordered by table
name (UTF-8 order) and then `_r_seq`. <a id="canonical-row"></a>Each row is a
CBOR array of three:

    text                      table
                                the table's name
    array of 7                row header
      16-byte byte string       replica
                                  _r_replica, the author id
      integer                   seq
                                  _r_seq
      integer                   lc
                                  _r_lc
      16-byte byte string       entity
                                  _r_entity
      text                      parents
                                  the _r_parents text as stored
      integer                   deleted
                                  _r_deleted, 0 or 1
      16-byte byte string       session
        or null                   _r_session, or null in a plain document
    array                     columns
                                the author's columns, ordered by name
                                (UTF-8 order), each a CBOR array of two:
      text                      column name
      value                     column value (Canonical CBOR, below)

<a id="canonical-rows-excluded"></a>`_r_batch` and `_r_superseded` are not in
it.

<a id="rows-digest"></a>The **rows digest** is SHA-256 of the canonical rows.

### Canonical header

<a id="canonical-header"></a>A CBOR array of six. This is what the signature
covers.

    integer                   version
                                the batch format version: 2
    text                      document
                                the document's uuid
    16-byte byte string       author
                                the author id
    integer                   lc
                                the author's clock
    32-byte byte string       digest
                                the rows digest
    array                     covers
                                the rows the batch covers, ordered by table
                                (UTF-8 order) and then seq, each a CBOR
                                array of two:
      text                      table
      integer                   seq

### Stored header

<a id="stored-header"></a>A stored header (`_dai_batch`) holds `id`,
`author`, `lc`, `sig`, `pub`, `att`, `version`, `digest` and `covers`.

## Signature

<a id="signature"></a>ES256 over the canonical header: raw `r || s`, 64 bytes.

<a id="unsigned-pub"></a>`pub`, the author's raw public key, travels in the
header outside the signed bytes and is bound by the author id it must
fingerprint to. <a id="unsigned-att"></a>`att`, an authority's attestation,
is reserved and empty, and sits outside the signed bytes.
<a id="att-stays-unsigned"></a>`att` MUST NOT be moved into the signed bytes.

## Covers

<a id="covers-spelling"></a>A stored header's `covers` is a JSON array of
`[table, seq]` pairs ordered by table (UTF-8 order) and then seq, in exactly
that spelling (`[["moves",1],["moves",2]]`): non-empty, each seq a positive
integer, no pair twice. Any other spelling is not a list.
<a id="covers-seq-once"></a>A list names each seq once, in any tables: one that
repeats a seq (`[["cases",1],["notes",1]]`) is not a list, so a header signed
over one is not authentic (`BATCH_SIGNATURE_INVALID`, in the author's name).
<a id="covers-author"></a>The author is the header's own; a batch has one.
<a id="covers-cache"></a>The stored list is a cache of the signed one.
<a id="covers-table"></a>A row is looked for only in the table the list
names: a row of the same seq in another table is not one the header covers.

<a id="covers-says"></a>The header, which is signed, is what says which rows
it covers. A row's `_r_batch` is a cache of one header that covers it: it can
be unset on a row that was signed, and it can name a batch the row was never
part of.

## Verification

<a id="verify-order"></a>Two parts, in this order.

<a id="verify-authentic"></a>**Authentic.** A list of rows makes a canonical
header; the header is the author's when that header hashes to the id, `pub`
fingerprints to the author, the version is 2, and the signature verifies over
it for this document. <a id="verify-lists-tried"></a>The stored list is tried
first, then the list of that author's rows naming the id (`_r_batch`), so a
relabeled list is recovered from the rows, which still name their header.
<a id="verify-unreplicated"></a>A list naming a table the document does not
replicate is not tried. <a id="verify-refused"></a>When no list makes it, the
header is refused, `BATCH_SIGNATURE_INVALID`, with the author it names.

<a id="verify-complete"></a>**Complete.** Every listed row found exactly once,
as that author's row in the table listed, and the digest over them the
header's. A row of the same seq in a table the header does not list is not
looked for, and does not make the header incomplete.
<a id="verify-incomplete-kept"></a>An authentic header that is not complete is
kept, and no row is taken through it.

## Merge

<a id="merge"></a>A merge takes a sibling copy's headers and rows into a
local copy, in this order:

1. <a id="merge-headers"></a>**Headers,** in batch id order. Each header the
   sibling holds is verified against the sibling's rows. One not authentic is
   refused and not kept. <a id="merge-headers-malformed"></a>An authentic,
   complete header that lists a malformed row is refused, `ROW_MALFORMED`,
   and not kept, and no row is taken through it.
   <a id="merge-headers-kept"></a>Every other authentic header is kept, under
   the list it signed, whether or not it is complete.
   <a id="merge-headers-kept-list"></a>The list it signed is the one that
   made it authentic ([tried in order](#verify-lists-tried)), and a kept
   header's stored `covers` is that list, not the one the sibling stored.
   <a id="merge-headers-rewritten"></a>A header the local copy already holds
   under another list is rewritten to the list it signed: the stored list is a
   [cache](#covers-cache) of the signed one.
2. <a id="merge-rows"></a>**Rows,** every row of every replicated table the
   sibling holds:
   - <a id="merge-row-malformed"></a>A malformed row is not taken. It is
     reported `ROW_MALFORMED` under the batch it names (or under no id), in
     its author's name, unless a header that listed it was refused for it
     already.
   - <a id="merge-row-signed"></a>A row listed by a complete header kept in
     step 1 (its table, its author, its seq) is signed, and taken, whatever
     the row says. <a id="merge-row-batch"></a>Its `_r_batch` is the header
     it names if that header is complete and kept in step 1, else the lowest
     complete kept header that lists it.
     <a id="merge-row-multi"></a>A row may be covered by more than one
     header.
   - <a id="merge-row-refused-header"></a>A row listed only by a header
     refused as `ROW_MALFORMED` is not taken, and not reported again.
   - <a id="merge-row-digest-mismatch"></a>A row that names a header and is
     listed by no complete one is refused, `BATCH_DIGEST_MISMATCH`, under the
     header it names, in the name of the row's own author, not the header's;
     unless the sibling held the header it names and that header was not
     authentic (refused already, in its own name). A header refused as
     `ROW_MALFORMED` was authentic, so a row naming it that it does not list
     is reported.
   - <a id="merge-row-unsigned"></a>A row that names no header and that no
     header lists is unsigned, and is refused, `BATCH_UNSIGNED`, under no id,
     in the name of the author id it carries; unless the local copy already
     holds a row at that id in that table, when the ordinary path decides (a
     duplicate, or a second row at one id, `rejected`).
     <a id="merge-row-held-signed"></a>A row the local copy holds with
     `_r_batch` unset is signed, not pending, when a complete header the copy
     holds or receives lists it (its table, its author, its seq). For a header
     the copy held before the merge, complete is over the copy's own rows, the
     header unverified, as [its own headers](#equivocation-own-headers) are;
     before any row is placed, the merge sets the row's `_r_batch` to the
     lowest such header. A header received lists it through a row that
     arrives the same, a duplicate, whose `_r_batch` the held row takes. Such
     a row is not unsigned: a signed row at its id does not
     [outrank](#merge-signed-outranks) it, and in another table the two are
     both taken.
3. <a id="merge-place"></a>**Placing,** signed rows first, then unsigned ones.
   <a id="merge-place-duplicate"></a>A row the copy already holds, identical,
   is a duplicate. <a id="merge-place-rejected"></a>A different row at an id
   the copy holds in the same table is rejected (`rejected`), and so is an
   unsigned row at an id another table holds ([one id](#row-one-id)),
   <a id="merge-signed-outranks"></a>except that a signed row outranks an
   unsigned row at the same id, whichever arrived first: the unsigned one is
   removed and the signed one takes its place, the removed id is reported in
   `rejected`, and whatever the removed row superseded is a head again unless
   something else names it. Since no merge takes an unsigned row, the one a
   copy can hold is its own, pending, listed by no complete header the copy
   holds ([merge-row-held-signed](#merge-row-held-signed)): a save lost after
   it left reissues its seq, and the signed row coming back takes the id.
   <a id="merge-signed-outranks-any-table"></a>The id is `(author, seq)`, so
   a signed row outranks an unsigned one at the same `(author, seq)` whatever
   table either is in.
4. <a id="merge-reports"></a>**Reports,** from the row set after placing
   (below): `SEAT_NOT_HELD`, `ENTITY_OTHER_SESSION` and
   `AUTHOR_EQUIVOCATED`.

<a id="merge-no-adopt"></a>A merge MUST NOT adopt a seal nobody verified onto
a row a copy holds pending; a header the copy held before the merge and that
is complete over its rows is its own, and is
[adopted](#merge-row-held-signed). <a id="merge-counts"></a>Of the rows it places, a
merge counts as `applied` those the copy did not hold, as `duplicate` those it
held already the same in `_r_lc`, `_r_entity`, `_r_parents`, `_r_deleted`,
`_r_session` and every author column, and lists in `rejected` the
[ids](#conv-row-id) of those refused as a second row at an id and of the rows
a signed row outranked; `newReplicas` is how many author ids it added to
`_dai_replicas`, from the sibling's own and those it lists.
<a id="merge-dump"></a>The canonical dump, which two copies compare, is a
section per replicated table in UTF-8 order of name (a line `# <table>`, then
a line per row ordered by author id and seq, its values tab-separated in the
table's column order), then `# _dai_replicas` (an author id per line,
ascending), then, when the copy has it, `# _dai_batch` (a stored header per
line, every column, ordered by id), each value written `nil`, as a decimal
integer, as lowercase hex for bytes, as text with tab, newline and backslash
escaped, or as a float's shortest round-trip decimal.
Both are decided in [replicated-tables.md](replicated-tables.md), section 8
(T1-D9 for the dump, with the floats' special cases, and T1-D15 for the
counts).

### Equivocation

<a id="equivocation"></a>Two authentic headers of one author that list the
same seq with different digests are **equivocation**.
<a id="equivocation-any-table"></a>The seq may be listed in any tables: two
headers of one author listing one seq, one in one table and one in another,
with different digests, are equivocation, as two listing it in one table are.
<a id="equivocation-own-headers"></a>A copy's own headers count toward
equivocation as the headers a merge keeps do, though a merge verifies only
the sibling's.
<a id="equivocated-id"></a>The id, `(author, seq)`, is **equivocated** on
every copy that holds both headers, whichever arrived first.
<a id="equivocated-counts-nothing"></a>A row at an equivocated id counts for
nothing anywhere: it is not admitted, it hides no row, it seats, confirms and
closes nobody. <a id="equivocation-headers-kept"></a>Both headers are kept
and passed on.
<a id="equivocator"></a>An author with two authentic headers at one
`(author, seq)` anywhere in the document is an **equivocator** in that
document, on every copy that holds both. Every `_dai_seat`, `_dai_binding`,
`_dai_confirm` and `_dai_close` row by an equivocator counts for nothing, as a
row at an equivocated id does: it seats, asks, confirms and closes nobody, and
it is no head and hides no row. Her rows in author tables count as any
author's, except at the equivocated ids.

<a id="equivocation-whole-digest"></a>The comparison is of whole-batch
digests, so two headers that list one row and differ anywhere, even in
another row, are equivocation.

## Session admission

<a id="session-document"></a>A session document declares the session
profile, and its replicated tables carry `_r_session`.
<a id="session-deterministic"></a>What it admits is computed from the rows
and headers it holds, the same on every copy that holds the same ones,
whatever order they arrived in. Admission MUST NOT read a clock.
<a id="session-declarations"></a>A reader computes it from the tables and
headers; the only declarations it needs are which tables are seated and by
which column (`_dai_seat_rules`), which author tables carry a role
(`_dai_author_rules`), the session's close rule (below) and its
`max_parties` ([confirm-minted](#confirm-minted)).

<a id="session-tables"></a>The tables: `_dai_seat` (seats the creator mints),
`_dai_binding` (a copy asking for a seat), `_dai_confirm` (the creator
seating a copy: a `seat` and a `holder`), `_dai_close`, and the author's own
tables. <a id="session-skip-equivocated"></a>Every rule below skips a row at
an equivocated id. A row that names an equivocated id as a parent is not
skipped: it is [neither admitted nor reported](#admitted-parent-equivocated).

### Creator

<a id="creator"></a>The session's creator is the author of its creator's seat
row: the `_dai_seat` row, not deleted, whose own author and seq hash to its
`_r_session` ([Session id](#session-id)), when that author is no
[equivocator](#equivocator). <a id="creator-seat"></a>The
creator's seat is that row's `seat`, and it is the creator's by definition.

<a id="session-void"></a>A session whose creator is an equivocator is
**void**. Here the creator is the author of that row, not deleted, whether or
not its rows count. No row in a void session is admitted, nobody holds a seat
in it, no seat in it is void (its confirms count for nothing), nothing closes
it, and nothing in it is reported but its creator signing twice
(`AUTHOR_EQUIVOCATED`, by the merge that reveals it, as for any
equivocation). Both headers are kept, so a session void on a copy stays void
on it, whatever arrives later. The repair is a new session.

### Confirms

<a id="confirms"></a>A confirm counts when it is a `_dai_confirm` row
authored by the session's creator, in the creator's session, naming a seat
that is not the creator's own and that she [minted](#confirm-minted);
deleted or not, superseded or not.
<a id="confirm-versions-count"></a>A later version or a delete of a confirm is
another confirm naming a holder, and counts as one.

### Void

<a id="void"></a>When the counting confirms of one seat name two or more
different holders, the seat is **void**: held by nobody, on every copy
holding both, whatever their seqs and whichever arrived first. The repair is
a new session.

### Holders

<a id="holders"></a>The creator holds the creator's seat. Every other seat
with counting confirms that is not void is held by the one holder they name.
<a id="members"></a>The members of a session are its holders.
<a id="confirm-minted"></a>A confirm counts only for a seat the creator
minted. Her seat rows in the session are her `_dai_seat` entities there, each
at the lowest seq of hers in it, deleted or not, superseded or not; only the
first `max_parties` of them in that seq order mint (the bound the signed
manifest's session profile declares, `max_parties=N`), and each mints every
seat its versions of hers name (a fresh open seat is a version of the open
seat's row). A seat no minting row names is not minted: nobody holds it, and
a row for it is waiting on nothing.

### Close

<a id="close-counts"></a>A `_dai_close` row is a close that counts when it is
not deleted and its author is permitted by the session's close rule: under
`close=any`, a member of the close's own session; under `close=creator`, the
session's creator. <a id="close-rule"></a>The rule is declared in the signed
manifest's session profile (`-- dai:profile session ... close=any|creator`)
and is not in the database. <a id="closed"></a>A session is **closed** when a
close that counts names it. <a id="late"></a>A close binds only its author: a
row is **late** when its author has a close that counts in the same session
at a lower seq. <a id="close-first"></a>Only the author's first close matters
(later ones are later seqs), and a delete of a close revokes nothing: a
deleted close row does not count, and the first close still does.
<a id="close-row"></a>A close is one row carrying its session and no author
columns.

### Admitted rows

<a id="admitted"></a>In a session author table a row is admitted when all of
these hold:

- <a id="admitted-not-equivocated"></a>its id is not equivocated;
- <a id="admitted-parent-equivocated"></a>it names as a parent no equivocated
  id, of any entity, whatever row this copy holds at that id. A row that
  names one is not admitted, not waiting and not reported; it neither shows
  nor hides;
- <a id="admitted-seat"></a>**seated table:** its author holds the seat its
  seat column names, in the row's own session (a seat is the pair of session
  and seat). <a id="admitted-member"></a>**Otherwise:** its author is a
  member of the row's session;
- <a id="admitted-no-other-session"></a>it names as a parent no row of its
  own entity from another session;
- <a id="admitted-no-other-seat"></a>in a seated table, it names as a parent
  no row of its own entity, in its session, whose seat column differs from
  its own;
- <a id="admitted-not-late"></a>it is not late;
- <a id="admitted-role"></a>where the table carries a role (`author=creator`
  or `author=joiner`), its author is, or is not, the session's creator.

<a id="parent-other-entity"></a>Parents name rows by `(author, seq)`, never
entities, and a version of a row is a row of its own table and entity: a
parent of another entity, or a row of another table at the id a parent names,
at an id not equivocated, is not a version of this row: it neither makes a row
cross nor hides anything.
<a id="parent-equivocated-outside"></a>Admission is only a session author
table's, so in the roster tables, the close and a plain document's tables a
row naming an equivocated id as a parent counts like any other row, and only
the row at that id counts for nothing.

### Heads

<a id="heads"></a>A head is a row no row of its own partition names as a
parent, and a head may be a delete (the tombstone is the head, with its flag):

- <a id="heads-author-table"></a>**a session author table:** among admitted
  rows only, partitioned by entity, session and (seated) seat. A row not
  admitted neither shows nor hides.
- <a id="heads-roster"></a>**the roster tables and the close** (`_dai_seat`,
  `_dai_binding`, `_dai_confirm`, `_dai_close`): among rows by authors who
  are no [equivocator](#equivocator), partitioned by **session, entity and
  author**. Only a row's
  own author's later row in the same session replaces it.
- <a id="heads-plain"></a>**a plain document's tables:** among rows at ids
  not equivocated, partitioned by entity.

### Waiting

<a id="waiting"></a>A row whose author asked for an open seat nobody holds
yet, and which names that seat, is waiting: neither admitted nor reported,
and admitted if the author is later confirmed. <a id="void-row"></a>A row for
a void seat is neither admitted nor reported.

## Reports

<a id="refused-batches"></a>`refusedBatches` is one entry `{author, reason}`
per batch id, code and author, where `author` is base64url: the author the
entry is about, which accuses her only where the code is `AUTHOR_EQUIVOCATED`.
<a id="report-order"></a>It MUST be emitted ordered by the batch id it is
filed under (lowercase hex, and no id sorts first), then by code, then by the
author id in hex.

| Code | In whose name | Filed under |
| --- | --- | --- |
| <a id="code-signature-invalid"></a>`BATCH_SIGNATURE_INVALID` | the author the header names | the header's id |
| <a id="code-row-malformed"></a>`ROW_MALFORMED` | the header's author, or the row's | the refused header's id; for a malformed row no refused header listed, the batch the row names, or no id |
| <a id="code-digest-mismatch"></a>`BATCH_DIGEST_MISMATCH` | the row's author, reported about her and not in accusation of her: a copy that forwards a header without a row it lists brings it about | the header the row names |
| <a id="code-unsigned"></a>`BATCH_UNSIGNED` | the author id the row carries | no id |
| <a id="code-seat-not-held"></a>`SEAT_NOT_HELD` | the row's author | the row's own `_r_batch` after the merge |
| <a id="code-entity-other-session"></a>`ENTITY_OTHER_SESSION` | the row's author | the row's own `_r_batch` after the merge |
| <a id="code-author-equivocated"></a>`AUTHOR_EQUIVOCATED` | the author who signed twice | the lowest of that author's revealing headers, or no id |

<a id="report-made-true"></a>`SEAT_NOT_HELD` and `ENTITY_OTHER_SESSION`
report what this merge made true. <a id="seat-not-held"></a>A row this merge
took, in a seated table, that names no seat (a seat column that is not 16
bytes), or a seat someone else holds, or that names a parent of its entity
and session acting for another seat, is `SEAT_NOT_HELD`.
<a id="entity-other-session"></a>A row in a session author table naming a
parent of its entity from another session is `ENTITY_OTHER_SESSION`.
<a id="report-crossing"></a>For the two crossings, the report is made
whichever of the two rows this merge took, the child or the parent, and is
the child's. <a id="report-silent"></a>A row waiting on a confirmation, a row
for a void seat, a late row, and a row naming an equivocated id as a parent
([whatever else it meets](#admitted-parent-equivocated)) are reported
nowhere; a row at an equivocated id is reported nowhere but as its author
signing twice (`AUTHOR_EQUIVOCATED`), whatever else it meets; and a row of a
[void session](#session-void) is reported nowhere. That covers the
reports made from the row set after placing; a refusal made before placing, in
steps 1 and 2 of a [merge](#merge), stands.

<a id="equivocated-report"></a>`AUTHOR_EQUIVOCATED` is reported once per
author per merge, for [equivocation](#equivocation) and [void
seats](#void) together, when this merge revealed that author signing twice.
A **revealing header** is:

- <a id="revealing-two-headers"></a>for two headers at one id: a header this
  merge kept that the local copy did not hold before, which lists, in any
  table, a seq of its author whose id is equivocated after the merge and was
  not before it;
- <a id="revealing-two-confirms"></a>for two confirms of one seat: the header
  named (`_r_batch`) by a row this merge took that the void rests on, for a
  seat void after the merge and not before it.
  <a id="void-rests-on"></a>A void rests only on the
  [counting confirms](#confirms) of its seat and on the session's creator's
  seat row that is not deleted and not at an equivocated id; only those
  reveal. A confirm of the seat at an equivocated id reveals nothing.

<a id="equivocated-filed"></a>It is filed under the lowest of that author's
revealing headers. <a id="equivocated-filed-no-id"></a>A void report with no
taken row it rests on is filed under no id; while a void rests only on what
[void-rests-on](#void-rests-on) names, no merge reaches this, since a void
newly true needs a counting confirm or the creator's seat row that the merge
took. <a id="equivocated-third"></a>A merge that brings a third
conflicting header for an id already equivocated reveals nothing new and
reports nothing.

## Canonical CBOR

<a id="cbor"></a>Deterministic CBOR (RFC 8949 §4.2.1), with these rules for
what a row's columns can hold:

- <a id="cbor-integer"></a>**Integers** are CBOR integers, in the shortest
  form that holds them, to ±2^64. A value past 2^53 is a BigInt and is
  written in eight bytes: 2^63 is `1b 8000000000000000`.
- <a id="cbor-unsafe"></a>**A whole JS number past 2^53** MUST be refused,
  never written as a float.
- <a id="cbor-float"></a>**A number with a fraction** is a float64 (`fb` and
  eight bytes, big-endian), never a shorter float. NaN MUST be refused.
  <a id="cbor-infinity"></a>Infinity, of either sign, MUST be refused, as NaN
  is.
- <a id="cbor-other"></a>Text is UTF-8; bytes are a byte string; NULL is CBOR
  null.

## Versions

<a id="version-declared"></a>A document written at batch format version 2
lists the capability `authorship` in its signed manifest's `requires`, and
every header it holds carries version 2. <a id="version-read-only"></a>A host
that lacks the capability `authorship` refuses the document
(`UNSUPPORTED_CAPABILITY`). A host that has it and does not write the
document's batch format version mounts it read-only, and so does a host that
writes version 2 given a document built without `authorship` or holding a
header of any other version, saying "This app needs an update before it can be
written to; what's here is kept."
<a id="version-unknown-header"></a>A merge MUST treat a header of a version it
does not know as one that does not verify (`BATCH_SIGNATURE_INVALID`).

<a id="version-not-container"></a>The batch format version is not the
container's format version, which is another number.
<a id="version-any-change"></a>A change to anything on this page is a format
version, never a refactor (identity.md, binding rule 10).

- Version 1: the header is `[version, document, author, lc, digest]`.
- Version 2: the header signs `covers`.
- Version 2: the session id hashes the seq of the creator's seat row, not a
  nonce.
- Version 2: two headers of one author at one id make the id count nowhere,
  reported `AUTHOR_EQUIVOCATED`.
- Version 2: two confirms of one seat naming different holders void it.
- Version 2: a close binds only its author and lists nothing.
- Version 2: an unsigned row is refused in every table (`BATCH_UNSIGNED`).
- Version 2: the one shape of parents; `ROW_MALFORMED`.
- Version 2: a document declares `authorship`; a host without it refuses the
  document, and one with it that does not write its format mounts it
  read-only.
- Version 2: equivocation is per `(author, seq)`, in any tables; the collision
  rule is an unsigned row's.
- Version 2: a row naming an equivocated id as a parent is neither admitted
  nor reported.
- Version 2: a row at an equivocated id is reported only as
  `AUTHOR_EQUIVOCATED`.
- Version 2: a void rests only on counting confirms and on the creator's seat
  row that counts.
- Version 2: Infinity is refused.
- Version 2: a list names each seq once, in any tables.
- Version 2: deleted and superseded confirms count.
- Version 2: roster heads partition by session, entity and author.
- Version 2: a held row a complete header the copy holds lists is signed, and
  a held header is rewritten to the list it signed.
- Version 2: the order of `refusedBatches`, and the header
  `AUTHOR_EQUIVOCATED` is filed under, or no id.
- Version 2: an equivocator's seat, binding, confirm and close rows count for
  nothing, and a session whose creator is an equivocator is void.
- Version 2: a confirm counts only for a seat the creator minted, the first
  `max_parties` in her seq order.

## Conformance

The bytes a signature covers are held byte for byte by
`tests/identity-vectors.spec.ts`, including 2^63 as `1b 8000000000000000`;
its values are derived outside the runtime (node:crypto and CBOR assembled
by hand). The session id is held by `tests/session-id.spec.ts`. What a merge
does is held by the fixtures in `conformance/merge`; the session fixtures
also carry what the document admits after the merge, and all of them are
`max_parties=2` and `close=any`. <a id="fixtures-verdicts"></a>The fixtures carry each header's
verdict in `verdicts.json` (`ok`, `incomplete`, or a refusal code), made
against the rows of the copy that holds it, and in `lists.json` the list
that made a header authentic where it is not the one the header stores, so a
reader can do the rest of the merge without its own signature check. The
reference readers, `conformance/reference/dai_merge.py` and
`conformance/readers/rust-merge`, are checked against this page.
