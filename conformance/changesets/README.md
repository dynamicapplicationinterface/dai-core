# Changeset vectors

The data of a document with no session policy (R-O, the ordinary data
interface) travels as signed changesets: each save's changes to the
application's ordinary tables are one row of `_cs_log`, a replicated table
the authorship layer admits like any other. These vectors fix how a reader
applies the admitted log to the application's tables (R-Q). The authorship
layer's own vectors are in [`../merge`](../merge).

## A vector

One directory per scenario, from the merge scenarios in
`tests/changesets/scenarios.ts`:

| Vector | Scenario | What it fixes |
|---|---|---|
| `different-rows` | S1 inserts | two authors' rows both land, each in its author's id range |
| `different-columns` | S2 columns | two columns of one row changed at once both land, unflagged |
| `same-column` | S3 same column | both values kept, the later by (lc, author) shown, the row `pending` |
| `delete-update` | S4 delete/update | the row kept with the update, flagged `delete-conflict` |
| `trigger-suppressed` | S8 app trigger | an application trigger does not fire again on merged rows |
| `key-moved` | K12 key moved | a key moved on one copy while the other edits the old key: both rows kept, the old key flagged `delete-conflict` |
| `returning` | D07 returning | a RETURNING statement stepped once and reset is logged whole, and applied once |
| `resolution` | RW-12 resolution | written by Build 1f, whose mechanism R-X retired: a write of the shown title, logged as an edit whose basis named both alternatives. Its outcome stands, resolved on both; a log of that shape still reads so |
| `respelled-key` | 1e-H3 respelled key | a key respelled under its NOCASE collation travels as a value change, beside the other copy's edit of another column |
| `form-echo` | R-X form echo | R-X's first assertion: over a coupled (qty, unit) pending between two copies, a form save writing the shown tuple back with a new note authors the note alone; the tuple stays pending |
| `explicit-keep` | R-X explicit keep | R-X's second assertion: the shown tuple kept by the kit's call, a resolution naming exactly the two alternatives shown; a third copy's tuple, carried in `b.db`, stays pending against it, whichever arrives first |
| `form-save` | 1f-H1 form save | a form save over a row pending on its title writes back the other copy's qty and note with `done`: `done` alone is authored, and the other copy's values stand as its own |
| `echo` | 1f-H1 echo | `SET qty = qty` on a row pending on its title authors nothing; a third copy's qty, carried in `b.db`, shows, and only the title is pending |
| `kept-released` | M05 kept, then released | a category kept for a row that refers to it, then the row moved out by the copy that deleted it: the delete stands on both, nothing flagged |
| `forged-basis` | R-X forged basis | a third copy's edit whose `bases` names a concurrent version it never saw, carried in `b.db`: refused by both readers, `basis-forged`, unapplied |
| `missing-basis` | R-X missing basis | a third copy's edit whose `bases` names nothing for the column it writes: refused, `basis-missing`, unapplied |

Each holds:

- `a.db`, `b.db`: the two copies as stored after each wrote concurrently, from
  one shared base. SQLite databases, signed by two authors under document
  `7d3e2c1b-4a59-4e6f-9a0b-c1d2e3f40516`.
- `verdicts.json`: `{"a": {...}, "b": {...}}`, each copy's batch headers by
  id with the verdict their signatures get (`ok`). A reader that verifies
  signatures itself must reach the same verdicts.
- `expected.json`: `{"scenario", "ab", "ba"}`. `ab` is what copy a holds after
  merging b and applying the admitted log; `ba` the other way. Each is
  `{"tables", "flags", "held"}`: every application table's rows in key order
  (a keyless table by rowid, with its rowid), `_cs_flag` as
  `[table, key, kind]`, and `_cs_held` as `[table, key]`.

## The payload

A `_cs_log` row's `payload` is CBOR:
`[1, [op, …], received]`, and each op is
`[table, key, code, new, old, bases, seen]`, or
`[table, key, code, new, old, bases, seen, resolves]` for a resolution:

- `key`: the row's key values, in key order (a keyless table: `[rowid]`); as
  JSON text, the row's id in `_cs_flag` and `_cs_held`;
- `code`: `"I"`, `"U"` or `"D"`;
- `new`: a map, column to value, of what this save wrote. Column `""` is the
  row's existence: 1 written, 0 deleted. A save writes a unit (a column, or
  a coupled group whole) only where its value changed from what it showed,
  or where it resolves it (R-X); writing a shown value back writes nothing;
- `old`: a map of the previous values the session recorded;
- `bases`: the operation's **basis**, a map from every column in `new` to
  the versions it was based on, which it supersedes. For an edit (`"U"`),
  the version the column's shown value came from, and no other: the other
  alternatives the copy held stay pending (R-X §3). For a birth, every
  current version of the column; for a delete, of its existence;
- `seen`: for a delete, the version each data column showed, and no other
  (1g-H1). A version it did not see (a pending loser, a proposal a
  constraint set aside) keeps the row, `delete-conflict`;
- `resolves`: present only on a **resolution** (R-X §4), made by the kit's
  explicit call. A map from each column of the unit resolved to the
  alternatives it explicitly accepted or rejected: exactly those the
  observation presented, never one that arrived after. It supersedes them
  too. Its `bases` is the version the resolved unit showed; its `new`, the
  chosen value, whole, though no byte changed. A resolution of `""` keeps a
  row a delete contested (1) or deletes it (0, with `seen`).

`received` is what the signer had received when it signed (1g-M1): a map
from each other author (hex) to the highest seq of theirs it had applied. A
copy applies one author's batches in their order, so that seq stands for
every batch of theirs it held. It is in the signed payload, so a signer
cannot widen it after.

A version is `<author hex>:<seq>`, the log row that carried it.

## The basis, checked

A reader takes `bases` and `resolves` from the signed payload, never from
its own projection, arrival order or flags, and refuses an admitted
changeset, unapplied, when an operation in it:

- **`basis-missing`**: has no `bases` map, or no list in it for a column in
  `new`;
- **`basis-forged`**: names, in `bases` or `resolves`, a version that is not
  a version of that cell (that table, row and column) from before it: one
  whose clock (`_r_lc`) is not lower than the changeset's own, one the reader
  already judged that wrote no such cell, or one the reader refused; or
  names, in `bases`, `resolves` or `seen`, a version the signer had not
  received: not its own from before (a lower seq), and above the seq
  `received` records for that author (a payload without `received` records
  none).
  Or is a resolution (a non-empty `resolves`) whose `resolves` does not name,
  for exactly the columns it writes, one and the same set of alternatives: a
  unit resolved in part (1g-L3);
- **`basis-unchanged`**: is an edit (`"U"`) that resolves nothing (no
  `resolves`, or an empty one) and whose every column holds, by value and
  storage class, the value of the one version its basis names. An honest
  runtime never signs one: an echo authors nothing, and a resolution names
  what it resolves (1g-L2). Judged once that version is here.

A version named that the reader has not admitted yet, with a lower clock,
is waited for: the changeset is applied, or refused, once it arrives. So
every reader judges a changeset alike whatever order batches came in. The
refused changesets are `_cs_refused` (version, reason), and in a vector's
`expected.json` they are `rejected`, `[version, reason]`; a vector written
before R-X has none.

## Applying it

The policy is the runtime's (`src/changesets.ts`, the header comment), and
the reference reader states it in Python
([`../reference/dai_changes.py`](../reference/dai_changes.py)), applying the
admitted log to emptied tables from the log alone:

- A cell's current versions are those no applied version names in its
  `bases` or `resolves`.
- A column with one current version shows it. With more than one, it shows
  the later by (lc, author), with the higher author id first on a clock tie,
  and the row is `pending`.
- Where a key can be spelled more than one way (a NOCASE or RTRIM key, or a
  key column with no type, where 1.0 is 1), the key's columns are registers
  too: a birth and a respelling write them, an edit of another column does
  not, and the row is written with their shown values. A log that carries
  none is written with its earliest-born version's spelling.
- A row is deleted when its existence holds only deletes, and every data
  version is one a delete saw. A delete with a concurrent change keeps the
  row, `delete-conflict`.
- A row whose merged values a CHECK or NOT NULL refuses, though each save
  was valid alone, is a constraint conflict (R-T): it shows the latest
  candidate the table admits, setting aside the newest versions first (by
  lc, author, version), each column such a version shows going back to the
  latest value before it, and the row is `pending`.
- A row a constraint will not admit otherwise is held (`held`). For UNIQUE,
  the earlier-born row keeps the slot.
- A deleted row a live row still references is kept, `kept-referenced`.
- A save is one effect group (R-T): where a row a save wrote is `pending`
  (every version a same-column conflict names, the proposals a constraint
  conflict set aside) or held, every other row where that save's change is
  still current is `pending` too.

## Running

```
python conformance/reference/dai_changes.py --vectors conformance/changesets
```

`tests/changesets/vectors.spec.ts` runs the runtime and this reader over the
committed files. The bytes are signed with fresh keys, so the vectors are
written once and committed, never rewritten by a check; the writer skips a
vector already on disk:

```
DAI_WRITE_CHANGESET_VECTORS=1 npx playwright test tests/changesets/vectors.spec.ts --project=node
```

The Rust reader reads them before Gate C (R-Q).
