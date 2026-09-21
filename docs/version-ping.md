# The version ping — design

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
POST /v/<documentUuid>
content-type: application/json

{ "version": "<build digest>", "publisher": "<fingerprint>" }
```

Three facts, and the route carries the first of them. No replica id, no cursor,
no mailbox address, no count of anything local, no name.

The publisher key is sent so the answer can be refused when it does not match
the one this copy already trusts — the copy checks the successor's signature
itself either way, and this only saves it fetching something it would reject.

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

One Durable Object **per document** (`idFromName(documentUuid)`), the same shape
as the mailbox. The publisher key is in the route and is checked against the
announcement's signature; it is not what names the object.

| Key | What | Written by |
|---|---|---|
| `current` | `{ version, label, note, successor, publisher, published }` — the newest build this document's author has announced | the author's announcement |
| `count:<version>:<day>` | check-ins for that version on that UTC day | each ping |
| `count:<day>` | check-ins for the document that day, whatever version | each ping |

**How the author announces.** A signed announcement, verified by the relay
before it is stored:

```
POST /v/<documentUuid>/announce
{ "document": "<uuid>", "version": "<digest>", "label": "<the author's name for it>",
  "note": "<one sentence, the author's words>", "successor": "<full address>",
  "publisher": "<fingerprint>", "signature": "<COSE-ES256 over the above>" }
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
200 { "current": "<digest>|null", "label": "<the author's name for it>|null",
      "note": "<the author's sentence>|null", "successor": "<full address>|null" }
```

The label and the note are the author's words and travel unchanged. The card
shows them; nothing compares them.

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

## Ruled, 21 September

1. **The build digest is the version**, as above. Because a digest carries
   nothing a person could read, the announcement carries a **label** — the
   author's own name for the version — and the **note** beside it. The label is
   what the card shows; the digest is what the machinery compares. Neither the
   label nor the note is ever compared, matched or ordered: they are the
   author's words, shown as the author's words.
2. **The announcement carries the successor's full address**, key and all. The
   relay can therefore fetch and read the successor — and the sentence that
   draws the line is this: **the relay holds what the author published, never
   what a person wrote.** An author's build is made to be handed to strangers;
   a person's rows never leave their device except in a link they make
   themselves. The relay is on the first side of that line and must never be on
   the second, which is why an announcement is the only thing it stores that
   has an address in it.
3. **The count is kept per version and per document.** Per version answers "did
   the update reach anyone"; per document answers "is this app used". Both are
   check-ins, never copies; neither is ever reported as installs.
4. **One relay object per document**, matching the mailbox. A busy author does
   not serialize every reader of every document they have published through one
   object.
