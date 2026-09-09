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
           WHERE x._r_entity = h._r_entity AND x._r_deleted = 0) > 1
           AS _r_conflicted
  FROM T_heads h
  WHERE h._r_deleted = 0
    AND h._r_seq = (
      SELECT y._r_seq FROM T_heads y
       WHERE y._r_entity = h._r_entity AND y._r_deleted = 0
       ORDER BY y._r_lc DESC, hex(y._r_replica) ASC, y._r_seq ASC
       LIMIT 1)
    AND h._r_replica = (
      SELECT y._r_replica FROM T_heads y
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
4. Schema digest equal, or reachable through the migration chain — otherwise
   `SCHEMA_INCOMPATIBLE`; a sibling *ahead* of the local application is
   `SCHEMA_AHEAD`.
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

**T1-D3 — a delete/change conflict shows the change, not the tombstone.**
2.1.1 says `T_current` picks the highest `_r_lc` head and never omits the
entity; it does not say what happens when the winning head is a tombstone.
`T_current` therefore picks among **non-deleted** heads, and an entity with any
live head is shown with `_r_conflicted = 1`. The alternative — letting a
tombstone win on clock order — deletes somebody's edit silently, which is the
exact failure 2.1.1's no-omission rule exists to prevent. The tombstone is not
lost: it is in `T_heads` and the entity is in `T_conflicts`, and resolution is
the app writing a row with both parents. An entity all of whose heads are
tombstones is deleted and absent from `T_current`, which is not an omission but
an answer.

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

**T1-D9 — "identical tables" in the G1 vectors means a canonical dump, not
identical files.** SQLite file bytes depend on page allocation and insertion
order, so two hosts that converge correctly can hold different files. The
comparison is a text dump of every replicated table plus `_dai_replicas`,
rows sorted by `(hex(_r_replica), _r_seq)`, columns in declared order, blobs as
lowercase hex. The Python reader's `merge` subcommand emits exactly this, and
so does the TypeScript side.

**T1-D10 — the update trigger is column-scoped.** Draft 1's blanket
`BEFORE UPDATE` would forbid the very write D5 requires. The trigger names the
immutable columns instead, leaving `_r_superseded` writable, and the author's
own columns are covered by the rule that applications never write `_r_*` and by
the kit's refusal to emit `UPDATE` against a replicated table.

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
| `heads-via-superseded-flag` | `T_heads` equals the set a full parents scan would produce, including for rows merged in child-before-parent order (T1-D2). |
| `current-conflict-deterministic-pick` | Identical `T_current` across both readers for a conflicted entity, including the same-replica tiebreak of T1-D6. |

The Python reader gains a `merge` subcommand implementing §6 from this text
alone. Both implementations must produce identical dumps for every vector.

## 10. Not in Track 1

Replica keys and row signatures (Draft 1 §5.2, §7), `_dai_snapshots`,
`merge-level2-bad-sig`, `merge-replica-key-conflict`,
`REPLICA_SIGNING_UNAVAILABLE`, `REPLICA_KEY_CONFLICT` — all Track 2.
Real-time sync, compaction, cross-publisher forks and delta exchange remain out
of scope entirely; compaction is instrumented from the first build (rows and
bytes per document) so that the decision to build it is made against numbers.
