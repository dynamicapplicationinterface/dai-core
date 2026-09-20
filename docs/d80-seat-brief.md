# D80: what a seat could be bound to — a brief for the sitting

Facts only, each read in the code or run today. No recommendation.

**The defect.** A row's author is `_r_replica`, set by the writing copy and
admitted as written. Batches are sealed with AES-GCM under a key both copies
hold (`sealBatch`), and **no row is signed** — nothing in a batch could only
have come from one copy. A copy writing under the other's replica id *is* the
other player, everywhere. Proved in `mailbox-link-e2e` ("D80: a copy running
under the creator's id…").

## Every identity that exists today

| What | Where | Wipe | Reinstall | Crosses devices |
|---|---|---|---|---|
| Replica id (`_dai_replica`, plus the host's `replica:<uuid>` record) | in the document's database and IndexedDB | lost | lost (new id) | no — it names a copy |
| Document key (`k`) | the link's fragment; `MailboxRecord.key` | restored by the link | restored by the link | yes, by the link |
| Session key | derived: `hkdf(documentKey, "dai:mailbox:key:" ‖ sessionId)` | derived | derived | yes |
| Mailbox address | derived likewise (`…:id:`); the relay sees only this | derived | derived | yes |
| Seat and binding rows | replicated rows in the document | with the document | with the document | yes |
| Push subscription | the browser's push manager, per mailbox scope | lost | lost | no |
| VAPID pair | the relay's config; public half reaches the opener | n/a | n/a | n/a |
| Publisher signing key | the author's machine at build; public half in the manifest | n/a | n/a | identifies the app's author, never a player |

**Nothing here identifies a person.** The replica id is per copy; the keys are
per document or per game and both players hold them.

## What a seat could be bound to

Frozen surfaces any change would touch, each with a wire test: `FRAME_PUBLIC`,
`FRAGMENT_KEYS`, the mailbox labels, the bridge names, the batch encoding.

**(a) The replica id — today.** Introduces nothing; wire unchanged. Lost
device: the owner cannot take the seat back; only a creator's reseat replaces
it (D48). Safari then install: a second copy binds the same seat, both
contested (D81). Handing over: no mechanism. Creator who lost storage: no
longer the creator, because `close=creator` and reseat read the seat rows'
author. And any copy can write as any player (D80).

**(b) A key pair per copy, rows signed.** Introduces a key pair at mount, its
public half in a roster row, a signature per row. Wire: the batch encoding
gains a signature — every conformance vector changes — and the merge gains
verification. Lost device: still impossible, the key died with the storage.
Safari then install: still a second copy. Handing over: still nothing. Creator
who lost storage: still not the creator. It fixes D80 alone.

**(c) A key pair per person, carried between devices.** Introduces the
key-holder identity three backlog items already block on: how it is made, where
it is kept, how it reaches a second device. Wire: as (b), and the roster names
people, not copies. Lost device: recoverable for the first time. Safari then
install: the seat follows the person, if the identity reaches that storage.
Handing over: becomes a transfer. Creator who lost storage: recovers the role.

**(d) A per-seat secret in the invite.** Introduces a secret minted at invite,
carried in the fragment, proved in each row. Wire: a new fragment field
(`src/fragment.ts` refuses a collision) and a proof in the batch. Lost device:
works only if the person still has the invite. Safari then install: works, by
opening the same link — which is what people do. Handing over: forwarding the
link hands over the seat, the contest the roster guards today. Creator who lost
storage: unchanged.

**(e) Bound to nothing.** Introduces nothing; withdraws `author=creator` /
`author=joiner`, its refusal code and D15's guarantee. No write is refused on
identity, so the four cases stop being about seats.

## What D82 needs from the same design

A copy can accept a row, show it, and lose it when others arrive — late after a
close, from a contested seat, from a party not admitted. The merge reports
`{ applied, duplicate, rejected, newReplicas }`, where `rejected` names rows
that *arrived* and were refused. **Nothing names a row this copy authored and no
longer holds**, so no application can say "what you did did not survive". The
same change must decide how a copy learns its own row was dropped, who says it
(runtime or application), and what is said about a refused seat — which is
D81's sentence and D48's way back in.

**Already decided, not for reopening:** a key belongs to the game, carried by
the invite (D37); roles are the two session roles per table (D15) — the half
that cannot hold today; an invite carries one session; seats are read from the
rows, never a stored column.
