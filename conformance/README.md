# The conformance suite

Containers with verdicts stated in advance, so that an implementation can be
checked against the format rather than against ours.

A specification with one implementation is a description of that implementation.
This is the thing that makes a second one possible: fifteen files, each carrying
a defect or none, and a record of what any conforming reader must conclude about
each. If your reader and ours disagree about one of these, one of us is wrong —
and it is a question with an answer, which is the whole point.

## What is here

| | |
|---|---|
| `cases.json` | Every case: the file, which form it is, what it is, and the verdict |
| `cases/` | The containers themselves |
| `signing-key.pem` | The key the signed cases were signed with |

The key is committed on purpose. It signs documents that exist to be checked;
publishing it is what lets anyone rebuild the suite. Do not use it for anything
else, and do not treat a container signed by it as trustworthy — it is trusted
by nobody, which is exactly its job.

## Running it

For each case, parse the file, then decide two things: whether a host may run it
(`expect.mount`), and why (the report fields). A case with `expect.parses: false`
is not a container at all and must be refused before any check runs.

```
for each case in cases.json:
    bytes   = read(case.file)
    verdict = your_reader(bytes)

    assert verdict.may_run == case.expect.mount
    assert verdict.reasons  match case.expect
```

The report fields are named after §7 of [the specification](../docs/spec-v0.2.md):

- `entries.mismatched` — files whose digest disagrees with the manifest
- `entries.missing` — files the manifest lists that are not there
- `entries.unlisted` — files that are there and the manifest does not list
- `shell` — `ok` or `mismatch`, the outer document against its sealed copy
- `signature` — `valid`, `invalid`, `unsigned`, or `unverifiable`
- `expiry` — `none`, `current`, or `expired`
- `sections` — sectioned form only: section digests, required sections, and
  whether the footer describes the database the file carries

`mount` is not derived from the others. It is the answer to the only question a
host asks, and an implementation that reports every defect correctly and then
runs the file anyway has failed the case.

## Rebuilding

```
npm run build && node scripts/build-conformance.mjs
```

The expectations in the generator are written from the specification by hand.
The script builds each case, runs our reader over it, and **refuses to write the
suite if the two disagree**. A suite recorded from our own output would agree
with us by construction and would prove nothing; this way, a reader that drifts
away from the specification cannot publish a suite that excuses it.

That check has already earned its place. A case meant to damage the payload
section flipped a byte at a guessed offset which landed in the manifest instead
— the file was a valid case for a defect nobody had described, under a name that
claimed something else. The expectation was written first, so the generator
caught it.

## What it does not cover

Isolation. Every case here is about what a reader concludes from a file, and
none of it is about what happens once an application runs — the sandbox flags,
the policy, the loader. Those are properties of a host, they need a browser to
observe, and a file cannot carry a verdict about them. §4 of the specification
states the requirements; checking them is a separate suite that does not exist
yet.

Saving, likewise. `generation` advancing and the manifest surviving a save are
host behaviours, tested in this repository against the Rust writer.
