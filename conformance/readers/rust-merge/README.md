# The independent reader

A Rust implementation of the merge at batch format version 2, built from
[docs/format.md](../../../docs/format.md) and the fixtures alone. It is the
independent reader: the only one of the three whose agreement is evidence
about the page. The runtime is the implementation, and the Python reader
(`conformance/reference`) is the reference reader, built with the runtime and
leveled in its commits; neither is independent evidence of the page.

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

The rule below was broken. Between 24 and 28 September, seven commits that
changed the runtime changed this reader in the same commit (`8536dc84`,
`f3dbd52a`, `95aa4c53`, `aaed42c3`, `873fadd3`, `1fbcd944`, `436a9725`), and
its placement, coverage and incomplete-header code came from them. Every level
since 29 September was blind, but each audited that code rather than rebuilding
it (branch review pass A, H3, 5 October). The paragraph above is kept as a
dated record of that.

On 7 October it was rebuilt from the page and the fixtures. The functions
written in those seven commits were gutted (`21337efe`), and the reader was
rebuilt blind (`f40d6c6e`, 122 of 122) and finished blind (`0529d43b`, 122
of 122, after the page answered the rebuild's one question, D197). Each
session was given only `docs/format.md`, `docs/replicated-tables.md`,
`conformance/merge/` and this crate, and was barred from the runtime, the
Python reader, the scripts, the other docs and git history. The function
signatures and doc comments were kept from the gutted version, so they are
not independent evidence; the bodies are.

On 8 October, `rejected` was ordered with the seq as a number, made blind
from [report-set](../../../docs/format.md#report-set) with the same four
inputs (`6fb9e1a4`, 123 of 123, D201).

The 7 October rebuild gutted `main.rs` only. `admit.rs` kept code from
`c5f1aa4a` (29 September), a commit that changed `src/replicated-rows.ts`,
`src/replicated.ts`, `admit.rs`, `main.rs` and `dai_merge.py` together, the
same pattern as the seven above, and missing from that list; it is added to
the dated record here (D202). On 9 October `admit.rs` was gutted too
(`3d71fff8`, 0 of 123) and rebuilt blind (`a338cd4d`, 123 of 123, no
questions), committed unedited. That session was given only
`docs/format.md`, `docs/replicated-tables.md`, `conformance/merge/` and this
crate (not `target/`), and was barred from the runtime, the Python reader,
the scripts, the other docs and git history. As with `main.rs`, the function
signatures, types and doc comments were kept from the gutted version, so
they are not independent evidence; the bodies are. With that, every function
body in the crate has been rebuilt blind.

## The one rule for changing it

**Changes come from docs/format.md and the fixtures. Never from reading the
runtime, the Python reader, or a commit that changes either.** A session that
changes the runtime does not change this reader; a blind session levels it
afterwards, citing the anchor behind each change.

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
