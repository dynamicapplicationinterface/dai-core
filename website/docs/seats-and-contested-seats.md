---
title: Seats and contested seats
---

# Seats and contested seats

A session is a closed group, and the question it has to answer without a server
is who is in it. This page is how it answers, and what that means for an
application. The rules themselves are under
[Sessions](/docs/constraints#topic-session).

## Seats and bindings

The creator declares the seats once, in the row that starts the session: one
for itself and `max_parties - 1` open seats, with the session's close rule. The
session's id is a hash of that row, so no seat is added, reordered or replaced
later. A person asks for an open seat by **binding** it from their own copy,
and the creator's copy **confirms** them in it. All of these are ordinary shared
rows, so they travel and merge like everything else.

A copy is a **member** of a session when the creator's copy has confirmed it in
a seat and in no way that makes the seat void. Only members' rows are read: the
`_current` views of a session document show admitted rows and nothing else.

## Why a seat two copies ask for admits neither

An invite is a link, and a link can be forwarded or opened on two devices. If
two copies ask for the same seat, something has to decide which one is in — and
with no server, the only thing that could decide is which asked first, which
means trusting clocks that two phones do not share. So neither is seated. The
seat is **contested**, and since no seat is ever replaced, the repair is a new
session: the creator's copy closes the contested one, starts another, and says
so, and the person they meant to play opens the new invite.

That is why an application shows the contested state rather than treating it as
an error: it is the honest answer to a question the protocol refuses to guess
at.

## Joining is an act, not an arrival

A copy binds a seat when a person opens an invite — a file or a link — never
because rows arrived in the background. Otherwise a copy that lost a contest
would quietly ask for a seat in the new session the moment it arrived by
mailbox, and contest it again. `dai:merged` says which kind of arrival it was
(`via`), and the application joins only on `"carrier"`.

## Closing on what was seen

Closing a session records, for every copy the closer has seen, the last row it
had seen from that copy. Rows written later than that are not admitted. It is a
statement of what the closer knew, not a time — the same refusal to trust a
clock.

## An invite is one session

An invite made with `requestShare(session)` carries that session and nothing
else: the other sessions in the document stay on the sender's device, and so
do the sender's local tables. The recipient's copy holds one game, and the
session to join is the one with an open seat it did not create. The host's own
menu share is different — it cannot know which game is meant, so it sends the
whole document and says so.

The design record for all of this is in
[`docs/replicated-tables.md`](https://github.com/dynamicapplicationinterface/dai-core/blob/main/docs/replicated-tables.md),
decisions T1-D26 to T1-D34.
