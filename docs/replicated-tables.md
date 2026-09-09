# Replicated tables — Level 1

Status: the build contract for Track 1. Reconciles *Replicated Tables and
Sealed Exchange, Draft 1* with §3 of *Profiles and Confidentiality 2.1.1*.
Where the two disagree, 2.1.1 wins and this document says so. Where both are
silent, this document decides, numbered, and the decision is here before it is
in code.

Level 1 only: no replica keys, no signatures, no relay. Everything about
authorship is a **claim** — a replica id and nothing more. Level 2 turns those
claims into proofs and is Track 2; the column that will carry the proof exists
now (T1-D7) so that arriving there needs no migration.

## 1. What a replicated table is

A table declared `-- dai:replicated` is append-only and merges by union. Rows
are never updated or deleted in place: a change is a new row naming the rows it
supersedes, and a delete is a new row with a tombstone flag. Merging two copies
is a set union keyed on `(_r_replica, _r_seq)`, which is commutative,
associative and idempotent — so any order of exchanges converges, merging the
same copy twice does nothing, and no copy is authoritative.

There is no ordering authority, no reducer, and no mutation classes. Draft 1
carried language implying otherwise in places; D1 of 2.1.1 removes it. Union
merge is the whole model.

**No wall clock decides anything, anywhere.** Ordering is the Lamport clock
`_r_lc` and the parents DAG. This is stronger than Draft 1's "advisory"
framing — see T1-D1.

`savedAt` succession (spec §2) does **not** apply to a document with
replicated tables. Whole-copy replacement by wall time is what union merge
replaces; the two rules would fight, and wall time would win by accident.
`savedAt` remains the mechanism for `broadcast` documents.

## 2. Terms

| Term | Meaning |
|---|---|
| Copy | One instance of a document's data section on one device. |
| Replica | The identity a copy writes under: 16 random bytes. One copy, one replica. |
| Row id | `(_r_replica, _r_seq)`. Text form `<replica-hex>:<seq>`. |
| Entity | A logical record that may have many rows over time. 16 random bytes, minted at creation. |
| Head | A row no other row supersedes. |
| Conflict | An entity with more than one head. |
| Sibling | Another copy of the same document (§5). |

## 3. Declaration

```sql
-- dai:replicated
CREATE TABLE cases (
  title  TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  notes  TEXT
);
```

The compiler records the table in the signed manifest, rewrites the
`CREATE TABLE` per §4, and refuses the build (`REPLICATION_SCHEMA_INVALID`) if
the author's columns use the reserved `_r_` prefix, declare their own
`PRIMARY KEY`, or declare `AUTOINCREMENT`.

Manifest surface, in the signed set so every copy agrees:

```json
{
  "manifestVersion": 4,
  "requires": ["replicated"],
  "replication": { "tables": ["cases"], "level": 1 }
}
```

See T1-D5: this is the first writer to emit version 4, and it is what closes
the "readers before writers" ordering that Track 0 opened.

## 4. Storage schema

For a declared table `T`:

```sql
CREATE TABLE T (
  -- the author's columns, unchanged --
  _r_replica    BLOB    NOT NULL CHECK (length(_r_replica) = 16),
  _r_seq        INTEGER NOT NULL CHECK (_r_seq > 0),
  _r_lc         INTEGER NOT NULL,
  _r_entity     BLOB    NOT NULL CHECK (length(_r_entity) = 16),
  _r_parents    TEXT    NOT NULL DEFAULT '[]',   -- JSON array of row ids, sorted
  _r_deleted    INTEGER NOT NULL DEFAULT 0 CHECK (_r_deleted IN (0,1)),
  _r_superseded INTEGER NOT NULL DEFAULT 0 CHECK (_r_superseded IN (0,1)),
  _r_sig        BLOB,                            -- always NULL at Level 1 (T1-D7)
  PRIMARY KEY (_r_replica, _r_seq)
) WITHOUT ROWID;

CREATE INDEX T__r_entity ON T(_r_entity, _r_lc);
CREATE INDEX T__r_heads  ON T(_r_entity) WHERE _r_superseded = 0;

CREATE TRIGGER T__no_update BEFORE UPDATE OF
    _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_sig ON T
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE'); END;
CREATE TRIGGER T__no_delete BEFORE DELETE ON T
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE'); END;

-- The one permitted update, and only in one direction (T1-D10).
CREATE TRIGGER T__superseded_monotonic BEFORE UPDATE OF _r_superseded ON T
  WHEN OLD._r_superseded = 1 AND NEW._r_superseded = 0
  BEGIN SELECT RAISE(ABORT, 'ROW_REJECTED'); END;
```

`_r_superseded` is maintained at write, not derived by a scan. This is D5 of
2.1.1 and it replaces Draft 1's `T_heads` view, which walked `json_each` over
every row's parents on every read. See T1-D2 for how the flag is kept correct
when rows arrive out of order, which Draft 1 never had to answer because its
view recomputed from scratch.

Note the update trigger names columns: `_r_superseded` must remain writable,
because maintaining it *is* a write. Draft 1's blanket `BEFORE UPDATE` would
have made D5 impossible to implement.

```sql
CREATE VIEW T_heads AS
  SELECT * FROM T WHERE _r_superseded = 0;

CREATE VIEW T_conflicts AS
  SELECT _r_entity,
         count(*) AS heads,
         json_group_array(hex(_r_replica) || ':' || _r_seq) AS head_ids
  FROM T_heads GROUP BY _r_entity HAVING count(*) > 1;
```

`T_current` shows **one row per live entity, always** — never an omission under
conflict, because omission is a silent resolution to nothing and reads to a
person as lost data. Under conflict it shows the head with the highest `_r_lc`,
tiebreak lexicographic on `_r_replica`, and exposes `_r_conflicted = 1`:

```sql
CREATE VIEW T_current AS
  SELECT h.*,
         (SELECT count(*) FROM T_heads x
           WHERE x._r_entity = h._r_entity) > 1
           AS _r_conflicted
  FROM T_heads h
  WHERE h._r_deleted = 0
    AND h._r_replica || ':' || h._r_seq = (
      SELECT y._r_replica || ':' || y._r_seq FROM T_heads y
       WHERE y._r_entity = h._r_entity AND y._r_deleted = 0
       ORDER BY y._r_lc DESC, hex(y._r_replica) ASC, y._r_seq ASC
       LIMIT 1);
```

The `_r_seq` tiebreak beyond `_r_replica` is T1-D6: two heads from the same
replica for the same entity are possible after a merge of a copy that forked
from itself, and the 2.1.1 rule stops one step short of total order.

Document-level tables, created once:

```sql
CREATE TABLE _dai_replica (
  id    BLOB PRIMARY KEY CHECK (length(id) = 16),
  seq   INTEGER NOT NULL DEFAULT 0,   -- last seq issued by THIS replica
  lc    INTEGER NOT NULL DEFAULT 0,   -- highest Lamport value seen
  label TEXT
);

CREATE TABLE _dai_replicas (
  id         BLOB PRIMARY KEY CHECK (length(id) = 16),
  label      TEXT,                    -- asserted by that replica; a claim
  first_seen INTEGER NOT NULL,        -- the local Lamport value at first sight (T1-D1)
  rows_seen  INTEGER NOT NULL DEFAULT 0
);
```

`pubkey` is absent from both at Level 1 and returns in Track 2.

An application MUST NOT write `_r_*` columns; the kit or the runtime does.
Non-replicated tables are local: never merged, never leaving the copy except
in a full export.

## 5. Write rules

Every write goes through the runtime, which stamps the row. For replica `R`:

**Create entity** — `seq := seq + 1`, `lc := lc + 1`, `entity := 16 random
bytes`, `parents := []`.

**Change entity** — `parents :=` the entity's current head ids, sorted; `seq`
and `lc` as above; the row carries the author's full new column values, not a
diff.

**Delete entity** — a tombstone: as *change*, with `_r_deleted = 1` and the
author columns copied from the head being deleted.

After every write `_dai_replica.seq` and `.lc` advance, and the flag of T1-D2
is applied. The row insert and both updates are one transaction.

## 6. Merge (frame)

The host hands the frame a verified sibling data section over
`DAI_HOST_MERGE`; the frame answers `dai:merge-result`. The frame never sees
container bytes, never parses a manifest, never touches host storage.

```
ATTACH sibling as S (read-only)
lc_max := max(local lc, S.lc, max(S.T._r_lc) over all replicated tables)
BEGIN
  for each replica X in S._dai_replicas ∪ {S._dai_replica}:
    INSERT OR IGNORE INTO _dai_replicas (id, label, first_seen)
  for each replicated table T:
    for each row r in S.T:
      INSERT OR IGNORE INTO T (...)          -- PK makes this idempotent
  apply the supersession rule (T1-D2) over the rows just inserted
  _dai_replica.lc := lc_max
COMMIT
```

Local tables in `S` are ignored. Lamport clocks only advance.

At Level 1 there is nothing to verify: no row carries a signature, and a
replica id is a claim. A copy can assert any id and any label. That is the
honest description of Level 1 and the reason Level 2 exists — it is not a gap
to be papered over in the UI.

## 7. Sibling test (host)

In order:

1. `documentUuid` equal — otherwise unrelated, no merge offered.
2. Publisher identity agrees (T1-D4) — otherwise refuse.
3. `replication.tables` present in both manifests — otherwise not a replicated
   document; fall through to normal succession.
4. Schema digest equal — otherwise `SCHEMA_MISMATCH`, refused (T1-D14).
5. Incoming `_dai_replica.id` differs from the local one — equal ids mean this
   is my own copy coming back, which is succession, not a merge.

On a sibling the host offers **Merge into my copy** on the launch card. It MUST
NOT merge without the person choosing it, and MUST NOT overwrite the local copy
with the incoming one.

## 8. Decisions taken here

Numbered because Draft 1 and 2.1.1 are both silent. Each is a choice that could
have gone another way, and the reasoning is what makes it reviewable.

**T1-D1 — `_r_ts` is removed; there is no wall clock in a row.** Draft 1 kept
an advisory RFC 3339 stamp, unused for ordering. An unused column that looks
authoritative is a trap: the first person to sort by it gets an answer, and the
answer is wrong across devices with skewed clocks. `_dai_replicas.first_seen`
becomes the local Lamport value rather than a timestamp for the same reason.
Nothing needs it — §7 of Draft 1 already excluded `_r_ts` from the signed
payload, so removing it costs Level 2 nothing.

**T1-D2 — supersession is applied in both directions at insert.** D5 sets the
flag at write, which is correct when a parent is already present. Rows arrive
out of order on merge: a child can be inserted before its parent exists. So
inserting row *r* does two things — mark every row named in `r._r_parents` as
superseded, **and** mark *r* itself superseded if any existing row already
names *r* as a parent. Both are pure functions of the row set, so every host
converges on the same flags regardless of arrival order. Draft 1 never faced
this because its view recomputed from scratch on every read; the flag is the
optimization and this is its cost.

**T1-D3 — a tombstone loses to a change only when the two are concurrent.**
2.1.1 says `T_current` picks the highest `_r_lc` head and never omits the
entity; it does not say what happens when the winning head is a tombstone.

The rule is scoped to concurrency, not to tombstones generally. A tombstone
that names the change as a parent is a later delete of an edit its author had
already seen, and it wins the ordinary way — the change is superseded, is not a
head, and the entity is deleted. Without that scoping a delete could never
stick against any edit that existed before it, which is not conflict resolution
but a table that cannot be emptied.

The case that needs a rule is two rows that are *both heads*, neither naming
the other: nobody saw the other's work. There `T_current` picks among the
**non-deleted** heads, because letting a tombstone win on clock order deletes
somebody's edit silently — the exact failure the no-omission rule exists to
prevent.

And the surfaced row carries `_r_conflicted = 1`. It is not enough to quietly
show the edit: the person has to see that somebody else deleted this and choose,
rather than discover later that a delete they made was reverted without a word.
So `_r_conflicted` counts **all** heads of the entity, not the live ones — an
entity with one live head and one tombstone head is conflicted, and an earlier
draft of this view read 0 there, which is the bug this amendment caught.

The tombstone is never lost: it is in `T_heads`, the entity is in
`T_conflicts`, and resolution is the app writing a row naming both parents. An
entity all of whose heads are tombstones is deleted and absent from
`T_current` — not an omission but an answer.

**T1-D4 — the publisher check is "agrees", not "SPKI equal".** Draft 1
assumes a signed document. Unsigned documents are ordinary in this project, and
comparing an absent SPKI to an absent SPKI as "equal" would let any unsigned
document claiming the same UUID present itself as a sibling. The rule: both
signed and the same SPKI → sibling; both unsigned → sibling only if the
person's device already holds that UUID as unsigned and the trust state is not
in conflict; one signed and one not → refuse. This is the weakest link in
Level 1 and it is a claim, like everything else here.

**T1-D5 — Track 1 is the first writer to emit `manifestVersion: 4`,** with
`requires: ["replicated"]`. Track 0 shipped the readers and deliberately no
writer. A document with replicated tables opened by a reader that ignores them
would merge nothing and silently diverge, which is exactly the degradation the
`requires` gate exists to refuse. `IMPLEMENTED_CAPABILITIES` gains
`"replicated"` in the same change that ships the merge.

Checked before building against this, because the ordering is only real if the
readers are actually deployed: the opener serving opendai.app was verified to
contain the version-4 reader commit. A returning visitor running a shell from
cache is the remaining case, and it degrades correctly — a pre-v4 shell meets
a version-4 document and refuses it by name with "update the app", which is
what the gate is for, rather than opening it without the capability.

**T1-D6 — `_r_seq` is the final tiebreak in `T_current`.** 2.1.1 gives highest
`_r_lc`, then lexicographic `_r_replica`. Two heads for one entity from the
*same* replica are reachable, so that pair is not a total order. Adding
`_r_seq` makes the pick total, and it is deterministic across readers, which
is what `current-conflict-deterministic-pick` demands.

**T1-D7 — `_r_sig` exists at Level 1 and is always NULL.** Keeping the column
means Level 2 is a behaviour change rather than a migration over every existing
replicated row, and §9's migration rules forbid rewriting `_r_*` columns
anyway. The cost is one always-null column.

**T1-D8 — `_dai_snapshots` is deferred to Track 2.** Draft 1 §8.1 makes it
optional and its value is the signature; unsigned, it is a hash anyone can
recompute and nobody can attest.

**T1-D9 — "identical tables" means a canonical dump, and the dump's encoding
is specified here.** SQLite file bytes depend on page allocation and insertion
order, so two hosts that converge correctly can hold different files.

The comparison is a text dump of every replicated table plus `_dai_replicas`:
rows ordered by `(hex(_r_replica), _r_seq)`, columns in declared order, one row
per line, values tab-separated.

The encoding is where two implementations actually diverge — not on the rows,
on the printing of them. So it is fixed per storage class:

| class | encoding |
|---|---|
| NULL | the three characters `nil` |
| INTEGER | decimal, no separators, leading `-` for negatives |
| TEXT | the UTF-8 text, with tab, newline and backslash backslash-escaped |
| BLOB | lowercase hex, no prefix, empty blob as the empty string |
| REAL | shortest round-trip decimal (the shortest string that parses back to the same double), always with a decimal point or exponent so it cannot be read as an integer |

REAL carries the special cases explicitly, because this is where a language's
default formatter will silently disagree: negative zero is `-0.0`, not-a-number
is `nan`, and the infinities are `inf` and `-inf`. Python's `repr` and
JavaScript's `Number.prototype.toString` both produce shortest round-trip
digits, but they disagree on all four of those tokens by default.

And the framing, which the first version of this decision left out entirely —
it fixed how a *value* is written and said nothing about where a line ends or a
section begins. A third implementation got every value right and had to read a
fixture to learn the shape of the file:

- One section per replicated table, in ascending name order, introduced by a
  line `# <table>`.
- Then one section `# _dai_replicas`, always last.
- Table sections: one line per row, values tab-separated, columns in the order
  `PRAGMA table_info` reports them, rows ordered by `(_r_replica, _r_seq)`.
- The `_dai_replicas` section: one bare replica id per line, lowercase hex,
  ascending. Not tab-separated, because there is one field (T1-D12).
- The file ends with a newline after the final line.

Ordering is by the raw bytes of `_r_replica`, and printing is lowercase hex.
Sorting the uppercase form SQLite's `hex()` produces gives the identical order —
digits precede letters in both cases, so the mapping is order-preserving — and
that is stated here only because a reader should not have to prove it.

Vector `canonical-dump-real-edge-cases` covers the value encoding and **runs
before `merge-commutative`**. Otherwise the first document with a float column fails
the commutativity vector, and the merge — which is correct — takes the blame
for the printer.

**T1-D12 — the dump asserts the replica ids and nothing else about them.**
`_dai_replicas` carries `first_seen` and `rows_seen`, and neither can converge:
they are records of *this copy's* history. A records seeing B on the merge that
introduced them, and B records the same about A, so the two disagree by
construction and always will.

The fixture generator found this on its first run, with every row in every
table converging perfectly and the dumps differing anyway — which is the
generator working: an assertion about convergence that a correct
implementation fails is worse than no assertion, because somebody will
eventually "fix" it by making the wrong thing converge.

`label` is excluded for a stronger reason than that it happens not to
converge: it must not. A label is **recipient-assigned by design** — a name
this copy gives a key, never a name the key carries. Keys cannot be faked and
names can, which is why authorship is a key and a name is a label attached to
one. A label that propagated between copies would be a name travelling with an
identity, which is exactly what that decision refused.

So this is not a conservative choice to revisit later. Two copies holding
different labels for one replica are both correct. The *set of ids* converges,
and that is what the dump asserts.

The columns stay in the table — a copy needs them — and are marked LOCAL in the
emitted schema, so the next person writing a dump generator finds the reason
next to the column rather than rediscovering it through a failing fixture.

**T1-D13 — a refusal must never be cheaper than the thing it refuses.** One
row refused does not deny the rest of the exchange. Refusing the whole merge on
one bad row would make forging a single row a cheaper attack than forging
anything real: an attacker who wanted to stop two people syncing would need one
malformed row rather than a plausible document. The same principle governs the
relay in Track 5, and it is written here because this is where it first has
teeth.

The corollary, which is not a defect: two copies holding different content
under one row id **never converge**. Each refuses the other's version and keeps
its own. Union merge converges over rows nobody disputes, and a disputed id is
exactly where the guarantee stops — the alternative is one side silently
adopting the other's version of a row, which is what refusing it exists to
prevent. Fixture `merge-row-id-reused` pins this with both dumps checked in and
`converges: false` recorded beside them.

**T1-D11 — the flag is not row content: not compared, not signed, not
exported as fact.** `_r_superseded` says what *this copy* has seen supersede
what. It is derived from the row set and it is local.

Three consequences, and the third is the one that would be found late:

- **Not compared.** Two copies of the same row legitimately carry different
  flags, because the sender may hold a child this copy has not. Including it in
  the idempotence check of §6 would make `ROW_REJECTED` fire on honest rows in
  every exchange.
- **Not exported as fact.** A merge derives the flag from the rows it has, and
  ignores whatever the sender's column said. There is nothing to reconcile,
  because the value is recomputed rather than transferred.
- **Not signed.** When Level 2 arrives, `_r_superseded` is excluded from the
  canonical row encoding. A signature covering it would fail verification on
  every honest merge, for exactly the reason the comparison would — and it
  would fail *after* the rows had been accepted, which reads as forgery rather
  than as a design error. Draft 1 §7 already lists the signed fields and this
  column is not among them; this says why it must stay that way.

It is in the canonical dump of T1-D9 all the same, and that is not a
contradiction. The dump is what proves two copies converged, and the flag is a
function of the row set — so if two hosts hold the same rows and disagree about
the flag, they have not converged and the dump must say so.

**T1-D10 — the update trigger is column-scoped, and the flag only rises.**
Draft 1's blanket `BEFORE UPDATE` would forbid the very write D5 requires. The
trigger names the immutable columns instead, leaving `_r_superseded` writable.

Writable in one direction only: 0 to 1 is permitted, 1 to 0 is
`ROW_REJECTED`. Without that, D2's convergence argument has a hole big enough
to lose data through — two hosts holding the identical row set, one of which
has cleared a flag, disagree about `T_heads` forever, and nothing in a later
exchange corrects it because the row sets already match and union merge has
nothing left to do. Monotonicity is what makes the flag a function of the row
set rather than of the history of writes to it.

The author's own columns are covered by the rule that applications never write
`_r_*` and by the kit's refusal to emit `UPDATE` against a replicated table.

**T1-D15 — the merge reports `applied`, `duplicate`, `rejected` and
`newReplicas`.** Draft 1 §9 says `rowsAdded` and nothing else, and a fixture
carrying four names the prose never defines makes the fixture the
specification. They are:

| field | meaning |
|---|---|
| `applied` | rows inserted, having not been held before |
| `duplicate` | rows already held with the same content (§6's idempotence) |
| `rejected` | row ids held with *different* content, refused per T1-D13 |
| `newReplicas` | ids written into `_dai_replicas` that were not there before |

"Same content" means every author column, `_r_lc`, `_r_entity`, `_r_parents`
and `_r_deleted`. `_r_superseded` is excluded (T1-D11), and that exclusion is
what makes `duplicate` rather than `rejected` the answer on almost every real
exchange: a sender's flag legitimately differs from ours.

A rejected id is written in the `_r_parents` text form — lowercase hex, colon,
sequence number. The `T_conflicts` view uses SQLite's uppercase `hex()` for the
same idea, and that inconsistency is the view's, not this one's; anything a
reader emits uses the lowercase form.

**T1-D20 — the bridge carries T1-D15's vocabulary, plus the conflict count.**
Draft 1 §8.3 gives `dai:merge-result` as `{ rowsAdded, conflicts,
unknownReplicas, refused? }`; T1-D15 defines `{ applied, duplicate, rejected,
newReplicas }` for the same event. Two names for one quantity is how a fixture
and a bridge drift apart, so the wire carries T1-D15's four, and `conflicts`
alongside them:

```
DAI_HOST_MERGE    host -> shell -> frame
  { sessionNonce, payload: { databaseBytes, replicaId, level } }
dai:merge-result  frame -> shell -> host
  { applied, duplicate, rejected: [...], newReplicas, conflicts, refused? }
```

`conflicts` is kept from Draft 1 because it is the one number the person is
shown and the only one not derivable from the other four. `rowsAdded` and
`unknownReplicas` are dropped as aliases of `applied` and `newReplicas`.

**It is the post-merge total: every entity that has more than one head now**,
across every replicated table — exactly what `T_conflicts` counts. Not the
entities this merge newly put into conflict, which is the other available
reading and the wrong one. The total needs no memory of the previous state, so
two hosts that merged in different orders report the same number for the same
rows; a delta depends on where each host started, and two people looking at the
same document would see different figures and both be right. It also matches
what the person can then go and look at: the count and the list agree.

`refused` carries a refusal name when the merge did not run at all: a schema
digest that differs (`SCHEMA_MISMATCH`, T1-D14), or a payload that is not a
database. It is absent when the merge ran, however many rows it rejected —
a merge that refused some rows still happened, and T1-D13 is the reason.

**T1-D21 — the schema comparison is over the author's columns, not the
compiler's output.** T1-D14 refuses a sibling whose schema digest differs, and
leaves open what is digested. The `CREATE TABLE` text SQLite stores is the
compiler's: replication columns, key, triggers, whitespace, ordering. Two
conforming compilers could emit it differently and both be right, and comparing
it would refuse a merge between two copies of the same document built by
different tools.

That is the worse kind of disagreement. Two readers disagreeing about a *merge*
is caught by the fixtures; two readers disagreeing about whether a merge may
happen at all is not, because the rows never get far enough to be compared.

So the comparison is the author's columns, recovered from the table: one line
per column, tab-separated, tables in name order and columns in declared order,
carrying the name, the declared type upper-cased, whether it is `NOT NULL`, and
the default verbatim. The `_r_*` columns are excluded — every conforming
compiler emits the same ones, so they carry no information and only invite a
formatting difference. Types are upper-cased because SQLite treats `text` and
`TEXT` alike; defaults are left exactly as written, because normalising a
literal is how two readers start disagreeing about what a default means.

Local tables are absent by construction, which is the point: a private table on
one side is not a reason to refuse, because local tables never travel and never
merge. Vector `schema-digest-replicated-only`.

**The comparison covers shape, not constraints, and that is a stated
trade-off.** What a table can be asked for its own columns are names, declared
types, `NOT NULL`, defaults and key position. `CHECK` constraints and `COLLATE`
clauses are not among them. So two copies whose author schemas differ *only* in
a `CHECK` compare as identical, are treated as siblings, and merge — and a row
that is valid on one side can fail the other side's constraint when it is
inserted.

That failure is `ROW_REJECTED`, counted like any other, and the two copies do
not converge on that row. It behaves exactly like the disputed-row-id case
(T1-D13, §10): the exchange continues, the refusal is reported, and the person
is told what was dropped.

The alternative is pulling the `CHECK` text into the comparison, which
reintroduces the problem this decision exists to remove — two compilers can
spell one constraint differently and both be right, and comparing their text
refuses a merge between two correct copies. A false refusal of a valid merge is
worse than a true refusal of a row: the first stops everything and cannot be
worked around, the second stops one row and says so.

Shape only, then, with the hole named rather than left to be discovered: a
`CHECK` that differs between copies shows up as rows that will not merge, not
as a document that will not open.

**T1-D22 — a copy that arrived from somebody else adopts a new replica
identity on first open.** A replica is per *copy*, not per document. Draft 1
§5.1 mints one on the first write to a replicated table and says nothing about
a file that already carries one — which is every file anybody ever sends.

Left alone, the recipient writes rows stamped with the sender's id. That is not
an attribution problem to tidy up later: both copies then allocate the same
`(replica, seq)` pairs independently, and the next exchange refuses one of them
with `ROW_REJECTED` — the code that means a row id was claimed twice with
different contents. **Two people using the document exactly as intended produce
a row rejected as tampering, and neither has done anything wrong.**

So on opening a copy this device did not write, the host mints a fresh replica
and moves the sender's id into `_dai_replicas`. Their rows stay theirs; nothing
already in the file changes hands. `seq` restarts at zero, because sequence
numbers are per replica and this one has issued none. The clock does **not**
restart: this copy has seen everything the file contains, so a row it writes
now happened after all of them, and a reset clock would sort that row below the
rows it was written in response to — which is what `_current` picks by.

Reopening your own copy is a no-op, so this is not "a new identity every
launch". The host knows which case it is: a document from its own library is
its own, and one that arrived as a file or a link is not.

**The same person opening their own file on a second device is also a new
replica, and that is the design rather than an oversight.** A replica is a
copy, and their phone and their laptop are two copies: each allocates sequence
numbers independently, and sharing an identity between them would produce
exactly the collision this decision exists to prevent — the same
`(replica, seq)` claimed twice, refused as tampering, by one person using two
of their own devices. They appear as two replicas in `_dai_replicas` and both
sets of rows are theirs.

Track 2 does not change this. A replica key derived from a synced passkey is
still per copy; what the key adds is proof that both replicas belong to the
same person, not permission to merge them into one. Anyone who files the
two-devices case as a bug should be shown this paragraph.

Found by an application author writing a fixture for two people playing
correspondence chess, against an implementation that had passed every
conformance vector. No vector covered it because every vector builds both
copies locally and never models a file *arriving* — the fixtures had no notion
of a recipient. Vector `merge-recipient-adopts-identity` closes that.

**T1-D16 — a refused row's parents supersede nothing.** T1-D13 keeps the rest
of the exchange when one row is refused, and says nothing about the refused
row's edges. They are dropped: the row is not in the set, so nothing it claims
about the set applies. Accepting its edges would let a row this copy refused to
hold still decide which rows are heads, which is the refusal doing half its job.

**T1-D17 — supersession is recomputed, not applied only to the rows just
inserted.** §6 says "apply the supersession rule over the rows just inserted",
which reads two ways. The normative one is the whole set: a row is superseded
if any row present names it, evaluated over everything the copy holds. T1-D2
makes the flag a function of the row set and T1-D10 makes it monotonic, so the
narrow reading is a permitted optimisation and never a different answer — but
only the wide one is the definition.

**T1-D18 — which tables are replicated is read from the manifest, and a bare
database is read structurally.** §3 puts the list in the signed manifest, which
is right for a document. A conformance fixture is two databases and no
manifest, so a reader given one takes any table carrying `_r_replica` and
`_r_seq` to be replicated. Stated because it was a guess a third implementation
had to make, and two readers guessing differently would disagree about what to
merge before disagreeing about anything interesting.

**T1-D19 — `first_seen` is the local clock before the merge advances it, and
`rows_seen` is unused at Level 1.** §6 inserts into `_dai_replicas` without
saying what goes in either column, and neither is in the dump (T1-D12), so two
implementations can disagree and both pass every vector. That is the worst
shape a gap can have, so: `first_seen` is `_dai_replica.lc` as it stood when
the merge began, and `rows_seen` stays 0 until something is specified to
maintain it. Neither is load-bearing; both are pinned so they cannot quietly
diverge.

## 9. Level 1 conformance vectors

From Draft 1 §13, minus everything that needs a key. `merge-conflict` is
restated: Draft 1 expected `T_current` to omit the entity, which 2.1.1
reverses.

| Vector | Expectation |
|---|---|
| `merge-disjoint` | Two replicas, disjoint entities. All rows added, 0 conflicts. |
| `merge-idempotent` | The same sibling merged twice. Second result `rowsAdded = 0`. |
| `merge-commutative` | A←B then A←C equals A←C then A←B, by the dump of T1-D9. |
| `merge-conflict` | Both replicas changed one entity from the same head. 1 conflict, both heads present, `T_current` shows the deterministic pick with `_r_conflicted = 1`. |
| `merge-resolve` | A row with both heads as parents. 0 conflicts, `T_current` shows it. |
| `merge-tombstone` | Delete on one side, no change on the other. Absent from `T_current`, present in `T_heads`. |
| `merge-tombstone-conflict` | Delete on one side, change on the other. 1 conflict; `T_current` shows the change (T1-D3). |
| `merge-unrelated-uuid` | Different `documentUuid`. Sibling test fails at step 1; no merge offered. |
| `merge-schema-behind` | Sibling one migration behind. Migrated in a scratch copy, then merged. |
| `merge-schema-ahead` | Sibling one migration ahead. `SCHEMA_AHEAD`. |
| `canonical-dump-real-edge-cases` | The REAL encoder over `-0.0`, `nan`, `inf`, `-inf` and a value needing 17 digits. **Runs before `merge-commutative`.** Note that SQLite cannot *store* NaN — it becomes NULL on insert — so that case is reachable only by calling the encoder directly, and the vector tests the encoder rather than a round trip. Positive zero prints `0.0`. |
| `heads-via-superseded-flag` | `T_heads` equals the set a full parents scan would produce, including for rows merged in child-before-parent order (T1-D2). |
| `current-conflict-deterministic-pick` | Identical `T_current` across both readers for a conflicted entity, including the same-replica tiebreak of T1-D6. |

The Python reader gains a `merge` subcommand implementing §6 from this text
alone. Both implementations must produce identical dumps for every vector.

**T1-D14 — at Level 1 a differing schema digest is refused, loudly.**
Draft 1 §9 sends a sibling that is one migration behind through the chain, in a
scratch copy, before merging. That needs migration semantics for replicated
tables which do not exist yet, and inventing them in a hurry to unblock the
wiring is how a format acquires a rule nobody meant.

So the interim rule is the conservative one: digests differ, `SCHEMA_MISMATCH`,
no merge. It is safe to tighten now and loosen later — the migration chain
turns some of these refusals into merges and never turns a merge into a
refusal, so nothing built against this rule breaks when it arrives. A document
refused today is refused with a message; a document merged today under invented
semantics is wrong quietly.

`merge-schema-behind` and `merge-schema-ahead` stay on the G1 list and are not
satisfied by this. They are the two vectors Track 1 closes last.

## 10. What Level 1 does not defend against

Stated plainly rather than left to be inferred from T1-D4, because it is the
kind of thing that reads as an oversight later.

At Level 1 a replica id is 16 random bytes a copy asserts about itself, and no
row carries a signature. So **any file claiming the document's UUID and
matching its schema digest can be offered as a sibling and merged**. It can
assert any replica id, any label, and any rows it likes. The person choosing
*Merge into my copy* is the only gate, and what they are told is where the file
came from — not who wrote the rows inside it.

This is not closed by being cleverer here. It is closed by Track 2, where the
replica key makes authorship a proof rather than a claim, and rows from an
unknown or mismatched key are refused rather than counted. Until then the
honest description of a Level 1 merge is: *these rows came from a file you
chose to merge.*

The sibling test of §7 raises the cost — a stranger needs the UUID and a
compatible schema — but it is a filter for accidents, not for adversaries.

**And union merge converges over undisputed rows only.** A row id claimed with
two different contents is disputed, and each copy keeps its own: neither can
accept the other's without abandoning a row it holds. Two such copies never
become the same, however many times they exchange.

That is a Level 1 property and the same weakness T1-D4 names, reached from the
other side. At Level 2 the boundary shrinks to nothing worth stating: the row
that fails to verify is refused and the one that verifies is kept, so the
dispute has an answer rather than two sides. Until then it is real, and
`merge-row-id-reused` pins it rather than describing it.

Non-convergent is not non-deterministic. Each copy's own state must be stable —
merging again changes nothing and the dispute does not grow — and the fixture
asserts that too.

## 10a. Refusal codes

Added to the bridge enum by Track 1. Each is refused **by name**, never as a
generic failure, for the reason the capability gate gives: "this could not be
merged" sends somebody looking for damage that is not there.

| code | when |
|---|---|
| `REPLICATION_SCHEMA_INVALID` | compile: reserved `_r_` prefix, an author's own primary key, or `AUTOINCREMENT` (§3) |
| `REPLICATED_TABLE_IMMUTABLE` | runtime: an `UPDATE` or `DELETE` against a replicated table (§4) |
| `ROW_REJECTED` | a row id already held with different content (T1-D13), or `_r_superseded` cleared (T1-D10) |
| `SCHEMA_MISMATCH` | merge: the two copies' replicated schemas differ (T1-D14, T1-D21) |
| `UNSUPPORTED_LEVEL` | merge: the sibling declares a level this reader does not implement |

`UNSUPPORTED_LEVEL` is `requires` at merge time and deserves the same
treatment. A Level 2 sibling merged as though it were Level 1 would have its
signatures unchecked while the person was told the merge succeeded — the same
silent degradation the capability gate refuses, arriving through a different
event.

**These names are immutable, as the capability names are.** If what a reader
must do to raise one changes, that is a new name and not a redefinition: a
refusal recorded in a host's log or shown on a card years ago says what it
meant when it was written, and there is no way for it to learn otherwise.

## 11. Not in Track 1

Replica keys and row signatures (Draft 1 §5.2, §7), `_dai_snapshots`,
`merge-level2-bad-sig`, `merge-replica-key-conflict`,
`REPLICA_SIGNING_UNAVAILABLE`, `REPLICA_KEY_CONFLICT` — all Track 2.
Real-time sync, compaction, cross-publisher forks and delta exchange remain out
of scope entirely; compaction is instrumented from the first build (rows and
bytes per document) so that the decision to build it is made against numbers.

### One rule Track 2 has to carry, measured before it was needed

When replica keys arrive they may be derived from a passkey's PRF output. A
measurement on 9 September 2026 found that Safari 18.3 driving the cross-device
QR flow completes the assertion and returns **no PRF at all** — where Chromium's
same flow, and Safari's own synced-keychain route, both return the value the
on-device route returns.

So the rule, written here because Track 2 is far enough away that a rule living
only in a plan is a rule that gets missed:

**An absent PRF means this route cannot derive a key. It must never mean derive
one another way.** A host that fails over to a freshly generated random key at
that moment mints a second replica for the same person and the same document,
and their earlier rows stay attributed to a replica that no longer answers.
That is the corruption the exclusion existed to prevent, arriving through the
door marked graceful degradation.

Two states, kept apart in the code:

- *PRF unavailable on this platform* — decided once, recorded as the key source,
  a random key generated and stored. A position.
- *PRF absent on this route* — a route failing mid-flow. The operation does not
  proceed on that route; another route is offered, or the person is told.

The first is a decision. The second is a failure, and it must not be allowed to
become the first by default. The measurement is bounded to Safari 18.3 /
AppleWebKit 605.1.15 and the browser behaviour may change; the rule does not
depend on it, and would hold even if no browser ever did this again.

**And the source recorded at first write is the source for that document on
that host, permanently.** PRF availability is consulted once, when the key is
created, and never again for a document that already has one.

This is the third door and the most dangerous, because it does not look like a
failure at all. A platform *gains* PRF — Safari updates, the OS changes, a
person moves from a browser without it to one with it — and a host that
consults availability on every launch sees a document whose key is `host-held`
sitting next to a PRF that now works. Upgrading it is the obvious, tidy,
well-intentioned move. It also mints a second replica for the same person and
the same document, and leaves everything they wrote before attributed to a
replica that no longer answers.

It is the same corruption as the divergent-value case and the same as the
fallback case, arriving through the door marked improvement. Nobody would ship
the first two on purpose; this one somebody ships as maintenance.

So availability is a question asked at creation. Afterwards the document's
recorded source is the answer, and a host that finds PRF newly available for a
document already keyed `host-held` does nothing at all.

If moving a document between key sources is ever wanted, it is an explicit
operation with a person behind it: re-sign under the new key, record the
succession so the old replica's rows keep their attribution and the new one
inherits it, and never do any of that because a capability appeared. That is
Track 2 work if it is wanted, and it is not wanted yet.

CTAP2 hardware keys are excluded and stay unmeasured. Nothing in the baseline
depends on them, they were already outside it, and a measurement nobody will
act on is a measurement not worth taking.
