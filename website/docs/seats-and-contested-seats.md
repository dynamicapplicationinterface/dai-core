---
title: Seats and contested seats
---

# Seats and contested seats

A session is a closed group, and the question it has to answer without a server
is who is in it. This page is how it answers, and what that means for an
application. The rules themselves are under
[Sessions](/docs/constraints#topic-session).

## Seats and bindings

The creator mints the seats: one for itself and one open seat. A person joins
by **binding** the open seat from their own copy. Both are ordinary shared rows,
so they travel and merge like everything else.

Today that is the whole roster: `session.create()` mints exactly two seats, and
no call mints another, so a session seats two people whatever `max_parties`
declares. The profile's number is enforced as a ceiling — a document holding
more seats than it is refused — but nothing yet fills seats beyond the second.
A group of three or more cannot be a session until that exists (backlog D6).

A copy is a **member** of a session when it binds a seat the creator minted and
no other copy binds the same seat. Only members' rows are read: the `_current`
views of a session document show admitted rows and nothing else.

## Why a seat two copies bind admits neither

An invite is a link, and a link can be forwarded or opened on two devices. If
two copies bind the same seat, something has to decide which one is in — and
with no server, the only thing that could decide is which bound first, which
means trusting clocks that two phones do not share. So neither is admitted. The
seat is **contested**: both copies can see that it is, the creator can repair
it by minting a fresh open seat (`reseat`) and sending a new invite, and the
person they meant to play opens that one.

That is why an application shows the contested state rather than treating it as
an error: it is the honest answer to a question the protocol refuses to guess
at.

## Joining is an act, not an arrival

A copy binds a seat when a person opens an invite — a file or a link — never
because rows arrived in the background. Otherwise a copy whose seat was
contested and replaced would quietly take the fresh seat the moment it arrived
by mailbox, and contest it again. `dai:merged` says which kind of arrival it was
(`via`), and the application joins only on `"carrier"`.

## Closing on what was seen

Closing a session records, for every copy the closer has seen, the last row it
had seen from that copy. Rows written later than that are not admitted. It is a
statement of what the closer knew, not a time — the same refusal to trust a
clock.

## What is not true yet

An invite today carries the whole document, every session in it, not only the
one being shared. The code to filter an invite to one session exists and no
host uses it yet (backlog D4), so an application should not tell a person that
an invite contains only one game.

The design record for all of this is in
[`docs/replicated-tables.md`](https://github.com/dynamicapplicationinterface/dai-core/blob/main/docs/replicated-tables.md),
decisions T1-D26 to T1-D34.
