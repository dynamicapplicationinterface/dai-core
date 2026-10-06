# The reference reader

`dai_merge.py` is the reference reader of batch format version 2
([docs/format.md](../../docs/format.md)), in Python, with the standard library
alone.

```
python conformance/reference/dai_merge.py            # every vector, both directions
python conformance/reference/dai_merge.py <name> ... # these vectors
```

It reads the checked-in vectors in `conformance/merge`, performs its own merge
in both directions, and diffs its own canonical dump, counts, refusals and
admitted state against the expected text beside them. It never reads the
generator's output at run time.

It is built with the runtime, not apart from it. It is leveled in the same
commits that change the runtime's merge, by the sessions that change it, and
its structure mirrors the runtime's in places (the two-pass roster, where
`AUTHOR_EQUIVOCATED` is filed). So its agreement with the runtime is a second
implementation of one reading of the page, written to the page's words in
another language, and catches what a second language catches: a value
printed differently, a set iterated in another order, a rule implemented only
in SQL. It is not independent evidence that the page says what the runtime
does. That is the Rust reader's job (`conformance/readers/rust-merge`), which
is built from the page alone.

What it is for besides the vectors:

- `scripts/holdout.py` removes one rule at a time from a copy of it, by exact
  text replacement, to show that each vector has teeth;
- `scripts/properties.py` runs it over the property pass's scenarios
  (`scripts/properties.mjs`), so P0 to P2 are checked by two implementations.

`dai_read.py` and `run.py` are the container's reader and its suite, not the
merge's; what is said here is about `dai_merge.py` alone.
