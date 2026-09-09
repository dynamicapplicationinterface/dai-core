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
| `countersign-key.pem` | The second key, for the countersignature cases |
| `trust-publisher-a-key.pem`, `trust-publisher-b-key.pem` | Two stand-in publishers, for the trust vectors only |

Every key here is committed on purpose. They sign documents that exist to be
checked, and publishing them is what lets anyone rebuild the suite and get the
same bytes.

**`signing-key.pem` and `countersign-key.pem` are declared test keys.** They are
listed by public key in `src/test-keys.ts`, and that has two consequences a
reader of this suite has to implement:

- **A host must label a container signed with one.** Not "signed", not a
  publisher name, and never pinned as a publisher: everybody has this key, so
  the signature proves only that whoever built the container had a file out of
  this repository. That is evidence-shaped and is not evidence, which makes it
  more dangerous than no signature at all. The state is `test-key` and the
  words are "treat as unsigned".
- **A writer must refuse to sign with one**, unless it is explicitly told
  otherwise — `--allow-test-key` on the command line, `allowTestKey` in the
  API. The suite's own generator passes it, and nothing else should.

**The two `trust-publisher-*` keys are not declared test keys**, deliberately.
The trust vectors exercise known / new / conflict, which is a question about
publisher keys — and a key every reader is required to report as a test key
could not play that part. They stand in for two publishers in those vectors and
are for nothing else.

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

## The reference reader

`reference/dai_read.py` is a second implementation: a reader in another
language, sharing no code with the one that wrote these cases, written from
[the specification](../docs/spec-v0.2.md) rather than from the TypeScript.

```
python conformance/reference/run.py
```

It exists to test the document. Everything else here shares one reader, so
"the format is portable" rested on the claim that the specification describes
what the code does — a claim nobody had tried to act on. Writing this is the
experiment that could falsify it, and did: on its first run it refused all ten
viewer-form containers. It was right to. §7 said an unlisted entry is as much a
failure as a modified one and named no exceptions, and there are two — the
database and the manifest itself. Every valid container has them.

Three more followed: the payload element was never named, the placeholder
substitution the shell comparison depends on was never described, and the
payload's field list never said that an absent optional field is signed as an
empty string. All four are now in the document, and marked in the Python where
they bit, so a future rewrite has a list of what it must not drop again.

It is deliberately stdlib-only, including the P-256 arithmetic. A reader that
needs a package installed proves the format is portable to environments that
have that package.

It reads. It does not run a container, save one, or write one — a second host
is a larger claim than a second reader, and this does not make it.

## The isolation probe

`isolation-probe.dai.html` is a different kind of artifact, for a different kind
of requirement. §7 can be checked from a file — a container carries its defect
and its verdict. §4 cannot. Whether the application runs at an opaque origin,
whether it can open a socket, whether an inline script it injects executes: none
of that is a property of the file. It is a property of the host, and the only
way to find out is to be inside one and try.

So the probe attacks the host running it and reports what got through. Open it
in your host. Every row must read **blocked**; a row reading **allowed** names a
boundary that is not there. It also posts the same results to the shell as
`dai:isolation-report`, for a harness running it without a person watching.

Nine checks: the opaque origin and the unreachable shell (§4.1), popups,
`connect-src`, sockets, `eval`, an injected inline script, an inline event
handler (§4.2), and the storage stand-in (§6).

**Violations, not failures.** "The fetch failed" proves nothing — a fetch fails
on an aircraft, with the network off, and against a host that blocks nothing, in
exactly the same way. The probe requires a `securitypolicyviolation` event
naming the directive, which fires only when the policy is what stopped it. A
check that could not tell a real boundary from a missing network would pass
everywhere and mean nothing.

The probe is run against this project's shell on three engines, and — because a
probe that reports "blocked" everywhere is worthless until it has been shown to
report otherwise — against a deliberately permissive host that grants
`allow-same-origin` and carries no policy. It must fail that one.

## A class of disagreement fixtures miss on their own

Worth naming, because it stayed invisible here for months and was found by
accident.

A fixture compares what two readers do with an input. It cannot compare what
they do *before* they reach that input — whether they agree the input is one
they should be reading at all. The merge suite is the example: every vector
held two readers to the same rows, and nothing held them to the same answer
about whether those two copies were allowed to merge in the first place. The
mergeability test lived in each reader's own code, was never compared, and two
readers could have disagreed about it while agreeing about every row they were
given.

That is the worse of the two disagreements. A disagreement about the answer
surfaces the moment anybody runs the suite. A disagreement about whether to
compute an answer never surfaces at all, because the inputs that would expose
it are the ones one reader declines to process.

So: whenever a reader has a *gate* — a check that decides whether to proceed —
that gate needs a fixture of its own, shipping the value the gate is computed
from rather than the outcome of passing it. `schema-digest-replicated-only`
does this: it ships the canonical schema text, not merely a pair of copies that
happen to merge. The rule for the next one is to notice the gate and give it a
vector on sight, rather than waiting for two implementations to differ.

## What it does not cover

Saving. `generation` advancing and the manifest surviving a save are host
behaviours, tested in this repository against the Rust writer.

Residual channels named in §4.2 — DNS prefetch, speculation rules, WebRTC.
`connect-src` does not govern them, a page cannot reliably observe them, and a
browser-based host cannot close them. They are documented as residual rather
than checked, which is the honest position and not a comfortable one.
