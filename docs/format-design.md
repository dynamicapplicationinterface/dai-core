Batch format 2: design notes
============================

Objective
---------

Record why batch format version 2 has the shape [format.md](format.md) gives
it: for each rule that version 2 changed or added, and for each reason the
version-2 page gave in its own text, the problem, the rule chosen and the
alternative rejected.

Nothing here is normative. Where this note and format.md differ, format.md
governs, and a reader built from format.md alone is complete. The `D` numbers
are entries in [backlog.md](backlog.md), which hold each whole argument; the
dates are the dates of the rulings, all in 2026.

Background
----------

Batch format version 1 signed `[1, document, author, lc, digest]`: the
document, the author, the author's clock and a digest of the rows. Signing
answered who wrote a row. The seat model's cold reviews (identity step 5,
24 to 27 September) then found rules that a signed row could still break,
because the rule trusted something the signature did not cover, or trusted
arrival order. Version 2 is the set of changes that closed them, built in
identity step 6 (27 to 29 September), and then stated as format when two
independent readers, built from the page, disagreed where it was silent
(D171, 29 September).

The properties the seat rules are derived from
---------------------------------------------

*3 October, the ninth attack review.* Rule: the
[session admission](format.md#session-admission) block.

**Problem.** Nine attack reviews of the seat model each closed the shape the
last one found. Each ruling (R11, R12, R13) was right about its attack and
left the next: a rule that decides which of one author's statements count by
their order in that author's seqs gives that author a retroactive edit, since
a dishonest client can sign at any seq the honest host never used. Leave a
seq unused, fill it later, and the filled row ranks above statements that
already granted holds.

**Rule.** The seat rules are derived from three properties, and a rule that
breaks one is a defect whatever attack it was written for:

- **P0.** The same rows and headers give the same state in any arrival order.
- **P1.** Adding any signed row, at any seq, by anyone, never removes an
  admitted row or a hold unless that merge reports `AUTHOR_EQUIVOCATED`. Void
  is the only way down.
- **P2.** Equivocation never lets the equivocator choose which of his
  statements survive.

The defect class is any rule that ranks two seqs of one author. Each such rule
is removed or shown harmless: the rules that remain compare a row's seq only
against the creator's seat row's (none in the roster since R14), or against
a close whose consequence is to accuse that author (R18), never to choose
between two of his statements.

*4 October, D190.* Reports are outside P0. P0 compares what a copy admits
(the admitted rows, the holders, the voided seats, the equivocated ids and the
closed sessions), not the reports its merges made on the way. A report says
what one merge made true ([report-made-true](format.md#report-made-true)), and
which merge makes a thing true depends on what arrived before it: a row that
arrives before the confirm that seats its author is reported `SEAT_NOT_HELD`
by the merge that takes it, and the same row arriving after it is admitted and
reported by nobody. Reports free of order would have to wait until nothing
arriving later could change their answer, and in a session nearly any row can
be changed by a later one (a confirm, a binding, a close, a second header), so
a copy would report almost nothing until every copy had met. A report tells a
person about one merge; the state is what the copies converge on. The
fixtures still hold each merge's reports, so two readers must agree on them.

**Rejected.** Ruling attack by attack: R11 to R13 each closed the shape the
review showed and not the class it belonged to, so the next review found the
next shape.

The header signs its list
-------------------------

*28 September, D161.* Rule: [canonical header](format.md#canonical-header),
[covers](format.md#covers-cache).

**Problem.** Version 1 left `covers` out of the signed bytes, on the reason
that the digest commits to the rows, their tables and their seqs, so a list
naming other rows digests to something else. That holds only where the
verifier holds the rows the list names. A copy forwarding a header could
change its list, and the next copy refused the header as a digest mismatch in
its honest author's name and dropped the rows it really covered.

**Rule.** The list is in the canonical header. A changed list no longer
verifies, so it is a forgery, not a mismatch, and a header can be checked as
the author's without holding any of its rows. That is what lets evidence of
an author signing twice travel (below).

**Rejected.** Leaving the list unsigned and relying on the digest: correct
only on a copy that holds every row the list names.

The list names the table
------------------------

Rule: [covers](format.md#covers-table).

**Problem.** A list of seqs alone (the column was `seqs` at step 4) says
nothing about where a row was signed.

**Rule.** The list names the table as well as the seq, so a row is looked for
only where it was signed: a row of the same number in another table is not
one the header covers, and cannot spoil it.

**Rejected.** Seqs alone, step 4's `seqs`, renamed and reshaped as `covers`.

The header lists its rows because saves get lost
------------------------------------------------

Rule: [covers](format.md#covers-says), [`_r_batch`](format.md#row-batch).

**Problem.** A row is written first and sealed later, and the seal reaches
the disk only in a later save. A save can be lost between the two: a tab
closed, a write the store refused. Then a copy holds the rows with no batch
named, and when they leave again they are sealed again, under a second header
over the same rows.

**Rule.** The header, which is signed, says which rows it covers, and
`_r_batch` is a cache of one header that covers the row.

**Rejected.** A row's own `_r_batch` as what says it was signed. It can be
unset on a row that was signed, and a row can claim a batch it was never part
of.

The session id hashes a seq, not a nonce
----------------------------------------

*27 September, D158.* Rule: [session id](format.md#session-id),
[the creator](format.md#creator).

**Problem.** At version 1 the id hashed a nonce carried on the creator's seat
row, and any row carrying that nonce counted as the creator's. The creator
could sign a second seat row with the nonce and the open seat's value, take a
seat already confirmed to someone else, and play that side.

**Rule.** The id hashes the seq of the creator's own seat row. A seq is spent
once per author per document, so no second row can carry it.

**Rejected.** The nonce, for the attack above. A highest-seq rule (the
creator's latest seat row wins): it would refuse honest rows delivered out of
order by file.

Two headers at one id: equivocation
-----------------------------------

*27 and 28 September, D160.* Rule: [equivocation](format.md#equivocation),
[headers kept](format.md#merge-headers-kept),
[the revealing header](format.md#revealing-two-headers).

**Problem.** One author can sign two different rows at one id. Picking a
winner between them trusts arrival order, and two copies that received them
in different orders split on who holds a seat.

**Rule.** The id is equivocated on every copy that holds both headers, and a
row at it counts for nothing. Both headers are kept and passed on, so every
copy that holds either side learns it from a copy that holds the other. An
authentic header is kept even when incomplete, because it is the author's
statement and the evidence of two conflicting ones has to travel with every
copy. This waited for the signed list (D161): the evidence is a header kept
without its rows, which is forgeable until the list is signed.

**Rejected.** Picking a winner, by arrival or by anything else a copy sees in
its own order.

### Whole-batch digests, and the floor

Rule: [whole digest](format.md#equivocation-whole-digest),
[the floor](format.md#floor).

**Problem.** The comparison is of whole-batch digests, so two headers that
list one row and differ anywhere, even in another row, are equivocation. That
accuses an author of signing twice whenever two such headers exist.

**Rule.** That is fair only because an honest author never has two headers
that list one row and both leave the device: a header leaves only in bytes a
save has landed, the floor is the highest seq the device has let leave it for
the document, and the host signs only rows above the floor. A re-seal after a
lost save covers rows whose first header never left. So the accusation is
fair while the floor holds.

**Rejected.** A host that let a row leave twice under two headers: it would
be accusing its own person. The same reason puts
[publishing after the save lands](format.md#publish-after-save): a batch
published on a save that was then lost would be on the relay and gone from
the device that signed it.

Two confirms of one seat void it
--------------------------------

*28 September, D165.* Rule: [void](format.md#void).

**Problem.** A confirmed seat is never reseated, so two confirms of one seat
naming different holders are two conflicting claims about one thing, as two
rows at one id are.

**Rule.** The seat is void, on every copy holding both, whatever their seqs
and whichever arrived first. The repair is a new session.

**Rejected.** The lowest seq's confirm holds: the creator could sign a
confirm at a seq skipped earlier and move a hold.

Deleted and superseded confirms count
-------------------------------------

*29 September, D171.* Rule: [confirms](format.md#confirms),
[versions count](format.md#confirm-versions-count).

**Problem.** A confirm is the creator's statement that a copy was seated, and
a hold never moves once made. What a later version or a delete of a confirm
means was unstated, and the readers split on it.

**Rule.** Every confirm row of the creator's in the session counts, deleted
or not, superseded or not; a delete naming another holder voids the seat as
any second confirm does.

**Rejected.** "Only current confirms count": a delete would unseat a
confirmed player. "Deleted rows do not count": a delete naming a different
holder would be a second confirm nobody sees. Both break the rule that a
hold never moves.

A close binds only its author
-----------------------------

*27 September, D151, D152, D153; amended 3 October, R18.* Rule:
[close-monotone](format.md#close-monotone),
[the close row](format.md#close-row), [first close](format.md#close-first).

**Problem.** At version 1 a close listed, per author, the highest seq its
author had seen, and every other author's rows past it were late. Signing
proved who wrote a close and could not prove the list, so a member who signed
a close naming only themselves erased the other member's moves in every copy.

**Rule.** A close makes only its author's own later rows late, ordered by
that author's own seq, which the author cannot reorder. The list's columns
retired with version 2. A deleted close row does not count, so a delete
revokes nothing (D153). "Late" itself retired with R18 (below): the author
can reorder his own seqs after all, by signing at one he skipped.

**Rejected.** The frontier list. [replicated-tables.md](replicated-tables.md)
T1-D31 keeps it, marked superseded, as the record of what was replaced.

An unsigned row is refused everywhere
-------------------------------------

*28 September.* Rule: [unsigned](format.md#merge-row-unsigned),
[placing](format.md#merge-place),
[a signed row outranks](format.md#merge-signed-outranks).

**Problem.** At version 1 a merge refused an unsigned row only in the seat
and close tables (D133, 25 September; D147, 26 September), where an unsigned
confirm under the creator's id seated whoever wrote it, and merged it
anywhere else as rows did before signing. Nobody's key vouches for such a
row, so it is nobody's.

**Rule.** `BATCH_UNSIGNED` in every table. Signed rows are placed before
unsigned ones, so the answer never depends on table order. Since no merge
takes an unsigned row, the one a copy can hold is its own, pending: a save
lost after it left reissues its seq, and the signed row coming back takes the
id.

**Rejected.** The refusal confined to the seat and close tables.

The one shape of parents, and `ROW_MALFORMED`
---------------------------------------------

*27 September, D159; stated as format 29 September, D171.* Rule:
[shape](format.md#parents-shape), [malformed](format.md#parents-malformed),
[never taken](format.md#parents-not-taken),
[the header refused](format.md#merge-headers-malformed).

**Problem.** Readers disagreed on what parents text means. JavaScript's
`JSON.parse` accepts nesting that SQLite's `json_each` refuses at depth over
1000, so a row that one reader parses and another throws on stops every read
that walks it; one stranger's ask with such parents made a contested seat
impossible to repair. The shape was then in no specification document, only
in the backlog, so an independent reader could not follow it (D171).

**Rule.** One shape, checked before anything reads a row, so every reader
walks the same parents or refuses the same row. The cap of 256 is far above
what an honest row needs: one head per writer who wrote concurrently.

**Rejected.** Leaving parents to each reader's own parser.

A document declares `authorship`
--------------------------------

*28 September, D108.* Rule: [declared](format.md#version-declared),
[read-only](format.md#version-read-only).

**Problem.** An installed copy runs whatever host its service worker cached.
A host from before signed authorship, handed a signed document, would write
unsigned rows into it.

**Rule.** The guard is in the format: a document declares its format version,
and a host that does not write it mounts the document read-only, with the
update sentence.

**Rejected.** Leaving it to the host alone: the skew is an old host meeting a
new document, and an old host cannot be changed after the fact; only what
the document says can reach it. (The other direction, an old document on a
new host, does not arise here: the runner mounts every document with its own
runtime.)

Roster heads partition by session, entity and author
----------------------------------------------------

*29 September, D171.* Rule: [roster heads](format.md#heads-roster).

**Problem.** A roster row (a seat, an ask, a confirm, a close) is one
author's statement in one session. The readers partitioned roster heads
differently.

**Rule.** Partition by session, entity and author, so only a row's own
author's later row in the same session replaces it.

**Rejected.** By entity alone, or by entity and session: another author's row
could replace it, so anyone could hide the creator's open seat by writing a
version of it. By entity and author: a row in another session could replace
it, so one game's roster would change another's.

The order of `refusedBatches`, and where `AUTHOR_EQUIVOCATED` is filed
----------------------------------------------------------------------

*29 September, D171.* Rule: [order](format.md#report-order),
[filed](format.md#equivocated-filed), [third header](format.md#equivocated-third),
[revealing header](format.md#revealing-two-confirms).

**Problem.** A report two readers emit in different orders is a report that
cannot be compared, and the batch id a refusal is filed under decides the
order. For `AUTHOR_EQUIVOCATED` it was unstated: the runtime filed it under
no id, the Rust reader under the lowest header that brought it. "The merge
that brings the second header" had two readings, which differ when a third
conflicting header arrives: the runtime reported whenever an arriving header
clashed with any held one; the Rust reader, when the set of equivocated ids
grew.

**Rule.** A report says what this merge made true, as the seat reports do,
and as the void-seat report already did. So `AUTHOR_EQUIVOCATED` is filed
under the lowest revealing header, and a third conflicting header reveals
nothing. The order is batch id, then code, then author: the third key
because one header can refuse rows of several authors under one code
(`BATCH_DIGEST_MISMATCH` is filed in the row author's name).

**Rejected.** Filing under no id, under the lowest header that arrived, or
under any header of the id; reporting the third header.

The attestation stays outside the signature
-------------------------------------------

Rule: [`att`](format.md#unsigned-att),
[stays unsigned](format.md#att-stays-unsigned).

**Problem.** Vouching for a key (an authority's attestation) arrives later
than the batches the key signed, and has to reach back to every one of them.

**Rule.** `att` sits outside the signed bytes, so vouching can arrive later
without touching any signature.

**Rejected.** "Tidying" `att` into the signed part: it would make every past
batch unvouchable without re-signing.

Canonical CBOR's numbers
------------------------

*Identity step 3's review, 24 September, before version 1 was frozen.*
Rule: [integers](format.md#cbor-integer), [unsafe](format.md#cbor-unsafe),
[floats](format.md#cbor-float).

**Problem.** sqlite-wasm returns an integer past 2^53 as a BigInt, and a
JavaScript number past 2^53 has already lost its low bits.

**Rule.** Integers in the shortest form, to ±2^64, BigInt included. A whole
JavaScript number past 2^53 is refused. A fraction is always a float64.

**Rejected.** Writing an unsafe number as a float: encoding it would sign a
value nobody wrote. Shorter floats: one width keeps the encoding
deterministic. No document signed under an earlier rule exists outside that
sitting's own tests.

A row naming an equivocated id as a parent
------------------------------------------

*29 September, the step 6 review, X1.* Rule:
[admitted rows](format.md#admitted-parent-equivocated),
[reports](format.md#report-silent).

**Problem.** Bo's move for his own seat names, as its earlier version, Ada's
move for her seat, at an id Ada signed twice. Which row that id is differs
from copy to copy: each copy holds whichever version reached it first, or
neither. The page said both "every rule below skips a row at an equivocated
id" and "names as a parent no row ... whose seat column differs", and the
two readers took one each.

**Rule.** A row naming an equivocated id as a parent is not admitted and not
reported, on every copy, whatever that id holds there. It neither shows nor
hides.

**Rejected.** The skip reading: the equivocated parent names nothing, so
Bo's move is admitted. It launders a crossing. A row the crossing rules
refuse (acting for another seat's row, or another session's) becomes
admitted as soon as the parent's author signs a second row at that id, and a
creator can do that to any row of hers a joiner's move might name. The reading of the parent this copy
holds (the runtime's before the ruling): the copy holding one version
reports `SEAT_NOT_HELD` and a copy holding the other may not, so copies
disagree on what a merge made true.

Equivocation across tables
--------------------------

*29 September, the step 6 review.* Rule:
[equivocation](format.md#equivocation-any-table),
[one id, one row](format.md#row-one-id).

**Problem.** One author signs seq 4 as a move under one header and as a
close under another. Equivocation compared `(table, seq)`, so the two
headers were not equivocation, and the collision rule refused whichever row
arrived second. A copy that received the move first kept the move, one that
received the close first kept the close, and nothing was reported: the split
by arrival order that equivocation was ruled to end (D160).

**Rule.** Equivocation is per `(author, seq)`, in any tables: the seq is one
counter per author per document, so a seq signed in two tables is signed
twice. Both rows are taken, both headers are kept, the id counts for nothing,
and the merge that reveals it reports `AUTHOR_EQUIVOCATED`. The collision rule
applies only to unsigned rows, which only a copy's own pending rows can be.

**Rejected.** Per-table equivocation with the collision rule for signed rows:
the split above.

What a void rests on
--------------------

*29 September, the step 6 review, X3.* Rule:
[the revealing header](format.md#void-rests-on).

**Problem.** The merge that voids a seat can also take a confirm of that seat
at an id already signed twice. That confirm counts for nothing, but the
runtime let every creator confirm of the seat reveal, so the report was
filed under the equivocated confirm's header, not the counting one's.

**Rule.** A void rests only on the seat's counting confirms and on the
creator's seat row that counts (not deleted, not at an equivocated id), and
only those reveal. The page already said "counting confirm"; the runtime was
brought to it.

**Rejected.** Any creator row naming the seat reveals: it files an accusation
under a header whose row the rules count as nothing.

A void report with nothing taken
--------------------------------

*29 September, the step 6 review.* Rule:
[filing](format.md#equivocated-filed-no-id).

**Problem.** The page named a void report's revealing headers as those of
rows the merge took, and was silent when it took none of them.

**Rule.** Filed under no id.

**Rejected.** A header of a row the void rests on that the copy already held:
a merge names a header only for what it took. Not reporting: the void is new
on this copy, and the report says what this merge made true.

`_r_batch` names a complete header
----------------------------------

*29 September, the step 6 review, X2.* Rule:
[`_r_batch`](format.md#merge-row-batch).

**Problem.** "The header it names if that header lists it" read literally
keeps an incomplete header on the row, though no row is taken through an
incomplete header. Both readers and the runtime already kept only a complete
kept one; the page's words said otherwise. The choice decides where a
`SEAT_NOT_HELD` or `ENTITY_OTHER_SESSION` is filed.

**Rule.** The named header if it is complete and kept in step 1, else the
lowest complete kept header that lists the row.

**Rejected.** The literal reading, for the reason above.

Infinity
--------

*29 September, the step 6 review.* Rule:
[floats](format.md#cbor-infinity).

**Problem.** The page refused NaN and was silent on Infinity, which the
runtime wrote as a float64.

**Rule.** Infinity, of either sign, is refused, as NaN is.

**Rejected.** Writing it as a float64: it is a valid float64 pattern, but it
is no more a value a row holds than NaN is, and a text form of it (JSON has
none) is spelled differently by each reader.

The version rule and an old host
--------------------------------

*29 September, the step 6 review.* Rule:
[read-only](format.md#version-read-only).

**Problem.** The page said a host that does not write version 2 mounts a
version-2 document read-only. A host built before signing cannot: it lacks
the capability `authorship`, which the document lists in `requires`, and
refuses it (`UNSUPPORTED_CAPABILITY`), which is the most such a host can do.

**Rule.** A host without the capability refuses the document; one with it
that does not write the document's batch format version mounts it read-only.

**Rejected.** The page's sentence as it stood: it described a host that
cannot exist.

What the floor counts
---------------------

*30 September, the step 6 review, Pass 1.* Rule: [the floor](format.md#floor),
[two honest seals](format.md#floor-honest-reseal).

**Problem.** The host raised its one floor to a number the frame sent beside
the header and never read the header's `covers`, so it signed whatever seqs
the header listed, at or below the floor included. The frame belongs to the
document and cannot be relied on (identity.md, binding rule 3), and a second
header over a seq that has left is the author signing twice, in the person's
own name.

**Rule.** Two marks. The sequence floor counts every seq the device has issued
a row at, so no new row is issued at one again; the host claims it from the
seqs the header lists, read from the bytes it signs. The floor the page names
is the other: the highest seq a header of the device's lists in bytes the host
saw land in its own store or is about to publish, read in the host's own
engine, and the host signs no header listing a seq at or below it. A save
raises it after the write lands and before the frame hears so, and a mount
reads the stored copy again, so a page gone between the two is counted on the
next open.

**Rejected.** One strict floor, the sequence floor, with every listed seq
above it. A save counts pending rows (their seqs are issued), so a seal of
rows a save held pending while a signature was on its way lists seqs at or
below it; so does a re-seal after a lost save. Either row would stay pending
for good, and a pending row refuses every later leave.

What leaves
-----------

*4 October, D181.* Rule: [the egress rule](format.md#floor-egress).

**Problem.** The floor holds the signer: no header over a seq at or below it
is signed. It held nothing that leaves. The document's code could ask for a
header over seq n above the floor, keep it, let the floor pass n, and then
write it into a file; or ask for two headers over one seq above the floor and
write both. Either reaches a copy as the person signing twice, and in a
session the person created it voids the session: the document's code makes
its own creator an equivocator.

**Rule.** The host records the id of every header of the person's that has
left, in the transaction that moves the floor. A header over a seq at or
below the floor leaves only if that very header left before, and no leave
carries two of the person's headers over one seq. A save checks before it
writes and records once it lands; a file and a publish check and record in
one step, since they leave on the answer. The seqs a header is held to are
read by the host from the bytes, the stored list and the person's rows naming
the header, since either can make it authentic.

**Rejected.** A sign-time record of every seq signed above the floor. It
refuses the second sign, but not the first header held while the floor
passes, and it refuses an honest re-seal after a lost save, which lists seqs
whose first header never left.

A list names each seq once
--------------------------

*30 September.* Rule: [covers](format.md#covers-seq-once).

**Problem.** A header could list one seq twice, in two tables. One header is
one statement, so every copy holding it held both rows, took both, and counted
both: one seq, two rows, which no honest writer produces, since the seq is one
counter per author per document.

**Rule.** A list names each seq once, in any tables. One that repeats a seq is
not a list, so no header signed over one is authentic
(`BATCH_SIGNATURE_INVALID`, in the author's name), and neither row is taken.

**Rejected.** Taking both rows: it spends one seq twice, and makes `(author,
seq)` name two rows on every copy that holds the header, the thing
equivocation exists to refuse.

Equivocation never benefits the equivocator
-------------------------------------------

*2 October, the eighth attack review, R10.* Rule:
[equivocator](format.md#equivocator), [void session](format.md#session-void).

**Problem.** A row at an equivocated id counts for nothing, and a void rests
only on counting confirms. Together they let a creator take back her own
confirm after the fact. She signs a second header at the confirm's seq, in
any table, with or without a row (an authentic header is kept whether or not
it is complete), and the confirm stops counting. Then she confirms whoever she
likes, herself or a copy that never held the seat: a hold made moves. A seat
void under D165 rests on its other confirm alone, and the void lifts onto it.
Every copy computed the same holder, and in one arrival order the merge that
moved the hold reported nothing.

**Rule.** Equivocation never benefits the equivocator. An author with two
authentic headers at one id anywhere in the document is an equivocator there,
and every seat, binding, confirm and close row of hers counts for nothing. A
session whose creator is an equivocator is void: nothing in it is admitted,
seats or closes, and nothing in it is reported but her signing twice. What
cannot be kept deterministically is voided, and the repair is a new session,
as for D165. Both headers are kept and passed on, so equivocation is never
undone, and void is monotone: nothing that arrives later restores the session.

**Rejected.** Keeping the earlier statement: the confirm she made before the
second header stands, and what she signs after it does not. Which of two
headers at one id came first is a fact about one copy's arrival order, not
about the rows (a seq orders nothing between two headers at the same seq), so
copies that received them in different orders would seat different holders:
non-deterministic across copies.

A confirm counts only for a seat the creator minted
---------------------------------------------------

*2 October, the eighth attack review, R11; retired 3 October by R14.* Rule:
[confirms](format.md#confirms), then `confirm-minted`, retired.

**Problem.** A confirm was not checked against the seats the creator minted,
and no reader read `max_parties`, which the manifest signs as the bound a
reader enforces (replicated-tables.md T1-D27). The creator of a two-party
session minted a third seat, confirmed a third copy in it, and three parties
played. The page said only that the confirm was not checked.

**Rule.** A confirm counts only for a seat she minted, and the seats she
minted are those her first `max_parties` seat rows in the session name, in her
seq order, a seat row being one entity of hers at the lowest seq of hers in
it. Deleted and superseded seat rows count, as deleted and superseded confirms
do, so no later row of hers unmints a seat. A row counts once whatever values
its versions give it, since a reseat gives the open seat's row a fresh value
and it is still the second seat.

**Rejected.** A confirm of any seat: the signed bound is enforced nowhere, and
a session declared for two holds as many parties as its creator confirms.

A seat is a seat row
--------------------

*2 October, R12; retired 3 October by R14.* Rule: then `seat-is-row` and
`held-row-frozen`, both retired.

**Problem.** Under R11 a minting row minted every value its versions named,
and a hold was a value's. After the creator confirmed one copy in the open
seat, she wrote a version of the open seat's row naming a fresh value and
confirmed another copy in it: two confirms, two values, two holders, and
three parties seated in a two-party session, without equivocating.

**Rule.** A seat is a seat row (an entity). A confirm binds to the row: each
value belongs to the row whose version named it first, in the creator's seq
order, and a confirm naming any value of a row is a confirm of that seat. Once
a row has a counting confirm it is held, and its later versions mint nothing
and move nothing; a confirm naming a later version's value is a second confirm
of the same seat, so another holder voids it (D165). The holder holds the seat
under the values its confirms name, so a later version of a held row does not
move the seat to its new value. A version of a row nobody holds is a reseat,
the same seat under a fresh value; a row for the old value, never confirmed,
acts for nothing.

**Rejected.** A seat by its value: a held seat's row can be versioned to a
fresh value and the fresh value confirmed to someone else, so a held seat is
reminted under another value, and the bound and the hold that never moves
both fall to a version of a row.

A session exists from its creator's seat row
--------------------------------------------

*2 October, R13; retired 3 October by R14.* Rule: then
`session-from-creator-row` and `confirm-minted`, both retired.

**Problem.** The session id is computable before the creator's seat row
exists. A creator could skip a seq, write her creator's seat row above it,
and later sign at the skipped seq a seat row in the session. In seq order it
came first, so the open seat's row fell past `max_parties`, the confirm of the
copy holding it stopped counting, and the hold went to nobody with nothing
reported.

**Rule.** A session exists from its creator's seat row. A roster or close row
of the creator's in her session below that row's seq counts for nothing
there, and the seats she mints are counted in seq order from it. An honest
writer never writes in a session before it exists.

The roster is declared
----------------------

*3 October, the ninth attack review, R14.* Rule:
[roster-declared](format.md#roster-declared),
[creator-row-immutable](format.md#creator-row-immutable),
[confirms](format.md#confirms).

**Problem.** A session's seats were minted: every seat row of the creator's
in the session, each counted once at its lowest seq, the first `max_parties`
of them in her seq order (R11), each value belonging to the row that named it
first (R12), counted from her creator's seat row (R13). Every one of those is
a rule that ranks two seqs of one author. A creator who never signed twice
left the seq after her creator's seat row unused, let a joiner be confirmed in
the open seat, and then filled the seq: with a seat row, so the open seat's
row fell past the bound; or with a version of her own seat row naming the open
seat's value, so the value became hers (review 9, A01, A02). Either way the
joiner's confirm stopped counting and the hold went to nobody, or to anyone
she confirmed next, with nothing reported, on every copy and in both readers.
It broke P1.

**Rule.** The creator's seat row, the one row the session id names, declares
the roster: her seat, the open seats as one run of 16-byte values, and the
close rule. Its roster is valid or the session is void. The row is immutable:
its later versions count for nothing, and no other `_dai_seat` row counts for
anything. A confirm counts only for a value the row lists. One holder may hold
several seats, so solo play seats the creator in an open seat. Nothing is
minted, nothing is ordered and nothing is reseated: a contested seat is never
confirmed, and the repair is a new session, which the kit starts by itself on
the creator's copy (closing the contested one). With no rule that reads a seq,
no seq a client fills later can move anything.

**Rejected.** Minting by seq order, and the whole gap family: R11 counted the
creator's seat rows in her seq order, R12 gave each value to the row that
named it first in that order, and R13 cut the order off below her creator's
seat row; each closed the gap the last review found and left one above it.
Forbidding gaps (a roster row counts only if her roster seqs run contiguously
from the creator's seat row): contiguity is a property of the set a copy
holds, so a copy that lacks one row sees a gap and stops counting honest rows
until it arrives, which is arrival order by another name. Reseat as the repair
of a contested seat: it is a second statement about a seat, and every rule
that let a second statement about a seat count had to decide between the two
by seq.

The session id hashes the roster
--------------------------------

*3 October, R15.* Rule: [session id](format.md#session-id),
[the roster hashed](format.md#session-id-roster).

**Problem.** Under R14 the creator's seat row carries the whole roster. Hashed
by its author and seq alone, two rows at that id declaring two rosters (the
creator signing twice) name the same session, and which roster a copy reads
depends on which row it holds.

**Rule.** The session id is SHA-256 of the author id, the seq, and the
canonical CBOR of `[seat, seats, close]` as the row holds them, whatever their
type, first 16 bytes. A row declaring another roster names another session, so
a session's roster is a fact of its id. `_r_session` is not hashed (it is the
hash). The frozen vectors of `tests/session-id.spec.ts` changed with it.

**Rejected.** Author and seq alone (D158): the roster would be whatever row a
copy holds at that id. Hashing only a valid roster: a row whose roster is not
valid would name no session, and its session would not be void but empty,
which a later row could not tell from one never started.

Two builds do not merge
-----------------------

*3 October, R16.* Rule: [document-mismatch](format.md#document-mismatch),
[`manifest.json`](format.md#fixtures-manifest).

**Problem.** `max_parties` and the close rule were in the signed manifest and
in no row or header, and the merge compared only tables and columns. The same
rows merged into a copy built under `max_parties=2` and one under 3 seated
different holders, and a copy under `close=any` and one under `close=creator`
disagreed on whether a session was closed (review 9, A04). Neither reader saw
the bound at all, and both assumed 2.

**Rule.** A merge refuses, whole, a sibling whose signed-view digest differs
from its own (`SIGNED_VIEW_MISMATCH`, with a sentence), so one copy's rules
are the only rules its rows are read under. Each fixture carries each copy's
digest and session profile in `manifest.json`, and both readers read it. The
close rule moved onto the creator's seat row (R14), so it is read from the
rows.

**Rejected.** Merging and reading each copy's own bound: the same rows give
two states, against P0. Carrying the bound in a header: every header would
repeat a declaration the manifest signs once.

An equivocator holds nothing
----------------------------

*3 October, R17, amending R10.* Rule:
[equivocator-holds-nothing](format.md#equivocator-holds-nothing),
[void](format.md#void).

**Problem.** Under R10 an equivocator's roster rows counted for nothing but
his hold, made by the creator's confirm, stood, and his rows in author tables
counted except at the equivocated ids. A joiner who resigned (a close), moved
anyway, and then signed two headers at one seq anywhere in the document had
his close stop counting, the session reopen, and his move after the close
admitted (review 9, A05): he chose which of his statements survived, against
P2.

**Rule.** An equivocator holds no seat: the seat he was confirmed in is void.
None of his rows is admitted, and none is reported but as his signing twice.
The equivocation that voids his seat is his, so it accuses him and not the
creator.

**Rejected.** Counting his close against him and never for him: it keeps his
other rows and his hold, and lets him choose again by which statements he
signs twice. Keeping the hold and dropping only his rows: a seat held by
someone none of whose rows count is a seat nobody can play, and is void in
all but name.

A close is monotone
-------------------

*3 October, R18.* Rule: [close-monotone](format.md#close-monotone),
[equivocator](format.md#equivocator).

**Problem.** A close made its author's rows at higher seqs late. A member who
played e5, skipped a seq, played Nf6, and later signed his first close at the
skipped seq made Nf6 late after the opponent had answered it, with nothing
reported (review 9, A10): a rule that ranks two seqs of one author, which a
client that fills a skipped seq reorders. It broke P1 for the author's own
admitted row.

**Rule.** A close that counts and any row of its author in that session at a
higher seq are equivocation: he is an equivocator (R17 applies), and the merge
that makes it true reports him `AUTHOR_EQUIVOCATED`. The rule still compares
two seqs of one author, but its only consequence is to accuse him: it never
chooses between his statements (P2), and every row it removes is his, in a
merge that reports him (P1). An honest writer never writes after his own
close: the runtime is to refuse his writes in a session after his close (the
host session's rule; until it is built the kit writes nothing in a session it
closed).

**Rejected.** `late`, and `admitted-not-late` with it: the author decides
which of his rows are late by where he signs his close.

A parent ahead of its row is malformed
--------------------------------------

*3 October, R19.* Rule: [parent-forward](format.md#parent-forward).

**Problem.** A row may name as a parent an id that does not exist yet. A
member's admitted move naming his own id at a higher seq, which he then fills
with a row of the same entity in another session, becomes a crossing
(`ENTITY_OTHER_SESSION`) after the fact: his own admitted row taken back,
through `foreign`, after the opponent answered it.

**Rule.** A parent naming an id of the row's own author at a seq at or above
the row's own is malformed (`ROW_MALFORMED`): an honest writer names only rows
it wrote before. A copy's own such row names nothing.

**Rejected.** Reading such a parent as naming nothing everywhere: the row
would be taken and its parents would mean different things on a copy that
holds the id and one that does not.

A void session does not depend on the row held at the creator's id
------------------------------------------------------------------

*3 October, R20.* Rule: [session-void](format.md#session-void).

**Problem.** A session was void when the author of its creator's seat row,
"not deleted", was an equivocator. A creator who signed, at her creator's seat
row's id, the row and a tombstone of it split copies for good: one table holds
one row per id, so a copy that met the row first was void and one that met
the tombstone first had no creator and was not void, and they reported
differently (review 9, A08). It read the row a copy holds at an equivocated
id, which the step 6 review (X1) had ruled must decide nothing.

**Rule.** A session whose creator's seat row is at an equivocated id is void,
deleted or not, and a copy holding only a tombstone there has no live
session: both admit nothing and report nothing but `AUTHOR_EQUIVOCATED`.

**Rejected.** The delete flag of the row held at that id, for the split above.

A seat someone else holds, and a value nobody holds
---------------------------------------------------

*3 October, A03.* Rule: [seat-not-held](format.md#seat-not-held).

**Problem.** A row for a value of a held seat row that no counting confirm
named (a reseat's old value) was reported `SEAT_NOT_HELD` by one reader and
nothing by the runtime and the other: the page did not say whether "a seat
someone else holds" was the row or the value.

**Rule.** A row naming a value no counting confirm names, by an author not
waiting in it, is `SEAT_NOT_HELD`. With the roster declared that covers a
value the creator's seat row does not list, a later version's value, and an
open seat nobody has asked for.

**Rejected.** Silence: a row that no confirm can ever seat is a row for a
seat its author does not hold.

A seat value is 16 bytes
------------------------

*3 October, A09.* Rule: [seat-value-shape](format.md#seat-value-shape).

**Problem.** The roster's `CHECK (length(seat) = 16)` counts characters for
text, and canonical CBOR signs text as text. With seat values typed as text,
the runtime seated both players and in the same merge reported one of them
`SEAT_NOT_HELD`, one reader seated nobody, and the other threw (review 9,
A09).

**Rule.** A seat value is a byte string of exactly 16 bytes; text of any
length, NULL, a number or a byte string of another length is not one. A
confirm naming one counts for nothing, a row naming one is `SEAT_NOT_HELD`,
and no reader fails on it.

**Rejected.** Comparing values whatever their type: text and bytes of the
same length then seat and fail to seat by turns.

A row waits on a parent it does not hold
----------------------------------------

*4 October, R21, D189.* Rule:
[waiting-on-parent](format.md#waiting-on-parent),
[admitted-parents-held](format.md#admitted-parents-held).

**Problem.** Parents name rows by author and seq, never by entity, session or
seat, so whether a row crosses a session or a seat through a parent is known
only on a copy that holds the parent. A copy that held a row and not its
parent admitted it; the parent's arrival made it a crossing, and that merge
took it back with only `SEAT_NOT_HELD` or `ENTITY_OTHER_SESSION` reported. The
property pass found eight such removals against P1: a version for another
seat, a version of another session's row, and a version naming an id that its
parent's arrival showed equivocated. Only a writer that names a parent it does
not hold makes such a row, but anyone can sign one, and whoever holds the
parent chooses when it arrives. R19 refused only a forward parent of the row's
own author.

**Rule.** A row of a session author table naming as a parent an id at which
the copy holds no row, in any table, waits on it: neither admitted nor
reported. Once every parent it names is held, the existing rules decide it,
once, and the merge that brought the last of them reports a refusal as it
reports a row it took. Whether a parent is held is a fact of the row set, and
an id once held stays held, so a row leaves waiting once and never returns:
no added row takes it back (P1), and every order of arrival ends in the same
state (P0). An honest reply that arrives before the move it names waits, and
is admitted when the move arrives.

**Rejected.** Admitting the row now and removing it later if its parent
crosses: that is the removal P1 forbids, made by a row its holder may release
whenever he likes. A crossing as an accusation (`AUTHOR_EQUIVOCATED` of the
child's author): the child's author does not choose when the parent arrives,
and an honest child naming another author's row would accuse its writer of
the other's timing. Refusing a parent of another author that the copy does not
hold, as R19 refuses a forward one of the row's own author: R19's test reads
the row alone and is the same on every copy, and this one would depend on
what a copy holds when the row arrives.

Reasons given inline
--------------------

The version-2 page gave these reasons in passing; no alternative was
recorded for them.

- [The document in the header](format.md#canonical-header): a batch signed
  for one document means nothing in another.
- [`_r_batch` and `_r_superseded` outside the canonical rows](format.md#canonical-rows-excluded):
  the batch is named after the rows, and supersession is derived.
  `_r_superseded` is read by no rule (D140).
- [One batch per session](format.md#batch-per-leave): each session travels
  in its own mailbox under its own key.
- [A header that does not verify](format.md#verify-refused) is refused in the
  name it carries: what any forgery in that name gets, and an accusation of
  nobody.
- [`BATCH_DIGEST_MISMATCH`](format.md#code-digest-mismatch) is reported
  about the row's author, not in accusation of her: a copy forwarding a
  header without a row it lists brings it about, so the report names whose
  row was refused, and only `AUTHOR_EQUIVOCATED` accuses (the eighth attack
  review, A4).
- [A parent of another entity](format.md#parent-other-entity) hides nothing:
  replicated-tables.md T1-D35.
