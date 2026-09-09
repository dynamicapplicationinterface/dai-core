# A third reader

A Rust implementation of the Level 1 union merge, kept here as a third
participant the conformance gate runs.

```
cargo run --release -- ../../merge
```

It reads the fixtures in `conformance/merge`, performs its own merge in both
directions, and diffs its own canonical dump and counts against the checked-in
expected text.

## Why it exists

Two implementations written by one person agree partly because they were
written by one person. This one was produced by a session given the
specification, the capability registry and the fixtures, and nothing else —
explicitly barred from reading either existing reader. It passed all eight
vectors on its first run, which is evidence about the *specification* rather
than about the code: the merge algorithm was described well enough to build
blind.

It also earned its keep immediately. It followed a sentence in
`docs/replicated-tables.md` that both existing readers had not — a label is a
name a copy gives a key and never one the key carries — and was therefore
correct where they were both wrong, in the same way, for the same reason: they
were written by someone who remembered the intent and skipped the sentence.

This is not the independent reader the specification's R1 asks for; that one
verifies containers, and this one only merges rows. It is the seed of one, and
until an outside participant arrives it is the closest thing to an outside
opinion this project has.

## The one rule for changing it

**Changes come from the specification text and the fixtures. Never from reading
the TypeScript or Python readers.**

The moment this is edited to match what another reader does, it stops being
evidence and becomes a copy with a different syntax — and the gate it feeds
stops meaning anything. If it disagrees with the others, the question to ask is
which of the three the specification actually describes. Twice already the
answer has been "none of them, the specification is silent", and the fix was to
say something in the specification rather than to change any reader.

If a change here cannot cite a section or a numbered decision, that is a gap in
the document, not a licence to guess.

## Findings it produced

Recorded because they are the reason it is kept, and because a future reader of
this directory should know what a third implementation is *for*:

- The dump's framing — section headers, the shape of the `_dai_replicas` lines,
  table order, replica order, the trailing newline — was carried entirely by the
  fixtures and stated nowhere. Now T1-D9.
- The merge result's four field names were defined only by `result.json`. Now
  T1-D15.
- Four properties were unobservable through the dump, so two implementations
  could disagree and both pass. Now T1-D16 through T1-D19.
- Two structural claims it made did not survive testing: that the `T_current`
  view admitted a non-winner (the primary key forbids it — 729 configurations
  agree), and that uppercase and lowercase hex sort differently (the mapping is
  order-preserving). Both are now stated in the document so the next reader does
  not spend an afternoon on them.
