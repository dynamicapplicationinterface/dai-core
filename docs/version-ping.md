# The version ping — design, for agreement

One mechanism for V1's steps 4 and 5: a copy tells the relay which version it
holds, and the relay answers whether there is a successor under that publisher
key. The count falls out of the same request. Nothing here is built.

Ruled already, and assumed throughout: an update changes the author's part and
never the person's rows; taking it is the person's choice and their data stays
either way; succession is the only update (D85); the relay learns document id,
version and publisher key and nothing else; an author's message travels with an
update and is never a push the author chose (D45).

---

## What a copy sends

```
POST /v/<publisher fingerprint>
content-type: application/json

{ "document": "<documentUuid>", "version": "<build digest>" }
```

Three facts, and the route carries the first of them. No replica id, no cursor,
no mailbox address, no count of anything local, no name.

**When.** On open, and at most once per document per 24 hours, held in the
library record. Never on a timer, never in the background, never from the
service worker: a copy that is not being used does not speak.

**What "version" is.** There is no version field in the format today — the
manifest carries `manifestVersion` (the format's), `documentUuid`, `appName`,
`supersedes` and the signed entries, and nothing an author bumps. So the build
digest is **the SHA-256 of the manifest's signed entries**, which exists now,
changes exactly when the author's files change, and does not move when the
person writes a row (the data is not in the signed set). No format change, and
older readers are unaffected.

Its one weakness, stated: a digest has no order. A copy cannot tell whether the
relay's answer is newer than what it holds — only that it differs. What makes
the answer trustworthy is the successor's signature under the pinned key, which
is the same check succession already makes (`main.ts:3610`), not the relay's
word.

**What the relay sees anyway.** The IP address and whatever the transport
carries. It is not stored, and a ping is one request with no cookie and no
identifier, but "the relay cannot know who" is false and should not be claimed:
a document id repeatedly seen from one address is a correlation the relay's
operator could make if they kept logs. The honest claim is that nothing in the
request identifies a person or a copy, and nothing is kept beyond the counters
below.

## What the relay stores, per publisher

One Durable Object per publisher fingerprint (`idFromName(fingerprint)`), the
same shape as one per mailbox today.

| Key | What | Written by |
|---|---|---|
| `current:<documentUuid>` | `{ version, successor, published }` — the newest build the author has announced for that document | the author's announcement |
| `count:<version>:<day>` | an integer: check-ins for that version on that UTC day | each ping |

**How the author announces.** A signed announcement, verified by the relay
before it is stored:

```
POST /v/<publisher fingerprint>/announce
{ "document": "<uuid>", "version": "<digest>", "successor": "<address>",
  "changed": "<one sentence>", "signature": "<COSE-ES256 over the above>" }
```

The relay verifies the signature against the fingerprint in the route — ES256,
the same curve it already signs VAPID with, so no new primitive. It means the
relay cannot invent a successor, and nobody without the publisher's key can
announce one. The relay is a noticeboard whose entries it cannot forge.

**What the count can and cannot be.** The relay cannot count copies: nothing in
a ping distinguishes one copy from another, by design, so it counts *check-ins*.
The copy's own once-a-day limit is what makes the number mean something —
"check-ins today" is a floor on copies used today, and nothing more. It must be
reported as that. A count that is quietly described as "installs" is the badge
mistake in another costume.

## What the relay answers

```
200 { "current": "<digest>", "successor": "<address>|null",
      "changed": "<one sentence>|null" }
```

When `current` equals what the copy sent, the copy does nothing and the person
sees nothing. When it differs and a successor is offered, the copy fetches it,
verifies the signature against the key it already pinned for this document, and
**only then** shows the card. An unsigned successor, or one under a different
key, is refused the way succession already refuses it — the person is told, and
their copy keeps working.

When the relay does not answer, or the request fails, nothing happens at all.
There is no retry loop and no queue: the next open asks again.

## A copy that has never pinged

Offline for a month, or never online, is the ordinary case and not an error:

- the ping fails, silently, and the app opens exactly as it does today;
- nothing is queued; the next open tries once;
- the person is never told the ping failed, because a failed check for an update
  that may not exist is not news;
- the copy is never counted, and the count is a floor for that reason;
- **nothing about the document degrades.** A copy that never reaches the relay
  again works forever, which is the property the whole format exists for, and
  an update mechanism that quietly made it false would be the wrong mechanism.

## What the person sees, on next open

A card, once, for that successor. Three things, in the ruling's order:

> **A new version of Beach trip**
> *What changed:* the exercise list has 40 more movements.
> Your entries are kept — this adds the author's part and touches nothing you
> have written.
> **Update** · **Not now**

- **Not now** is not a deferral with a timer. The card does not come back until
  the next open, and taking the update is never automatic.
- If it cannot carry the rows forward, the card does not offer the update at
  all: it says why, in one sentence, and the version they have keeps working —
  which is what `tests/succession.spec.ts` already proves the machinery does.
- The author's sentence is theirs, shown as theirs, and it is the only thing in
  the card the author writes.

## Cost per ping on Workers

Per ping: one Worker request, one Durable Object request, and a few milliseconds
of object time.

| | Rate (Cloudflare, published) | Per million pings |
|---|---|---|
| Worker requests | 10M/month included, then **$0.30/million** | $0.30 |
| DO requests | 1M/month included, then **$0.15/million** | $0.15 |
| DO duration | 400,000 GB-s/month included, then **$12.50/million GB-s** | ~$0.03 at ~0.002 GB-s each |
| | | **≈ $0.48 per million** |

At V1's scale this is nothing: 200 copies checking in once a day is 6,000
requests a month, inside the free plan's 100,000 per day and far inside every
included allowance. A million daily check-ins would be about $15 a month. The
cost that matters at V1 is not money.

## What needs agreement before anything is built

1. **The build digest as the version.** It needs no format change and does not
   move when data does, but it carries no order and no name a person could read.
   The alternative is a signed `version` field, which is a `manifestVersion`
   bump that every deployed reader refuses by name.
2. **Where the successor's address points, and what it carries.** A store link's
   key lives in its fragment and never reaches a server. An announcement that
   includes a fetchable address hands the relay the means to read the successor
   — which is the author's public app, so the loss may be nil, but it is a
   deliberate departure from "the relay cannot read what it holds" and should be
   agreed rather than assumed.
3. **Whether the count is per version or per document.** Per version answers
   "did the update reach anyone"; per document answers "is this app used". The
   table above can hold either and the ping carries both, so this is a decision
   about what the relay is allowed to keep, not about the wire.
4. **One publisher object, or one per document.** Per publisher makes the
   counts trivially readable and puts every document by one author in one
   object; per document keeps the blast radius smaller and matches the mailbox
   shape. This affects what a busy author's object has to serialize.
