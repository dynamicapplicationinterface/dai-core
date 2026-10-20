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
| `resolution` | RW-12 resolution | a write of the value a pending row shows, though no byte changed, is a new version superseding what its copy saw: resolved on both |
| `respelled-key` | 1e-H3 respelled key | a key respelled under its NOCASE collation travels as a value change, beside the other copy's edit of another column |

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
`[1, [op, …]]`, and each op is
`[table, key, code, new, old, bases, seen]`:

- `key`: the row's key values, in key order (a keyless table: `[rowid]`); as
  JSON text, the row's id in `_cs_flag` and `_cs_held`;
- `code`: `"I"`, `"U"` or `"D"`;
- `new`: a map, column to value, of what this save wrote. Column `""` is the
  row's existence: 1 written, 0 deleted;
- `old`: a map of the previous values the session recorded;
- `bases`: a map, column to the versions this save saw and so supersedes;
- `seen`: for a delete, every data version it saw.

A version is `<author hex>:<seq>`, the log row that carried it.

## Applying it

The policy is the runtime's (`src/changesets.ts`, the header comment), and
the reference reader states it in Python
([`../reference/dai_changes.py`](../reference/dai_changes.py)), applying the
admitted log to emptied tables from the log alone:

- A cell's current versions are those no other version names in its bases.
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
